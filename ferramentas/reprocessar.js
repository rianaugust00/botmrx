#!/usr/bin/env node
// Recoloca uma daily na fila:
//   npm run reprocessar -- <id>               refaz o resumo (mantém a transcrição)
//   npm run reprocessar -- <id> transcrever   refaz a transcrição (só se o áudio ainda existir)
import { config } from '../nucleo/config.js';
import { abrirBanco } from '../nucleo/sqlite/banco.js';

const [arg, etapaArg = 'extrair'] = process.argv.slice(2);
const etapa = { extrair: 'EXTRAIR', transcrever: 'TRANSCREVER' }[etapaArg.toLowerCase()];
const id = Number(arg);
if (!Number.isInteger(id) || !etapa) {
  console.error('Uso: npm run reprocessar -- <id da daily> [extrair|transcrever]');
  process.exit(2);
}
const banco = abrirBanco(config.banco.caminho);
try {
  const jobId = await banco.reprocessar(id, etapa);
  console.log(`✔ Daily ${id} na fila para ${etapa} (job ${jobId}). O worker processa em seguida.`);
} catch (e) {
  console.error(`✖ ${e.message}`);
  process.exitCode = 1;
} finally {
  banco.fechar();
}
