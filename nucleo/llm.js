// Chamada de LLM com resposta em JSON, para os dois provedores configuráveis (LLM_PROVEDOR):
// "anthropic" (SDK do Claude, saída estruturada) e "openai" (qualquer API /chat/completions).

export class ErroLlm extends Error {}

/**
 * @param {object} cfg  config.llm
 * @param {{ fetch?: typeof fetch, anthropic?: any }} [deps]
 * @returns {(p: { system: string, usuario: string, schema: object, nome: string }) => Promise<{ json: any, modelo: string }>}
 */
export function criarLlm(cfg, { fetch: f = fetch, anthropic } = {}) {
  if (cfg.provedor === 'anthropic') return viaAnthropic(cfg, anthropic);
  if (cfg.provedor === 'openai') {
    if (!cfg.url) throw new ErroLlm('LLM_PROVEDOR=openai exige LLM_URL.');
    return viaOpenAI(cfg, f);
  }
  throw new ErroLlm(`LLM_PROVEDOR desconhecido: "${cfg.provedor}" (use anthropic ou openai).`);
}

function interpretar(texto) {
  try {
    return JSON.parse(texto.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch {
    throw new ErroLlm(`O modelo não devolveu JSON válido: ${texto.slice(0, 200)}`);
  }
}

function viaOpenAI({ url, apiKey, modelo }, f) {
  const endpoint = `${url.replace(/\/$/, '')}/chat/completions`;
  const chamar = async (corpo) => {
    const r = await f(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(apiKey && { Authorization: `Bearer ${apiKey}` }) },
      body: JSON.stringify(corpo),
    });
    return r.ok ? { ok: true, json: await r.json() } : { ok: false, status: r.status, texto: (await r.text().catch(() => '')).slice(0, 300) };
  };

  return async function gerarJson({ system, usuario, schema, nome }) {
    const base = {
      model: modelo,
      temperature: 0,
      messages: [
        { role: 'system', content: `${system}\n\nResponda somente com um objeto JSON que siga este JSON Schema:\n${JSON.stringify(schema)}` },
        { role: 'user', content: usuario },
      ],
    };
    let r = await chamar({ ...base, response_format: { type: 'json_schema', json_schema: { name: nome, strict: true, schema } } });
    if (!r.ok && r.status === 400) r = await chamar({ ...base, response_format: { type: 'json_object' } });
    if (!r.ok) {
      if (r.status === 401 || r.status === 403) throw new ErroLlm('Chave do LLM recusada. Confira LLM_API_KEY no .env.');
      if (r.status === 413 || r.status === 429) throw new ErroLlm('Limite de uso do LLM atingido. Tente de novo em instantes ou escolha um período menor.');
      throw new ErroLlm(`O LLM falhou (${r.status}): ${r.texto}`);
    }
    const escolha = r.json.choices?.[0];
    if (escolha?.message?.refusal) throw new ErroLlm(`O modelo recusou a pergunta: ${escolha.message.refusal}`);
    if (escolha?.finish_reason === 'length') throw new ErroLlm('Resposta cortada pelo limite de tokens do modelo.');
    return { json: interpretar(escolha?.message?.content ?? ''), modelo: String(r.json.model ?? modelo) };
  };
}

function viaAnthropic({ modelo, effort, fallback }, cliente) {
  let client = cliente;
  return async function gerarJson({ system, usuario, schema }) {
    client ??= new (await import('@anthropic-ai/sdk')).default();
    const r = await client.beta.messages.create({
      model: modelo,
      max_tokens: 8000,
      system,
      messages: [{ role: 'user', content: usuario }],
      output_config: { effort, format: { type: 'json_schema', schema } },
      ...(fallback && { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }),
    });
    if (r.stop_reason === 'refusal') throw new ErroLlm(`O modelo recusou a pergunta (${r.stop_details?.category ?? 'sem categoria'}).`);
    if (r.stop_reason === 'max_tokens') throw new ErroLlm('Resposta cortada por max_tokens.');
    return { json: interpretar(r.content.filter((b) => b.type === 'text').map((b) => b.text).join('')), modelo: r.model };
  };
}
