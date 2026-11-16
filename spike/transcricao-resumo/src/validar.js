// Validação pós-LLM (docs/CONTRATOS.md §3): toda referência precisa existir na entrada.
// Itens sem nenhuma fala válida são descartados; o resto é mantido com avisos.

/**
 * @param {any} resumo                JSON devolvido pelo LLM (já no formato do schema)
 * @param {import('./tipos.js').Transcricao} transcricao
 * @param {import('./tipos.js').BloqueioAberto[]} bloqueiosAbertos
 * @returns {{ resumo: any, avisos: string[] }}
 */
export function validarResumo(resumo, transcricao, bloqueiosAbertos = []) {
  const avisos = [];
  const participantes = new Set(transcricao.participantes.map((p) => p.id));
  const falas = new Set(transcricao.falas.map((f) => f.id));
  const bloqueios = new Set(bloqueiosAbertos.map((b) => b.id));

  const filtrarFalas = (item, onde) => {
    const validas = [...new Set(item.fala_ids)].filter((id) => falas.has(id));
    const invalidas = item.fala_ids.filter((id) => !falas.has(id));
    if (invalidas.length) avisos.push(`${onde}: fala(s) inexistente(s) ${invalidas.join(', ')} removida(s)`);
    if (validas.length === 0) {
      avisos.push(`${onde}: item descartado por não ter fala que o sustente — "${item.descricao ?? ''}"`);
      return null;
    }
    return { ...item, fala_ids: validas };
  };
  const filtrarLista = (lista, onde) =>
    lista.map((item, i) => filtrarFalas(item, `${onde}[${i}]`)).filter(Boolean);

  const vistos = new Set();
  const porPessoa = [];
  for (const p of resumo.participantes) {
    if (!participantes.has(p.participante_id)) {
      avisos.push(`participante ${p.participante_id} não existe; bloco descartado`);
      continue;
    }
    if (vistos.has(p.participante_id)) {
      avisos.push(`participante ${p.participante_id} repetido; blocos unidos`);
    }
    vistos.add(p.participante_id);
    const onde = `participante ${p.participante_id}`;
    const bloco = {
      participante_id: p.participante_id,
      fez: filtrarLista(p.fez, `${onde}.fez`),
      vai_fazer: filtrarLista(p.vai_fazer, `${onde}.vai_fazer`),
      bloqueios: filtrarLista(p.bloqueios, `${onde}.bloqueios`).map((b) => {
        if (b.bloqueio_existente_id !== null && !bloqueios.has(b.bloqueio_existente_id)) {
          avisos.push(`${onde}: bloqueio_existente_id ${b.bloqueio_existente_id} inexistente; tratado como novo`);
          return { ...b, bloqueio_existente_id: null };
        }
        return b;
      }),
    };
    const anterior = porPessoa.find((x) => x.participante_id === bloco.participante_id);
    if (anterior) {
      anterior.fez.push(...bloco.fez);
      anterior.vai_fazer.push(...bloco.vai_fazer);
      anterior.bloqueios.push(...bloco.bloqueios);
    } else {
      porPessoa.push(bloco);
    }
  }

  const pendencias = filtrarLista(resumo.pendencias, 'pendencias').map((p, i) => {
    if (p.responsavel_id !== null && !participantes.has(p.responsavel_id)) {
      avisos.push(`pendencias[${i}]: responsável ${p.responsavel_id} inexistente; ficou sem dono`);
      return { ...p, responsavel_id: null };
    }
    return p;
  });

  const bloqueiosResolvidos = resumo.bloqueios_resolvidos.filter((b) => {
    if (bloqueios.has(b.bloqueio_id)) return true;
    avisos.push(`bloqueios_resolvidos: bloqueio ${b.bloqueio_id} não estava em aberto; ignorado`);
    return false;
  });

  return {
    resumo: {
      resumo_geral: resumo.resumo_geral,
      participantes: porPessoa,
      decisoes: filtrarLista(resumo.decisoes, 'decisoes'),
      pendencias,
      bloqueios_resolvidos: bloqueiosResolvidos,
    },
    avisos,
  };
}
