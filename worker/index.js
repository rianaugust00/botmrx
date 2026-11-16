// Serviço Worker: consome a fila de jobs (transcrição, extração, retenção).
import { hostname } from 'node:os';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../nucleo/config.js';
import { abrirBanco } from '../nucleo/sqlite/banco.js';
import { criarArmazenamentoDisco } from '../nucleo/armazenamento-disco.js';
import { criarTranscritor } from './transcritor.js';
import { criarExtrator } from './extrator.js';
import { criarExtratorOpenAI } from './extrator-openai.js';
import { criarNotificadorDiscord } from './notificador-discord.js';
import { executarProximo } from './processar.js';

function criarExtratorConfigurado() {
  const { provedor, url, apiKey, modelo, effort, fallback } = config.llm;
  if (provedor === 'anthropic') return criarExtrator({ client: new Anthropic(), modelo, effort, fallback });
  if (provedor === 'openai') {
    if (!url) throw new Error('LLM_PROVEDOR=openai exige LLM_URL (ex.: https://api.groq.com/openai/v1).');
    return criarExtratorOpenAI({ url, apiKey, modelo });
  }
  throw new Error(`LLM_PROVEDOR desconhecido: "${provedor}" (use anthropic ou openai).`);
}

const log = (msg) => console.log(`${new Date().toISOString().slice(11, 19)} ${msg}`);

const banco = abrirBanco(config.banco.caminho);
const postar = config.worker.postarResumo && config.discord.token;

const deps = {
  banco,
  armazenamento: criarArmazenamentoDisco(config.audio.pasta),
  transcrever: criarTranscritor({
    url: config.transcricao.url,
    apiKey: config.transcricao.apiKey,
    modelo: config.transcricao.modelo,
    vocabulario: config.transcricao.vocabulario,
  }),
  extrair: criarExtratorConfigurado(),
  notificar: postar ? criarNotificadorDiscord({ token: config.discord.token }) : null,
  workerId: `${hostname()}:${process.pid}`,
  opcoes: {
    maxTentativas: config.worker.maxTentativas,
    reservaMin: config.worker.reservaMin,
    concorrencia: config.transcricao.concorrencia,
    juntarAteMs: config.transcricao.juntarAteMs,
    retencaoTranscricaoDias: config.retencaoTranscricaoDias,
    retencaoAudioParadoDias: config.audio.retencaoParadasDias,
  },
  log,
};

log(`Worker ${deps.workerId} · banco ${config.banco.caminho}`);
log(`  transcrição: ${config.transcricao.url} (${config.transcricao.modelo})`);
log(`  LLM: ${config.llm.provedor === 'anthropic' ? `Claude ${config.llm.modelo}, effort ${config.llm.effort}` : `${config.llm.url} (${config.llm.modelo})`}`);
if (!config.transcricao.apiKey && /api\.openai\.com/.test(config.transcricao.url)) {
  log('  ⚠ TRANSCRICAO_API_KEY não definida: jobs TRANSCREVER vão falhar até você preencher o .env.');
}
if (config.llm.provedor === 'openai' && !config.llm.apiKey && !/localhost|127\.0\.0\.1/.test(config.llm.url)) {
  log('  ⚠ LLM_API_KEY não definida: jobs EXTRAIR vão falhar até você preencher o .env.');
}
if (config.llm.provedor === 'anthropic' && !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
  log('  ⚠ ANTHROPIC_API_KEY não definida: jobs EXTRAIR vão falhar, a menos que haja login via `ant auth login`.');
}
if (!postar) log('  (resumo não será postado no Discord: sem token ou POSTAR_RESUMO=off)');

await banco.enfileirarSeAusente('LIMPAR_RETENCAO');

let parar = false;
let acordar = () => {};
for (const sinal of ['SIGINT', 'SIGTERM']) {
  process.on(sinal, () => {
    if (parar) process.exit(1);
    log('Encerrando depois do job atual... (de novo para forçar)');
    parar = true;
    acordar();
  });
}

while (!parar) {
  let r = null;
  try {
    r = await executarProximo(deps);
  } catch (e) {
    log(`✖ erro no laço do worker: ${e?.stack ?? e}`);
  }
  if (!r && !parar) {
    await new Promise((resolve) => {
      const t = setTimeout(resolve, config.worker.intervaloMs);
      acordar = () => (clearTimeout(t), resolve());
    });
  }
}
banco.fechar();
log('Worker encerrado.');
