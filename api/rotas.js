// API de leitura e administração (M6/M8), no formato de docs/CONTRATOS.md §4.
// `rotear` não conhece HTTP: recebe método/caminho/query/corpo e devolve { status, corpo }.

import { ErroBanco } from '../nucleo/sqlite/banco.js';
import { ErroLlm } from '../nucleo/llm.js';
import { PerguntaInvalida } from './perguntas.js';

export class ErroApi extends Error {
  constructor(status, codigo, mensagem) {
    super(mensagem);
    this.status = status;
    this.codigo = codigo;
  }
}

const DATA = /^\d{4}-\d{2}-\d{2}$/;

function inteiro(valor, nome, { obrigatorio = false } = {}) {
  if (valor === undefined || valor === null || valor === '') {
    if (obrigatorio) throw new ErroApi(400, 'PARAMETRO_INVALIDO', `Informe ${nome}.`);
    return undefined;
  }
  const n = Number(valor);
  if (!Number.isInteger(n) || n <= 0) throw new ErroApi(400, 'PARAMETRO_INVALIDO', `${nome} precisa ser um número inteiro positivo.`);
  return n;
}

function data(valor, nome) {
  if (!valor) return undefined;
  if (!DATA.test(valor)) throw new ErroApi(400, 'PARAMETRO_INVALIDO', `${nome} precisa estar no formato AAAA-MM-DD.`);
  return valor;
}

/** `datas=2026-11-10,2026-11-12` ou `de`/`ate`. */
function periodo(q) {
  const datas = q.datas ? q.datas.split(',').map((d) => data(d.trim(), 'datas')) : undefined;
  return { datas, de: data(q.de, 'de'), ate: data(q.ate, 'ate') };
}

/** Dailies lado a lado, com os cards alinhados por pessoa. `null` = não falou naquela daily. */
export function compararVisoes(visoes) {
  const pessoas = new Map();
  for (const v of visoes) for (const p of v.pessoas) pessoas.set(p.participante.id, p.participante);
  return {
    dailies: visoes.map((v) => ({ id: v.id, data: v.data, status: v.status, resumoGeral: v.resumoGeral })),
    linhas: [...pessoas.values()]
      .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'))
      .map((participante) => ({
        participante,
        porDaily: Object.fromEntries(
          visoes.map((v) => {
            const p = v.pessoas.find((x) => x.participante.id === participante.id);
            return [v.id, p ? { fez: p.fez, vaiFazer: p.vaiFazer, bloqueios: p.bloqueios } : null];
          }),
        ),
      })),
  };
}

/**
 * @param {import('../nucleo/sqlite/banco.js').Banco} banco
 * @param {{ metodo: string, caminho: string, query?: Record<string, string>, corpo?: any }} req
 * @param {{ responder?: ReturnType<import('./perguntas.js').criarRespondedor>, timesPermitidos?: Set<number> | null }} [servicos]
 *   `timesPermitidos`: com login ligado, os times que a pessoa pode ver; null/ausente = sem restrição.
 * @returns {Promise<{ status: number, corpo: any }>}
 */
export async function rotear(banco, { metodo, caminho, query: q = {}, corpo = {} }, servicos = {}) {
  try {
    return { status: 200, corpo: await despachar(banco, metodo, caminho.replace(/\/+$/, '') || '/', q, corpo ?? {}, servicos) };
  } catch (e) {
    if (e instanceof PerguntaInvalida) return { status: 400, corpo: { erro: { codigo: 'PARAMETRO_INVALIDO', mensagem: e.message } } };
    if (e instanceof ErroLlm) return { status: 502, corpo: { erro: { codigo: 'LLM_INDISPONIVEL', mensagem: e.message } } };
    if (e instanceof ErroApi) return { status: e.status, corpo: { erro: { codigo: e.codigo, mensagem: e.message } } };
    if (e instanceof ErroBanco) return { status: 409, corpo: { erro: { codigo: 'OPERACAO_INVALIDA', mensagem: e.message } } };
    throw e;
  }
}

async function despachar(banco, metodo, caminho, q, corpo, servicos) {
  let m;
  const permitidos = servicos.timesPermitidos ?? null;
  const semAcesso = () => new ErroApi(403, 'SEM_ACESSO', 'Você não tem acesso a este time.');
  /** Com login ligado, toda consulta precisa dizer o time, e ele precisa estar entre os permitidos. */
  const time = (valor) => {
    const id = inteiro(valor, 'timeId', { obrigatorio: Boolean(permitidos) });
    if (id !== undefined && permitidos && !permitidos.has(id)) throw semAcesso();
    return id;
  };
  const daily = async (id) => {
    const v = await banco.visaoDaily(inteiro(id, 'id'));
    if (!v) throw new ErroApi(404, 'DAILY_NAO_ENCONTRADA', `Daily ${id} não existe.`);
    if (permitidos && !permitidos.has(v.time.id)) throw semAcesso();
    return v;
  };
  const participante = async (id) => {
    const p = await banco.obterParticipante(inteiro(id, 'id'));
    if (!p) throw new ErroApi(404, 'PARTICIPANTE_NAO_ENCONTRADO', `Participante ${id} não existe.`);
    if (permitidos && !(await banco.participanteNosTimes(p.id, [...permitidos]))) throw semAcesso();
    return p;
  };

  if (metodo === 'GET') {
    if (caminho === '/times') return (await banco.listarTimes()).filter((t) => !permitidos || permitidos.has(t.id));
    if ((m = caminho.match(/^\/times\/(\d+)\/participantes$/))) return banco.participantesDoTime(time(m[1]));
    if (caminho === '/dailies') return banco.dailiesDoPeriodo({ timeId: time(q.timeId), ...periodo(q) });

    if (caminho === '/dailies/comparar') {
      const ids = (q.ids ?? '').split(',').filter(Boolean).map((id) => inteiro(id.trim(), 'ids'));
      if (!ids.length) throw new ErroApi(400, 'PARAMETRO_INVALIDO', 'Informe ids (ex.: ids=40,41,42).');
      if (ids.length > 10) throw new ErroApi(400, 'PARAMETRO_INVALIDO', 'Compare no máximo 10 dailies por vez.');
      return compararVisoes(await Promise.all(ids.map(daily)));
    }
    if ((m = caminho.match(/^\/dailies\/(\d+)$/))) return daily(m[1]);
    if ((m = caminho.match(/^\/dailies\/(\d+)\/transcricao$/))) {
      await daily(m[1]);
      return banco.transcricao(Number(m[1]));
    }
    if ((m = caminho.match(/^\/participantes\/(\d+)\/historico$/))) {
      const p = await participante(m[1]);
      return banco.historicoParticipante(p.id, { timeId: time(q.timeId), ...periodo(q) });
    }
    if ((m = caminho.match(/^\/participantes\/(\d+)$/))) return participante(m[1]);
    if (caminho === '/bloqueios') {
      const status = q.status ? q.status.toUpperCase() : undefined;
      if (status && !['ABERTO', 'RESOLVIDO'].includes(status)) throw new ErroApi(400, 'PARAMETRO_INVALIDO', 'status precisa ser ABERTO ou RESOLVIDO.');
      return banco.listarBloqueios({ timeId: time(q.timeId), status });
    }
    if (caminho === '/busca') {
      if ((q.q ?? '').trim().length < 2) throw new ErroApi(400, 'PARAMETRO_INVALIDO', 'Informe q com pelo menos 2 caracteres.');
      return banco.buscarFalas({
        q: q.q,
        timeId: time(q.timeId),
        participanteId: inteiro(q.participanteId, 'participanteId'),
        de: data(q.de, 'de'),
        ate: data(q.ate, 'ate'),
      });
    }
  }

  if (metodo === 'POST' && caminho === '/perguntas') {
    const pedido = {
      pergunta: corpo.pergunta,
      timeId: time(inteiro(corpo.timeId, 'timeId', { obrigatorio: true })),
      participanteId: inteiro(corpo.participanteId, 'participanteId'),
      de: data(corpo.de, 'de'),
      ate: data(corpo.ate, 'ate'),
    };
    if (!servicos.responder) throw new ErroApi(503, 'PERGUNTAS_INDISPONIVEL', 'Perguntas livres não estão configuradas neste servidor.');
    return servicos.responder(pedido);
  }

  if (metodo === 'POST' && (m = caminho.match(/^\/admin\/dailies\/(\d+)\/reprocessar$/))) {
    await daily(m[1]);
    const etapa = String(corpo.etapa ?? 'EXTRAIR').toUpperCase();
    if (!['EXTRAIR', 'TRANSCREVER'].includes(etapa)) throw new ErroApi(400, 'PARAMETRO_INVALIDO', 'etapa precisa ser EXTRAIR ou TRANSCREVER.');
    return { jobId: await banco.reprocessar(Number(m[1]), etapa), etapa };
  }

  if (metodo === 'PUT' && (m = caminho.match(/^\/admin\/participantes\/(\d+)$/))) {
    await participante(m[1]);
    if (corpo.nome !== undefined && (typeof corpo.nome !== 'string' || !corpo.nome.trim())) throw new ErroApi(400, 'PARAMETRO_INVALIDO', 'nome não pode ser vazio.');
    if (corpo.naoGravar !== undefined && typeof corpo.naoGravar !== 'boolean') throw new ErroApi(400, 'PARAMETRO_INVALIDO', 'naoGravar precisa ser true ou false.');
    return banco.atualizarParticipante(Number(m[1]), { nome: corpo.nome, naoGravar: corpo.naoGravar });
  }

  throw new ErroApi(404, 'ROTA_NAO_ENCONTRADA', `${metodo} ${caminho} não existe.`);
}
