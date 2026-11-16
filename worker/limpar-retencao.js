// Caso de uso LimparRetencao (LGPD): remove transcrições além do prazo e áudios que sobraram.
import { dataLocal } from '../nucleo/tempo.js';

const DIA_MS = 24 * 60 * 60 * 1000;

/**
 * @param {object} o
 * @param {import('../nucleo/sqlite/banco.js').Banco} o.banco
 * @param {ReturnType<import('../nucleo/armazenamento-disco.js').criarArmazenamentoDisco>} o.armazenamento
 * @param {number} o.retencaoTranscricaoDias
 * @param {number} o.retencaoAudioParadoDias  áudio de dailies paradas (ERRO) é guardado só por este prazo
 * @param {() => Date} [o.agora]
 */
export async function limparRetencao({ banco, armazenamento, retencaoTranscricaoDias, retencaoAudioParadoDias, agora = () => new Date() }) {
  const hoje = agora().getTime();
  const { falas } = await banco.apagarTranscricoesAntigas(dataLocal(hoje - retencaoTranscricaoDias * DIA_MS, 'UTC'));

  const orfaos = await banco.audiosOrfaos({ paradasAntesDe: new Date(hoje - retencaoAudioParadoDias * DIA_MS) });
  for (const s of orfaos) await armazenamento.apagar(s.caminho);
  await banco.marcarAudioApagado(orfaos.map((s) => s.id));

  return { falasApagadas: falas, audiosApagados: orfaos.length };
}
