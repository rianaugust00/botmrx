// Porta ArmazenamentoDeAudio em disco local: <pasta>/<dailyId>/<participanteId>-<inicioMs>.<formato>
// (docs/CONTRATOS.md §2). O áudio é temporário: o worker apaga depois de transcrever.
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

export function criarArmazenamentoDisco(pasta) {
  const raiz = path.resolve(pasta);
  return {
    raiz,
    caminhoSegmento(dailyId, participanteId, inicioMs, formato = 'ogg') {
      return path.join(raiz, String(dailyId), `${participanteId}-${Math.round(inicioMs)}.${formato}`);
    },
    /** Abre um stream de escrita, criando a pasta da daily. */
    async abrirEscrita(caminho) {
      await mkdir(path.dirname(caminho), { recursive: true });
      return createWriteStream(caminho);
    },
    ler: (caminho) => readFile(caminho),
    /** Apagar um arquivo que já não existe não é erro. */
    apagar: (caminho) => rm(caminho, { force: true }),
    apagarDaily: (dailyId) => rm(path.join(raiz, String(dailyId)), { recursive: true, force: true }),
  };
}
