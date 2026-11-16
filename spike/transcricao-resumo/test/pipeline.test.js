// Testes sem chamar APIs reais: transcritor e Claude são simulados.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderizar } from '../src/template.js';
import { carregarPrompt, carregarSchema, montarMensagemUsuario } from '../src/prompt.js';
import { criarTranscritor, limparTexto } from '../src/transcritor.js';
import { juntarTrechos, transcreverGravacao } from '../src/transcrever.js';
import { validarResumo } from '../src/validar.js';
import { extrairResumo, ErroExtracao } from '../src/extrator.js';
import { resumoParaMarkdown } from '../src/markdown.js';

const aqui = path.dirname(fileURLToPath(import.meta.url));
const exemplo = path.join(aqui, '../exemplo/daily-exemplo');
const lerJson = async (p) => JSON.parse(await readFile(p, 'utf8'));

// ---------- template / prompt ----------

test('renderizar: variáveis, listas e seção invertida', () => {
  const t = 'Olá {{nome}}\n{{#itens}}\n- {{id}} {{nome}}\n{{/itens}}\n{{^vazia}}\n(nenhum)\n{{/vazia}}\nfim';
  const r = renderizar(t, { nome: 'raiz', itens: [{ id: 1, nome: 'a' }, { id: 2 }], vazia: [] });
  assert.equal(r, 'Olá raiz\n- 1 a\n- 2 raiz\n(nenhum)\nfim');
});

test('prompt versionado é lido e a mensagem do usuário segue o formato [F<id> | mm:ss | nome]', async () => {
  const p = await carregarPrompt();
  assert.match(p.versao, /^extracao-v\d+/);
  assert.match(p.system, /Não avalie pessoas/);

  const transcricao = await lerJson(path.join(exemplo, 'falas.json'));
  const bloqueios = await lerJson(path.join(exemplo, 'bloqueios-abertos.json'));
  const msg = montarMensagemUsuario(p.templateUsuario, transcricao, bloqueios);
  assert.match(msg, /^Time: Squad Pagamentos/);
  assert.match(msg, /- 3: Bruno/);
  assert.match(msg, /- 15 \| Bruno \| 2026-11-10 \| Sem acesso/);
  assert.match(msg, /\[F8 \| 01:36 \| Bruno\] O problema continua/);
  assert.doesNotMatch(msg, /\{\{/);
  assert.doesNotMatch(msg, /\(nenhum\)/);

  const semBloqueios = montarMensagemUsuario(p.templateUsuario, transcricao, []);
  assert.match(semBloqueios, /\(nenhum\)/);
});

test('schema enviado à API não tem chaves de metadados e só usa recursos suportados', async () => {
  const s = await carregarSchema();
  assert.equal(s.$schema, undefined);
  assert.equal(s.$id, undefined);
  const texto = JSON.stringify(s);
  assert.doesNotMatch(texto, /"type":\[/, 'tipos nulos devem usar anyOf');
  assert.doesNotMatch(texto, /minLength|maxLength|minimum|maximum/);
});

// ---------- transcrição ----------

test('limparTexto remove alucinações comuns do Whisper', () => {
  assert.equal(limparTexto('Legendas pela comunidade Amara.org'), '');
  assert.equal(limparTexto('  [Música]  '), '');
  assert.equal(limparTexto(' Ontem terminei a tela. '), 'Ontem terminei a tela.');
});

test('criarTranscritor envia multipart no formato OpenAI e repete em 5xx', async () => {
  const chamadas = [];
  const fetchFalso = async (url, init) => {
    chamadas.push({ url, init });
    if (chamadas.length === 1) return new Response('ocupado', { status: 503 });
    return Response.json({ text: ' Bom dia, pessoal. ' });
  };
  const t = criarTranscritor({ url: 'http://local/v1/', apiKey: 'k', modelo: 'whisper-1', vocabulario: 'Pix, Cypress', fetch: fetchFalso });
  const texto = await t(Buffer.from('OggS...'), 'a.ogg');

  assert.equal(texto, 'Bom dia, pessoal.');
  assert.equal(chamadas.length, 2);
  assert.equal(chamadas[1].url, 'http://local/v1/audio/transcriptions');
  assert.equal(chamadas[1].init.headers.Authorization, 'Bearer k');
  const form = chamadas[1].init.body;
  assert.equal(form.get('model'), 'whisper-1');
  assert.equal(form.get('language'), 'pt');
  assert.equal(form.get('prompt'), 'Pix, Cypress');
  assert.equal(form.get('file').name, 'a.ogg');
});

test('criarTranscritor não repete em erro 4xx', async () => {
  let n = 0;
  const t = criarTranscritor({ url: 'http://x/v1', modelo: 'm', fetch: async () => (n++, new Response('chave inválida', { status: 401 })) });
  await assert.rejects(t(Buffer.alloc(1), 'a.ogg'), /401/);
  assert.equal(n, 1);
});

test('juntarTrechos une a mesma pessoa só quando ninguém falou no meio e o intervalo é curto', () => {
  const r = juntarTrechos(
    [
      { participanteId: 1, inicioMs: 0, fimMs: 1000, texto: 'a' },
      { participanteId: 1, inicioMs: 2000, fimMs: 3000, texto: 'b' }, // 1 s depois → junta
      { participanteId: 2, inicioMs: 3500, fimMs: 4000, texto: 'c' },
      { participanteId: 1, inicioMs: 4200, fimMs: 5000, texto: 'd' }, // alguém falou no meio → não junta
      { participanteId: 1, inicioMs: 9000, fimMs: 9500, texto: 'e' }, // 4 s depois → não junta
    ],
    1500,
  );
  assert.deepEqual(r.map((f) => f.texto), ['a b', 'c', 'd', 'e']);
  assert.equal(r[0].fimMs, 3000);
});

test('transcreverGravacao lê o manifest do spike de gravação e gera falas.json', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'botmrx-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, 'u1'));
  await mkdir(path.join(dir, 'u2'));
  const textos = { 'u1/00001000.ogg': 'Bom dia.', 'u1/00003000.ogg': 'Ontem fiz X.', 'u2/00008000.ogg': 'Legendas pela comunidade Amara.org', 'u2/00010000.ogg': 'Hoje faço Y.' };
  for (const arq of Object.keys(textos)) await writeFile(path.join(dir, arq), arq);
  await writeFile(
    path.join(dir, 'manifest.json'),
    JSON.stringify({
      iniciadaEm: '2026-11-14T02:30:00.000Z', // 23:30 do dia 13 em São Paulo
      participantes: { u1: { nome: 'Ana', bot: false, gravado: true }, u2: { nome: 'Bruno', bot: false, gravado: true }, b: { nome: 'Bot', bot: true, gravado: false } },
      segmentos: [
        { userId: 'u2', inicioMs: 10000, fimMs: 12000, duracaoAudioMs: 1000, arquivo: 'u2/00010000.ogg' },
        { userId: 'u1', inicioMs: 1000, fimMs: 3000, duracaoAudioMs: 1500, arquivo: 'u1/00001000.ogg' },
        { userId: 'u1', inicioMs: 3000, fimMs: 6000, duracaoAudioMs: 2000, arquivo: 'u1/00003000.ogg' },
        { userId: 'u2', inicioMs: 8000, fimMs: 9000, duracaoAudioMs: 500, arquivo: 'u2/00008000.ogg' },
      ],
    }),
  );

  const r = await transcreverGravacao({
    pasta: dir,
    transcrever: async (audio) => limparTexto(textos[audio.toString()]),
    time: 'Squad',
  });

  assert.equal(r.daily.data, '2026-11-13');
  assert.deepEqual(r.participantes.map((p) => p.nome), ['Ana', 'Bruno']);
  assert.deepEqual(r.falas, [
    { id: 1, participanteId: 1, inicioMs: 1000, fimMs: 5000, texto: 'Bom dia. Ontem fiz X.' },
    { id: 2, participanteId: 2, inicioMs: 10000, fimMs: 11000, texto: 'Hoje faço Y.' },
  ]);
  assert.deepEqual(r.transcricao, { segmentos: 4, descartados: 1 });
});

// ---------- validação ----------

test('validarResumo descarta itens sem evidência e corrige referências inválidas', async () => {
  const transcricao = await lerJson(path.join(exemplo, 'falas.json'));
  const bloqueios = await lerJson(path.join(exemplo, 'bloqueios-abertos.json'));
  const { resumo, avisos } = validarResumo(
    {
      resumo_geral: 'x',
      participantes: [
        { participante_id: 2, fez: [{ descricao: 'ok', fala_ids: [2, 999] }, { descricao: 'inventado', fala_ids: [999] }], vai_fazer: [], bloqueios: [] },
        { participante_id: 77, fez: [{ descricao: 'fantasma', fala_ids: [1] }], vai_fazer: [], bloqueios: [] },
        { participante_id: 3, fez: [], vai_fazer: [], bloqueios: [{ descricao: 'b', bloqueio_existente_id: 404, fala_ids: [8] }] },
      ],
      decisoes: [],
      pendencias: [{ descricao: 'p', responsavel_id: 88, prazo: null, fala_ids: [9] }],
      bloqueios_resolvidos: [{ bloqueio_id: 16, fala_ids: [14] }, { bloqueio_id: 999, fala_ids: [14] }],
    },
    transcricao,
    bloqueios,
  );

  assert.deepEqual(resumo.participantes.map((p) => p.participante_id), [2, 3]);
  assert.deepEqual(resumo.participantes[0].fez, [{ descricao: 'ok', fala_ids: [2] }]);
  assert.equal(resumo.participantes[1].bloqueios[0].bloqueio_existente_id, null);
  assert.equal(resumo.pendencias[0].responsavel_id, null);
  assert.deepEqual(resumo.bloqueios_resolvidos.map((b) => b.bloqueio_id), [16]);
  assert.equal(avisos.length, 7);
});

// ---------- extração (Claude simulado) ----------

const respostaFalsa = (corpo, extra = {}) => ({
  model: 'claude-opus-5-5',
  stop_reason: 'end_turn',
  usage: { input_tokens: 3000, output_tokens: 900 },
  content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify(corpo) }],
  ...extra,
});

const resumoExemplo = {
  resumo_geral: 'Daily do squad.',
  participantes: [
    { participante_id: 2, fez: [{ descricao: 'Terminou a tela de extrato', fala_ids: [2] }], vai_fazer: [{ descricao: 'Começar a tela de comprovante Pix', fala_ids: [3] }], bloqueios: [] },
    { participante_id: 3, fez: [], vai_fazer: [], bloqueios: [{ descricao: 'Sem acesso à homologação do banco', bloqueio_existente_id: 15, fala_ids: [8] }] },
  ],
  decisoes: [{ descricao: 'Deploy do extrato na quinta', fala_ids: [21] }],
  pendencias: [{ descricao: 'Cobrar acesso com infra', responsavel_id: 1, prazo: 'até o fim do dia', fala_ids: [9] }],
  bloqueios_resolvidos: [{ bloqueio_id: 16, fala_ids: [14] }],
};

test('extrairResumo envia prompt, schema, effort e fallback; valida e devolve metadados', async () => {
  let pedido;
  const client = { beta: { messages: { create: async (p) => ((pedido = p), respostaFalsa(resumoExemplo)) } } };
  const transcricao = await lerJson(path.join(exemplo, 'falas.json'));
  const bloqueios = await lerJson(path.join(exemplo, 'bloqueios-abertos.json'));

  const r = await extrairResumo({ client, transcricao, bloqueiosAbertos: bloqueios });

  assert.equal(pedido.model, 'claude-opus-5-5');
  assert.equal(pedido.output_config.effort, 'medium');
  assert.equal(pedido.output_config.format.type, 'json_schema');
  assert.ok(pedido.output_config.format.schema.properties.participantes);
  assert.deepEqual(pedido.betas, ['server-side-fallback-2026-07-01']);
  assert.equal(pedido.fallbacks, 'default');
  assert.equal(pedido.thinking, undefined);
  assert.match(pedido.system, /Registre apenas o que foi dito/);
  assert.match(pedido.messages[0].content, /\[F21 \| 05:13 \| Diego\]/);

  assert.deepEqual(r.avisos, []);
  assert.equal(r.meta.versaoPrompt, 'extracao-v1');
  assert.equal(r.resumo.participantes.length, 2);

  const md = resumoParaMarkdown({ ...r, transcricao, bloqueiosAbertos: bloqueios });
  assert.match(md, /^# Daily — 13\/11\/2026 · Squad Pagamentos/);
  assert.match(md, /### Ana\n\n\*\*Fez\*\*\n- Terminou a tela de extrato <sub>\(F2 00:08\)<\/sub>/);
  assert.match(md, /em aberto desde 2026-11-10/);
  assert.match(md, /Cobrar acesso com infra — Diego · até o fim do dia/);
  assert.match(md, /✅ Sem massa de testes/);
  assert.match(md, /Presentes sem atualização: Diego, Carla, Eduardo/);
});

test('extrairResumo sem fallback não envia o beta', async () => {
  let pedido;
  const client = { beta: { messages: { create: async (p) => ((pedido = p), respostaFalsa(resumoExemplo)) } } };
  const transcricao = await lerJson(path.join(exemplo, 'falas.json'));
  await extrairResumo({ client, transcricao, fallback: false, modelo: 'claude-haiku-5-5', effort: 'low' });
  assert.equal(pedido.betas, undefined);
  assert.equal(pedido.fallbacks, undefined);
  assert.equal(pedido.model, 'claude-haiku-5-5');
});

test('extrairResumo trata recusa e resposta cortada', async () => {
  const transcricao = await lerJson(path.join(exemplo, 'falas.json'));
  const comResposta = (extra) => ({ beta: { messages: { create: async () => respostaFalsa({}, extra) } } });

  await assert.rejects(
    extrairResumo({ client: comResposta({ stop_reason: 'refusal', stop_details: { category: 'cyber', explanation: 'x' } }), transcricao }),
    (e) => e instanceof ErroExtracao && /recusou/.test(e.message),
  );
  await assert.rejects(
    extrairResumo({ client: comResposta({ stop_reason: 'max_tokens' }), transcricao }),
    (e) => e instanceof ErroExtracao && /max_tokens/.test(e.message),
  );
  await assert.rejects(
    extrairResumo({ client: comResposta({}), transcricao: { ...transcricao, falas: [] } }),
    /não tem falas/,
  );
});
