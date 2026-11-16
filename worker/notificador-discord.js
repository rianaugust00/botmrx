// Porta Notificador para o worker: posta no canal de texto pela API REST do Discord.
// Só precisa do token do bot (não abre conexão de gateway, então não disputa com o serviço Bot).
import { dividirMensagem } from './resumo-texto.js';

/**
 * @param {{ token: string, fetch?: typeof fetch }} o
 * @returns {(canalTextoId: string, mensagem: string) => Promise<void>}
 */
export function criarNotificadorDiscord({ token, fetch: f = fetch }) {
  return async function postar(canalTextoId, mensagem) {
    for (const parte of dividirMensagem(mensagem)) {
      const r = await f(`https://discord.com/api/v10/channels/${canalTextoId}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bot ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'DiscordBot (botmrx, 0.1.0)',
        },
        // O texto vem do LLM: nunca deixar virar menção (@everyone, @cargo, @pessoa).
        body: JSON.stringify({ content: parte, allowed_mentions: { parse: [] } }),
      });
      if (!r.ok) {
        const corpo = await r.text().catch(() => '');
        throw new Error(`Discord recusou a mensagem (${r.status}): ${corpo.slice(0, 200)}`);
      }
    }
  };
}
