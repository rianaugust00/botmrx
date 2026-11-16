// Perguntas livres sobre um período (Fase 3): o LLM responde só com base nas transcrições
// e cita as falas; as citações são conferidas antes de voltar para o dashboard.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatarTempo } from '../nucleo/tempo.js';

const CAMINHO_PROMPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../prompts/perguntas.md');
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['resposta', 'fala_ids'],
  properties: {
    resposta: { type: 'string' },
    fala_ids: { type: 'array', items: { type: 'integer' }, description: 'IDs das falas que sustentam a resposta.' },
  },
};

export class PerguntaInvalida extends Error {}

async function carregarPrompt() {
  const md = await readFile(CAMINHO_PROMPT, 'utf8');
  const versao = md.match(/vers[aã]o\s+`([^`]+)`/i)?.[1];
  const system = md.match(/^## System\s*\n([\s\S]*)$/m)?.[1].trim();
  if (!versao || !system) throw new Error(`Não consegui ler versão/System de ${CAMINHO_PROMPT}`);
  return { versao, system };
}

/**
 * @param {object} o
 * @param {import('../nucleo/sqlite/banco.js').Banco} o.banco
 * @param {ReturnType<import('../nucleo/llm.js').criarLlm>} o.gerarJson
 * @param {number} [o.maxCaracteres]  teto de transcrição enviada; acima disso ficam as dailies mais recentes
 */
export function criarRespondedor({ banco, gerarJson, maxCaracteres = 40_000 }) {
  return async function responder({ pergunta, timeId, de, ate, participanteId }) {
    const texto = String(pergunta ?? '').trim();
    if (texto.length < 5) throw new PerguntaInvalida('Escreva a pergunta com pelo menos 5 caracteres.');
    if (texto.length > 500) throw new PerguntaInvalida('A pergunta pode ter no máximo 500 caracteres.');

    const falas = await banco.falasDoPeriodo({ timeId, de, ate, participanteId });
    if (!falas.length) {
      return { resposta: 'Não há transcrições de dailies no período escolhido.', citacoes: [], dailiesConsideradas: 0, periodoCortado: false, modelo: null, versaoPrompt: null };
    }

    // Agrupa por daily (as falas vêm em ordem cronológica) e, se passar do teto, mantém as mais recentes.
    const dailies = [...Map.groupBy(falas, (f) => f.dailyId).values()];
    const blocos = dailies.map((fs) =>
      [`## Daily de ${fs[0].data} (id ${fs[0].dailyId})`, ...fs.map((f) => `[F${f.id} | ${formatarTempo(f.inicioMs)} | ${f.participante.nome}] ${f.texto}`)].join('\n'),
    );
    let inicio = blocos.length - 1;
    let tamanho = blocos[inicio].length;
    while (inicio > 0 && tamanho + blocos[inicio - 1].length <= maxCaracteres) tamanho += blocos[--inicio].length;
    const usados = dailies.slice(inicio);

    const prompt = await carregarPrompt();
    const usuario =
      `Período: ${usados[0][0].data} a ${usados.at(-1)[0].data}\n\n` +
      `Transcrições (formato: [F<id> | mm:ss | nome] texto):\n\n${blocos.slice(inicio).join('\n\n')}\n\n` +
      `Pergunta do gestor: ${texto}`;

    const { json, modelo } = await gerarJson({ system: prompt.system, usuario, schema: SCHEMA, nome: 'resposta_pergunta' });

    const porId = new Map(usados.flat().map((f) => [f.id, f]));
    const ids = Array.isArray(json?.fala_ids) ? json.fala_ids : [];
    const citacoes = [...new Set(ids.map((id) => Number(String(id).replace(/^[Ff#]/, ''))))].map((id) => porId.get(id)).filter(Boolean);
    return {
      resposta: typeof json?.resposta === 'string' && json.resposta.trim() ? json.resposta.trim() : 'O modelo não devolveu uma resposta.',
      citacoes: citacoes.map((f) => ({ falaId: f.id, dailyId: f.dailyId, data: f.data, participante: f.participante, inicioMs: f.inicioMs, texto: f.texto })),
      dailiesConsideradas: usados.length,
      periodoCortado: inicio > 0,
      modelo,
      versaoPrompt: prompt.versao,
    };
  };
}
