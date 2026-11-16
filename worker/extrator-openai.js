// Adaptador da porta ExtratorDeResumo para qualquer API no formato OpenAI /chat/completions
// (Groq, Gemini, OpenRouter, Ollama local...). Mesmo prompt e mesma validação do adaptador do Claude.
import { carregarPrompt, carregarSchema, montarMensagemUsuario } from './prompt.js';
import { validarResumo } from './validar.js';
import { normalizarResumo } from './normalizar.js';
import { ErroExtracao } from './extrator.js';

/**
 * @param {object} o
 * @param {string} o.url      ex.: https://api.groq.com/openai/v1  ou  http://localhost:11434/v1
 * @param {string} [o.apiKey]
 * @param {string} o.modelo
 * @param {typeof fetch} [o.fetch]
 * @returns {ReturnType<import('./extrator.js').criarExtrator>}
 */
export function criarExtratorOpenAI({ url, apiKey, modelo, fetch: f = fetch }) {
  const endpoint = `${url.replace(/\/$/, '')}/chat/completions`;

  async function chamar(corpo) {
    const r = await f(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(apiKey && { Authorization: `Bearer ${apiKey}` }) },
      body: JSON.stringify(corpo),
    });
    if (r.ok) return { ok: true, json: await r.json() };
    return { ok: false, status: r.status, texto: (await r.text().catch(() => '')).slice(0, 400) };
  }

  return async function extrair(entrada) {
    if (entrada.falas.length === 0) throw new ErroExtracao('A transcrição não tem falas.');

    const [prompt, schema] = await Promise.all([carregarPrompt(), carregarSchema()]);
    const system =
      `${prompt.system}\n\nResponda somente com um objeto JSON, sem texto antes ou depois, que siga este JSON Schema:\n` +
      JSON.stringify(schema);
    const base = {
      model: modelo,
      temperature: 0,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: montarMensagemUsuario(prompt.templateUsuario, entrada) },
      ],
    };

    // Tenta saída estruturada pelo schema; provedores/modelos que não suportam caem para JSON livre.
    let r = await chamar({ ...base, response_format: { type: 'json_schema', json_schema: { name: 'resumo_daily', strict: true, schema } } });
    if (!r.ok && r.status === 400) r = await chamar({ ...base, response_format: { type: 'json_object' } });
    if (!r.ok) {
      if (r.status === 401 || r.status === 403) throw new ErroExtracao(`Chave do LLM recusada (${r.status}). Confira LLM_API_KEY no .env.`);
      if (r.status === 404) throw new ErroExtracao(`LLM não encontrado (404): confira LLM_URL e LLM_MODELO ("${modelo}"). ${r.texto}`);
      if (r.status === 429) throw new ErroExtracao(`Limite de uso do LLM atingido (429); o job tenta de novo mais tarde. ${r.texto}`);
      throw new ErroExtracao(`LLM falhou (${r.status}): ${r.texto}`);
    }

    const escolha = r.json.choices?.[0];
    if (escolha?.message?.refusal) throw new ErroExtracao(`O modelo recusou a extração: ${escolha.message.refusal}`);
    if (escolha?.finish_reason === 'length') throw new ErroExtracao('Resposta cortada pelo limite de tokens do modelo.');

    const texto = (escolha?.message?.content ?? '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
    let bruto;
    try {
      bruto = JSON.parse(texto);
    } catch {
      throw new ErroExtracao(`Resposta não é JSON válido: ${texto.slice(0, 300)}`);
    }
    let normalizado;
    try {
      normalizado = normalizarResumo(bruto);
    } catch (e) {
      throw new ErroExtracao(e.message);
    }

    const { resumo, avisos } = validarResumo(normalizado, entrada, entrada.bloqueiosAbertos);
    return {
      resumo,
      avisos,
      bruto,
      meta: {
        modelo: String(r.json.model ?? modelo).slice(0, 64),
        versaoPrompt: prompt.versao,
        tokensEntrada: r.json.usage?.prompt_tokens,
        tokensSaida: r.json.usage?.completion_tokens,
      },
    };
  };
}
