#!/usr/bin/env node
// Uso:
//   node src/cli.js transcrever <pasta>   manifest.json + .ogg → falas.json, transcricao.md
//   node src/cli.js resumir <pasta>       falas.json (+ bloqueios-abertos.json) → resumo.json, resumo.md
//   node src/cli.js processar <pasta>     as duas etapas
import 'dotenv/config';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { criarTranscritor } from './transcritor.js';
import { transcreverGravacao } from './transcrever.js';
import { extrairResumo, ErroExtracao } from './extrator.js';
import { resumoParaMarkdown } from './markdown.js';
import { formatarTempo } from './prompt.js';

const [comando, pasta] = process.argv.slice(2);
const etapas = { transcrever: [transcrever], resumir: [resumir], processar: [transcrever, resumir] };

if (!etapas[comando] || !pasta) {
  console.error('Uso: node src/cli.js <transcrever|resumir|processar> <pasta>');
  process.exit(2);
}

try {
  for (const etapa of etapas[comando]) await etapa(path.resolve(pasta));
} catch (e) {
  console.error(`\n✖ ${mensagemDeErro(e)}`);
  process.exit(1);
}

async function transcrever(dir) {
  const url = process.env.TRANSCRICAO_URL || 'https://api.openai.com/v1';
  const modelo = process.env.TRANSCRICAO_MODELO || 'whisper-1';
  console.log(`Transcrevendo ${dir}\n  ${url} · modelo ${modelo}`);

  const transcricao = await transcreverGravacao({
    pasta: dir,
    transcrever: criarTranscritor({
      url,
      modelo,
      apiKey: process.env.TRANSCRICAO_API_KEY,
      vocabulario: process.env.TRANSCRICAO_VOCABULARIO,
    }),
    concorrencia: Number(process.env.TRANSCRICAO_CONCORRENCIA || 4),
    juntarAteMs: Number(process.env.JUNTAR_FALAS_ATE_MS || 1500),
    fusoHorario: process.env.FUSO_HORARIO || 'America/Sao_Paulo',
    time: process.env.TIME_NOME,
    log: console.log,
  });
  transcricao.transcricao = { provedor: url, modelo, ...transcricao.transcricao };

  await escreverJson(path.join(dir, 'falas.json'), transcricao);
  const nome = new Map(transcricao.participantes.map((p) => [p.id, p.nome]));
  const md = [
    `# Transcrição — ${transcricao.daily.data}`,
    '',
    ...transcricao.falas.map((f) => `**[${formatarTempo(f.inicioMs)}] ${nome.get(f.participanteId)}** <sub>F${f.id}</sub>  \n${f.texto}\n`),
  ].join('\n');
  await writeFile(path.join(dir, 'transcricao.md'), md);

  const t = transcricao.transcricao;
  console.log(`✔ ${transcricao.falas.length} falas (${t.segmentos} trechos, ${t.descartados} vazios) → falas.json, transcricao.md`);
}

async function resumir(dir) {
  const transcricao = JSON.parse(await readFile(path.join(dir, 'falas.json'), 'utf8'));
  const bloqueiosAbertos = await lerJsonOpcional(path.join(dir, 'bloqueios-abertos.json'), []);
  const modelo = process.env.LLM_MODELO || 'claude-opus-5-5';
  const effort = process.env.LLM_EFFORT || 'medium';
  console.log(`Resumindo ${transcricao.falas.length} falas · ${modelo} · effort ${effort}`);

  const r = await extrairResumo({
    client: new Anthropic(),
    transcricao,
    bloqueiosAbertos,
    modelo,
    effort,
    fallback: process.env.LLM_FALLBACK !== 'off',
  });

  await escreverJson(path.join(dir, 'resumo.bruto.json'), r.bruto);
  await escreverJson(path.join(dir, 'resumo.json'), { meta: r.meta, avisos: r.avisos, resumo: r.resumo });
  await writeFile(path.join(dir, 'resumo.md'), resumoParaMarkdown({ ...r, transcricao, bloqueiosAbertos }));

  console.log(`✔ resumo.md, resumo.json (${r.meta.tokensEntrada} tokens entrada / ${r.meta.tokensSaida} saída)`);
  if (r.avisos.length) console.log(`  ⚠ ${r.avisos.length} aviso(s) da validação — veja resumo.md`);
}

function mensagemDeErro(e) {
  if (e instanceof ErroExtracao) return e.message;
  if (e instanceof Anthropic.AuthenticationError) return 'Credencial da Anthropic inválida ou ausente (ANTHROPIC_API_KEY).';
  if (e instanceof Anthropic.RateLimitError) return 'Limite de requisições da Anthropic atingido; tente de novo em instantes.';
  if (e instanceof Anthropic.BadRequestError) return `Requisição rejeitada pela API: ${e.message}`;
  if (e instanceof Anthropic.APIError) return `Erro da API Anthropic (${e.status}): ${e.message}`;
  if (e?.code === 'ENOENT') return `Arquivo não encontrado: ${e.path}`;
  if (/authentication method/i.test(e?.message ?? '')) {
    return 'Nenhuma credencial da Anthropic encontrada: defina ANTHROPIC_API_KEY no .env (ou rode `ant auth login`).';
  }
  return process.env.DEBUG ? (e?.stack ?? String(e)) : `${e?.message ?? e}  (DEBUG=1 para ver o stack)`;
}

async function escreverJson(caminho, dados) {
  await writeFile(caminho, JSON.stringify(dados, null, 2) + '\n');
}

async function lerJsonOpcional(caminho, padrao) {
  try {
    return JSON.parse(await readFile(caminho, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return padrao;
    throw e;
  }
}
