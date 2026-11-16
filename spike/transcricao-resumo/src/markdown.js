// Renderiza o resumo validado em Markdown — uma prévia do que o gestor verá no dashboard.
import { formatarTempo } from './prompt.js';

/**
 * @param {object} o
 * @param {any} o.resumo  saída de validarResumo().resumo
 * @param {import('./tipos.js').Transcricao} o.transcricao
 * @param {import('./tipos.js').BloqueioAberto[]} [o.bloqueiosAbertos]
 * @param {string[]} [o.avisos]
 * @param {any} [o.meta]
 */
export function resumoParaMarkdown({ resumo, transcricao, bloqueiosAbertos = [], avisos = [], meta }) {
  const nome = new Map(transcricao.participantes.map((p) => [p.id, p.nome]));
  const fala = new Map(transcricao.falas.map((f) => [f.id, f]));
  const bloqueio = new Map(bloqueiosAbertos.map((b) => [b.id, b]));
  const refs = (ids) => ids.map((id) => `F${id} ${formatarTempo(fala.get(id)?.inicioMs ?? 0)}`).join(', ');
  const item = (i) => `- ${i.descricao} <sub>(${refs(i.fala_ids)})</sub>`;
  const lista = (titulo, itens, fmt = item) => (itens.length ? [`**${titulo}**`, ...itens.map(fmt), ''] : []);

  const [a, m, d] = transcricao.daily.data.split('-');
  const linhas = [
    `# Daily — ${d}/${m}/${a}${transcricao.daily.time ? ` · ${transcricao.daily.time}` : ''}`,
    '',
    resumo.resumo_geral,
    '',
    '## Por pessoa',
    '',
  ];

  for (const p of resumo.participantes) {
    linhas.push(`### ${nome.get(p.participante_id)}`, '');
    linhas.push(...lista('Fez', p.fez));
    linhas.push(...lista('Vai fazer', p.vai_fazer));
    linhas.push(
      ...lista('Bloqueios', p.bloqueios, (b) => {
        const existente = b.bloqueio_existente_id && bloqueio.get(b.bloqueio_existente_id);
        const marca = existente ? ` ⏳ _em aberto desde ${existente.desde}_` : ' 🆕';
        return `${item(b)}${marca}`;
      }),
    );
    if (!p.fez.length && !p.vai_fazer.length && !p.bloqueios.length) linhas.push('_Nada reportado._', '');
  }

  const silenciosos = transcricao.participantes.filter((p) => !resumo.participantes.some((r) => r.participante_id === p.id));
  if (silenciosos.length) linhas.push(`_Presentes sem atualização: ${silenciosos.map((p) => p.nome).join(', ')}._`, '');

  if (resumo.decisoes.length) linhas.push('## Decisões', '', ...resumo.decisoes.map(item), '');
  if (resumo.pendencias.length) {
    linhas.push(
      '## Pendências',
      '',
      ...resumo.pendencias.map((p) => {
        const dono = p.responsavel_id ? nome.get(p.responsavel_id) : '_sem responsável_';
        return `- ${p.descricao} — ${dono}${p.prazo ? ` · ${p.prazo}` : ''} <sub>(${refs(p.fala_ids)})</sub>`;
      }),
      '',
    );
  }
  if (resumo.bloqueios_resolvidos.length) {
    linhas.push(
      '## Bloqueios resolvidos',
      '',
      ...resumo.bloqueios_resolvidos.map((b) => `- ✅ ${bloqueio.get(b.bloqueio_id)?.descricao ?? `#${b.bloqueio_id}`} <sub>(${refs(b.fala_ids)})</sub>`),
      '',
    );
  }
  if (avisos.length) linhas.push('## Avisos da validação', '', ...avisos.map((a) => `- ${a}`), '');
  if (meta) {
    linhas.push('---', `<sub>${meta.modelo} · effort ${meta.effort} · prompt ${meta.versaoPrompt} · ${meta.tokensEntrada} tokens de entrada / ${meta.tokensSaida} de saída</sub>`, '');
  }
  return linhas.join('\n');
}
