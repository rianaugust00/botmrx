// Carrega o prompt versionado (prompts/extracao-daily.md) e o contrato JSON (contracts/).
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderizar } from './template.js';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const CAMINHO_PROMPT = path.join(raiz, 'prompts/extracao-daily.md');
export const CAMINHO_SCHEMA = path.join(raiz, 'contracts/resumo-daily.schema.json');

/** @returns {Promise<{ versao: string, system: string, templateUsuario: string }>} */
export async function carregarPrompt(caminho = CAMINHO_PROMPT) {
  const md = await readFile(caminho, 'utf8');
  const versao = md.match(/vers[aã]o\s+`([^`]+)`/i)?.[1];
  const system = md.match(/^## System\s*\n([\s\S]*?)(?=^## )/m)?.[1].trim();
  const templateUsuario = md.match(/^## User[^\n]*\n[\s\S]*?```\n([\s\S]*?)```/m)?.[1];
  if (!versao || !system || !templateUsuario) {
    throw new Error(`Não consegui ler versão/System/User de ${caminho}`);
  }
  return { versao, system, templateUsuario };
}

/** Schema do contrato, sem as chaves de metadados que a API não precisa. */
export async function carregarSchema(caminho = CAMINHO_SCHEMA) {
  const { $schema, $id, title, ...schema } = JSON.parse(await readFile(caminho, 'utf8'));
  return schema;
}

/**
 * Monta a mensagem do usuário a partir de falas.json (+ bloqueios em aberto).
 * @param {string} templateUsuario
 * @param {import('./tipos.js').Transcricao} transcricao
 * @param {import('./tipos.js').BloqueioAberto[]} bloqueiosAbertos
 */
export function montarMensagemUsuario(templateUsuario, transcricao, bloqueiosAbertos = []) {
  const nomes = new Map(transcricao.participantes.map((p) => [p.id, p.nome]));
  return renderizar(templateUsuario, {
    time_nome: transcricao.daily.time ?? '(não informado)',
    data: transcricao.daily.data,
    participantes: transcricao.participantes,
    bloqueios_abertos: bloqueiosAbertos.map((b) => ({
      ...b,
      participante_nome: nomes.get(b.participanteId) ?? b.participanteNome ?? `#${b.participanteId}`,
    })),
    falas: transcricao.falas.map((f) => ({
      ...f,
      nome: nomes.get(f.participanteId) ?? `#${f.participanteId}`,
      tempo: formatarTempo(f.inicioMs),
    })),
  });
}

export function formatarTempo(ms) {
  const s = Math.floor(ms / 1000);
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}
