// Adaptador para APIs no formato OpenAI (Groq, Gemini, Ollama...). Sem rede: fetch simulado.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { criarExtratorOpenAI } from '../worker/extrator-openai.js';
import { normalizarResumo } from '../worker/normalizar.js';
import { ErroExtracao } from '../worker/extrator.js';
import { limparTexto } from '../worker/transcritor.js';

const entrada = {
  time: { id: 1, nome: 'Squad' },
  data: '2026-11-16',
  participantes: [{ id: 7, nome: 'Ana' }, { id: 9, nome: 'Bruno' }],
  bloqueiosAbertos: [{ id: 15, participanteId: 9, desde: '2026-11-12', descricao: 'Sem acesso' }],
  falas: [
    { id: 101, participanteId: 7, inicioMs: 1000, texto: 'Terminei a tela.' },
    { id: 102, participanteId: 9, inicioMs: 5000, texto: 'Continuo sem acesso.' },
  ],
};
const bom = {
  resumo_geral: 'Resumo.',
  participantes: [
    { participante_id: 7, fez: [{ descricao: 'Terminou a tela', fala_ids: [101] }], vai_fazer: [], bloqueios: [] },
    { participante_id: 9, fez: [], vai_fazer: [], bloqueios: [{ descricao: 'Sem acesso', bloqueio_existente_id: 15, fala_ids: [102] }] },
  ],
  decisoes: [], pendencias: [], bloqueios_resolvidos: [],
};
const resposta = (conteudo, extra = {}) => ({
  ok: true,
  json: async () => ({ model: 'modelo-x', choices: [{ finish_reason: 'stop', message: { content: conteudo } }], usage: { prompt_tokens: 10, completion_tokens: 5 }, ...extra }),
});
const erro = (status, texto = '') => ({ ok: false, status, text: async () => texto });

test('formato OpenAI: envia prompt + schema, pede json_schema e valida a resposta', async () => {
  const pedidos = [];
  const extrair = criarExtratorOpenAI({
    url: 'https://api.exemplo.com/v1/',
    apiKey: 'k',
    modelo: 'modelo-x',
    fetch: async (url, init) => (pedidos.push({ url, init, corpo: JSON.parse(init.body) }), resposta(JSON.stringify(bom))),
  });
  const r = await extrair(entrada);

  assert.equal(pedidos[0].url, 'https://api.exemplo.com/v1/chat/completions');
  assert.equal(pedidos[0].init.headers.Authorization, 'Bearer k');
  const { corpo } = pedidos[0];
  assert.equal(corpo.model, 'modelo-x');
  assert.equal(corpo.response_format.type, 'json_schema');
  assert.equal(corpo.response_format.json_schema.schema.type, 'object');
  assert.match(corpo.messages[0].content, /Não avalie pessoas/);
  assert.match(corpo.messages[0].content, /"bloqueios_resolvidos"/, 'schema também vai no prompt');
  assert.match(corpo.messages[1].content, /\[F101 \| 00:01 \| Ana\] Terminei a tela\./);

  assert.deepEqual(r.resumo, bom);
  assert.deepEqual(r.avisos, []);
  assert.deepEqual(r.meta, { modelo: 'modelo-x', versaoPrompt: 'extracao-v1', tokensEntrada: 10, tokensSaida: 5 });
});

test('formato OpenAI: sem suporte a json_schema cai para json_object; resposta solta é normalizada', async () => {
  const formatos = [];
  const solto = {
    resumo_geral: 'Resumo.',
    participantes: [
      // ids como texto, "F101", campo faltando, item sem descrição e fala inventada
      { participante_id: '7', fez: [{ descricao: 'Terminou a tela', fala_ids: ['F101'] }, { fala_ids: [101] }, { descricao: 'Inventado', fala_ids: [999] }] },
      { participante_id: 'x', fez: [{ descricao: 'Pessoa inválida', fala_ids: [101] }] },
    ],
    pendencias: [{ descricao: 'Pedir acesso', responsavel_id: '9', prazo: '', fala_ids: ['102'] }],
  };
  const extrair = criarExtratorOpenAI({
    url: 'http://localhost:11434/v1',
    modelo: 'm',
    fetch: async (_, init) => {
      const corpo = JSON.parse(init.body);
      formatos.push(corpo.response_format.type);
      assert.equal(init.headers.Authorization, undefined, 'sem chave para servidor local');
      return corpo.response_format.type === 'json_schema' ? erro(400, 'json_schema not supported') : resposta('```json\n' + JSON.stringify(solto) + '\n```');
    },
  });
  const r = await extrair(entrada);
  assert.deepEqual(formatos, ['json_schema', 'json_object']);
  assert.deepEqual(r.resumo.participantes, [
    { participante_id: 7, fez: [{ descricao: 'Terminou a tela', fala_ids: [101] }], vai_fazer: [], bloqueios: [] },
  ]);
  assert.deepEqual(r.resumo.pendencias, [{ descricao: 'Pedir acesso', responsavel_id: 9, prazo: null, fala_ids: [102] }]);
  assert.deepEqual(r.resumo.decisoes, []);
  assert.ok(r.avisos.some((a) => /Inventado/.test(a)), 'item sem evidência é descartado com aviso');
});

test('formato OpenAI: erros do provedor viram mensagens claras', async () => {
  const com = (r) => criarExtratorOpenAI({ url: 'http://x/v1', apiKey: 'k', modelo: 'm', fetch: async () => r });
  await assert.rejects(com(erro(401))(entrada), /Chave do LLM recusada.*LLM_API_KEY/);
  await assert.rejects(com(erro(404, 'model not found'))(entrada), /confira LLM_URL e LLM_MODELO \("m"\)/);
  await assert.rejects(com(erro(429, 'rate limit'))(entrada), /Limite de uso do LLM atingido/);
  await assert.rejects(com(resposta('isto não é json'))(entrada), /não é JSON válido/);
  await assert.rejects(com(resposta('[1,2]'))(entrada), ErroExtracao);
  await assert.rejects(
    com({ ok: true, json: async () => ({ choices: [{ finish_reason: 'length', message: { content: '{' } }] }) })(entrada),
    /cortada/,
  );
  await assert.rejects(com(resposta('{}'))({ ...entrada, falas: [] }), /não tem falas/);
});

test('normalizarResumo devolve sempre o formato do contrato', () => {
  assert.deepEqual(normalizarResumo({}), { resumo_geral: '', participantes: [], decisoes: [], pendencias: [], bloqueios_resolvidos: [] });
  const r = normalizarResumo({ bloqueios_resolvidos: [{ bloqueio_id: '#15', fala_ids: 'F3' }, { fala_ids: [1] }], decisoes: 'nenhuma' });
  assert.deepEqual(r.bloqueios_resolvidos, [{ bloqueio_id: 15, fala_ids: [] }]);
  assert.deepEqual(r.decisoes, []);
  assert.throws(() => normalizarResumo(null), TypeError);
});

test('limparTexto remove as invenções comuns do Whisper em silêncio, sem mexer em fala real', () => {
  assert.equal(limparTexto('Obrigado.'), '');
  assert.equal(limparTexto(' obrigada por assistir! '), '');
  assert.equal(limparTexto('Legendas pela comunidade Amara.org'), '');
  assert.equal(limparTexto('Obrigado, Ana. Vou revisar o PR hoje.'), 'Obrigado, Ana. Vou revisar o PR hoje.');
});
