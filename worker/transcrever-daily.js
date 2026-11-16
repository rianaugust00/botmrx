// Caso de uso TranscreverDaily (M4): SegmentosAudio → Falas, apaga o áudio e enfileira EXTRAIR.

const ETAPA = new Set(['AGUARDANDO_TRANSCRICAO', 'TRANSCREVENDO']);

/**
 * Idempotente: se a daily já passou desta etapa, só termina de apagar o áudio.
 * @param {object} o
 * @param {import('../nucleo/sqlite/banco.js').Banco} o.banco
 * @param {ReturnType<import('../nucleo/armazenamento-disco.js').criarArmazenamentoDisco>} o.armazenamento
 * @param {(audio: Buffer, nomeArquivo: string) => Promise<string>} o.transcrever
 * @param {number} o.dailyId
 * @param {number} [o.concorrencia]
 * @param {number} [o.juntarAteMs] junta trechos seguidos da mesma pessoa com intervalo menor que isso
 * @param {(msg: string) => void} [o.log]
 */
export async function transcreverDaily({ banco, armazenamento, transcrever, dailyId, concorrencia = 4, juntarAteMs = 1500, log = () => {} }) {
  const daily = await banco.obterDaily(dailyId);
  if (!daily) throw new Error(`Daily ${dailyId} não existe.`);

  let resultado = { pulada: true, falas: 0, segmentos: 0, descartados: 0 };
  if (ETAPA.has(daily.status)) {
    await banco.definirStatus(dailyId, 'TRANSCREVENDO');
    const segmentos = await banco.segmentosDaDaily(dailyId, { status: 'PENDENTE' });

    let feitos = 0;
    const textos = await mapComLimite(segmentos, concorrencia, async (s) => {
      const audio = await armazenamento.ler(s.caminho);
      const texto = await transcrever(audio, `${s.id}.${s.formato}`);
      log(`  [${++feitos}/${segmentos.length}] ${s.nome}: ${texto || '(vazio)'}`);
      return texto;
    });

    const trechos = segmentos
      .map((s, i) => ({ participanteId: s.participanteId, inicioMs: s.inicioMs, fimMs: s.fimMs, texto: textos[i] }))
      .filter((t) => t.texto);
    const falas = juntarTrechos(trechos, juntarAteMs);

    await banco.salvarTranscricao({
      dailyId,
      falas,
      segmentos: segmentos.map((s, i) => ({ id: s.id, status: textos[i] ? 'TRANSCRITO' : 'DESCARTADO' })),
    });
    resultado = { pulada: false, falas: falas.length, segmentos: segmentos.length, descartados: segmentos.length - trechos.length };
  }

  // Minimização (D5): o áudio só existe até a transcrição dar certo.
  const comAudio = (await banco.segmentosDaDaily(dailyId, { comAudio: true })).filter((s) => s.status !== 'PENDENTE');
  for (const s of comAudio) await armazenamento.apagar(s.caminho);
  await banco.marcarAudioApagado(comAudio.map((s) => s.id));

  return { ...resultado, audiosApagados: comAudio.length };
}

/**
 * Junta trechos consecutivos da mesma pessoa quando ninguém falou no meio e o intervalo é curto.
 * Entrada ordenada por inicioMs.
 */
export function juntarTrechos(trechos, juntarAteMs) {
  const falas = [];
  for (const t of trechos) {
    const ultima = falas.at(-1);
    if (ultima && ultima.participanteId === t.participanteId && t.inicioMs - ultima.fimMs <= juntarAteMs) {
      ultima.texto += ' ' + t.texto;
      ultima.fimMs = Math.max(ultima.fimMs, t.fimMs);
    } else {
      falas.push({ ...t });
    }
  }
  return falas;
}

async function mapComLimite(itens, limite, fn) {
  const resultados = new Array(itens.length);
  let proximo = 0;
  const trabalhador = async () => {
    while (proximo < itens.length) {
      const i = proximo++;
      resultados[i] = await fn(itens[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limite, itens.length) }, trabalhador));
  return resultados;
}
