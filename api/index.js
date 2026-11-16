// Serviço API + dashboard. Sem login por enquanto: por isso só escuta em 127.0.0.1.
import { config } from '../nucleo/config.js';
import { abrirBanco } from '../nucleo/sqlite/banco.js';
import { criarServidor } from './servidor.js';
import { criarRespondedor } from './perguntas.js';
import { criarLlm } from '../nucleo/llm.js';
import { criarAuth } from './auth.js';
import { criarClienteDiscord } from './discord.js';

const log = (msg) => console.log(`${new Date().toISOString().slice(11, 19)} ${msg}`);
const banco = abrirBanco(config.banco.caminho);
// Perguntas livres usam o mesmo LLM do worker; sem configuração válida, só essa rota fica indisponível.
let responder;
try {
  responder = criarRespondedor({ banco, gerarJson: criarLlm(config.llm), maxCaracteres: config.api.perguntasMaxCaracteres });
} catch (e) {
  log(`  (perguntas livres desligadas: ${e.message})`);
}
// Login com Discord: ligado quando o .env tem DISCORD_CLIENT_ID e DISCORD_CLIENT_SECRET.
const { clientId, clientSecret, token: botToken } = config.discord;
const local = ['127.0.0.1', 'localhost', '::1'].includes(config.api.host);
let auth;
if (clientId && clientSecret && botToken) {
  const urlRetorno = `${config.api.urlPainel}/api/auth/retorno`;
  auth = criarAuth({
    banco,
    discord: criarClienteDiscord({ clientId, clientSecret, botToken, urlRetorno }),
    urlPainel: config.api.urlPainel,
    sessaoDias: config.api.sessaoDias,
    log,
  });
  log(`  login com Discord ligado · retorno cadastrado no portal deve ser ${urlRetorno}`);
} else if (!local) {
  console.error(
    `API_HOST=${config.api.host} abre o dashboard para a rede, mas o login não está configurado.\n` +
      'Preencha DISCORD_CLIENT_ID e DISCORD_CLIENT_SECRET no .env, ou volte API_HOST para 127.0.0.1.',
  );
  process.exit(1);
} else {
  log('  login desligado (sem DISCORD_CLIENT_SECRET): dashboard aberto só nesta máquina');
}
const servidor = criarServidor({ banco, responder, auth, log });

servidor.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `A porta ${config.api.porta} já está em uso. Mude API_PORT no .env.` : e);
  process.exit(1);
});
servidor.listen(config.api.porta, config.api.host, () => {
  log(`Dashboard em http://${config.api.host === '0.0.0.0' ? 'localhost' : config.api.host}:${config.api.porta}`);
});

for (const sinal of ['SIGINT', 'SIGTERM']) {
  process.on(sinal, () => {
    servidor.close(() => (banco.fechar(), process.exit(0)));
    servidor.closeAllConnections?.();
  });
}
