// Porta "Transcritor" com um adaptador para o endpoint /audio/transcriptions no formato
// OpenAI. O mesmo formato é aceito por serviços na nuvem e por servidores Whisper locais
// (ex.: faster-whisper com API compatível), então trocar de provedor é só trocar a URL.

const ALUCINACOES = [
  /legendas? pela comunidade amara\.org/i,
  /inscreva-se no canal/i,
  /^\s*\[?(m[uú]sica|sil[eê]ncio|aplausos)\]?\s*$/i,
];

/** Remove textos que o Whisper costuma "inventar" em trechos de silêncio/ruído. */
export function limparTexto(texto) {
  const t = (texto ?? '').trim();
  if (!t || ALUCINACOES.some((r) => r.test(t))) return '';
  return t;
}

/**
 * @param {object} o
 * @param {string} o.url          ex.: https://api.openai.com/v1  ou  http://localhost:8000/v1
 * @param {string} [o.apiKey]
 * @param {string} o.modelo
 * @param {string} [o.idioma]
 * @param {string} [o.vocabulario] nomes de sistemas/siglas do time, melhora a grafia
 * @param {typeof fetch} [o.fetch]
 * @returns {(audio: Buffer, nomeArquivo: string) => Promise<string>}
 */
export function criarTranscritor({ url, apiKey, modelo, idioma = 'pt', vocabulario, fetch: f = fetch }) {
  const endpoint = `${url.replace(/\/$/, '')}/audio/transcriptions`;

  return async function transcrever(audio, nomeArquivo) {
    for (let tentativa = 1; ; tentativa++) {
      const form = new FormData();
      form.append('file', new Blob([audio], { type: 'audio/ogg' }), nomeArquivo);
      form.append('model', modelo);
      form.append('language', idioma);
      form.append('response_format', 'json');
      if (vocabulario) form.append('prompt', vocabulario);

      const r = await f(endpoint, {
        method: 'POST',
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        body: form,
      });
      if (r.ok) return limparTexto((await r.json()).text);

      const corpo = await r.text().catch(() => '');
      const temporario = r.status === 429 || r.status >= 500;
      if (!temporario || tentativa >= 4) {
        throw new Error(`Transcrição falhou (${r.status}) para ${nomeArquivo}: ${corpo.slice(0, 300)}`);
      }
      await new Promise((res) => setTimeout(res, 1000 * 2 ** (tentativa - 1)));
    }
  };
}
