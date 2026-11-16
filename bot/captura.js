// Captura (M1): um arquivo .ogg por trecho contínuo de fala de cada usuário.
// Não conhece banco nem Discord além da conexão de voz: quem falou é resolvido por
// `resolverParticipante` e cada trecho fechado é entregue em `aoSegmento`.

import { EndBehaviorType } from '@discordjs/voice';
import { OggOpusWriter } from './ogg-opus-writer.js';

/**
 * @typedef {{ id?: number, nome: string, bot: boolean, gravado: boolean }} ParticipanteCaptura
 * @typedef {{ userId: string, participanteId: number, inicioMs: number, fimMs: number, duracaoAudioMs: number, caminho: string }} Segmento
 */

export class SessaoCaptura {
  #conexao;
  #dailyId;
  #armazenamento;
  #resolverParticipante;
  #aoSegmento;
  #silencioMs;
  #minSegmentoMs;
  #log;
  #agora;
  #encerrando = false;
  #pendentes = new Set();
  #iniciando = new Set();
  #participantes = new Map(); // userId -> ParticipanteCaptura
  #aoFalar = null;
  #stats = { segmentos: 0, descartados: 0, erros: [], porUsuario: {} };

  /**
   * @param {object} o
   * @param {import('@discordjs/voice').VoiceConnection} o.conexao
   * @param {number} o.dailyId
   * @param {number} o.inicio  epoch (ms) de Dailies.IniciadaEm; os tempos dos trechos são relativos a ele
   * @param {ReturnType<import('../nucleo/armazenamento-disco.js').criarArmazenamentoDisco>} o.armazenamento
   * @param {(userId: string) => Promise<ParticipanteCaptura>} o.resolverParticipante
   * @param {(s: Segmento) => Promise<void>} o.aoSegmento
   * @param {number} [o.silencioMs]     silêncio que fecha um trecho
   * @param {number} [o.minSegmentoMs]  trechos com menos áudio que isso são descartados
   * @param {(msg: string) => void} [o.log]
   * @param {() => number} [o.agora]
   */
  constructor(o) {
    this.#conexao = o.conexao;
    this.#dailyId = o.dailyId;
    this.inicio = o.inicio;
    this.#armazenamento = o.armazenamento;
    this.#resolverParticipante = o.resolverParticipante;
    this.#aoSegmento = o.aoSegmento;
    this.#silencioMs = o.silencioMs ?? 1000;
    this.#minSegmentoMs = o.minSegmentoMs ?? 600;
    this.#log = o.log ?? (() => {});
    this.#agora = o.agora ?? Date.now;
  }

  iniciar() {
    this.#aoFalar = (userId) => {
      this.#gravarSegmento(userId).catch((e) => this.#registrarErro(userId, e));
    };
    this.#conexao.receiver.speaking.on('start', this.#aoFalar);
  }

  /** Dados de quem está na call (com cache durante a sessão). */
  async participante(userId) {
    let p = this.#participantes.get(userId);
    if (!p) {
      p = await this.#resolverParticipante(userId);
      this.#participantes.set(userId, p);
    }
    return p;
  }

  /**
   * Opt-out/opt-in durante a daily. Ao desligar, o trecho que estiver aberto é fechado e descartado.
   */
  definirGravado(userId, gravado) {
    const p = this.#participantes.get(userId);
    if (p) p.gravado = gravado && !p.bot;
    if (!gravado) this.#conexao.receiver.subscriptions.get(userId)?.push(null);
  }

  /** Informações do DAVE (criptografia ponta a ponta) da conexão atual. */
  dave() {
    const estado = this.#conexao.state;
    const dave = estado.status === 'ready' ? estado.networking?.state?.dave : undefined;
    return dave ? { ativo: true, protocolVersion: dave.protocolVersion } : { ativo: false };
  }

  estatisticas() {
    return {
      duracaoSeg: Math.round(this.#agoraMs() / 1000),
      segmentos: this.#stats.segmentos,
      descartados: this.#stats.descartados,
      erros: this.#stats.erros.length,
      porUsuario: this.#stats.porUsuario,
    };
  }

  /** Fecha os trechos abertos e espera todos serem entregues em `aoSegmento`. */
  async encerrar() {
    this.#encerrando = true;
    if (this.#aoFalar) this.#conexao.receiver.speaking.off('start', this.#aoFalar);
    for (const stream of this.#conexao.receiver.subscriptions.values()) stream.push(null);
    await Promise.allSettled([...this.#pendentes]);
    return this.estatisticas();
  }

  async #gravarSegmento(userId) {
    if (this.#encerrando) return;
    const receiver = this.#conexao.receiver;
    if (receiver.subscriptions.has(userId) || this.#iniciando.has(userId)) return;

    const inicioMs = this.#agoraMs();
    this.#iniciando.add(userId);
    let info, caminho, saida;
    try {
      info = await this.participante(userId);
      // Opt-out: o áudio da pessoa nunca é assinado.
      if (info.bot || !info.gravado || this.#encerrando) return;
      caminho = this.#armazenamento.caminhoSegmento(this.#dailyId, info.id, inicioMs, 'ogg');
      saida = await this.#armazenamento.abrirEscrita(caminho);
    } finally {
      this.#iniciando.delete(userId);
    }
    if (this.#encerrando || !info.gravado) {
      saida.destroy();
      await this.#armazenamento.apagar(caminho);
      return;
    }

    const opus = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: this.#silencioMs },
    });
    const writer = new OggOpusWriter(saida);
    let erroStream = null;

    opus.on('data', (pacote) => writer.write(pacote));
    opus.on('error', (e) => {
      erroStream = e; // ex.: falha ao descriptografar (DAVE)
    });

    const finalizado = new Promise((resolve) => opus.once('close', resolve))
      .then(async () => {
        await writer.close();
        if (erroStream) this.#registrarErro(userId, erroStream);

        if (!info.gravado) return this.#armazenamento.apagar(caminho); // opt-out no meio do trecho
        if (writer.duracaoMs < this.#minSegmentoMs) {
          this.#stats.descartados++;
          return this.#armazenamento.apagar(caminho);
        }
        const duracaoAudioMs = Math.round(writer.duracaoMs);
        await this.#aoSegmento({
          userId,
          participanteId: info.id,
          inicioMs,
          // fim real do áudio (sem o silêncio que fechou o trecho)
          fimMs: inicioMs + duracaoAudioMs,
          duracaoAudioMs,
          caminho,
        });
        this.#stats.segmentos++;
        const u = (this.#stats.porUsuario[userId] ??= { nome: info.nome, segmentos: 0, audioSeg: 0 });
        u.segmentos++;
        u.audioSeg += duracaoAudioMs / 1000;
        this.#log(`  ● ${info.nome}: ${(duracaoAudioMs / 1000).toFixed(1)} s`);
      })
      .catch((e) => this.#registrarErro(userId, e));

    this.#pendentes.add(finalizado);
    finalizado.finally(() => this.#pendentes.delete(finalizado));
  }

  #registrarErro(userId, erro) {
    const mensagem = erro?.message ?? String(erro);
    this.#stats.erros.push({ userId, ms: this.#agoraMs(), mensagem });
    this.#log(`  ✖ erro (${this.#participantes.get(userId)?.nome ?? userId}): ${mensagem}`);
  }

  #agoraMs() {
    return this.#agora() - this.inicio;
  }
}
