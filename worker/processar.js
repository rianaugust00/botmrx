// Laço do worker: reserva um job, executa, conclui ou falha (com retry/backoff na fila).
import { transcreverDaily } from './transcrever-daily.js';
import { extrairResumoDaDaily } from './extrair-resumo.js';
import { limparRetencao } from './limpar-retencao.js';
import { resumoEmTexto } from './resumo-texto.js';

export const TIPOS = ['TRANSCREVER', 'EXTRAIR', 'LIMPAR_RETENCAO'];
const DIA_MS = 24 * 60 * 60 * 1000;

/**
 * @typedef {object} Deps
 * @property {import('../nucleo/sqlite/banco.js').Banco} banco
 * @property {ReturnType<import('../nucleo/armazenamento-disco.js').criarArmazenamentoDisco>} armazenamento
 * @property {(audio: Buffer, nomeArquivo: string) => Promise<string>} transcrever
 * @property {ReturnType<import('./extrator.js').criarExtrator>} extrair
 * @property {((canalTextoId: string, mensagem: string) => Promise<void>) | null} [notificar]
 * @property {string} [workerId]
 * @property {{ maxTentativas?: number, reservaMin?: number, concorrencia?: number, juntarAteMs?: number,
 *              retencaoTranscricaoDias?: number, retencaoAudioParadoDias?: number }} [opcoes]
 * @property {(msg: string) => void} [log]
 * @property {() => Date} [agora]
 */

/**
 * Executa o próximo job da fila, se houver.
 * @param {Deps} deps
 * @returns {Promise<null | { job: object, ok: boolean, resultado?: any, erro?: string, statusJob?: string }>}
 */
export async function executarProximo(deps) {
  const { banco, opcoes = {}, log = () => {}, workerId = 'worker', agora = () => new Date() } = deps;
  const job = await banco.reservarProximo(TIPOS, workerId, opcoes.reservaMin ?? 10);
  if (!job) return null;

  const rotulo = `job ${job.id} ${job.tipo}${job.dailyId ? ` daily ${job.dailyId}` : ''}`;
  log(`▶ ${rotulo} (tentativa ${job.tentativas})`);
  try {
    const resultado = await processarJob(job, deps);
    await banco.concluir(job.id);
    log(`✔ ${rotulo}: ${JSON.stringify(resultado)}`);
    if (job.tipo === 'LIMPAR_RETENCAO') await banco.enfileirarSeAusente('LIMPAR_RETENCAO', new Date(agora().getTime() + DIA_MS));
    return { job, ok: true, resultado };
  } catch (e) {
    const erro = e?.message ?? String(e);
    const statusJob = await banco.falhar(job.id, erro, opcoes.maxTentativas ?? 5);
    log(`✖ ${rotulo}: ${erro}${statusJob === 'FALHOU' ? ' — desisti' : ' — vou tentar de novo'}`);
    if (statusJob === 'FALHOU' && job.dailyId) {
      await banco.definirStatus(job.dailyId, 'ERRO', erro);
      await avisar(deps, job.dailyId);
    }
    return { job, ok: false, erro, statusJob };
  }
}

/** @param {{ tipo: string, dailyId: number | null }} job  @param {Deps} deps */
export async function processarJob(job, deps) {
  const { banco, armazenamento, opcoes = {}, log = () => {} } = deps;
  switch (job.tipo) {
    case 'TRANSCREVER':
      return transcreverDaily({
        banco,
        armazenamento,
        transcrever: deps.transcrever,
        dailyId: job.dailyId,
        concorrencia: opcoes.concorrencia,
        juntarAteMs: opcoes.juntarAteMs,
        log,
      });
    case 'EXTRAIR': {
      const r = await extrairResumoDaDaily({ banco, extrair: deps.extrair, dailyId: job.dailyId, log });
      if (!r.pulada) await avisar(deps, job.dailyId);
      return r;
    }
    case 'LIMPAR_RETENCAO':
      return limparRetencao({
        banco,
        armazenamento,
        retencaoTranscricaoDias: opcoes.retencaoTranscricaoDias ?? 180,
        retencaoAudioParadoDias: opcoes.retencaoAudioParadoDias ?? 7,
        agora: deps.agora,
      });
    default:
      throw new Error(`Tipo de job desconhecido: ${job.tipo}`);
  }
}

/** Posta o resumo (ou o erro) no canal de texto do time. Falhar aqui não derruba o job. */
async function avisar({ banco, notificar, log = () => {} }, dailyId) {
  if (!notificar) return;
  try {
    const visao = await banco.visaoDaily(dailyId);
    const canal = (await banco.obterDaily(dailyId)).time.canalTextoId;
    if (!canal) return log(`  (time sem canal de texto; resumo da daily ${dailyId} não foi postado)`);
    await notificar(canal, resumoEmTexto(visao));
  } catch (e) {
    log(`  ⚠ não consegui postar no Discord: ${e?.message ?? e}`);
  }
}
