// Adaptador SQLite das portas de dados (repositórios + FilaDeJobs) de docs/ARQUITETURA.md §4.
//
// Cada método é uma operação atômica e assíncrona. Quem chama (bot, worker) não conhece SQL nem
// transações, então trocar por um adaptador SQL Server (db/schema.sql) é reescrever só este arquivo.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataLocal } from '../tempo.js';

const SCHEMA = path.join(path.dirname(fileURLToPath(import.meta.url)), 'schema.sql');

export const SEM_FALAS = 'Nenhuma fala foi registrada nesta daily.';

export class ErroBanco extends Error {}

// Mantém o comprimento do texto (cada letra acentuada vira a letra base), para os índices valerem no original.
const semAcento = (t) => t.split('').map((c) => c.normalize('NFD')[0].toLowerCase()[0] ?? c).join('');
const escaparHtml = (t) => t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * @param {string} [caminho]  arquivo do banco, ou ':memory:' (testes)
 * @param {{ agora?: () => Date }} [o]
 */
export function abrirBanco(caminho = ':memory:', { agora = () => new Date() } = {}) {
  if (caminho !== ':memory:') mkdirSync(path.dirname(path.resolve(caminho)), { recursive: true });
  const db = new DatabaseSync(caminho);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if (caminho !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(readFileSync(SCHEMA, 'utf8'));
  return new Banco(db, agora);
}

export class Banco {
  #db;
  #agora;
  #stmts = new Map();

  constructor(db, agora) {
    this.#db = db;
    this.#agora = agora;
  }

  /** Acesso direto, só para ferramentas e testes. */
  get db() {
    return this.#db;
  }

  fechar() {
    this.#db.close();
  }

  // ------------------------------------------------------------------ times e pessoas

  /** Devolve o time do canal de voz; cria na primeira daily do canal. */
  async obterOuCriarTime({ guildId, canalVozId, canalTextoId = null, nome }) {
    return this.#tx(() => {
      const t = this.#get('SELECT * FROM Times WHERE DiscordGuildId = ? AND DiscordCanalVozId = ?', guildId, canalVozId);
      if (!t) {
        const { Id } = this.#get(
          `INSERT INTO Times (Nome, DiscordGuildId, DiscordCanalVozId, DiscordCanalTextoId, CriadoEm)
           VALUES (?, ?, ?, ?, ?) RETURNING Id`,
          nome, guildId, canalVozId, canalTextoId, this.#iso(),
        );
        return { ...this.#time(Id), criado: true };
      }
      if (!t.DiscordCanalTextoId && canalTextoId) {
        this.#run('UPDATE Times SET DiscordCanalTextoId = ? WHERE Id = ?', canalTextoId, t.Id);
      }
      return { ...this.#time(t.Id), criado: false };
    });
  }

  /** Cadastra a pessoa na primeira vez que aparece e mantém o nome de exibição atualizado. */
  async obterOuCriarParticipante({ discordUserId, nome }) {
    return this.#tx(() => this.#participante(discordUserId, nome));
  }

  /** Opt-out persistente (/daily nao-gravar) ou a volta dele (/daily gravar). */
  async definirNaoGravar({ discordUserId, nome, naoGravar }) {
    return this.#tx(() => {
      const p = this.#participante(discordUserId, nome);
      this.#run('UPDATE Participantes SET NaoGravar = ?, AtualizadoEm = ? WHERE Id = ?', naoGravar ? 1 : 0, this.#iso(), p.id);
      return { ...p, naoGravar: Boolean(naoGravar) };
    });
  }

  // ------------------------------------------------------------------ captura (bot)

  async criarDaily({ timeId, iniciadaEm = this.#agora() }) {
    const time = this.#time(timeId);
    if (!time) throw new ErroBanco(`Time ${timeId} não existe.`);
    const agora = this.#iso();
    const inicio = new Date(iniciadaEm).toISOString();
    const data = dataLocal(inicio, time.fusoHorario);
    const { Id } = this.#get(
      `INSERT INTO Dailies (TimeId, Data, IniciadaEm, Status, CriadaEm, AtualizadaEm)
       VALUES (?, ?, ?, 'GRAVANDO', ?, ?) RETURNING Id`,
      timeId, data, inicio, agora, agora,
    );
    return { id: Id, timeId, data, iniciadaEm: inicio };
  }

  /** Entrada no canal. Reentrada reabre a presença (uma linha por pessoa por daily). */
  async registrarEntrada({ dailyId, participanteId, quando = this.#agora(), gravado }) {
    this.#run(
      `INSERT INTO DailyParticipantes (DailyId, ParticipanteId, EntrouEm, Gravado) VALUES (?, ?, ?, ?)
       ON CONFLICT (DailyId, ParticipanteId) DO UPDATE SET SaiuEm = NULL`,
      dailyId, participanteId, new Date(quando).toISOString(), gravado ? 1 : 0,
    );
  }

  async registrarSaida({ dailyId, participanteId, quando = this.#agora() }) {
    this.#run(
      'UPDATE DailyParticipantes SET SaiuEm = ? WHERE DailyId = ? AND ParticipanteId = ? AND SaiuEm IS NULL',
      new Date(quando).toISOString(), dailyId, participanteId,
    );
  }

  /** Opt-out/opt-in no meio da daily. */
  async definirGravadoNaDaily({ dailyId, participanteId, gravado }) {
    this.#run('UPDATE DailyParticipantes SET Gravado = ? WHERE DailyId = ? AND ParticipanteId = ?', gravado ? 1 : 0, dailyId, participanteId);
  }

  /**
   * Opt-out no meio da daily: os trechos já gravados da pessoa deixam de valer.
   * @returns {Promise<string[]>} caminhos dos arquivos a apagar
   */
  async descartarSegmentosDoParticipante({ dailyId, participanteId }) {
    return this.#tx(() => {
      const caminhos = this.#all(
        'SELECT Caminho FROM SegmentosAudio WHERE DailyId = ? AND ParticipanteId = ? AND ApagadoEm IS NULL',
        dailyId, participanteId,
      ).map((r) => r.Caminho);
      this.#run(
        `UPDATE SegmentosAudio SET Status = 'DESCARTADO', ApagadoEm = ? WHERE DailyId = ? AND ParticipanteId = ? AND ApagadoEm IS NULL`,
        this.#iso(), dailyId, participanteId,
      );
      return caminhos;
    });
  }

  async registrarSegmento({ dailyId, participanteId, inicioMs, fimMs, caminho, formato = 'ogg' }) {
    const { Id } = this.#get(
      `INSERT INTO SegmentosAudio (DailyId, ParticipanteId, InicioMs, FimMs, Caminho, Formato)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING Id`,
      dailyId, participanteId, Math.round(inicioMs), Math.round(fimMs), caminho, formato,
    );
    return Id;
  }

  /**
   * Fim da gravação: fecha presenças, daily → AGUARDANDO_TRANSCRICAO e enfileira TRANSCREVER.
   * Idempotente: devolve false se a daily já não estava GRAVANDO.
   */
  async encerrarGravacao({ dailyId, quando = this.#agora() }) {
    return this.#tx(() => {
      const d = this.#get('SELECT Status FROM Dailies WHERE Id = ?', dailyId);
      if (!d) throw new ErroBanco(`Daily ${dailyId} não existe.`);
      if (d.Status !== 'GRAVANDO') return false;
      const fim = new Date(quando).toISOString();
      this.#run('UPDATE DailyParticipantes SET SaiuEm = ? WHERE DailyId = ? AND SaiuEm IS NULL', fim, dailyId);
      this.#run(
        `UPDATE Dailies SET Status = 'AGUARDANDO_TRANSCRICAO', EncerradaEm = ?, AtualizadaEm = ? WHERE Id = ?`,
        fim, this.#iso(), dailyId,
      );
      this.#enfileirar('TRANSCREVER', dailyId);
      return true;
    });
  }

  /** Dailies que ficaram GRAVANDO (o bot caiu no meio). */
  async dailiesGravando() {
    return this.#all(`SELECT Id FROM Dailies WHERE Status = 'GRAVANDO' ORDER BY Id`).map((r) => r.Id);
  }

  async ultimaDailyDoTime(timeId) {
    const r = this.#get('SELECT Id FROM Dailies WHERE TimeId = ? ORDER BY IniciadaEm DESC, Id DESC LIMIT 1', timeId);
    return r ? this.obterDaily(r.Id) : null;
  }

  async ultimaDailyDaGuild(guildId) {
    const r = this.#get(
      `SELECT d.Id FROM Dailies d JOIN Times t ON t.Id = d.TimeId
        WHERE t.DiscordGuildId = ? ORDER BY d.IniciadaEm DESC, d.Id DESC LIMIT 1`,
      guildId,
    );
    return r ? this.obterDaily(r.Id) : null;
  }

  async timeDoCanal({ guildId, canalVozId }) {
    const t = this.#get('SELECT Id FROM Times WHERE DiscordGuildId = ? AND DiscordCanalVozId = ?', guildId, canalVozId);
    return t ? this.#time(t.Id) : null;
  }

  // ------------------------------------------------------------------ dailies

  async obterDaily(id) {
    const d = this.#get('SELECT * FROM Dailies WHERE Id = ?', id);
    if (!d) return null;
    return {
      id: d.Id,
      data: d.Data,
      iniciadaEm: d.IniciadaEm,
      encerradaEm: d.EncerradaEm,
      status: d.Status,
      erroMensagem: d.ErroMensagem,
      resumoGeral: d.ResumoGeral,
      time: this.#time(d.TimeId),
    };
  }

  async definirStatus(dailyId, status, erroMensagem = null) {
    this.#run(
      'UPDATE Dailies SET Status = ?, ErroMensagem = ?, AtualizadaEm = ? WHERE Id = ?',
      status, erroMensagem ? String(erroMensagem).slice(0, 2000) : null, this.#iso(), dailyId,
    );
  }

  async listarDailies({ timeId = null, limite = 20 } = {}) {
    return this.#all(
      `SELECT d.Id id, d.Data data, d.Status status, d.IniciadaEm iniciadaEm, d.EncerradaEm encerradaEm, t.Nome time,
              (SELECT COUNT(*) FROM DailyParticipantes dp WHERE dp.DailyId = d.Id) participantes,
              (SELECT COUNT(*) FROM Falas f WHERE f.DailyId = d.Id) falas
         FROM Dailies d JOIN Times t ON t.Id = d.TimeId
        WHERE (? IS NULL OR d.TimeId = ?)
        ORDER BY d.IniciadaEm DESC, d.Id DESC LIMIT ?`,
      timeId, timeId, limite,
    );
  }

  // ------------------------------------------------------------------ transcrição (worker)

  /** @param {{ status?: string, comAudio?: boolean }} [filtro] */
  async segmentosDaDaily(dailyId, { status, comAudio } = {}) {
    return this.#all(
      `SELECT s.Id id, s.ParticipanteId participanteId, p.NomeExibicao nome, s.InicioMs inicioMs, s.FimMs fimMs,
              s.Caminho caminho, s.Formato formato, s.Status status, s.ApagadoEm apagadoEm
         FROM SegmentosAudio s JOIN Participantes p ON p.Id = s.ParticipanteId
        WHERE s.DailyId = ? ORDER BY s.InicioMs, s.Id`,
      dailyId,
    ).filter((s) => (!status || s.status === status) && (comAudio === undefined || (s.apagadoEm === null) === comAudio));
  }

  /**
   * Grava o resultado da transcrição de uma vez: Falas, status dos segmentos,
   * daily → AGUARDANDO_EXTRACAO e job EXTRAIR. Substitui falas (e resumo) anteriores da daily.
   * @param {object} o
   * @param {number} o.dailyId
   * @param {{ participanteId: number, inicioMs: number, fimMs: number, texto: string, confianca?: number }[]} o.falas
   * @param {{ id: number, status: 'TRANSCRITO'|'DESCARTADO' }[]} o.segmentos
   */
  async salvarTranscricao({ dailyId, falas, segmentos }) {
    return this.#tx(() => {
      this.#desfazerExtracao(dailyId);
      this.#run('DELETE FROM Falas WHERE DailyId = ?', dailyId);
      for (const f of [...falas].sort((a, b) => a.inicioMs - b.inicioMs)) {
        this.#run(
          'INSERT INTO Falas (DailyId, ParticipanteId, InicioMs, FimMs, Texto, Confianca) VALUES (?, ?, ?, ?, ?, ?)',
          dailyId, f.participanteId, Math.round(f.inicioMs), Math.round(f.fimMs), f.texto, f.confianca ?? null,
        );
      }
      for (const s of segmentos) this.#run('UPDATE SegmentosAudio SET Status = ? WHERE Id = ? AND DailyId = ?', s.status, s.id, dailyId);
      this.#run(`UPDATE Dailies SET Status = 'AGUARDANDO_EXTRACAO', ErroMensagem = NULL, AtualizadaEm = ? WHERE Id = ?`, this.#iso(), dailyId);
      this.#enfileirar('EXTRAIR', dailyId);
      return falas.length;
    });
  }

  async marcarAudioApagado(segmentoIds) {
    const agora = this.#iso();
    this.#tx(() => {
      for (const id of segmentoIds) this.#run('UPDATE SegmentosAudio SET ApagadoEm = ? WHERE Id = ? AND ApagadoEm IS NULL', agora, id);
    });
  }

  /** Transcrição da daily no formato de GET /dailies/{id}/transcricao (docs/CONTRATOS.md §4). */
  async transcricao(dailyId) {
    return this.#all(
      `SELECT f.Id id, f.ParticipanteId pid, p.NomeExibicao nome, f.InicioMs inicioMs, f.FimMs fimMs, f.Texto texto
         FROM Falas f JOIN Participantes p ON p.Id = f.ParticipanteId
        WHERE f.DailyId = ? ORDER BY f.InicioMs, f.Id`,
      dailyId,
    ).map((f) => ({ id: f.id, participante: { id: f.pid, nome: f.nome }, inicioMs: f.inicioMs, fimMs: f.fimMs, texto: f.texto }));
  }

  // ------------------------------------------------------------------ extração (worker)

  /** Entrada do extrator (docs/CONTRATOS.md §3). */
  async entradaExtracao(dailyId) {
    const d = await this.obterDaily(dailyId);
    if (!d) throw new ErroBanco(`Daily ${dailyId} não existe.`);
    const participantes = this.#all(
      `SELECT p.Id id, p.NomeExibicao nome FROM Participantes p
        WHERE p.Id IN (SELECT ParticipanteId FROM DailyParticipantes WHERE DailyId = ?1)
           OR p.Id IN (SELECT ParticipanteId FROM Falas WHERE DailyId = ?1)
        ORDER BY p.Id`,
      dailyId,
    );
    // Em aberto ao chegar nesta daily: criados antes dela e ainda abertos, ou que ela mesma
    // resolveu numa extração anterior (caso de reextração).
    const bloqueiosAbertos = this.#all(
      `SELECT b.Id id, b.ParticipanteId participanteId, p.NomeExibicao participanteNome, pd.Data desde, b.Descricao descricao
         FROM Bloqueios b
         JOIN Dailies pd ON pd.Id = b.PrimeiraDailyId
         JOIN Participantes p ON p.Id = b.ParticipanteId
        WHERE b.TimeId = ? AND b.PrimeiraDailyId <> ? AND pd.IniciadaEm < ?
          AND (b.Status = 'ABERTO' OR b.ResolvidoNaDailyId = ?)
        ORDER BY b.Id`,
      d.time.id, dailyId, d.iniciadaEm, dailyId,
    );
    const falas = this.#all(
      'SELECT Id id, ParticipanteId participanteId, InicioMs inicioMs, FimMs fimMs, Texto texto FROM Falas WHERE DailyId = ? ORDER BY InicioMs, Id',
      dailyId,
    );
    return { time: { id: d.time.id, nome: d.time.nome }, data: d.data, participantes, bloqueiosAbertos, falas };
  }

  /**
   * Grava uma extração (já validada) e conclui a daily. Substitui a extração anterior:
   * apaga os itens, desativa as extrações antigas e refaz o efeito sobre os bloqueios.
   * @param {object} o
   * @param {number} o.dailyId
   * @param {any} o.resumo   saída de validarResumo() (formato de contracts/resumo-daily.schema.json)
   * @param {any} o.bruto    JSON como veio do LLM
   * @param {{ modelo: string, versaoPrompt: string, tokensEntrada?: number, tokensSaida?: number }} o.meta
   */
  async salvarExtracao({ dailyId, resumo, bruto, meta }) {
    return this.#tx(() => {
      const d = this.#get('SELECT TimeId FROM Dailies WHERE Id = ?', dailyId);
      if (!d) throw new ErroBanco(`Daily ${dailyId} não existe.`);
      this.#desfazerExtracao(dailyId);

      this.#run(
        `INSERT INTO ExtracoesLlm (DailyId, Modelo, VersaoPrompt, JsonResposta, TokensEntrada, TokensSaida, Ativa, CriadaEm)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
        dailyId, meta.modelo, meta.versaoPrompt, JSON.stringify(bruto), meta.tokensEntrada ?? null, meta.tokensSaida ?? null, this.#iso(),
      );

      let ordem = 0;
      const item = ({ tipo, participanteId = null, descricao, responsavelId = null, prazo = null, bloqueioId = null, falaIds }) => {
        const { Id } = this.#get(
          `INSERT INTO ItensResumo (DailyId, ParticipanteId, Tipo, Descricao, ResponsavelId, Prazo, BloqueioId, Ordem)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING Id`,
          dailyId, participanteId, tipo, descricao.slice(0, 1000), responsavelId, prazo?.slice(0, 100) ?? null, bloqueioId, ++ordem,
        );
        for (const falaId of falaIds) this.#run('INSERT OR IGNORE INTO ItensResumoEvidencias (ItemResumoId, FalaId) VALUES (?, ?)', Id, falaId);
      };

      for (const p of resumo.participantes) {
        const participanteId = p.participante_id;
        for (const i of p.fez) item({ tipo: 'FEZ', participanteId, descricao: i.descricao, falaIds: i.fala_ids });
        for (const i of p.vai_fazer) item({ tipo: 'VAI_FAZER', participanteId, descricao: i.descricao, falaIds: i.fala_ids });
        for (const b of p.bloqueios) {
          let bloqueioId = b.bloqueio_existente_id;
          if (bloqueioId) {
            this.#run('UPDATE Bloqueios SET UltimaDailyId = ? WHERE Id = ?', dailyId, bloqueioId);
          } else {
            bloqueioId = this.#get(
              `INSERT INTO Bloqueios (TimeId, ParticipanteId, Descricao, Status, PrimeiraDailyId, UltimaDailyId)
               VALUES (?, ?, ?, 'ABERTO', ?, ?) RETURNING Id`,
              d.TimeId, participanteId, b.descricao.slice(0, 1000), dailyId, dailyId,
            ).Id;
          }
          item({ tipo: 'BLOQUEIO', participanteId, descricao: b.descricao, bloqueioId, falaIds: b.fala_ids });
        }
      }
      for (const i of resumo.decisoes) item({ tipo: 'DECISAO', descricao: i.descricao, falaIds: i.fala_ids });
      for (const i of resumo.pendencias) {
        item({ tipo: 'PENDENCIA', descricao: i.descricao, responsavelId: i.responsavel_id, prazo: i.prazo, falaIds: i.fala_ids });
      }
      for (const b of resumo.bloqueios_resolvidos) {
        this.#run(
          `UPDATE Bloqueios SET Status = 'RESOLVIDO', ResolvidoNaDailyId = ?, UltimaDailyId = ? WHERE Id = ? AND TimeId = ?`,
          dailyId, dailyId, b.bloqueio_id, d.TimeId,
        );
      }

      this.#run(
        `UPDATE Dailies SET Status = 'CONCLUIDA', ResumoGeral = ?, ErroMensagem = NULL, AtualizadaEm = ? WHERE Id = ?`,
        resumo.resumo_geral, this.#iso(), dailyId,
      );
      return { itens: ordem };
    });
  }

  /** Daily em que ninguém (gravado) falou: conclui sem chamar o LLM. */
  async concluirSemFalas(dailyId) {
    this.#tx(() => {
      this.#desfazerExtracao(dailyId);
      this.#run(
        `UPDATE Dailies SET Status = 'CONCLUIDA', ResumoGeral = ?, ErroMensagem = NULL, AtualizadaEm = ? WHERE Id = ?`,
        SEM_FALAS, this.#iso(), dailyId,
      );
    });
  }

  /**
   * Visão do dia no formato de GET /dailies/{id} (docs/CONTRATOS.md §4), mais `time`,
   * `bloqueiosResolvidos` e, em cada bloqueio, `desde`/`novo`.
   */
  async visaoDaily(id) {
    const d = await this.obterDaily(id);
    if (!d) return null;

    const presentes = this.#all(
      `SELECT p.Id id, p.NomeExibicao nome, dp.Gravado gravado FROM DailyParticipantes dp
         JOIN Participantes p ON p.Id = dp.ParticipanteId WHERE dp.DailyId = ? ORDER BY dp.EntrouEm, p.Id`,
      id,
    ).map((p) => ({ ...p, gravado: Boolean(p.gravado) }));

    const evidencias = new Map();
    for (const e of this.#all(
      `SELECT e.ItemResumoId itemId, e.FalaId falaId FROM ItensResumoEvidencias e
         JOIN ItensResumo i ON i.Id = e.ItemResumoId WHERE i.DailyId = ? ORDER BY e.FalaId`,
      id,
    )) {
      if (!evidencias.has(e.itemId)) evidencias.set(e.itemId, []);
      evidencias.get(e.itemId).push(e.falaId);
    }

    const itens = this.#all(
      `SELECT i.Id id, i.Tipo tipo, i.Descricao descricao, i.Prazo prazo, i.BloqueioId bloqueioId,
              i.ParticipanteId pid, p.NomeExibicao pnome, i.ResponsavelId rid, r.NomeExibicao rnome,
              b.PrimeiraDailyId primeiraDailyId, pd.Data desde
         FROM ItensResumo i
         LEFT JOIN Participantes p ON p.Id = i.ParticipanteId
         LEFT JOIN Participantes r ON r.Id = i.ResponsavelId
         LEFT JOIN Bloqueios b ON b.Id = i.BloqueioId
         LEFT JOIN Dailies pd ON pd.Id = b.PrimeiraDailyId
        WHERE i.DailyId = ? ORDER BY i.Ordem`,
      id,
    );

    const pessoas = [];
    const decisoes = [];
    const pendencias = [];
    for (const i of itens) {
      const base = { id: i.id, descricao: i.descricao, falaIds: evidencias.get(i.id) ?? [] };
      if (i.tipo === 'DECISAO') decisoes.push(base);
      else if (i.tipo === 'PENDENCIA') {
        pendencias.push({ ...base, responsavel: i.rid ? { id: i.rid, nome: i.rnome } : null, prazo: i.prazo });
      } else {
        let pessoa = pessoas.find((x) => x.participante.id === i.pid);
        if (!pessoa) pessoas.push((pessoa = { participante: { id: i.pid, nome: i.pnome }, fez: [], vaiFazer: [], bloqueios: [] }));
        if (i.tipo === 'FEZ') pessoa.fez.push(base);
        else if (i.tipo === 'VAI_FAZER') pessoa.vaiFazer.push(base);
        else pessoa.bloqueios.push({ ...base, bloqueioId: i.bloqueioId, desde: i.desde, novo: i.primeiraDailyId === id });
      }
    }

    const bloqueiosResolvidos = this.#all(
      `SELECT b.Id id, b.Descricao descricao, b.ParticipanteId pid, p.NomeExibicao pnome, pd.Data desde
         FROM Bloqueios b JOIN Participantes p ON p.Id = b.ParticipanteId JOIN Dailies pd ON pd.Id = b.PrimeiraDailyId
        WHERE b.ResolvidoNaDailyId = ? ORDER BY b.Id`,
      id,
    ).map((b) => ({ id: b.id, descricao: b.descricao, desde: b.desde, participante: { id: b.pid, nome: b.pnome } }));

    const ex = this.#get('SELECT Modelo modelo, VersaoPrompt versaoPrompt FROM ExtracoesLlm WHERE DailyId = ? AND Ativa = 1 ORDER BY Id DESC LIMIT 1', id);

    return {
      id: d.id,
      data: d.data,
      status: d.status,
      erroMensagem: d.erroMensagem,
      iniciadaEm: d.iniciadaEm,
      encerradaEm: d.encerradaEm,
      time: { id: d.time.id, nome: d.time.nome },
      resumoGeral: d.resumoGeral,
      presentes,
      pessoas,
      decisoes,
      pendencias,
      bloqueiosResolvidos,
      extracao: ex ? { modelo: ex.modelo, versaoPrompt: ex.versaoPrompt } : null,
    };
  }

  // ------------------------------------------------------------------ leitura (API / dashboard)

  async listarTimes() {
    return this.#all(
      `SELECT t.Id id, t.Nome nome, t.FusoHorario fusoHorario,
              (SELECT COUNT(*) FROM Dailies d WHERE d.TimeId = t.Id) dailies
         FROM Times t WHERE t.Ativo = 1 ORDER BY t.Nome, t.Id`,
    );
  }

  /**
   * Lista para o calendário / seletor de dias (GET /dailies). Filtra por `datas` (lista) ou `de`/`ate`.
   * @param {{ timeId?: number, datas?: string[], de?: string, ate?: string }} [f]
   */
  async dailiesDoPeriodo({ timeId, datas, de, ate } = {}) {
    const { sql, params } = this.#filtroDailies({ timeId, datas, de, ate });
    return this.#all(
      `SELECT d.Id id, d.TimeId timeId, d.Data data, d.Status status, d.IniciadaEm iniciadaEm, d.EncerradaEm encerradaEm,
              (SELECT COUNT(*) FROM DailyParticipantes dp WHERE dp.DailyId = d.Id) participantes,
              (SELECT COUNT(*) FROM ItensResumo i WHERE i.DailyId = d.Id AND i.Tipo = 'BLOQUEIO') bloqueios
         FROM Dailies d WHERE ${sql} ORDER BY d.Data, d.IniciadaEm, d.Id`,
      ...params,
    ).map(({ encerradaEm, ...d }) => ({
      ...d,
      duracaoMin: encerradaEm ? Math.round((new Date(encerradaEm) - new Date(d.iniciadaEm)) / 60_000) : null,
    }));
  }

  async obterParticipante(id) {
    const p = this.#get('SELECT Id id, NomeExibicao nome, NaoGravar naoGravar FROM Participantes WHERE Id = ?', id);
    return p ? { ...p, naoGravar: Boolean(p.naoGravar) } : null;
  }

  /** Pessoas que já apareceram em alguma daily do time. */
  async participantesDoTime(timeId) {
    return this.#all(
      `SELECT p.Id id, p.NomeExibicao nome, p.NaoGravar naoGravar FROM Participantes p
        WHERE p.Id IN (SELECT dp.ParticipanteId FROM DailyParticipantes dp JOIN Dailies d ON d.Id = dp.DailyId WHERE d.TimeId = ?)
        ORDER BY p.NomeExibicao, p.Id`,
      timeId,
    ).map((p) => ({ ...p, naoGravar: Boolean(p.naoGravar) }));
  }

  /** PUT /admin/participantes/{id}: nome de exibição e opt-out. */
  async atualizarParticipante(id, { nome, naoGravar } = {}) {
    return this.#tx(() => {
      if (!this.#get('SELECT Id FROM Participantes WHERE Id = ?', id)) return null;
      if (typeof nome === 'string' && nome.trim()) {
        this.#run('UPDATE Participantes SET NomeExibicao = ?, AtualizadoEm = ? WHERE Id = ?', nome.trim().slice(0, 100), this.#iso(), id);
      }
      if (typeof naoGravar === 'boolean') {
        this.#run('UPDATE Participantes SET NaoGravar = ?, AtualizadoEm = ? WHERE Id = ?', naoGravar ? 1 : 0, this.#iso(), id);
      }
      const p = this.#get('SELECT Id id, NomeExibicao nome, NaoGravar naoGravar FROM Participantes WHERE Id = ?', id);
      return { ...p, naoGravar: Boolean(p.naoGravar) };
    });
  }

  /**
   * O que a pessoa reportou nos dias escolhidos (GET /participantes/{id}/historico).
   * Só entram dailies em que ela esteve presente ou teve itens.
   */
  async historicoParticipante(participanteId, filtro = {}) {
    const { sql, params } = this.#filtroDailies(filtro);
    const dailies = this.#all(
      `SELECT d.Id id, d.Data data FROM Dailies d
        WHERE ${sql}
          AND (d.Id IN (SELECT DailyId FROM DailyParticipantes WHERE ParticipanteId = ?)
               OR d.Id IN (SELECT DailyId FROM ItensResumo WHERE ParticipanteId = ?))
        ORDER BY d.Data, d.IniciadaEm, d.Id`,
      ...params, participanteId, participanteId,
    );
    const historico = [];
    for (const d of dailies) {
      const pessoa = (await this.visaoDaily(d.id)).pessoas.find((p) => p.participante.id === participanteId);
      historico.push({ dailyId: d.id, data: d.data, fez: pessoa?.fez ?? [], vaiFazer: pessoa?.vaiFazer ?? [], bloqueios: pessoa?.bloqueios ?? [] });
    }
    return historico;
  }

  /** GET /bloqueios: o que foi citado como bloqueio, desde quando e em quais dailies apareceu. */
  async listarBloqueios({ timeId, status } = {}) {
    const dailiesDo = this.#stmt('SELECT DISTINCT DailyId id FROM ItensResumo WHERE BloqueioId = ? ORDER BY DailyId');
    return this.#all(
      `SELECT b.Id id, b.Descricao descricao, b.Status status, b.ParticipanteId pid, p.NomeExibicao pnome,
              b.PrimeiraDailyId primeira, pd.Data desde, ud.Data ultimaMencao, rd.Data resolvidoEm
         FROM Bloqueios b
         JOIN Participantes p ON p.Id = b.ParticipanteId
         JOIN Dailies pd ON pd.Id = b.PrimeiraDailyId
         JOIN Dailies ud ON ud.Id = b.UltimaDailyId
         LEFT JOIN Dailies rd ON rd.Id = b.ResolvidoNaDailyId
        WHERE (? IS NULL OR b.TimeId = ?) AND (? IS NULL OR b.Status = ?)
        ORDER BY pd.Data, b.Id`,
      timeId ?? null, timeId ?? null, status ?? null, status ?? null,
    ).map((b) => ({
      id: b.id,
      participante: { id: b.pid, nome: b.pnome },
      descricao: b.descricao,
      status: b.status,
      desde: b.desde,
      ultimaMencao: b.ultimaMencao,
      resolvidoEm: b.resolvidoEm,
      dailies: [...new Set([b.primeira, ...dailiesDo.all(b.id).map((r) => r.id)])].sort((x, y) => x - y),
    }));
  }

  /**
   * GET /busca: texto livre nas transcrições, sem diferenciar maiúsculas nem acentos.
   * `trecho` vem com o termo entre <mark> e o restante com HTML escapado.
   */
  async buscarFalas({ q, timeId, de, ate, participanteId, limite = 100 } = {}) {
    const alvo = semAcento(q ?? '').trim();
    if (alvo.length < 2) return [];
    const { sql, params } = this.#filtroDailies({ timeId, de, ate });
    const falas = this.#all(
      `SELECT f.Id falaId, f.DailyId dailyId, d.Data data, f.ParticipanteId pid, p.NomeExibicao pnome, f.InicioMs inicioMs, f.Texto texto
         FROM Falas f JOIN Dailies d ON d.Id = f.DailyId JOIN Participantes p ON p.Id = f.ParticipanteId
        WHERE ${sql} AND (? IS NULL OR f.ParticipanteId = ?)
        ORDER BY d.Data DESC, d.Id DESC, f.InicioMs`,
      ...params, participanteId ?? null, participanteId ?? null,
    );
    const achados = [];
    for (const f of falas) {
      const pos = semAcento(f.texto).indexOf(alvo);
      if (pos < 0) continue;
      const ini = Math.max(0, pos - 60);
      const fim = Math.min(f.texto.length, pos + alvo.length + 60);
      const trecho =
        (ini > 0 ? '…' : '') + escaparHtml(f.texto.slice(ini, pos)) +
        `<mark>${escaparHtml(f.texto.slice(pos, pos + alvo.length))}</mark>` +
        escaparHtml(f.texto.slice(pos + alvo.length, fim)) + (fim < f.texto.length ? '…' : '');
      achados.push({ falaId: f.falaId, dailyId: f.dailyId, data: f.data, participante: { id: f.pid, nome: f.pnome }, trecho, inicioMs: f.inicioMs });
      if (achados.length >= limite) break;
    }
    return achados;
  }

  /** Falas de um período em ordem cronológica (entrada de POST /perguntas). */
  async falasDoPeriodo({ timeId, de, ate, participanteId } = {}) {
    const { sql, params } = this.#filtroDailies({ timeId, de, ate });
    return this.#all(
      `SELECT f.Id id, f.DailyId dailyId, d.Data data, f.ParticipanteId pid, p.NomeExibicao pnome, f.InicioMs inicioMs, f.Texto texto
         FROM Falas f JOIN Dailies d ON d.Id = f.DailyId JOIN Participantes p ON p.Id = f.ParticipanteId
        WHERE ${sql} AND (? IS NULL OR f.ParticipanteId = ?)
        ORDER BY d.Data, d.IniciadaEm, d.Id, f.InicioMs, f.Id`,
      ...params, participanteId ?? null, participanteId ?? null,
    ).map(({ pid, pnome, ...f }) => ({ ...f, participante: { id: pid, nome: pnome } }));
  }

  #filtroDailies({ timeId, datas, de, ate } = {}) {
    const cond = ['1 = 1'];
    const params = [];
    if (timeId != null) cond.push('d.TimeId = ?'), params.push(timeId);
    if (datas?.length) cond.push(`d.Data IN (${datas.map(() => '?').join(', ')})`), params.push(...datas);
    if (de) cond.push('d.Data >= ?'), params.push(de);
    if (ate) cond.push('d.Data <= ?'), params.push(ate);
    return { sql: cond.join(' AND '), params };
  }

  // ------------------------------------------------------------------ acesso ao dashboard

  /** Times com os dados do Discord necessários para decidir quem pode ver cada um. */
  async timesParaAutorizacao() {
    return this.#all('SELECT Id id, Nome nome, DiscordGuildId guildId, DiscordRoleGestorId roleGestorId FROM Times WHERE Ativo = 1 ORDER BY Id');
  }

  /** Cargo do Discord que dá acesso ao dashboard do time; null volta para "só administradores". */
  async definirRoleGestor(timeId, roleId) {
    this.#run('UPDATE Times SET DiscordRoleGestorId = ? WHERE Id = ?', roleId ?? null, timeId);
    return this.#time(timeId);
  }

  async timesDaGuild(guildId) {
    return this.#all('SELECT Id FROM Times WHERE DiscordGuildId = ? AND Ativo = 1 ORDER BY Id', guildId).map((r) => this.#time(r.Id));
  }

  /** A pessoa já apareceu em alguma daily de algum destes times? */
  async participanteNosTimes(participanteId, timeIds) {
    if (!timeIds.length) return false;
    return Boolean(
      this.#get(
        `SELECT 1 ok FROM DailyParticipantes dp JOIN Dailies d ON d.Id = dp.DailyId
          WHERE dp.ParticipanteId = ? AND d.TimeId IN (${timeIds.map(() => '?').join(', ')}) LIMIT 1`,
        participanteId, ...timeIds,
      ),
    );
  }

  async criarSessao({ tokenHash, discordUserId, nome, expiraEm }) {
    this.#tx(() => {
      this.#run('DELETE FROM Sessoes WHERE ExpiraEm < ?', this.#iso());
      this.#run(
        'INSERT INTO Sessoes (TokenHash, DiscordUserId, Nome, CriadaEm, ExpiraEm) VALUES (?, ?, ?, ?, ?)',
        tokenHash, discordUserId, nome.slice(0, 100), this.#iso(), new Date(expiraEm).toISOString(),
      );
    });
  }

  /** Sessão válida (não expirada) ou null. */
  async obterSessao(tokenHash) {
    const s = this.#get('SELECT DiscordUserId discordUserId, Nome nome, ExpiraEm expiraEm FROM Sessoes WHERE TokenHash = ? AND ExpiraEm > ?', tokenHash, this.#iso());
    return s ?? null;
  }

  async apagarSessao(tokenHash) {
    this.#run('DELETE FROM Sessoes WHERE TokenHash = ?', tokenHash);
  }

  // ------------------------------------------------------------------ reprocessamento e retenção

  /**
   * Recoloca a daily na fila. EXTRAIR mantém a transcrição; TRANSCREVER exige que o áudio
   * ainda exista (ele é apagado depois de uma transcrição bem-sucedida).
   * @param {'EXTRAIR'|'TRANSCREVER'} etapa
   */
  async reprocessar(dailyId, etapa) {
    return this.#tx(() => {
      const d = this.#get('SELECT Status FROM Dailies WHERE Id = ?', dailyId);
      if (!d) throw new ErroBanco(`Daily ${dailyId} não existe.`);
      if (d.Status === 'GRAVANDO') throw new ErroBanco(`Daily ${dailyId} ainda está sendo gravada.`);

      if (etapa === 'EXTRAIR') {
        const { n } = this.#get('SELECT COUNT(*) n FROM Falas WHERE DailyId = ?', dailyId);
        if (n === 0) throw new ErroBanco(`Daily ${dailyId} não tem transcrição; reprocesse a partir de TRANSCREVER.`);
        this.#run(`UPDATE Dailies SET Status = 'AGUARDANDO_EXTRACAO', ErroMensagem = NULL, AtualizadaEm = ? WHERE Id = ?`, this.#iso(), dailyId);
      } else if (etapa === 'TRANSCREVER') {
        const { n } = this.#get('SELECT COUNT(*) n FROM SegmentosAudio WHERE DailyId = ? AND ApagadoEm IS NULL', dailyId);
        if (n === 0) throw new ErroBanco(`O áudio da daily ${dailyId} já foi apagado; só é possível reextrair (EXTRAIR).`);
        this.#run(`UPDATE SegmentosAudio SET Status = 'PENDENTE' WHERE DailyId = ? AND ApagadoEm IS NULL`, dailyId);
        this.#run(`UPDATE Dailies SET Status = 'AGUARDANDO_TRANSCRICAO', ErroMensagem = NULL, AtualizadaEm = ? WHERE Id = ?`, this.#iso(), dailyId);
      } else {
        throw new ErroBanco(`Etapa desconhecida: ${etapa}`);
      }
      // Cancela jobs antigos da daily que ainda estejam na fila, para não rodar duas vezes.
      this.#run(
        `UPDATE Jobs SET Status = 'CONCLUIDO', UltimoErro = 'substituído por reprocessamento', AtualizadoEm = ?
          WHERE DailyId = ? AND Status = 'PENDENTE'`,
        this.#iso(), dailyId,
      );
      return this.#enfileirar(etapa, dailyId);
    });
  }

  /**
   * Retenção (LGPD): apaga as transcrições das dailies com Data anterior a `antesDe` (AAAA-MM-DD).
   * O resumo (itens) fica; as evidências deixam de apontar para falas.
   */
  async apagarTranscricoesAntigas(antesDe) {
    return this.#tx(() => {
      const ids = this.#all('SELECT Id FROM Dailies WHERE Data < ?', antesDe).map((r) => r.Id);
      let falas = 0;
      for (const id of ids) {
        this.#run('DELETE FROM ItensResumoEvidencias WHERE FalaId IN (SELECT Id FROM Falas WHERE DailyId = ?)', id);
        falas += Number(this.#run('DELETE FROM Falas WHERE DailyId = ?', id).changes);
      }
      return { falas };
    });
  }

  /**
   * Áudios que não deveriam mais existir: segmentos já processados cujo arquivo não foi apagado,
   * e segmentos de dailies paradas (ERRO ou esquecidas) encerradas antes de `paradasAntesDe`.
   */
  async audiosOrfaos({ paradasAntesDe }) {
    return this.#all(
      `SELECT s.Id id, s.Caminho caminho FROM SegmentosAudio s JOIN Dailies d ON d.Id = s.DailyId
        WHERE s.ApagadoEm IS NULL
          AND (s.Status <> 'PENDENTE' OR d.Status = 'CONCLUIDA'
               OR (d.Status <> 'GRAVANDO' AND COALESCE(d.EncerradaEm, d.IniciadaEm) < ?))`,
      new Date(paradasAntesDe).toISOString(),
    );
  }

  // ------------------------------------------------------------------ fila de jobs

  async enfileirar(tipo, dailyId = null, executarApos = this.#agora()) {
    return this.#enfileirar(tipo, dailyId, executarApos);
  }

  /** Enfileira só se não houver job desse tipo aguardando ou em execução (ex.: LIMPAR_RETENCAO diário). */
  async enfileirarSeAusente(tipo, executarApos = this.#agora()) {
    return this.#tx(() => {
      const existe = this.#get(`SELECT Id FROM Jobs WHERE Tipo = ? AND Status IN ('PENDENTE','EM_EXECUCAO') LIMIT 1`, tipo);
      return existe ? null : this.#enfileirar(tipo, null, executarApos);
    });
  }

  /**
   * Reserva o próximo job, inclusive os de reserva expirada (worker que caiu).
   * Um único UPDATE: seguro com vários workers.
   */
  async reservarProximo(tipos, workerId, reservaMin = 10) {
    const agora = this.#agora();
    const iso = agora.toISOString();
    const ate = new Date(agora.getTime() + reservaMin * 60_000).toISOString();
    const marcas = tipos.map(() => '?').join(', ');
    const r = this.#get(
      `UPDATE Jobs SET Status = 'EM_EXECUCAO', Tentativas = Tentativas + 1, ReservadoPor = ?, ReservadoAte = ?, AtualizadoEm = ?
        WHERE Id = (
          SELECT Id FROM Jobs
           WHERE Tipo IN (${marcas})
             AND ((Status = 'PENDENTE' AND ExecutarApos <= ?) OR (Status = 'EM_EXECUCAO' AND ReservadoAte < ?))
           ORDER BY ExecutarApos, Id LIMIT 1)
       RETURNING Id, Tipo, DailyId, Tentativas`,
      workerId, ate, iso, ...tipos, iso, iso,
    );
    return r ? { id: r.Id, tipo: r.Tipo, dailyId: r.DailyId, tentativas: r.Tentativas } : null;
  }

  async concluir(jobId) {
    this.#run(
      `UPDATE Jobs SET Status = 'CONCLUIDO', ReservadoPor = NULL, ReservadoAte = NULL, AtualizadoEm = ? WHERE Id = ?`,
      this.#iso(), jobId,
    );
  }

  /**
   * Falha com backoff exponencial (1, 2, 4, 8... min); depois de `maxTentativas` vira FALHOU.
   * @returns {Promise<'PENDENTE'|'FALHOU'>}
   */
  async falhar(jobId, erro, maxTentativas = 5) {
    return this.#tx(() => {
      const j = this.#get('SELECT Tentativas FROM Jobs WHERE Id = ?', jobId);
      if (!j) throw new ErroBanco(`Job ${jobId} não existe.`);
      const status = j.Tentativas >= maxTentativas ? 'FALHOU' : 'PENDENTE';
      const agora = this.#agora();
      const proxima = new Date(agora.getTime() + 2 ** Math.max(j.Tentativas - 1, 0) * 60_000).toISOString();
      this.#run(
        `UPDATE Jobs SET Status = ?, ExecutarApos = ?, ReservadoPor = NULL, ReservadoAte = NULL, UltimoErro = ?, AtualizadoEm = ? WHERE Id = ?`,
        status, proxima, String(erro).slice(0, 2000), agora.toISOString(), jobId,
      );
      return status;
    });
  }

  async listarJobs({ dailyId = null } = {}) {
    return this.#all(
      `SELECT Id id, Tipo tipo, DailyId dailyId, Status status, Tentativas tentativas, ExecutarApos executarApos, UltimoErro ultimoErro
         FROM Jobs WHERE (? IS NULL OR DailyId = ?) ORDER BY Id`,
      dailyId, dailyId,
    );
  }

  // ------------------------------------------------------------------ internos

  #enfileirar(tipo, dailyId = null, executarApos = this.#agora()) {
    const agora = this.#iso();
    return this.#get(
      'INSERT INTO Jobs (Tipo, DailyId, ExecutarApos, CriadoEm, AtualizadoEm) VALUES (?, ?, ?, ?, ?) RETURNING Id',
      tipo, dailyId, new Date(executarApos).toISOString(), agora, agora,
    ).Id;
  }

  /**
   * Remove o efeito da extração atual da daily: itens (e evidências), bloqueios que ela criou
   * ou resolveu e a marca de extração ativa. Chamar dentro de uma transação.
   */
  #desfazerExtracao(dailyId) {
    this.#run('DELETE FROM ItensResumo WHERE DailyId = ?', dailyId);
    this.#run(`UPDATE Bloqueios SET Status = 'ABERTO', ResolvidoNaDailyId = NULL WHERE ResolvidoNaDailyId = ?`, dailyId);
    // Bloqueios criados por esta daily e que nenhuma outra citou deixam de existir.
    this.#run(
      'DELETE FROM Bloqueios WHERE PrimeiraDailyId = ? AND Id NOT IN (SELECT BloqueioId FROM ItensResumo WHERE BloqueioId IS NOT NULL)',
      dailyId,
    );
    // Os demais voltam a apontar para a última daily que ainda os cita.
    for (const b of this.#all('SELECT Id, PrimeiraDailyId FROM Bloqueios WHERE UltimaDailyId = ?', dailyId)) {
      const ultima = this.#get(
        `SELECT d.Id FROM ItensResumo i JOIN Dailies d ON d.Id = i.DailyId
          WHERE i.BloqueioId = ? ORDER BY d.IniciadaEm DESC, d.Id DESC LIMIT 1`,
        b.Id,
      );
      this.#run('UPDATE Bloqueios SET UltimaDailyId = ? WHERE Id = ?', ultima?.Id ?? b.PrimeiraDailyId, b.Id);
    }
    this.#run('UPDATE ExtracoesLlm SET Ativa = 0 WHERE DailyId = ?', dailyId);
  }

  #participante(discordUserId, nome) {
    const agora = this.#iso();
    const p = this.#get('SELECT * FROM Participantes WHERE DiscordUserId = ?', discordUserId);
    if (!p) {
      const nomeFinal = (nome || discordUserId).slice(0, 100);
      const { Id } = this.#get(
        'INSERT INTO Participantes (DiscordUserId, NomeExibicao, CriadoEm, AtualizadoEm) VALUES (?, ?, ?, ?) RETURNING Id',
        discordUserId, nomeFinal, agora, agora,
      );
      return { id: Id, discordUserId, nome: nomeFinal, naoGravar: false };
    }
    let nomeAtual = p.NomeExibicao;
    if (nome && nome !== nomeAtual) {
      nomeAtual = nome.slice(0, 100);
      this.#run('UPDATE Participantes SET NomeExibicao = ?, AtualizadoEm = ? WHERE Id = ?', nomeAtual, agora, p.Id);
    }
    return { id: p.Id, discordUserId, nome: nomeAtual, naoGravar: Boolean(p.NaoGravar) };
  }

  #time(id) {
    const t = this.#get('SELECT * FROM Times WHERE Id = ?', id);
    return t && {
      id: t.Id,
      nome: t.Nome,
      guildId: t.DiscordGuildId,
      canalVozId: t.DiscordCanalVozId,
      canalTextoId: t.DiscordCanalTextoId,
      fusoHorario: t.FusoHorario,
    };
  }

  #iso() {
    return this.#agora().toISOString();
  }

  #stmt(sql) {
    let s = this.#stmts.get(sql);
    if (!s) this.#stmts.set(sql, (s = this.#db.prepare(sql)));
    return s;
  }

  #get(sql, ...p) {
    const r = this.#stmt(sql).get(...p);
    return r ? { ...r } : undefined;
  }

  #all(sql, ...p) {
    return this.#stmt(sql).all(...p).map((r) => ({ ...r }));
  }

  #run(sql, ...p) {
    return this.#stmt(sql).run(...p);
  }

  /** Transação síncrona (o corpo não pode ter await). Reentrante. */
  #emTx = false;
  #tx(fn) {
    if (this.#emTx) return fn();
    this.#db.exec('BEGIN IMMEDIATE');
    this.#emTx = true;
    try {
      const r = fn();
      this.#db.exec('COMMIT');
      return r;
    } catch (e) {
      this.#db.exec('ROLLBACK');
      throw e;
    } finally {
      this.#emTx = false;
    }
  }
}
