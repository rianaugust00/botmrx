// Ajusta a resposta de modelos que não garantem o JSON Schema (provedores no formato OpenAI):
// campos ausentes viram listas vazias, ids como "F12" ou "12" viram números e itens sem
// descrição são descartados. A checagem de evidências continua em validar.js.

const inteiro = (v) => {
  if (Number.isInteger(v)) return v;
  if (typeof v === 'string') {
    const m = v.trim().match(/^[Ff#]?(\d+)$/);
    if (m) return Number(m[1]);
  }
  return null;
};
const lista = (v) => (Array.isArray(v) ? v : []);
const ids = (v) => lista(v).map(inteiro).filter((n) => n !== null);
const texto = (v) => (typeof v === 'string' ? v.trim() : '');
const objetos = (v) => lista(v).filter((x) => x && typeof x === 'object');
const itens = (v) => objetos(v).map((i) => ({ descricao: texto(i.descricao), fala_ids: ids(i.fala_ids) })).filter((i) => i.descricao);

/** @returns {any} objeto no formato de contracts/resumo-daily.schema.json */
export function normalizarResumo(bruto) {
  if (!bruto || typeof bruto !== 'object' || Array.isArray(bruto)) {
    throw new TypeError('A resposta do modelo não é um objeto JSON.');
  }
  return {
    resumo_geral: texto(bruto.resumo_geral),
    participantes: objetos(bruto.participantes)
      .map((p) => ({
        participante_id: inteiro(p.participante_id),
        fez: itens(p.fez),
        vai_fazer: itens(p.vai_fazer),
        bloqueios: objetos(p.bloqueios)
          .map((b) => ({ descricao: texto(b.descricao), bloqueio_existente_id: inteiro(b.bloqueio_existente_id), fala_ids: ids(b.fala_ids) }))
          .filter((b) => b.descricao),
      }))
      .filter((p) => p.participante_id !== null),
    decisoes: itens(bruto.decisoes),
    pendencias: objetos(bruto.pendencias)
      .map((p) => ({ descricao: texto(p.descricao), responsavel_id: inteiro(p.responsavel_id), prazo: texto(p.prazo) || null, fala_ids: ids(p.fala_ids) }))
      .filter((p) => p.descricao),
    bloqueios_resolvidos: objetos(bruto.bloqueios_resolvidos)
      .map((b) => ({ bloqueio_id: inteiro(b.bloqueio_id), fala_ids: ids(b.fala_ids) }))
      .filter((b) => b.bloqueio_id !== null),
  };
}
