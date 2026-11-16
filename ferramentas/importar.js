#!/usr/bin/env node
// Coloca uma daily no banco sem passar pelo Discord, para testar o worker:
//   npm run importar -- <pasta>
// A pasta pode ser:
//   - uma gravação do spike (manifest.json + .ogg)  → entra na fila em TRANSCREVER
//   - uma transcrição pronta (falas.json, com bloqueios-abertos.json opcional) → entra em EXTRAIR
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../nucleo/config.js';
import { abrirBanco } from '../nucleo/sqlite/banco.js';
import { criarArmazenamentoDisco } from '../nucleo/armazenamento-disco.js';

const lerJson = async (arquivo, padrao) => {
  try {
    return JSON.parse(await readFile(arquivo, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT' && padrao !== undefined) return padrao;
    throw e;
  }
};

/** Gravação do spike: copia os .ogg para o armazenamento (o worker apaga a cópia, não o original). */
export async function importarGravacao({ banco, armazenamento, pasta, nomeTime }) {
  const manifest = await lerJson(path.join(pasta, 'manifest.json'));
  const inicio = new Date(manifest.iniciadaEm).getTime();
  const time = await banco.obterOuCriarTime({ guildId: manifest.guildId, canalVozId: manifest.canalId, nome: nomeTime || 'Gravação importada' });
  const daily = await banco.criarDaily({ timeId: time.id, iniciadaEm: new Date(inicio) });

  const ids = new Map();
  for (const [discordUserId, p] of Object.entries(manifest.participantes)) {
    if (p.bot) continue;
    ids.set(discordUserId, { id: (await banco.obterOuCriarParticipante({ discordUserId, nome: p.nome })).id, gravado: p.gravado });
  }
  for (const pr of manifest.presencas) {
    const p = ids.get(pr.userId);
    if (!p) continue;
    await banco.registrarEntrada({ dailyId: daily.id, participanteId: p.id, quando: new Date(inicio + pr.entrouMs), gravado: p.gravado });
  }
  let segmentos = 0;
  for (const s of manifest.segmentos) {
    const p = ids.get(s.userId);
    if (!p?.gravado) continue;
    const caminho = armazenamento.caminhoSegmento(daily.id, p.id, s.inicioMs, 'ogg');
    await mkdir(path.dirname(caminho), { recursive: true });
    await copyFile(path.join(pasta, s.arquivo), caminho);
    const fimMs = s.inicioMs + (s.duracaoAudioMs ?? s.fimMs - s.inicioMs);
    await banco.registrarSegmento({ dailyId: daily.id, participanteId: p.id, inicioMs: s.inicioMs, fimMs, caminho });
    segmentos++;
  }
  await banco.encerrarGravacao({ dailyId: daily.id, quando: new Date(manifest.encerradaEm ?? inicio) });
  return { dailyId: daily.id, etapa: 'TRANSCREVER', participantes: ids.size, segmentos };
}

/** Transcrição pronta (formato falas.json do spike). Bloqueios em aberto viram dailies anteriores mínimas. */
export async function importarTranscricao({ banco, pasta, nomeTime }) {
  const t = await lerJson(path.join(pasta, 'falas.json'));
  const bloqueios = await lerJson(path.join(pasta, 'bloqueios-abertos.json'), []);
  const nome = nomeTime || t.daily.time || 'Transcrição importada';
  const slug = (s) => s.normalize('NFD').replace(/[^\w]+/g, '-').toLowerCase();
  const time = await banco.obterOuCriarTime({ guildId: 'importado', canalVozId: slug(nome), nome });

  const ids = new Map();
  for (const p of t.participantes) {
    const discordUserId = p.discordUserId ?? `importado:${slug(nome)}:${slug(p.nome)}`;
    ids.set(p.id, (await banco.obterOuCriarParticipante({ discordUserId, nome: p.nome })).id);
  }

  for (const b of bloqueios) {
    const anterior = await banco.criarDaily({ timeId: time.id, iniciadaEm: new Date(`${b.desde}T15:00:00Z`) });
    await banco.concluirSemFalas(anterior.id);
    banco.db
      .prepare(`INSERT INTO Bloqueios (TimeId, ParticipanteId, Descricao, Status, PrimeiraDailyId, UltimaDailyId) VALUES (?, ?, ?, 'ABERTO', ?, ?)`)
      .run(time.id, ids.get(b.participanteId), b.descricao, anterior.id, anterior.id);
  }

  const iniciadaEm = new Date(t.daily.iniciadaEm ?? `${t.daily.data}T15:00:00Z`);
  const daily = await banco.criarDaily({ timeId: time.id, iniciadaEm });
  for (const id of ids.values()) await banco.registrarEntrada({ dailyId: daily.id, participanteId: id, quando: iniciadaEm, gravado: true });
  const falas = t.falas.map((f) => ({ participanteId: ids.get(f.participanteId), inicioMs: f.inicioMs, fimMs: f.fimMs, texto: f.texto }));
  const fim = new Date(iniciadaEm.getTime() + Math.max(0, ...falas.map((f) => f.fimMs)));
  banco.db.prepare('UPDATE Dailies SET EncerradaEm = ? WHERE Id = ?').run(fim.toISOString(), daily.id);
  banco.db.prepare('UPDATE DailyParticipantes SET SaiuEm = ? WHERE DailyId = ?').run(fim.toISOString(), daily.id);
  await banco.salvarTranscricao({ dailyId: daily.id, falas, segmentos: [] });
  return { dailyId: daily.id, etapa: 'EXTRAIR', participantes: ids.size, falas: falas.length, bloqueiosAbertos: bloqueios.length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pasta = process.argv[2] && path.resolve(process.env.INIT_CWD ?? '.', process.argv[2]);
  if (!pasta) {
    console.error('Uso: npm run importar -- <pasta com manifest.json ou falas.json>');
    process.exit(2);
  }
  const banco = abrirBanco(config.banco.caminho);
  try {
    const manifest = await lerJson(path.join(pasta, 'manifest.json'), null);
    const r = manifest
      ? await importarGravacao({ banco, armazenamento: criarArmazenamentoDisco(config.audio.pasta), pasta, nomeTime: process.env.TIME_NOME })
      : await importarTranscricao({ banco, pasta, nomeTime: process.env.TIME_NOME });
    console.log(`✔ Daily ${r.dailyId} importada e na fila (${r.etapa}): ${JSON.stringify(r)}`);
    console.log('  Rode `npm run worker` para processar e `npm run ver -- ' + r.dailyId + '` para ver o resultado.');
  } catch (e) {
    console.error(`✖ ${e.code === 'ENOENT' ? `Arquivo não encontrado: ${e.path}` : e.message}`);
    process.exitCode = 1;
  } finally {
    banco.fechar();
  }
}
