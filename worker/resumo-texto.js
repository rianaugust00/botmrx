// Resumo da daily em Markdown: é o que o bot posta no canal de texto e o que `npm run ver` mostra.
import { dataBr, formatarTempo } from '../nucleo/tempo.js';

/**
 * @param {Awaited<ReturnType<import('../nucleo/sqlite/banco.js').Banco['visaoDaily']>>} visao
 * @param {object} [o]
 * @param {{ id: number, inicioMs: number }[]} [o.falas] se informado, cada item mostra as falas de origem (F12 01:36)
 */
export function resumoEmTexto(visao, { falas } = {}) {
  const inicio = falas && new Map(falas.map((f) => [f.id, f.inicioMs]));
  const refs = (ids) =>
    inicio && ids.length ? ` _(${ids.map((id) => `F${id} ${formatarTempo(inicio.get(id) ?? 0)}`).join(', ')})_` : '';

  const linhas = [`📋 **Daily ${dataBr(visao.data)} · ${visao.time.nome}**`];
  if (visao.status === 'ERRO') linhas.push(`⚠️ Não foi possível processar esta daily: ${visao.erroMensagem ?? 'erro desconhecido'}`);
  if (visao.resumoGeral) linhas.push(visao.resumoGeral);

  for (const p of visao.pessoas) {
    linhas.push('', `**${p.participante.nome}**`);
    for (const i of p.fez) linhas.push(`- ✅ ${i.descricao}${refs(i.falaIds)}`);
    for (const i of p.vaiFazer) linhas.push(`- ▶️ ${i.descricao}${refs(i.falaIds)}`);
    for (const b of p.bloqueios) {
      const marca = b.novo ? '' : ` (em aberto desde ${dataBr(b.desde).slice(0, 5)})`;
      linhas.push(`- ⛔ ${b.descricao}${marca}${refs(b.falaIds)}`);
    }
  }

  if (visao.decisoes.length) {
    linhas.push('', '**Decisões**', ...visao.decisoes.map((i) => `- ${i.descricao}${refs(i.falaIds)}`));
  }
  if (visao.pendencias.length) {
    linhas.push('', '**Pendências**');
    for (const p of visao.pendencias) {
      const dono = p.responsavel ? p.responsavel.nome : 'sem responsável';
      linhas.push(`- ${p.descricao} — ${dono}${p.prazo ? ` · ${p.prazo}` : ''}${refs(p.falaIds)}`);
    }
  }
  if (visao.bloqueiosResolvidos.length) {
    linhas.push('', '**Bloqueios resolvidos**');
    for (const b of visao.bloqueiosResolvidos) linhas.push(`- 🟢 ${b.descricao} (${b.participante.nome})`);
  }

  const comItens = new Set(visao.pessoas.map((p) => p.participante.id));
  const naoGravados = visao.presentes.filter((p) => !p.gravado).map((p) => p.nome);
  const semAtualizacao = visao.presentes.filter((p) => p.gravado && !comItens.has(p.id)).map((p) => p.nome);
  const rodape = [];
  if (semAtualizacao.length && visao.pessoas.length) rodape.push(`_Presentes sem atualização: ${semAtualizacao.join(', ')}._`);
  if (naoGravados.length) rodape.push(`_Presentes, não gravados: ${naoGravados.join(', ')}._`);
  if (rodape.length) linhas.push('', ...rodape);

  return linhas.join('\n');
}

/** Divide um texto em partes de até `limite` caracteres (o Discord aceita 2000), quebrando em linhas. */
export function dividirMensagem(texto, limite = 2000) {
  const partes = [];
  let atual = '';
  for (let linha of texto.split('\n')) {
    while (linha.length > limite) {
      if (atual) partes.push(atual), (atual = '');
      partes.push(linha.slice(0, limite));
      linha = linha.slice(limite);
    }
    if (atual && atual.length + 1 + linha.length > limite) {
      partes.push(atual);
      atual = linha;
    } else {
      atual = atual ? `${atual}\n${linha}` : linha;
    }
  }
  if (atual.trim()) partes.push(atual);
  return partes;
}
