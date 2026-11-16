// API de leitura: rotas no formato de docs/CONTRATOS.md §4, sobre um banco em memória.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { abrirBanco } from '../nucleo/sqlite/banco.js';
import { rotear } from '../api/rotas.js';
import { criarServidor } from '../api/servidor.js';

const meta = { modelo: 'm', versaoPrompt: 'v1' };

/** Três dailies do mesmo time: bloqueio do Bruno nasce no dia 10, continua no 12 e é resolvido no 14. */
async function cenario(t) {
  let agora = new Date('2026-11-10T12:30:00Z');
  const banco = abrirBanco(':memory:', { agora: () => agora });
  t.after(() => banco.fechar());
  const time = await banco.obterOuCriarTime({ guildId: 'g', canalVozId: 'v', canalTextoId: 't', nome: 'Squad Pagamentos' });
  const outro = await banco.obterOuCriarTime({ guildId: 'g', canalVozId: 'v2', nome: 'Outro time' });
  const ana = await banco.obterOuCriarParticipante({ discordUserId: 'a', nome: 'Ana' });
  const bruno = await banco.obterOuCriarParticipante({ discordUserId: 'b', nome: 'Bruno' });
  const carla = await banco.definirNaoGravar({ discordUserId: 'c', nome: 'Carla', naoGravar: true });

  async function daily(dia, falas, montar, presentes = [ana, bruno]) {
    agora = new Date(`2026-11-${dia}T12:30:00Z`);
    const d = await banco.criarDaily({ timeId: time.id });
    for (const p of presentes) await banco.registrarEntrada({ dailyId: d.id, participanteId: p.id, gravado: !p.naoGravar });
    agora = new Date(agora.getTime() + 14 * 60_000);
    await banco.encerrarGravacao({ dailyId: d.id });
    await banco.salvarTranscricao({ dailyId: d.id, falas: falas.map(([p, inicioMs, texto]) => ({ participanteId: p.id, inicioMs, fimMs: inicioMs + 3000, texto })), segmentos: [] });
    const f = (await banco.transcricao(d.id)).map((x) => x.id);
    const abertos = (await banco.entradaExtracao(d.id)).bloqueiosAbertos;
    const base = { resumo_geral: `Resumo do dia ${dia}.`, participantes: [], decisoes: [], pendencias: [], bloqueios_resolvidos: [] };
    await banco.salvarExtracao({ dailyId: d.id, resumo: { ...base, ...montar(f, abertos) }, bruto: {}, meta });
    return d.id;
  }

  const d10 = await daily('10', [[ana, 1000, 'Terminei a tela de extrato.'], [bruno, 6000, 'Estou sem acesso à homologação.']], (f) => ({
    participantes: [
      { participante_id: ana.id, fez: [{ descricao: 'Terminou a tela de extrato', fala_ids: [f[0]] }], vai_fazer: [], bloqueios: [] },
      { participante_id: bruno.id, fez: [], vai_fazer: [], bloqueios: [{ descricao: 'Sem acesso à homologação', bloqueio_existente_id: null, fala_ids: [f[1]] }] },
    ],
  }), [ana, bruno, carla]);
  const d12 = await daily('12', [[bruno, 2000, 'Sigo sem acesso, <b>urgente</b> & crítico.']], (f, abertos) => ({
    participantes: [{ participante_id: bruno.id, fez: [], vai_fazer: [{ descricao: 'Vai cobrar a infra', fala_ids: f }], bloqueios: [{ descricao: 'Segue sem acesso', bloqueio_existente_id: abertos[0].id, fala_ids: f }] }],
    pendencias: [{ descricao: 'Cobrar a infra', responsavel_id: bruno.id, prazo: 'hoje', fala_ids: f }],
  }), [bruno]);
  const d14 = await daily('14', [[ana, 1000, 'Começo os testes de integração.'], [bruno, 5000, 'Liberaram o acesso à homologação.']], (f, abertos) => ({
    participantes: [{ participante_id: ana.id, fez: [], vai_fazer: [{ descricao: 'Vai começar os testes', fala_ids: [f[0]] }], bloqueios: [] }],
    decisoes: [{ descricao: 'Deploy na quinta', fala_ids: [f[1]] }],
    bloqueios_resolvidos: [{ bloqueio_id: abertos[0].id, fala_ids: [f[1]] }],
  }));

  const get = (caminho, query = {}) => rotear(banco, { metodo: 'GET', caminho, query });
  return { banco, time, outro, ana, bruno, carla, d10, d12, d14, get };
}

test('GET /times, /dailies (datas ou período) e /dailies/{id}', async (t) => {
  const { time, outro, ana, bruno, carla, d10, d12, d14, get } = await cenario(t);

  assert.deepEqual((await get('/times')).corpo.map((x) => [x.nome, x.dailies]), [['Outro time', 0], ['Squad Pagamentos', 3]]);

  const todas = (await get('/dailies', { timeId: String(time.id) })).corpo;
  assert.deepEqual(todas.map((d) => [d.id, d.data, d.status, d.duracaoMin, d.participantes, d.bloqueios]), [
    [d10, '2026-11-10', 'CONCLUIDA', 14, 3, 1],
    [d12, '2026-11-12', 'CONCLUIDA', 14, 1, 1],
    [d14, '2026-11-14', 'CONCLUIDA', 14, 2, 0],
  ]);
  assert.deepEqual((await get('/dailies', { datas: '2026-11-10,2026-11-14' })).corpo.map((d) => d.id), [d10, d14]);
  assert.deepEqual((await get('/dailies', { de: '2026-11-11', ate: '2026-11-12' })).corpo.map((d) => d.id), [d12]);
  assert.deepEqual((await get('/dailies', { timeId: String(outro.id) })).corpo, []);

  const { corpo: v } = await get(`/dailies/${d10}`);
  assert.equal(v.resumoGeral, 'Resumo do dia 10.');
  assert.deepEqual(v.presentes.map((p) => [p.nome, p.gravado]), [['Ana', true], ['Bruno', true], ['Carla', false]]);
  assert.deepEqual(v.pessoas.map((p) => p.participante.nome), ['Ana', 'Bruno']);
  assert.equal(v.pessoas[1].bloqueios[0].novo, true);
  assert.deepEqual(v.extracao, meta);

  const { corpo: tr } = await get(`/dailies/${d10}/transcricao`);
  assert.deepEqual(tr.map((f) => [f.participante.nome, f.texto]), [['Ana', 'Terminei a tela de extrato.'], ['Bruno', 'Estou sem acesso à homologação.']]);
  assert.deepEqual(v.pessoas[0].fez[0].falaIds, [tr[0].id]);
  assert.ok(ana.id && bruno.id && carla.id);
});

test('GET /dailies/comparar alinha as pessoas; quem não falou no dia fica null', async (t) => {
  const { ana, bruno, d10, d12, d14, get } = await cenario(t);
  const { corpo } = await get('/dailies/comparar', { ids: `${d10},${d12},${d14}` });
  assert.deepEqual(corpo.dailies.map((d) => [d.id, d.data]), [[d10, '2026-11-10'], [d12, '2026-11-12'], [d14, '2026-11-14']]);
  assert.deepEqual(corpo.linhas.map((l) => l.participante), [{ id: ana.id, nome: 'Ana' }, { id: bruno.id, nome: 'Bruno' }]);
  const [lAna, lBruno] = corpo.linhas;
  assert.equal(lAna.porDaily[d10].fez[0].descricao, 'Terminou a tela de extrato');
  assert.equal(lAna.porDaily[d12], null);
  assert.equal(lAna.porDaily[d14].vaiFazer.length, 1);
  assert.equal(lBruno.porDaily[d12].bloqueios[0].novo, false);
  assert.equal(lBruno.porDaily[d14], null);
});

test('GET /participantes/{id}/historico e /bloqueios', async (t) => {
  const { time, bruno, d10, d12, d14, get } = await cenario(t);

  const { corpo: h } = await get(`/participantes/${bruno.id}/historico`, { de: '2026-11-01', ate: '2026-11-30' });
  assert.deepEqual(h.map((d) => [d.dailyId, d.data, d.fez.length, d.vaiFazer.length, d.bloqueios.length]), [
    [d10, '2026-11-10', 0, 0, 1],
    [d12, '2026-11-12', 0, 1, 1],
    [d14, '2026-11-14', 0, 0, 0], // presente, sem itens
  ]);
  assert.equal((await get(`/participantes/${bruno.id}/historico`, { datas: '2026-11-12' })).corpo.length, 1);
  assert.deepEqual((await get(`/participantes/${bruno.id}`)).corpo, { id: bruno.id, nome: 'Bruno', naoGravar: false });

  const { corpo: todos } = await get('/bloqueios', { timeId: String(time.id) });
  assert.equal(todos.length, 1);
  assert.deepEqual(
    { ...todos[0], id: 0 },
    { id: 0, participante: { id: bruno.id, nome: 'Bruno' }, descricao: 'Sem acesso à homologação', status: 'RESOLVIDO',
      desde: '2026-11-10', ultimaMencao: '2026-11-14', resolvidoEm: '2026-11-14', dailies: [d10, d12] },
  );
  assert.deepEqual((await get('/bloqueios', { status: 'aberto' })).corpo, []);
  assert.equal((await get('/bloqueios', { status: 'RESOLVIDO' })).corpo.length, 1);
});

test('GET /busca ignora acentos e maiúsculas, filtra e escapa HTML no trecho', async (t) => {
  const { ana, bruno, d12, get } = await cenario(t);

  const { corpo } = await get('/busca', { q: 'HOMOLOGACAO' });
  assert.deepEqual(corpo.map((r) => [r.data, r.participante.nome]), [['2026-11-14', 'Bruno'], ['2026-11-10', 'Bruno']]);
  assert.match(corpo[0].trecho, /acesso à <mark>homologação<\/mark>\./);

  assert.deepEqual((await get('/busca', { q: 'acesso', participanteId: String(ana.id) })).corpo, []);
  assert.equal((await get('/busca', { q: 'acesso', de: '2026-11-11', ate: '2026-11-13' })).corpo.length, 1);

  const [achado] = (await get('/busca', { q: 'urgente' })).corpo;
  assert.equal(achado.dailyId, d12);
  assert.equal(achado.participante.id, bruno.id);
  assert.equal(achado.trecho, 'Sigo sem acesso, &lt;b&gt;<mark>urgente</mark>&lt;/b&gt; &amp; crítico.');
});

test('erros no formato do contrato', async (t) => {
  const { get, banco } = await cenario(t);
  assert.deepEqual(await get('/dailies/999'), { status: 404, corpo: { erro: { codigo: 'DAILY_NAO_ENCONTRADA', mensagem: 'Daily 999 não existe.' } } });
  assert.equal((await get('/dailies/999/transcricao')).status, 404);
  assert.equal((await get('/participantes/999/historico')).corpo.erro.codigo, 'PARTICIPANTE_NAO_ENCONTRADO');
  assert.equal((await get('/dailies', { de: '10/11/2026' })).corpo.erro.codigo, 'PARAMETRO_INVALIDO');
  assert.equal((await get('/dailies', { timeId: 'abc' })).status, 400);
  assert.equal((await get('/dailies/comparar')).status, 400);
  assert.equal((await get('/busca', { q: 'a' })).status, 400);
  assert.equal((await get('/bloqueios', { status: 'x' })).status, 400);
  assert.equal((await get('/nao-existe')).corpo.erro.codigo, 'ROTA_NAO_ENCONTRADA');
  assert.equal((await rotear(banco, { metodo: 'DELETE', caminho: '/dailies/1' })).status, 404);
});

test('admin: reprocessar daily e atualizar participante', async (t) => {
  const { banco, carla, d14, get } = await cenario(t);

  const r = await rotear(banco, { metodo: 'POST', caminho: `/admin/dailies/${d14}/reprocessar`, corpo: {} });
  assert.equal(r.status, 200);
  assert.equal(r.corpo.etapa, 'EXTRAIR');
  assert.equal((await get(`/dailies/${d14}`)).corpo.status, 'AGUARDANDO_EXTRACAO');

  // o áudio não existe mais: retranscrever não é possível
  const semAudio = await rotear(banco, { metodo: 'POST', caminho: `/admin/dailies/${d14}/reprocessar`, corpo: { etapa: 'transcrever' } });
  assert.equal(semAudio.status, 409);
  assert.equal(semAudio.corpo.erro.codigo, 'OPERACAO_INVALIDA');
  assert.equal((await rotear(banco, { metodo: 'POST', caminho: `/admin/dailies/${d14}/reprocessar`, corpo: { etapa: 'x' } })).status, 400);
  assert.equal((await rotear(banco, { metodo: 'POST', caminho: '/admin/dailies/999/reprocessar' })).status, 404);

  const p = await rotear(banco, { metodo: 'PUT', caminho: `/admin/participantes/${carla.id}`, corpo: { nome: ' Carla Souza ', naoGravar: false } });
  assert.deepEqual(p.corpo, { id: carla.id, nome: 'Carla Souza', naoGravar: false });
  assert.equal((await rotear(banco, { metodo: 'PUT', caminho: `/admin/participantes/${carla.id}`, corpo: { naoGravar: 'sim' } })).status, 400);
  assert.equal((await rotear(banco, { metodo: 'PUT', caminho: `/admin/participantes/${carla.id}`, corpo: { nome: '  ' } })).status, 400);
});

test('servidor HTTP: API em /api, dashboard estático e nada fora da pasta web/', async (t) => {
  const { banco, d10 } = await cenario(t);
  const servidor = criarServidor({ banco });
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  t.after(() => servidor.close());
  const base = `http://127.0.0.1:${servidor.address().port}`;

  const r = await fetch(`${base}/api/dailies/${d10}`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /application\/json/);
  assert.equal((await r.json()).data, '2026-11-10');
  assert.equal((await fetch(`${base}/api/dailies/999`)).status, 404);

  const ruim = await fetch(`${base}/api/admin/participantes/1`, { method: 'PUT', body: '{nao é json' });
  assert.equal(ruim.status, 400);
  assert.equal((await ruim.json()).erro.codigo, 'CORPO_INVALIDO');

  const pagina = await fetch(`${base}/`);
  assert.equal(pagina.status, 200);
  assert.match(pagina.headers.get('content-type'), /text\/html/);
  assert.match(pagina.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal((await fetch(`${base}/app.js`)).status, 200);
  assert.equal((await fetch(`${base}/%2e%2e/package.json`)).status, 404);
  assert.equal((await fetch(`${base}/..%2f.env`)).status, 404);
  assert.equal((await fetch(`${base}/`, { method: 'POST' })).status, 405);
});
