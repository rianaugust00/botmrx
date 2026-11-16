// Login do dashboard com Discord e regra de acesso por time.
//
// Pode ver (e administrar) um time: quem é membro do servidor e tem o cargo de gestor definido
// para o time (/daily gestor), além do dono e dos administradores do servidor. Enquanto nenhum
// cargo for definido, só dono e administradores.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const COOKIE_SESSAO = 'botmrx_sessao';
const COOKIE_ESTADO = 'botmrx_estado';
const DIA_MS = 24 * 60 * 60 * 1000;

const hash = (token) => createHash('sha256').update(token).digest('hex');
const iguais = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function lerCookies(cabecalho = '') {
  const cookies = {};
  for (const par of cabecalho.split(';')) {
    const i = par.indexOf('=');
    if (i > 0) cookies[par.slice(0, i).trim()] = decodeURIComponent(par.slice(i + 1).trim());
  }
  return cookies;
}

/**
 * @param {object} o
 * @param {import('../nucleo/sqlite/banco.js').Banco} o.banco
 * @param {ReturnType<import('./discord.js').criarClienteDiscord>} o.discord
 * @param {string} o.urlPainel        ex.: http://127.0.0.1:3000
 * @param {number} [o.sessaoDias]
 * @param {number} [o.cacheMs]        por quanto tempo lembrar os cargos de alguém
 * @param {() => Date} [o.agora]
 * @param {(msg: string) => void} [o.log]
 */
export function criarAuth({ banco, discord, urlPainel, sessaoDias = 7, cacheMs = 5 * 60_000, agora = () => new Date(), log = () => {} }) {
  const seguro = urlPainel.startsWith('https://');
  const cache = new Map(); // discordUserId -> { ate, times: Set<number> }

  const cookie = (nome, valor, maxAgeSeg) =>
    `${nome}=${encodeURIComponent(valor)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeg}${seguro ? '; Secure' : ''}`;

  /** Times que a pessoa pode ver, consultando os cargos no Discord (com cache curto). */
  async function timesPermitidos(discordUserId, { forcar = false } = {}) {
    const guardado = cache.get(discordUserId);
    if (!forcar && guardado && guardado.ate > agora().getTime()) return guardado.times;

    const times = await banco.timesParaAutorizacao();
    const permitidos = new Set();
    for (const guildId of new Set(times.map((t) => t.guildId))) {
      const membro = await discord.membro(guildId, discordUserId);
      if (!membro) continue;
      for (const t of times.filter((x) => x.guildId === guildId)) {
        if (membro.admin || (t.roleGestorId && membro.cargos.includes(t.roleGestorId))) permitidos.add(t.id);
      }
    }
    cache.set(discordUserId, { ate: agora().getTime() + cacheMs, times: permitidos });
    return permitidos;
  }

  /** Sessão da requisição: { usuario, timesPermitidos, tokenHash } ou null. */
  async function sessaoDe(req) {
    const token = lerCookies(req.headers.cookie)[COOKIE_SESSAO];
    if (!token) return null;
    const tokenHash = hash(token);
    const s = await banco.obterSessao(tokenHash);
    if (!s) return null;
    return { usuario: { id: s.discordUserId, nome: s.nome }, timesPermitidos: await timesPermitidos(s.discordUserId), tokenHash };
  }

  /**
   * Rotas /api/auth/*. Devolve { status, headers, corpo } (corpo: objeto vira JSON, string vira HTML).
   * @param {{ metodo: string, caminho: string, query: Record<string, string>, req: import('node:http').IncomingMessage }} p
   */
  async function tratar({ metodo, caminho, query, req }) {
    if (metodo === 'GET' && caminho === '/auth/eu') {
      const s = await sessaoDe(req);
      return { status: 200, corpo: { login: true, usuario: s?.usuario ?? null } };
    }

    if (metodo === 'GET' && caminho === '/auth/entrar') {
      const estado = randomBytes(16).toString('hex');
      return { status: 302, headers: { Location: discord.urlAutorizacao(estado), 'Set-Cookie': cookie(COOKIE_ESTADO, estado, 600) }, corpo: '' };
    }

    if (metodo === 'GET' && caminho === '/auth/retorno') {
      const limparEstado = cookie(COOKIE_ESTADO, '', 0);
      const esperado = lerCookies(req.headers.cookie)[COOKIE_ESTADO] ?? '';
      if (query.error) return pagina(400, 'Login cancelado', 'O login com o Discord não foi concluído.', limparEstado);
      if (!query.code || !query.state || !esperado || !iguais(query.state, esperado)) {
        return pagina(400, 'Não foi possível entrar', 'O pedido de login expirou ou não começou nesta janela. Tente de novo.', limparEstado);
      }
      let usuario;
      try {
        usuario = await discord.identificar(query.code);
      } catch (e) {
        log(`✖ login: ${e.message}`);
        return pagina(502, 'Não foi possível entrar', 'O Discord não confirmou o login. Tente de novo em instantes.', limparEstado);
      }
      const permitidos = await timesPermitidos(usuario.id, { forcar: true });
      if (!permitidos.size) {
        log(`login negado: ${usuario.nome} (${usuario.id}) não tem acesso a nenhum time`);
        return pagina(
          403,
          'Sem acesso',
          `${usuario.nome}, sua conta não tem acesso a nenhum time. O acesso é de quem tem o cargo de gestor do time ou é administrador do servidor.`,
          limparEstado,
        );
      }
      const token = randomBytes(32).toString('hex');
      await banco.criarSessao({ tokenHash: hash(token), discordUserId: usuario.id, nome: usuario.nome, expiraEm: new Date(agora().getTime() + sessaoDias * DIA_MS) });
      log(`login: ${usuario.nome} (${usuario.id}), ${permitidos.size} time(s)`);
      return { status: 302, headers: { Location: '/', 'Set-Cookie': [cookie(COOKIE_SESSAO, token, sessaoDias * 86_400), limparEstado] }, corpo: '' };
    }

    if (metodo === 'POST' && caminho === '/auth/sair') {
      const s = await sessaoDe(req).catch(() => null);
      if (s) await banco.apagarSessao(s.tokenHash);
      return { status: 200, headers: { 'Set-Cookie': cookie(COOKIE_SESSAO, '', 0) }, corpo: { ok: true } };
    }

    return { status: 404, corpo: { erro: { codigo: 'ROTA_NAO_ENCONTRADA', mensagem: `${metodo} ${caminho} não existe.` } } };
  }

  return { tratar, sessaoDe, timesPermitidos };
}

const escapar = (t) => t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function pagina(status, titulo, mensagem, setCookie) {
  return {
    status,
    headers: { 'Set-Cookie': setCookie },
    corpo:
      `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${escapar(titulo)} — BotMRX</title>` +
      `<link rel="stylesheet" href="/estilo.css"></head><body><main class="entrada"><div class="painel">` +
      `<h1>${escapar(titulo)}</h1><p>${escapar(mensagem)}</p><p><a href="/">Voltar</a></p></div></main></body></html>`,
  };
}
