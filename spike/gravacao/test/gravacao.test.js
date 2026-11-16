// Testes sem Discord: valida o arquivo Ogg Opus gerado e a lógica de segmentos da sessão.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import prism from 'prism-media';
import { AudioReceiveStream } from '@discordjs/voice';
import { OggOpusWriter, amostrasDoPacote } from '../src/ogg-opus-writer.js';
import { SessaoGravacao } from '../src/gravador.js';

// TOC 0xFC = config 31 (CELT 20 ms), estéreo, 1 frame → 960 amostras
const pacoteFalso = (i) => Buffer.from([0xfc, i & 0xff, 0xaa, 0xbb, 0xcc]);
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

test('amostrasDoPacote lê a duração pelo TOC', () => {
  assert.equal(amostrasDoPacote(Buffer.from([0xfc])), 960); // CELT 20 ms
  assert.equal(amostrasDoPacote(Buffer.from([0x08])), 960); // SILK 20 ms
  assert.equal(amostrasDoPacote(Buffer.from([0xfd])), 1920); // CELT 20 ms, 2 frames
  assert.equal(amostrasDoPacote(Buffer.from([0xff, 0x03])), 2880); // código 3, 3 frames
});

test('OggOpusWriter gera Ogg válido que o demuxer lê de volta', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'botmrx-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const arquivo = path.join(dir, 'a.ogg');

  const w = new OggOpusWriter(createWriteStream(arquivo));
  const enviados = Array.from({ length: 100 }, (_, i) => pacoteFalso(i));
  enviados.push(Buffer.alloc(600, 0x11).fill(0xfc, 0, 1)); // pacote > 255 bytes (lacing múltiplo)
  for (const p of enviados) w.write(p);
  await w.close();

  assert.equal(w.pacotes, 101);
  assert.equal(w.duracaoMs, 101 * 20);

  const bruto = await readFile(arquivo);
  assert.equal(bruto.subarray(0, 4).toString(), 'OggS');
  assert.ok(bruto.includes(Buffer.from('OpusHead')));

  const recebidos = [];
  await new Promise((resolve, reject) => {
    createReadStream(arquivo)
      .pipe(new prism.opus.OggDemuxer())
      .on('data', (p) => recebidos.push(p))
      .on('end', resolve)
      .on('error', reject);
  });
  assert.equal(recebidos.length, enviados.length);
  recebidos.forEach((p, i) => assert.deepEqual(p, enviados[i]));
});

test('OggOpusWriter calcula CRC correto em todas as páginas', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'botmrx-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const arquivo = path.join(dir, 'b.ogg');
  const w = new OggOpusWriter(createWriteStream(arquivo));
  for (let i = 0; i < 5; i++) w.write(pacoteFalso(i));
  await w.close();

  // CRC de referência calculado de forma independente (bit a bit)
  const crcRef = (buf) => {
    let crc = 0;
    for (const b of buf) {
      crc ^= b << 24;
      for (let k = 0; k < 8; k++) crc = crc & 0x80000000 ? ((crc << 1) ^ 0x04c11db7) >>> 0 : (crc << 1) >>> 0;
    }
    return crc >>> 0;
  };
  const bruto = await readFile(arquivo);
  let pos = 0, paginas = 0, flagsUltima = 0;
  while (pos < bruto.length) {
    const nSeg = bruto[pos + 26];
    const tam = bruto.subarray(pos + 27, pos + 27 + nSeg).reduce((a, b) => a + b, 0);
    const pagina = Buffer.from(bruto.subarray(pos, pos + 27 + nSeg + tam));
    const crc = pagina.readUInt32LE(22);
    pagina.writeUInt32LE(0, 22);
    assert.equal(crc, crcRef(pagina), `CRC da página ${paginas}`);
    flagsUltima = pagina[5];
    pos += pagina.length;
    paginas++;
  }
  assert.equal(paginas, 2 + 5); // OpusHead + OpusTags + 5 de áudio
  assert.equal(bruto[5], 0x02, 'primeira página com BOS');
  assert.equal(flagsUltima, 0x04, 'última página com EOS');
});

test('SessaoGravacao: um arquivo por trecho de fala, ignora bots/opt-out e descarta trechos curtos', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'botmrx-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  // Conexão falsa com o receiver real do @discordjs/voice (AudioReceiveStream)
  const subscriptions = new Map();
  const conexao = {
    state: { status: 'ready', networking: { state: { dave: { protocolVersion: 1, voicePrivacyCode: '123' } } } },
    receiver: {
      speaking: new EventEmitter(),
      subscriptions,
      subscribe(userId, options) {
        const s = new AudioReceiveStream({ end: options.end });
        s.once('close', () => subscriptions.delete(userId));
        subscriptions.set(userId, s);
        return s;
      },
    },
  };
  const usuarios = { ana: { nome: 'Ana', bot: false }, bruno: { nome: 'Bruno', bot: false }, bot: { nome: 'Bot', bot: true }, carla: { nome: 'Carla', bot: false } };

  const sessao = new SessaoGravacao({
    conexao,
    pastaBase: dir,
    guildId: 'g',
    canalId: 'c',
    ignorar: new Set(['carla']),
    silencioMs: 150,
    minSegmentoMs: 300,
    resolverNome: async (id) => usuarios[id],
    log: () => {},
  });
  await sessao.iniciar(['ana', 'bruno', 'bot', 'carla']);

  // Simula o receiver: dispara 'start' e empurra pacotes para quem tem assinatura
  const falar = async (userId, pacotes) => {
    conexao.receiver.speaking.emit('start', userId);
    await esperar(20); // tempo da assinatura ser criada (resolverNome/mkdir)
    for (let i = 0; i < pacotes; i++) {
      subscriptions.get(userId)?.push(pacoteFalso(i));
      await esperar(2);
    }
  };

  await falar('ana', 25); // 500 ms → grava
  await esperar(250); // silêncio > 150 ms → fecha o trecho
  await falar('ana', 30); // segundo trecho da Ana
  await falar('bruno', 5); // 100 ms → descartado (curto)
  await falar('bot', 30); // bot → ignorado
  await falar('carla', 30); // opt-out → ignorada
  await esperar(250);
  sessao.registrarSaida('bruno');

  sessao.registrarDave();
  const r = await sessao.encerrar();

  assert.equal(r.segmentos, 2);
  assert.equal(r.descartados, 1);
  assert.equal(r.erros, 0);
  assert.deepEqual(Object.keys(r.porUsuario), ['ana']);
  assert.deepEqual(r.dave, { ativo: true, protocolVersion: 1, voicePrivacyCode: '123' });

  const manifest = JSON.parse(await readFile(path.join(sessao.pasta, 'manifest.json'), 'utf8'));
  assert.equal(manifest.segmentos.length, 2);
  assert.ok(manifest.segmentos[0].inicioMs < manifest.segmentos[1].inicioMs);
  assert.equal(manifest.segmentos[0].duracaoAudioMs, 25 * 20);
  assert.equal(manifest.participantes.carla.gravado, false);
  assert.equal(manifest.presencas.length, 3); // ana, bruno, carla (bot não entra)
  assert.ok(manifest.presencas.find((p) => p.userId === 'bruno').saiuMs !== null);

  const arquivosAna = await readdir(path.join(sessao.pasta, 'ana'));
  assert.equal(arquivosAna.length, 2);
  await assert.rejects(readdir(path.join(sessao.pasta, 'carla'))); // nada criado para opt-out
});
