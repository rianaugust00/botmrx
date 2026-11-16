#!/usr/bin/env node
// Liga os três serviços num terminal só: npm start
// Se um deles cair, os outros são encerrados (o bot fecha a daily em andamento antes de sair).
import { spawn } from 'node:child_process';
import path from 'node:path';
import { RAIZ } from '../nucleo/config.js';

const SERVICOS = { bot: 'bot/index.js', worker: 'worker/index.js', painel: 'api/index.js' };
const filhos = new Map();
let saindo = false;

function encerrar(codigo = 0) {
  if (saindo) return;
  saindo = true;
  process.exitCode = codigo;
  for (const filho of filhos.values()) filho.kill('SIGINT');
  // Se algum não sair sozinho em 15 s, força.
  setTimeout(() => [...filhos.values()].forEach((f) => f.kill('SIGKILL')), 15_000).unref();
}

for (const [nome, arquivo] of Object.entries(SERVICOS)) {
  const filho = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(RAIZ, arquivo)], { cwd: RAIZ, stdio: ['ignore', 'pipe', 'pipe'] });
  filhos.set(nome, filho);
  const prefixo = `[${nome}]`.padEnd(9);
  for (const saida of [filho.stdout, filho.stderr]) {
    let resto = '';
    saida.setEncoding('utf8').on('data', (pedaco) => {
      const linhas = (resto + pedaco).split('\n');
      resto = linhas.pop();
      for (const linha of linhas) console.log(`${prefixo}${linha}`);
    });
    saida.on('end', () => resto && console.log(`${prefixo}${resto}`));
  }
  filho.on('exit', (codigo, sinal) => {
    filhos.delete(nome);
    if (!saindo) {
      console.log(`${prefixo}parou (${sinal ?? `código ${codigo}`}); encerrando os outros serviços.`);
      encerrar(1);
    }
  });
}

process.on('SIGINT', () => encerrar(0));
process.on('SIGTERM', () => encerrar(0));
