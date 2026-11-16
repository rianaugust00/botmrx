// Casos de uso do Bot: IniciarDaily, EncerrarDaily, RegistrarSegmento, presença e opt-out.
// Liga a captura às portas de dados; não importa discord.js (o index.js adapta os eventos).

import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { SessaoCaptura } from './captura.js';

export class ErroDaily extends Error {}

export class ServicoDailies {
  #banco;
  #armazenamento;
  #opcoes;
  #log;
  #agora;
  /** @type {Map<string, { dailyId: number, time: any, canalVozId: string, sessao: SessaoCaptura }>} */
  #ativas = new Map();

  /**
   * @param {object} o
   * @param {import('../nucleo/sqlite/banco.js').Banco} o.banco
   * @param {ReturnType<import('../nucleo/armazenamento-disco.js').criarArmazenamentoDisco>} o.armazenamento
   * @param {{ silencioMs?: number, minSegmentoMs?: number }} [o.opcoes]
   * @param {(msg: string) => void} [o.log]
   * @param {() => number} [o.agora]
   */
  constructor({ banco, armazenamento, opcoes = {}, log = () => {}, agora = Date.now }) {
    this.#banco = banco;
    this.#armazenamento = armazenamento;
    this.#opcoes = opcoes;
    this.#log = log;
    this.#agora = agora;
  }

  /** Daily em gravação no servidor (uma por guild: só existe uma conexão de voz por servidor). */
  ativa(guildId) {
    return this.#ativas.get(guildId) ?? null;
  }

  guildsAtivas() {
    return [...this.#ativas.keys()];
  }

  /**
   * @param {object} o
   * @param {string} o.guildId
   * @param {string} o.canalVozId
   * @param {string} o.canalVozNome   vira o nome do time na primeira daily do canal
   * @param {string | null} o.canalTextoId  onde o resumo será postado
   * @param {import('@discordjs/voice').VoiceConnection} o.conexao  já conectada (Ready)
   * @param {(userId: string) => Promise<{ nome: string, bot: boolean }>} o.resolverMembro
   * @param {string[]} o.presentes  quem já está no canal
   */
  async iniciar({ guildId, canalVozId, canalVozNome, canalTextoId, conexao, resolverMembro, presentes }) {
    if (this.#ativas.has(guildId)) throw new ErroDaily('Já existe uma daily sendo gravada neste servidor.');

    const time = await this.#banco.obterOuCriarTime({ guildId, canalVozId, canalTextoId, nome: canalVozNome });
    const inicio = this.#agora();
    const daily = await this.#banco.criarDaily({ timeId: time.id, iniciadaEm: new Date(inicio) });

    const sessao = new SessaoCaptura({
      conexao,
      dailyId: daily.id,
      inicio,
      armazenamento: this.#armazenamento,
      silencioMs: this.#opcoes.silencioMs,
      minSegmentoMs: this.#opcoes.minSegmentoMs,
      log: this.#log,
      agora: this.#agora,
      resolverParticipante: async (userId) => {
        const m = await resolverMembro(userId);
        if (m.bot) return { nome: m.nome, bot: true, gravado: false };
        const p = await this.#banco.obterOuCriarParticipante({ discordUserId: userId, nome: m.nome });
        return { id: p.id, nome: p.nome, bot: false, gravado: !p.naoGravar };
      },
      aoSegmento: (s) =>
        this.#banco.registrarSegmento({
          dailyId: daily.id,
          participanteId: s.participanteId,
          inicioMs: s.inicioMs,
          fimMs: s.fimMs,
          caminho: s.caminho,
          formato: 'ogg',
        }),
    });

    const ativa = { dailyId: daily.id, time, canalVozId, sessao };
    this.#ativas.set(guildId, ativa);
    for (const userId of presentes) await this.entrou(guildId, userId);
    sessao.iniciar();
    return ativa;
  }

  async entrou(guildId, userId) {
    const ativa = this.#ativas.get(guildId);
    if (!ativa) return;
    const p = await ativa.sessao.participante(userId);
    if (p.bot) return;
    await this.#banco.registrarEntrada({ dailyId: ativa.dailyId, participanteId: p.id, quando: new Date(this.#agora()), gravado: p.gravado });
  }

  async saiu(guildId, userId) {
    const ativa = this.#ativas.get(guildId);
    if (!ativa) return;
    const p = await ativa.sessao.participante(userId);
    if (p.bot) return;
    await this.#banco.registrarSaida({ dailyId: ativa.dailyId, participanteId: p.id, quando: new Date(this.#agora()) });
  }

  /** Fecha a gravação e entrega a daily para o worker (job TRANSCREVER). */
  async encerrar(guildId) {
    const ativa = this.#ativas.get(guildId);
    if (!ativa) return null;
    this.#ativas.delete(guildId);
    const dave = ativa.sessao.dave();
    const stats = await ativa.sessao.encerrar();
    await this.#banco.encerrarGravacao({ dailyId: ativa.dailyId, quando: new Date(this.#agora()) });
    return { dailyId: ativa.dailyId, time: ativa.time, dave, ...stats };
  }

  /**
   * /daily nao-gravar e /daily gravar. Vale para as próximas dailies e para a que estiver em
   * andamento; nela, o que já tinha sido gravado da pessoa é apagado.
   */
  async definirOptOut({ userId, nome, naoGravar }) {
    const p = await this.#banco.definirNaoGravar({ discordUserId: userId, nome, naoGravar });
    for (const ativa of this.#ativas.values()) {
      ativa.sessao.definirGravado(userId, !naoGravar);
      await this.#banco.definirGravadoNaDaily({ dailyId: ativa.dailyId, participanteId: p.id, gravado: !naoGravar });
      if (naoGravar) {
        const caminhos = await this.#banco.descartarSegmentosDoParticipante({ dailyId: ativa.dailyId, participanteId: p.id });
        for (const c of caminhos) await this.#armazenamento.apagar(c);
      }
    }
    return p;
  }

  /**
   * Ao ligar: dailies que ficaram GRAVANDO porque o bot caiu seguem para o worker com o que já
   * estava salvo. Arquivos de trechos que não chegaram a ser registrados são apagados.
   */
  async recuperarOrfas() {
    const ids = await this.#banco.dailiesGravando();
    for (const dailyId of ids) {
      const registrados = new Set((await this.#banco.segmentosDaDaily(dailyId)).map((s) => path.resolve(s.caminho)));
      const pasta = path.dirname(this.#armazenamento.caminhoSegmento(dailyId, 0, 0));
      for (const arquivo of await readdir(pasta).catch(() => [])) {
        const caminho = path.join(pasta, arquivo);
        if (!registrados.has(caminho)) await this.#armazenamento.apagar(caminho);
      }
      await this.#banco.encerrarGravacao({ dailyId, quando: new Date(this.#agora()) });
    }
    return ids;
  }
}
