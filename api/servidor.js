// Servidor HTTP: a API em /api/* e o dashboard estático (pasta web/) no restante.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rotear } from './rotas.js';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web');
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const LIMITE_CORPO = 64 * 1024;

/**
 * @param {object} o
 * @param {import('../nucleo/sqlite/banco.js').Banco} o.banco
 * @param {Function} [o.responder]   perguntas livres
 * @param {ReturnType<import('./auth.js').criarAuth>} [o.auth]  login; sem ele a API fica aberta (só para uso local)
 * @param {(msg: string) => void} [o.log]
 */
export function criarServidor({ banco, responder, auth, log = () => {} }) {
  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local');
    if (process.env.API_LOG === '1') res.on('finish', () => log(`${req.method} ${req.url} → ${res.statusCode}`));
    try {
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        const caminho = url.pathname.slice(4) || '/';
        const query = Object.fromEntries(url.searchParams);
        // Pedidos que alteram algo só valem vindos da própria página (o cookie é SameSite=Lax; isto é a segunda trava).
        if (req.method !== 'GET' && req.headers.origin && !mesmaOrigem(req.headers.origin, req.headers.host)) {
          return enviarJson(res, 403, { erro: { codigo: 'ORIGEM_INVALIDA', mensagem: 'Pedido de outra origem.' } });
        }

        if (caminho.startsWith('/auth/')) {
          if (!auth) {
            if (req.method === 'GET' && caminho === '/auth/eu') return enviarJson(res, 200, { login: false, usuario: null });
            return enviarJson(res, 404, { erro: { codigo: 'LOGIN_DESLIGADO', mensagem: 'O login não está configurado neste servidor.' } });
          }
          const r = await auth.tratar({ metodo: req.method, caminho, query, req });
          return typeof r.corpo === 'string'
            ? enviar(res, r.status, 'text/html; charset=utf-8', r.corpo, r.headers)
            : enviarJson(res, r.status, r.corpo, r.headers);
        }

        let timesPermitidos = null;
        if (auth) {
          const sessao = await auth.sessaoDe(req);
          if (!sessao) return enviarJson(res, 401, { erro: { codigo: 'NAO_AUTENTICADO', mensagem: 'Entre com o Discord para continuar.' } });
          timesPermitidos = sessao.timesPermitidos;
        }
        const corpo = req.method === 'GET' ? {} : await lerJson(req);
        const r = await rotear(banco, { metodo: req.method, caminho, query, corpo }, { responder, timesPermitidos });
        return enviarJson(res, r.status, r.corpo);
      }
      if (req.method !== 'GET') return enviar(res, 405, 'text/plain; charset=utf-8', 'Método não permitido');
      return await servirArquivo(res, url.pathname);
    } catch (e) {
      if (e?.status === 400) return enviar(res, 400, 'application/json; charset=utf-8', JSON.stringify({ erro: { codigo: 'CORPO_INVALIDO', mensagem: e.message } }));
      log(`✖ ${req.method} ${url.pathname}: ${e?.stack ?? e}`);
      return enviar(res, 500, 'application/json; charset=utf-8', JSON.stringify({ erro: { codigo: 'ERRO_INTERNO', mensagem: 'Erro interno.' } }));
    }
  });
}

function mesmaOrigem(origem, host) {
  try {
    return new URL(origem).host === host;
  } catch {
    return false; // "null" e afins
  }
}

const enviarJson = (res, status, corpo, headers) => enviar(res, status, 'application/json; charset=utf-8', JSON.stringify(corpo), headers);

function enviar(res, status, tipo, corpo, headers = {}) {
  res.writeHead(status, {
    ...headers,
    'Content-Type': tipo,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    // O dashboard só carrega os próprios arquivos: nada de script embutido ou de terceiros.
    'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'",
  });
  res.end(corpo);
}

async function servirArquivo(res, caminho) {
  const relativo = caminho === '/' ? 'index.html' : decodeURIComponent(caminho).replace(/^\/+/, '');
  const arquivo = path.resolve(WEB, relativo);
  if (!arquivo.startsWith(WEB + path.sep) || !TIPOS[path.extname(arquivo)]) return enviar(res, 404, 'text/plain; charset=utf-8', 'Não encontrado');
  try {
    return enviar(res, 200, TIPOS[path.extname(arquivo)], await readFile(arquivo));
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'EISDIR') return enviar(res, 404, 'text/plain; charset=utf-8', 'Não encontrado');
    throw e;
  }
}

async function lerJson(req) {
  const partes = [];
  let tamanho = 0;
  for await (const parte of req) {
    tamanho += parte.length;
    if (tamanho > LIMITE_CORPO) throw Object.assign(new Error('Corpo grande demais.'), { status: 400 });
    partes.push(parte);
  }
  if (!tamanho) return {};
  try {
    return JSON.parse(Buffer.concat(partes).toString('utf8'));
  } catch {
    throw Object.assign(new Error('O corpo precisa ser JSON válido.'), { status: 400 });
  }
}
