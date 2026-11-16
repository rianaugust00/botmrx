#!/usr/bin/env node
// Consulta o banco pelo terminal (enquanto não há dashboard):
//   npm run ver                       lista as últimas dailies
//   npm run ver -- <id>               resumo da daily, com as falas de origem de cada item
//   npm run ver -- <id> --transcricao também mostra a transcrição
import { config } from '../nucleo/config.js';
import { abrirBanco } from '../nucleo/sqlite/banco.js';
import { dataBr, formatarTempo } from '../nucleo/tempo.js';
import { resumoEmTexto } from '../worker/resumo-texto.js';

const [arg, ...resto] = process.argv.slice(2);
const banco = abrirBanco(config.banco.caminho);
try {
  if (!arg) {
    const dailies = await banco.listarDailies({ limite: 30 });
    if (!dailies.length) console.log('Nenhuma daily no banco ainda.');
    for (const d of dailies) {
      console.log(`#${String(d.id).padEnd(4)} ${dataBr(d.data)}  ${d.status.padEnd(22)} ${d.time} · ${d.participantes} pessoa(s), ${d.falas} fala(s)`);
    }
  } else {
    const id = Number(arg);
    const visao = Number.isInteger(id) ? await banco.visaoDaily(id) : null;
    if (!visao) {
      console.error(`Daily "${arg}" não existe. Rode \`npm run ver\` para listar.`);
      process.exitCode = 1;
    } else {
      const falas = await banco.transcricao(id);
      console.log(`Daily #${visao.id} — ${visao.status}\n`);
      console.log(resumoEmTexto(visao, { falas }));
      if (visao.extracao) console.log(`\n(${visao.extracao.modelo} · prompt ${visao.extracao.versaoPrompt})`);

      const jobs = await banco.listarJobs({ dailyId: id });
      if (visao.status !== 'CONCLUIDA' && jobs.length) {
        console.log('\nJobs:');
        for (const j of jobs) console.log(`  ${j.tipo} ${j.status} (tentativas: ${j.tentativas})${j.ultimoErro ? ` — ${j.ultimoErro}` : ''}`);
      }
      if (resto.includes('--transcricao')) {
        console.log('\nTranscrição:');
        for (const f of falas) console.log(`  [F${f.id} ${formatarTempo(f.inicioMs)}] ${f.participante.nome}: ${f.texto}`);
      }
    }
  }
} finally {
  banco.fechar();
}
