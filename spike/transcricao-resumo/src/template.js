// Renderizador mínimo no estilo Mustache, suficiente para prompts/extracao-daily.md:
//   {{var}}                    valor (chave do item atual ou do contexto raiz)
//   {{#lista}}...{{/lista}}    repete para cada item da lista
//   {{^lista}}...{{/lista}}    renderiza se a lista estiver vazia/ausente
// Sem escape de HTML (o destino é texto para o LLM).

export function renderizar(template, contexto) {
  return renderizarCom(template, [contexto]);
}

function renderizarCom(template, pilha) {
  const secao = /\{\{([#^])(\w+)\}\}\n?([\s\S]*?)\{\{\/\2\}\}\n?/g;
  const comSecoes = template.replace(secao, (_, tipo, nome, corpo) => {
    const valor = buscar(nome, pilha);
    const lista = Array.isArray(valor) ? valor : valor ? [valor] : [];
    if (tipo === '^') return lista.length === 0 ? renderizarCom(corpo, pilha) : '';
    return lista.map((item) => renderizarCom(corpo, [item, ...pilha])).join('');
  });
  return comSecoes.replace(/\{\{(\w+)\}\}/g, (_, nome) => {
    const v = buscar(nome, pilha);
    return v === undefined || v === null ? '' : String(v);
  });
}

function buscar(nome, pilha) {
  for (const ctx of pilha) if (ctx && typeof ctx === 'object' && nome in ctx) return ctx[nome];
  return undefined;
}
