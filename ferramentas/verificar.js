#!/usr/bin/env node
// Confere a configuração do .env sem processar nada: npm run verificar
// Para APIs no formato OpenAI, consulta GET /models (não gasta créditos) e confere o modelo configurado.
import { config } from '../nucleo/config.js';

let problemas = 0;
const ok = (msg) => console.log(`✔ ${msg}`);
const ruim = (msg) => (problemas++, console.log(`✖ ${msg}`));

async function conferirModelos(rotulo, url, apiKey, modelo, nomeChave) {
  let r;
  try {
    r = await fetch(`${url.replace(/\/$/, '')}/models`, { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {} });
  } catch (e) {
    return ruim(`${rotulo}: não consegui conectar em ${url} (${e.cause?.code ?? e.message})`);
  }
  if (r.status === 401 || r.status === 403) return ruim(`${rotulo}: chave ${apiKey ? 'recusada' : 'ausente'} em ${url}. Preencha ${nomeChave} no .env.`);
  if (!r.ok) return ruim(`${rotulo}: ${url} respondeu ${r.status}`);
  const ids = ((await r.json().catch(() => ({}))).data ?? []).map((m) => m.id).sort();
  if (!ids.length) return ok(`${rotulo}: ${url} respondeu, mas não listou modelos (modelo configurado: ${modelo})`);
  if (ids.includes(modelo)) return ok(`${rotulo}: ${url} · modelo ${modelo} disponível`);
  ruim(`${rotulo}: o modelo "${modelo}" não existe em ${url}. Disponíveis:\n    ${ids.join('\n    ')}`);
}

config.discord.token ? ok('Discord: token do bot preenchido') : ruim('Discord: DISCORD_BOT_TOKEN vazio no .env');

const t = config.transcricao;
await conferirModelos('Transcrição', t.url, t.apiKey, t.modelo, 'TRANSCRICAO_API_KEY');

const l = config.llm;
if (l.provedor === 'openai') {
  l.url ? await conferirModelos('Resumo (LLM)', l.url, l.apiKey, l.modelo, 'LLM_API_KEY') : ruim('Resumo (LLM): LLM_PROVEDOR=openai exige LLM_URL');
} else if (l.provedor === 'anthropic') {
  process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN
    ? ok(`Resumo (LLM): Claude ${l.modelo}, chave preenchida (não testada, para não gastar)`)
    : ruim('Resumo (LLM): ANTHROPIC_API_KEY vazia. Para usar um provedor gratuito, veja LLM_PROVEDOR no .env.example.');
} else {
  ruim(`Resumo (LLM): LLM_PROVEDOR desconhecido ("${l.provedor}")`);
}

console.log(problemas ? `\n${problemas} problema(s). Corrija o .env e rode de novo.` : '\nTudo certo: pode rodar `npm run worker`.');
process.exitCode = problemas ? 1 : 0;
