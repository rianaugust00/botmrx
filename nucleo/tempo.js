/** Data (AAAA-MM-DD) de um instante no fuso do time. */
export function dataLocal(instante, fusoHorario = 'America/Sao_Paulo') {
  // en-CA formata como AAAA-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone: fusoHorario }).format(new Date(instante));
}

/** 83120 → "01:23" (ou "1:01:23" a partir de uma hora). */
export function formatarTempo(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** "2026-11-14" → "14/11/2026" */
export function dataBr(data) {
  const [a, m, d] = data.split('-');
  return `${d}/${m}/${a}`;
}
