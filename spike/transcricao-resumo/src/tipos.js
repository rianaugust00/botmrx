// Tipos (JSDoc) dos arquivos trocados entre as etapas. Espelham docs/CONTRATOS.md.

/**
 * @typedef {{ id: number, nome: string, discordUserId?: string }} Participante
 * @typedef {{ id: number, participanteId: number, inicioMs: number, fimMs: number, texto: string }} Fala
 * @typedef {{
 *   daily: { data: string, iniciadaEm?: string, time?: string },
 *   participantes: Participante[],
 *   falas: Fala[],
 *   transcricao?: { provedor: string, modelo: string, segmentos: number, descartados: number }
 * }} Transcricao   conteúdo de falas.json
 * @typedef {{ id: number, participanteId: number, participanteNome?: string, desde: string, descricao: string }} BloqueioAberto
 */

export {};
