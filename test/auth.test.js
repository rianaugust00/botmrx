// Login do dashboard e acesso por time. Discord simulado; servidor HTTP real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { abrirBanco } from '../nucleo/sqlite/banco.js';
import { criarAuth, lerCookies } from '../api/auth.js';
import { criarClienteDiscord } from '../api/discord.js';
import { criarServidor } from '../api/servidor.js';

async function ambiente(t) {
  let agora = new Date('2026-11-16T12:00:00Z');
  const banco = abrirBanco(':memory:', { agora: () => agora });
  t.after(() => banco.fechar());
  const pagamentos = await banco.obterOuCriarTime({ guildId: 'g1', canalVozId: 'v1', nome: 'Pagamentos' });
  const cartoes = await banco.obterOuCriarTime({ guildId: 'g1', canalVozId: 'v2', nome: 'Cartões' });
  const outro = await banco.obterOuCriarTime({ guildId: 'g2', canalVozId: 'v3', nome: 'Outro servidor' });
  await banco.definirRoleGestor(pagamentos.id, 'cargo-gestor');
  const ana = await banco.obterOuCriarParticipante({ discordUserId: 'u-ana', nome: 'Ana' });
  const dailyDe = async (time) => {
    const d = await banco.criarDaily({ timeId: time.id });
    await banco.registrarEntrada({ dailyId: d.id, participanteId: ana.id, gravado: true });
    await banco.salvarTranscricao({ dailyId: d.id, falas: [{ participanteId: ana.id, inicioMs: 0, fimMs: 1000, texto: `Fala em ${time.nome}.` }], segmentos: [] });
    return d.id;
  };
  const dPag = await dailyDe(pagamentos);
  const dCar = await dailyDe(cartoes);

  // Quem é quem no Discord: dona é admin de g1; gestora tem o cargo; visitante é membro sem cargo; estranho não é membro.
  const membros = { g1: { dona: { cargos: [], admin: true }, gestora: { cargos: ['cargo-gestor'], admin: false }, visitante: { cargos: ['outro'], admin: false } } };
  const consultas = [];
  const discord = {
    urlAutorizacao: (estado) => `https://discord.test/authorize?state=${estado}`,
    identificar: async (codigo) => {
      if (codigo === 'ruim') throw new Error('invalid_grant');
      return { id: codigo, nome: `Nome de ${codigo}` };
    },
    membro: async (guildId, userId) => (consultas.push(`${guildId}:${userId}`), membros[guildId]?.[userId] ?? null),
  };
  const auth = criarAuth({ banco, discord, urlPainel: 'http://127.0.0.1:3000', agora: () => agora });
  const servidor = criarServidor({ banco, auth });
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  t.after(() => servidor.close());
  const base = `http://127.0.0.1:${servidor.address().port}`;

  /** Faz o fluxo de login como `userId` e devolve o cookie de sessão (ou a resposta, se negado). */
  async function entrar(userId) {
    const ida = await fetch(`${base}/api/auth/entrar`, { redirect: 'manual' });
    const estado = new URL(ida.headers.get('location')).searchParams.get('state');
    const cookieEstado = ida.headers.getSetCookie()[0].split(';')[0];
    const volta = await fetch(`${base}/api/auth/retorno?code=${userId}&state=${estado}`, { redirect: 'manual', headers: { Cookie: cookieEstado } });
    const sessao = volta.headers.getSetCookie().find((c) => c.startsWith('botmrx_sessao=') && !c.includes('Max-Age=0'));
    return { resposta: volta, cookie: sessao?.split(';')[0], bruto: sessao };
  }
  const get = (caminho, cookie) => fetch(`${base}/api${caminho}`, { headers: cookie ? { Cookie: cookie } : {} });

  return { banco, base, entrar, get, pagamentos, cartoes, outro, ana, dPag, dCar, consultas, membros, avancar: (ms) => (agora = new Date(agora.getTime() + ms)) };
}

test('sem sessão a API responde 401; /auth/eu diz que o login está ligado', async (t) => {
  const { get, base } = await ambiente(t);
  const r = await get('/times');
  assert.equal(r.status, 401);
  assert.equal((await r.json()).erro.codigo, 'NAO_AUTENTICADO');
  assert.equal((await get('/dailies/1')).status, 401);
  assert.equal((await fetch(`${base}/api/perguntas`, { method: 'POST', body: '{}' })).status, 401);
  assert.deepEqual(await (await get('/auth/eu')).json(), { login: true, usuario: null });
  assert.equal((await fetch(`${base}/`)).status, 200, 'a página em si abre (ela mostra o botão de entrar)');
});

test('login: administradora vê os times do servidor dela; cookie é HttpOnly e SameSite', async (t) => {
  const { entrar, get, pagamentos, cartoes, dPag, dCar } = await ambiente(t);
  const { resposta, cookie, bruto } = await entrar('dona');
  assert.equal(resposta.status, 302);
  assert.equal(resposta.headers.get('location'), '/');
  assert.match(bruto, /HttpOnly/);
  assert.match(bruto, /SameSite=Lax/);
  assert.doesNotMatch(bruto, /Secure/, 'http local não usa Secure');

  assert.deepEqual(await (await get('/auth/eu', cookie)).json(), { login: true, usuario: { id: 'dona', nome: 'Nome de dona' } });
  assert.deepEqual((await (await get('/times', cookie)).json()).map((x) => x.id), [cartoes.id, pagamentos.id], 'o time do outro servidor não aparece');
  assert.equal((await get(`/dailies/${dPag}`, cookie)).status, 200);
  assert.equal((await get(`/dailies/${dCar}`, cookie)).status, 200);
});

test('gestora só vê o time do cargo dela, por qualquer rota', async (t) => {
  const { entrar, get, base, pagamentos, cartoes, ana, dPag, dCar } = await ambiente(t);
  const { cookie } = await entrar('gestora');
  assert.deepEqual((await (await get('/times', cookie)).json()).map((x) => x.nome), ['Pagamentos']);

  assert.equal((await get(`/dailies?timeId=${pagamentos.id}`, cookie)).status, 200);
  assert.equal((await get(`/dailies/${dPag}/transcricao`, cookie)).status, 200);
  assert.equal((await get(`/participantes/${ana.id}/historico?timeId=${pagamentos.id}`, cookie)).status, 200);

  const negadas = [
    `/dailies?timeId=${cartoes.id}`,
    `/dailies/${dCar}`,
    `/dailies/${dCar}/transcricao`,
    `/dailies/comparar?ids=${dPag},${dCar}`,
    `/bloqueios?timeId=${cartoes.id}`,
    `/busca?q=fala&timeId=${cartoes.id}`,
    `/times/${cartoes.id}/participantes`,
    `/participantes/${ana.id}/historico?timeId=${cartoes.id}`,
  ];
  for (const rota of negadas) {
    const r = await get(rota, cookie);
    assert.equal(r.status, 403, rota);
    assert.equal((await r.json()).erro.codigo, 'SEM_ACESSO');
  }
  // sem dizer o time não dá para listar "tudo"
  for (const rota of ['/dailies', '/bloqueios', '/busca?q=fala']) assert.equal((await get(rota, cookie)).status, 400, rota);

  const reproc = await fetch(`${base}/api/admin/dailies/${dCar}/reprocessar`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(reproc.status, 403);
  const pergunta = await fetch(`${base}/api/perguntas`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ pergunta: 'O que houve?', timeId: cartoes.id }) });
  assert.equal(pergunta.status, 403);
});

test('quem não tem cargo nem é do servidor não entra', async (t) => {
  const { entrar } = await ambiente(t);
  for (const quem of ['visitante', 'estranho']) {
    const { resposta, cookie } = await entrar(quem);
    assert.equal(resposta.status, 403);
    assert.equal(cookie, undefined);
    assert.match(await resposta.text(), /não tem acesso a nenhum time/);
  }
});

test('retorno do login: estado errado, cancelamento e falha do Discord não criam sessão', async (t) => {
  const { base, banco } = await ambiente(t);
  const ida = await fetch(`${base}/api/auth/entrar`, { redirect: 'manual' });
  assert.match(ida.headers.get('location'), /^https:\/\/discord\.test\/authorize\?state=[0-9a-f]{32}$/);
  const estado = new URL(ida.headers.get('location')).searchParams.get('state');
  const cookieEstado = ida.headers.getSetCookie()[0].split(';')[0];
  const voltar = (query, cookie) => fetch(`${base}/api/auth/retorno?${query}`, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} });

  assert.equal((await voltar(`code=dona&state=${estado}`)).status, 400, 'sem o cookie de estado (outro navegador)');
  assert.equal((await voltar('code=dona&state=forjado', cookieEstado)).status, 400);
  assert.equal((await voltar(`error=access_denied&state=${estado}`, cookieEstado)).status, 400);
  assert.equal((await voltar(`code=ruim&state=${estado}`, cookieEstado)).status, 502);
  assert.equal(banco.db.prepare('SELECT COUNT(*) n FROM Sessoes').get().n, 0);
});

test('sair encerra a sessão; sessão expira; cargo removido perde o acesso depois do cache', async (t) => {
  const { entrar, get, base, membros, avancar, banco } = await ambiente(t);

  const a = await entrar('dona');
  const sair = await fetch(`${base}/api/auth/sair`, { method: 'POST', headers: { Cookie: a.cookie } });
  assert.equal(sair.status, 200);
  assert.match(sair.headers.getSetCookie()[0], /botmrx_sessao=; .*Max-Age=0/);
  assert.equal((await get('/times', a.cookie)).status, 401);

  const g = await entrar('gestora');
  assert.equal((await (await get('/times', g.cookie)).json()).length, 1);
  membros.g1.gestora.cargos = []; // perdeu o cargo no Discord
  assert.equal((await (await get('/times', g.cookie)).json()).length, 1, 'ainda no cache de 5 min');
  avancar(6 * 60_000);
  assert.deepEqual(await (await get('/times', g.cookie)).json(), []);

  const d = await entrar('dona');
  avancar(8 * 24 * 60 * 60_000);
  assert.equal((await get('/times', d.cookie)).status, 401, 'sessão de 7 dias expirou');
  await entrar('dona');
  assert.equal(banco.db.prepare('SELECT COUNT(*) n FROM Sessoes').get().n, 1, 'sessões expiradas são limpas no próximo login');
});

test('pedido que altera algo vindo de outra origem é recusado', async (t) => {
  const { entrar, base } = await ambiente(t);
  const { cookie } = await entrar('dona');
  const r = await fetch(`${base}/api/auth/sair`, { method: 'POST', headers: { Cookie: cookie, Origin: 'https://site-malicioso.example' } });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).erro.codigo, 'ORIGEM_INVALIDA');
  assert.equal((await fetch(`${base}/api/auth/sair`, { method: 'POST', headers: { Cookie: cookie, Origin: 'null' } })).status, 403);
  assert.equal((await fetch(`${base}/api/auth/sair`, { method: 'POST', headers: { Cookie: cookie, Origin: base } })).status, 200);
});

test('cliente Discord: URL de autorização, troca do código e cálculo de administrador', async () => {
  const pedidos = [];
  const respostas = {
    '/oauth2/token': { access_token: 'tok-usuario' },
    '/users/@me': { id: '42', username: 'rian', global_name: 'Rian' },
    '/guilds/g1/members/42': { roles: ['r-gestor'] },
    '/guilds/g1/members/7': { roles: [] },
    '/guilds/g1': { owner_id: '7', roles: [{ id: 'g1', permissions: '0' }, { id: 'r-gestor', permissions: '1024' }, { id: 'r-admin', permissions: '8' }] },
  };
  const discord = criarClienteDiscord({
    clientId: 'cid',
    clientSecret: 'segredo',
    botToken: 'bot-tok',
    urlRetorno: 'http://127.0.0.1:3000/api/auth/retorno',
    fetch: async (url, init = {}) => {
      const caminho = new URL(url).pathname.replace('/api/v10', '');
      pedidos.push({ caminho, init });
      const corpo = respostas[caminho];
      return corpo ? { ok: true, status: 200, json: async () => corpo } : { ok: false, status: 404, text: async () => '' };
    },
  });

  const u = new URL(discord.urlAutorizacao('abc'));
  assert.equal(u.origin + u.pathname, 'https://discord.com/oauth2/authorize');
  assert.deepEqual(Object.fromEntries(u.searchParams), { client_id: 'cid', response_type: 'code', redirect_uri: 'http://127.0.0.1:3000/api/auth/retorno', scope: 'identify', state: 'abc', prompt: 'none' });

  assert.deepEqual(await discord.identificar('codigo'), { id: '42', nome: 'Rian' });
  const troca = pedidos[0].init.body;
  assert.equal(troca.get('client_secret'), 'segredo');
  assert.equal(troca.get('code'), 'codigo');
  assert.equal(pedidos[1].init.headers.Authorization, 'Bearer tok-usuario');

  assert.deepEqual(await discord.membro('g1', '42'), { cargos: ['r-gestor'], admin: false });
  assert.equal(pedidos.at(-1).init.headers.Authorization, 'Bot bot-tok');
  assert.deepEqual(await discord.membro('g1', '7'), { cargos: [], admin: true }, 'dono do servidor');
  respostas['/guilds/g1/members/42'] = { roles: ['r-admin'] };
  assert.equal((await discord.membro('g1', '42')).admin, true, 'cargo com permissão de Administrador');
  assert.equal(await discord.membro('g1', '999'), null);

  assert.deepEqual(lerCookies('a=1; botmrx_sessao=x%20y; vazio'), { a: '1', botmrx_sessao: 'x y' });
});
