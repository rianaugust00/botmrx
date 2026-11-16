// Configuração por variáveis de ambiente (docs/ARQUITETURA.md §10). Lê o .env da raiz do projeto.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

export const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(RAIZ, '.env'), quiet: true });

const env = process.env;
const num = (nome, padrao) => {
  const v = Number(env[nome] ?? padrao);
  if (!Number.isFinite(v)) throw new Error(`${nome} precisa ser um número (valor: "${env[nome]}").`);
  return v;
};
const caminho = (nome, padrao) => path.resolve(RAIZ, env[nome] || padrao);

export const config = {
  discord: {
    token: env.DISCORD_BOT_TOKEN || env.DISCORD_TOKEN || '',
    // Login do dashboard (OAuth2). O Client ID é o mesmo "Application ID" do bot.
    clientId: env.DISCORD_CLIENT_ID || '',
    clientSecret: env.DISCORD_CLIENT_SECRET || '',
    debugVoz: env.DEBUG_VOZ === '1',
  },
  banco: { caminho: caminho('SQLITE_PATH', 'dados/botmrx.db') },
  audio: {
    pasta: caminho('AUDIO_STORAGE_PATH', 'dados/audio'),
    silencioMs: num('SEGMENTO_SILENCIO_MS', 1000),
    minSegmentoMs: num('SEGMENTO_MINIMO_MS', 600),
    duracaoMaximaMin: num('DAILY_DURACAO_MAXIMA_MIN', 60),
    retencaoParadasDias: num('AUDIO_RETENCAO_ERRO_DIAS', 7),
  },
  transcricao: {
    url: env.TRANSCRICAO_URL || 'https://api.openai.com/v1',
    apiKey: env.TRANSCRICAO_API_KEY || '',
    modelo: env.TRANSCRICAO_MODELO || 'whisper-1',
    concorrencia: num('TRANSCRICAO_CONCORRENCIA', 4),
    vocabulario: env.TRANSCRICAO_VOCABULARIO || '',
    juntarAteMs: num('JUNTAR_FALAS_ATE_MS', 1500),
  },
  llm: {
    // "anthropic" (API do Claude) ou "openai" (qualquer API no formato OpenAI: Groq, Gemini, Ollama...)
    provedor: (env.LLM_PROVEDOR || 'anthropic').toLowerCase(),
    url: env.LLM_URL || '',
    apiKey: env.LLM_API_KEY || '',
    modelo: env.LLM_MODELO || 'claude-opus-5-5',
    effort: env.LLM_EFFORT || 'medium',
    fallback: env.LLM_FALLBACK !== 'off',
  },
  worker: {
    maxTentativas: num('JOB_MAX_TENTATIVAS', 5),
    reservaMin: num('JOB_RESERVA_MIN', 10),
    intervaloMs: num('WORKER_INTERVALO_MS', 2000),
    postarResumo: env.POSTAR_RESUMO !== 'off',
  },
  api: {
    porta: num('API_PORT', 3000),
    host: env.API_HOST || '127.0.0.1',
    // Endereço pelo qual as pessoas abrem o dashboard; define o retorno do login e o cookie.
    urlPainel: (env.PAINEL_URL || `http://127.0.0.1:${num('API_PORT', 3000)}`).replace(/\/$/, ''),
    sessaoDias: num('PAINEL_SESSAO_DIAS', 7),
    perguntasMaxCaracteres: num('PERGUNTAS_MAX_CARACTERES', 40000),
  },
  retencaoTranscricaoDias: num('RETENCAO_TRANSCRICAO_DIAS', 180),
};
