// Caso de uso ExtrairResumo (M5): Falas → LLM → validação → ItensResumo/Bloqueios, daily CONCLUIDA.

const ETAPA = new Set(['AGUARDANDO_EXTRACAO', 'EXTRAINDO']);

/**
 * Idempotente: se a daily já não está nesta etapa, não faz nada.
 * @param {object} o
 * @param {import('../nucleo/sqlite/banco.js').Banco} o.banco
 * @param {ReturnType<import('./extrator.js').criarExtrator>} o.extrair
 * @param {number} o.dailyId
 * @param {(msg: string) => void} [o.log]
 */
export async function extrairResumoDaDaily({ banco, extrair, dailyId, log = () => {} }) {
  const daily = await banco.obterDaily(dailyId);
  if (!daily) throw new Error(`Daily ${dailyId} não existe.`);
  if (!ETAPA.has(daily.status)) return { pulada: true };

  await banco.definirStatus(dailyId, 'EXTRAINDO');
  const entrada = await banco.entradaExtracao(dailyId);

  if (entrada.falas.length === 0) {
    await banco.concluirSemFalas(dailyId);
    return { pulada: false, semFalas: true, itens: 0, avisos: [] };
  }

  const r = await extrair(entrada);
  for (const aviso of r.avisos) log(`  ⚠ ${aviso}`);
  const { itens } = await banco.salvarExtracao({ dailyId, resumo: r.resumo, bruto: r.bruto, meta: r.meta });
  return { pulada: false, semFalas: false, itens, avisos: r.avisos, meta: r.meta };
}
