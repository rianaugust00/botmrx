// Chamadas à API do Discord usadas pelo login do dashboard.
// OAuth2 (escopo "identify") diz quem é a pessoa; o token do bot consulta os cargos dela no servidor.

const API = 'https://discord.com/api/v10';
const ADMINISTRADOR = 1n << 3n;
const GERENCIAR_SERVIDOR = 1n << 5n;

export class ErroDiscord extends Error {}

/**
 * @param {object} o
 * @param {string} o.clientId
 * @param {string} o.clientSecret
 * @param {string} o.botToken
 * @param {string} o.urlRetorno   precisa estar cadastrada em OAuth2 → Redirects no portal do Discord
 * @param {typeof fetch} [o.fetch]
 */
export function criarClienteDiscord({ clientId, clientSecret, botToken, urlRetorno, fetch: f = fetch }) {
  const comoBot = { Authorization: `Bot ${botToken}`, 'User-Agent': 'DiscordBot (botmrx, 0.1.0)' };

  async function pedir(url, init, oQue) {
    const r = await f(url, init);
    if (r.status === 404) return null;
    if (!r.ok) throw new ErroDiscord(`O Discord recusou ${oQue} (${r.status}): ${(await r.text().catch(() => '')).slice(0, 200)}`);
    return r.json();
  }

  return {
    /** Endereço para onde mandar a pessoa fazer login. */
    urlAutorizacao(estado) {
      return `https://discord.com/oauth2/authorize?${new URLSearchParams({
        client_id: clientId,
        response_type: 'code',
        redirect_uri: urlRetorno,
        scope: 'identify',
        state: estado,
        prompt: 'none',
      })}`;
    },

    /** Troca o código do retorno pela identidade da pessoa. */
    async identificar(codigo) {
      const token = await pedir(
        `${API}/oauth2/token`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'authorization_code', code: codigo, redirect_uri: urlRetorno, client_id: clientId, client_secret: clientSecret }),
        },
        'o código de login',
      );
      if (!token?.access_token) throw new ErroDiscord('O Discord não devolveu o token de acesso.');
      const u = await pedir(`${API}/users/@me`, { headers: { Authorization: `Bearer ${token.access_token}` } }, 'a consulta do usuário');
      if (!u?.id) throw new ErroDiscord('O Discord não devolveu o usuário.');
      return { id: u.id, nome: u.global_name || u.username || u.id };
    },

    /**
     * Situação da pessoa num servidor: null se não é membro; senão os cargos e se é dona ou
     * administradora (permissão Administrador ou Gerenciar servidor).
     */
    async membro(guildId, userId) {
      const m = await pedir(`${API}/guilds/${guildId}/members/${userId}`, { headers: comoBot }, 'a consulta do membro');
      if (!m) return null;
      const g = await pedir(`${API}/guilds/${guildId}`, { headers: comoBot }, 'a consulta do servidor');
      if (!g) return null;
      const cargos = new Set([guildId, ...(m.roles ?? [])]); // o cargo @everyone tem o id do servidor
      const permissoes = (g.roles ?? []).filter((r) => cargos.has(r.id)).reduce((acc, r) => acc | BigInt(r.permissions ?? 0), 0n);
      const admin = g.owner_id === userId || (permissoes & (ADMINISTRADOR | GERENCIAR_SERVIDOR)) !== 0n;
      return { cargos: m.roles ?? [], admin };
    },
  };
}
