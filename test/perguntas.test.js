// Perguntas livres sobre um período: LLM simulado, banco em memória.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { abrirBanco } from '../nucleo/sqlite/banco.js';
import { criarRespondedor } from '../api/perguntas.js';
import { criarLlm, ErroLlm } from '../nucleo/llm.js';
import { rotear } from '../api/rotas.js';

async function cenario(t) {
  let agora = new Date('2026-11-10T12:30:00Z');
  const banco = abrirBanco(':memory:', { agora: () => agora });
  t.after(() => banco.fechar());
  const time = await banco.obterOuCriarTime({ guildId: 'g', canalVozId: 'v', nome: 'Squad' });
  const ana = await banco.obterOuCriarParticipante({ discordUserId: 'a', nome: 'Ana' });
  const bruno = await banco.obterOuCriarParticipante({ discordUserId: 'b', nome: 'Bruno' });
  const ids = {};
  for (const [dia, falas] of [
    ['10', [[ana, 'Terminei a tela de extrato.'], [bruno, 'Estou sem acesso à homologação.']]],
    ['12', [[bruno, 'Sigo sem acesso à homologação.']]],
    ['14', [[ana, 'Vou começar os testes.'], [bruno, 'Liberaram meu acesso.']]],
  ]) {
    agora = new Date(`2026-11-${dia}T12:30:00Z`);
    const d = await banco.criarDaily({ timeId: time.id });
    await banco.salvarTranscricao({ dailyId: d.id, falas: falas.map(([p, texto], i) => ({ participanteId: p.id, inicioMs: i * 5000, fimMs: i * 5000 + 3000, texto })), segmentos: [] });
    ids[dia] = (await banco.transcricao(d.id)).map((f) => f.id);
  }
  return { banco, time, ana, bruno, ids };
}

test('pergunta: envia as transcrições do período e devolve a resposta com citações conferidas', async (t) => {
  const { banco, time, bruno, ids } = await cenario(t);
  const pedidos = [];
  const responder = criarRespondedor({
    banco,
    gerarJson: async (p) => (pedidos.push(p), { json: { resposta: ' Bruno ficou sem acesso até o dia 14. ', fala_ids: [ids['10'][1], `F${ids['14'][1]}`, 9999, ids['10'][1]] }, modelo: 'modelo-x' }),
  });

  const r = await responder({ pergunta: 'Quando o Bruno teve acesso à homologação?', timeId: time.id, de: '2026-11-01', ate: '2026-11-30' });
  assert.equal(r.resposta, 'Bruno ficou sem acesso até o dia 14.');
  assert.deepEqual(r.citacoes.map((c) => [c.data, c.participante.nome, c.texto]), [
    ['2026-11-10', 'Bruno', 'Estou sem acesso à homologação.'],
    ['2026-11-14', 'Bruno', 'Liberaram meu acesso.'],
  ], 'ids inexistentes e repetidos são descartados; "F12" vale como 12');
  assert.deepEqual({ d: r.dailiesConsideradas, cortado: r.periodoCortado, modelo: r.modelo, v: r.versaoPrompt }, { d: 3, cortado: false, modelo: 'modelo-x', v: 'perguntas-v1' });

  const [p] = pedidos;
  assert.match(p.system, /Não avalie pessoas/);
  assert.match(p.usuario, /^Período: 2026-11-10 a 2026-11-14/);
  assert.match(p.usuario, new RegExp(`## Daily de 2026-11-12 \\(id \\d+\\)\\n\\[F${ids['12'][0]} \\| 00:00 \\| Bruno\\] Sigo sem acesso`));
  assert.match(p.usuario, /Pergunta do gestor: Quando o Bruno teve acesso à homologação\?$/);
  assert.deepEqual(p.schema.required, ['resposta', 'fala_ids']);

  // filtros: período e pessoa
  await responder({ pergunta: 'O que o Bruno disse?', timeId: time.id, de: '2026-11-11', ate: '2026-11-13', participanteId: bruno.id });
  assert.match(pedidos[1].usuario, /^Período: 2026-11-12 a 2026-11-12/);
  assert.doesNotMatch(pedidos[1].usuario, /Ana/);
});

test('pergunta: período grande fica só com as dailies mais recentes; período vazio não chama o LLM', async (t) => {
  const { banco, time } = await cenario(t);
  let chamadas = 0;
  let usuario;
  const responder = criarRespondedor({ banco, maxCaracteres: 120, gerarJson: async (p) => (chamadas++, (usuario = p.usuario), { json: { resposta: 'ok', fala_ids: [] }, modelo: 'm' }) });

  const r = await responder({ pergunta: 'O que aconteceu?', timeId: time.id });
  assert.deepEqual({ d: r.dailiesConsideradas, cortado: r.periodoCortado }, { d: 1, cortado: true });
  assert.match(usuario, /^Período: 2026-11-14 a 2026-11-14/);
  assert.doesNotMatch(usuario, /2026-11-10/);

  const vazio = await responder({ pergunta: 'O que aconteceu?', timeId: time.id, de: '2027-01-01' });
  assert.match(vazio.resposta, /Não há transcrições/);
  assert.equal(chamadas, 1);

  await assert.rejects(responder({ pergunta: 'oi', timeId: time.id }), /pelo menos 5 caracteres/);
  await assert.rejects(responder({ pergunta: 'x'.repeat(501), timeId: time.id }), /no máximo 500/);
});

test('POST /perguntas: validação, erro do LLM e servidor sem LLM configurado', async (t) => {
  const { banco, time } = await cenario(t);
  const post = (corpo, servicos) => rotear(banco, { metodo: 'POST', caminho: '/perguntas', corpo }, servicos);
  const ok = { responder: criarRespondedor({ banco, gerarJson: async () => ({ json: { resposta: 'Resposta.', fala_ids: [] }, modelo: 'm' }) }) };

  const r = await post({ pergunta: 'O que ficou pendente?', timeId: time.id }, ok);
  assert.equal(r.status, 200);
  assert.equal(r.corpo.resposta, 'Resposta.');

  assert.equal((await post({ pergunta: 'O que ficou pendente?' }, ok)).status, 400, 'timeId é obrigatório');
  assert.equal((await post({ pergunta: 'oi', timeId: time.id }, ok)).corpo.erro.codigo, 'PARAMETRO_INVALIDO');
  assert.equal((await post({ pergunta: 'O que ficou pendente?', timeId: time.id, de: '10/11' }, ok)).status, 400);

  const fora = { responder: criarRespondedor({ banco, gerarJson: async () => { throw new ErroLlm('Limite de uso do LLM atingido.'); } }) };
  assert.deepEqual(await post({ pergunta: 'O que ficou pendente?', timeId: time.id }, fora), {
    status: 502,
    corpo: { erro: { codigo: 'LLM_INDISPONIVEL', mensagem: 'Limite de uso do LLM atingido.' } },
  });
  assert.equal((await post({ pergunta: 'O que ficou pendente?', timeId: time.id }, {})).status, 503);
});

test('criarLlm (formato OpenAI): json_schema com queda para json_object e erros claros', async () => {
  const cfg = { provedor: 'openai', url: 'http://x/v1', apiKey: 'k', modelo: 'm' };
  const formatos = [];
  const gerar = criarLlm(cfg, {
    fetch: async (url, init) => {
      const corpo = JSON.parse(init.body);
      formatos.push(corpo.response_format.type);
      assert.equal(url, 'http://x/v1/chat/completions');
      assert.match(corpo.messages[0].content, /REGRAS[\s\S]*JSON Schema/);
      if (corpo.response_format.type === 'json_schema') return { ok: false, status: 400, text: async () => 'unsupported' };
      return { ok: true, json: async () => ({ model: 'm-real', choices: [{ finish_reason: 'stop', message: { content: '```json\n{"resposta":"oi","fala_ids":[]}\n```' } }] }) };
    },
  });
  assert.deepEqual(await gerar({ system: 'REGRAS', usuario: 'u', schema: { type: 'object' }, nome: 'n' }), { json: { resposta: 'oi', fala_ids: [] }, modelo: 'm-real' });
  assert.deepEqual(formatos, ['json_schema', 'json_object']);

  const com = (r) => criarLlm(cfg, { fetch: async () => r })({ system: 's', usuario: 'u', schema: {}, nome: 'n' });
  await assert.rejects(com({ ok: false, status: 401, text: async () => '' }), /Chave do LLM recusada/);
  await assert.rejects(com({ ok: false, status: 429, text: async () => '' }), /Limite de uso/);
  await assert.rejects(com({ ok: true, json: async () => ({ choices: [{ message: { content: 'não é json' } }] }) }), ErroLlm);
  assert.throws(() => criarLlm({ provedor: 'openai', url: '' }), /LLM_URL/);
  assert.throws(() => criarLlm({ provedor: 'outro' }), /desconhecido/);
});
