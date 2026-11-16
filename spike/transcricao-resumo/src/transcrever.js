// Etapa 1: manifest.json + .ogg (saída do spike de gravação) → falas.json
import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * @param {object} o
 * @param {string} o.pasta  pasta da gravação (contém manifest.json)
 * @param {(audio: Buffer, nomeArquivo: string) => Promise<string>} o.transcrever
 * @param {number} [o.concorrencia]
 * @param {number} [o.juntarAteMs] junta trechos seguidos da mesma pessoa com intervalo menor que isso
 * @param {string} [o.fusoHorario]
 * @param {string} [o.time]
 * @param {(msg: string) => void} [o.log]
 * @returns {Promise<import('./tipos.js').Transcricao>}
 */
export async function transcreverGravacao({
  pasta,
  transcrever,
  concorrencia = 4,
  juntarAteMs = 1500,
  fusoHorario = 'America/Sao_Paulo',
  time,
  log = () => {},
}) {
  const manifest = JSON.parse(await readFile(path.join(pasta, 'manifest.json'), 'utf8'));

  // IDs internos sequenciais (no banco serão os IDs de Participantes)
  const idPorUsuario = new Map();
  const participantes = [];
  for (const [discordUserId, p] of Object.entries(manifest.participantes)) {
    if (p.bot || !p.gravado) continue;
    const id = participantes.length + 1;
    idPorUsuario.set(discordUserId, id);
    participantes.push({ id, nome: p.nome, discordUserId });
  }

  const segmentos = manifest.segmentos
    .filter((s) => idPorUsuario.has(s.userId))
    .sort((a, b) => a.inicioMs - b.inicioMs);

  let feitos = 0;
  const textos = await mapComLimite(segmentos, concorrencia, async (s) => {
    const audio = await readFile(path.join(pasta, s.arquivo));
    const texto = await transcrever(audio, path.basename(s.arquivo));
    log(`  [${++feitos}/${segmentos.length}] ${manifest.participantes[s.userId].nome}: ${texto || '(vazio)'}`);
    return texto;
  });

  const trechos = segmentos
    .map((s, i) => ({
      participanteId: idPorUsuario.get(s.userId),
      inicioMs: s.inicioMs,
      // fim real do áudio (fimMs do manifest inclui o silêncio que fechou o trecho)
      fimMs: s.inicioMs + (s.duracaoAudioMs ?? s.fimMs - s.inicioMs),
      texto: textos[i],
    }))
    .filter((t) => t.texto);

  return {
    daily: { data: dataLocal(manifest.iniciadaEm, fusoHorario), iniciadaEm: manifest.iniciadaEm, ...(time && { time }) },
    participantes,
    falas: juntarTrechos(trechos, juntarAteMs).map((f, i) => ({ id: i + 1, ...f })),
    transcricao: { segmentos: segmentos.length, descartados: segmentos.length - trechos.length },
  };
}

/**
 * Junta trechos consecutivos da mesma pessoa quando ninguém falou no meio e o intervalo é curto.
 * Entrada ordenada por inicioMs.
 */
export function juntarTrechos(trechos, juntarAteMs) {
  const falas = [];
  for (const t of trechos) {
    const ultima = falas.at(-1);
    if (ultima && ultima.participanteId === t.participanteId && t.inicioMs - ultima.fimMs <= juntarAteMs) {
      ultima.texto += ' ' + t.texto;
      ultima.fimMs = Math.max(ultima.fimMs, t.fimMs);
    } else {
      falas.push({ ...t });
    }
  }
  return falas;
}

function dataLocal(iso, fusoHorario) {
  // en-CA formata como AAAA-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone: fusoHorario }).format(new Date(iso));
}

async function mapComLimite(itens, limite, fn) {
  const resultados = new Array(itens.length);
  let proximo = 0;
  const trabalhador = async () => {
    while (proximo < itens.length) {
      const i = proximo++;
      resultados[i] = await fn(itens[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limite, itens.length) }, trabalhador));
  return resultados;
}
