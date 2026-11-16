// Grava uma sessão de voz: um arquivo .ogg por trecho contínuo de fala de cada usuário,
// mais um manifest.json com quem falou, quando, presença no canal e erros.

import { createWriteStream } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { EndBehaviorType } from '@discordjs/voice';
import { OggOpusWriter } from './ogg-opus-writer.js';

export class SessaoGravacao {
  #conexao;
  #pasta;
  #resolverNome;
  #ignorar;
  #silencioMs;
  #minSegmentoMs;
  #encerrando = false;
  #pendentes = new Set();
  #iniciando = new Set();
  #log;

  /**
   * @param {object} o
   * @param {import('@discordjs/voice').VoiceConnection} o.conexao
   * @param {string} o.pastaBase
   * @param {string} o.guildId
   * @param {string} o.canalId
   * @param {(userId: string) => Promise<{ nome: string, bot: boolean }>} o.resolverNome
   * @param {Set<string>} [o.ignorar] userIds que não devem ser gravados (opt-out)
   * @param {number} [o.silencioMs]
   * @param {number} [o.minSegmentoMs]
   * @param {(msg: string) => void} [o.log]
   */
  constructor(o) {
    this.#conexao = o.conexao;
    this.#resolverNome = o.resolverNome;
    this.#ignorar = o.ignorar ?? new Set();
    this.#silencioMs = o.silencioMs ?? 1000;
    this.#minSegmentoMs = o.minSegmentoMs ?? 600;
    this.#log = o.log ?? console.log;

    this.inicio = Date.now();
    const carimbo = new Date(this.inicio).toISOString().replace(/[:.]/g, '-');
    this.#pasta = path.join(o.pastaBase, carimbo);

    this.manifest = {
      versao: 1,
      guildId: o.guildId,
      canalId: o.canalId,
      iniciadaEm: new Date(this.inicio).toISOString(),
      encerradaEm: null,
      dave: null,
      participantes: {}, // userId -> { nome, gravado }
      presencas: [], // { userId, entrouMs, saiuMs }
      segmentos: [], // { userId, inicioMs, fimMs, duracaoAudioMs, pacotes, arquivo }
      descartados: 0,
      erros: [], // { userId, ms, mensagem }
    };
  }

  get pasta() {
    return this.#pasta;
  }

  async iniciar(presentesIniciais = []) {
    await mkdir(this.#pasta, { recursive: true });
    for (const userId of presentesIniciais) await this.registrarEntrada(userId);
    this.#conexao.receiver.speaking.on('start', (userId) => {
      this.#gravarSegmento(userId).catch((e) => this.#registrarErro(userId, e));
    });
  }

  /** Informações do DAVE (criptografia ponta a ponta) da conexão atual. */
  registrarDave() {
    const estado = this.#conexao.state;
    const dave = estado.status === 'ready' ? estado.networking?.state?.dave : undefined;
    this.manifest.dave = dave
      ? { ativo: true, protocolVersion: dave.protocolVersion, voicePrivacyCode: dave.voicePrivacyCode }
      : { ativo: false };
    return this.manifest.dave;
  }

  async registrarEntrada(userId) {
    const info = await this.#participante(userId);
    if (info.bot) return;
    const aberta = this.manifest.presencas.find((p) => p.userId === userId && p.saiuMs === null);
    if (!aberta) this.manifest.presencas.push({ userId, entrouMs: this.#agoraMs(), saiuMs: null });
  }

  registrarSaida(userId) {
    const aberta = this.manifest.presencas.find((p) => p.userId === userId && p.saiuMs === null);
    if (aberta) aberta.saiuMs = this.#agoraMs();
  }

  /** Encerra todos os segmentos abertos, grava o manifest e devolve o resumo. */
  async encerrar() {
    this.#encerrando = true;
    for (const stream of this.#conexao.receiver.subscriptions.values()) stream.push(null);
    await Promise.allSettled([...this.#pendentes]);

    const fim = this.#agoraMs();
    for (const p of this.manifest.presencas) if (p.saiuMs === null) p.saiuMs = fim;
    this.manifest.encerradaEm = new Date().toISOString();
    this.manifest.segmentos.sort((a, b) => a.inicioMs - b.inicioMs);

    await writeFile(path.join(this.#pasta, 'manifest.json'), JSON.stringify(this.manifest, null, 2));
    return this.resumo();
  }

  resumo() {
    const porUsuario = {};
    for (const s of this.manifest.segmentos) {
      const r = (porUsuario[s.userId] ??= { nome: this.manifest.participantes[s.userId]?.nome, segmentos: 0, audioSeg: 0 });
      r.segmentos++;
      r.audioSeg += s.duracaoAudioMs / 1000;
    }
    return {
      pasta: this.#pasta,
      duracaoSeg: Math.round(this.#agoraMs() / 1000),
      segmentos: this.manifest.segmentos.length,
      descartados: this.manifest.descartados,
      erros: this.manifest.erros.length,
      dave: this.manifest.dave,
      porUsuario,
    };
  }

  async #gravarSegmento(userId) {
    if (this.#encerrando) return;
    const receiver = this.#conexao.receiver;
    if (receiver.subscriptions.has(userId) || this.#iniciando.has(userId)) return;

    const inicioMs = this.#agoraMs();
    this.#iniciando.add(userId);
    let info;
    try {
      info = await this.#participante(userId);
      if (info.bot || !info.gravado || this.#encerrando) return;
      await mkdir(path.join(this.#pasta, userId), { recursive: true });
    } finally {
      this.#iniciando.delete(userId);
    }
    if (this.#encerrando) return;
    const arquivo = path.join(userId, `${String(inicioMs).padStart(8, '0')}.ogg`);
    const caminho = path.join(this.#pasta, arquivo);

    const opus = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: this.#silencioMs },
    });
    const writer = new OggOpusWriter(createWriteStream(caminho));
    let erroStream = null;

    opus.on('data', (pacote) => writer.write(pacote));
    opus.on('error', (e) => {
      erroStream = e; // ex.: falha ao descriptografar (DAVE)
    });

    const finalizado = new Promise((resolve) => opus.once('close', resolve)).then(async () => {
      await writer.close();
      const fimMs = this.#agoraMs();
      if (erroStream) this.#registrarErro(userId, erroStream, inicioMs);

      if (writer.duracaoMs < this.#minSegmentoMs) {
        this.manifest.descartados++;
        await rm(caminho, { force: true });
        return;
      }
      this.manifest.segmentos.push({
        userId,
        inicioMs,
        fimMs,
        duracaoAudioMs: Math.round(writer.duracaoMs),
        pacotes: writer.pacotes,
        arquivo,
      });
      this.#log(`  ● ${info.nome}: ${(writer.duracaoMs / 1000).toFixed(1)} s (${writer.pacotes} pacotes) → ${arquivo}`);
    });

    this.#pendentes.add(finalizado);
    finalizado.finally(() => this.#pendentes.delete(finalizado));
  }

  async #participante(userId) {
    let p = this.manifest.participantes[userId];
    if (!p) {
      const { nome, bot } = await this.#resolverNome(userId);
      p = { nome, bot, gravado: !bot && !this.#ignorar.has(userId) };
      this.manifest.participantes[userId] = p;
    }
    return p;
  }

  #registrarErro(userId, erro, ms = this.#agoraMs()) {
    const mensagem = erro?.message ?? String(erro);
    this.manifest.erros.push({ userId, ms, mensagem });
    this.#log(`  ✖ erro (${this.manifest.participantes[userId]?.nome ?? userId}): ${mensagem}`);
  }

  #agoraMs() {
    return Date.now() - this.inicio;
  }
}
