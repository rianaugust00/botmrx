#!/usr/bin/env node
// Dashboard com dados fictícios, para ver o visual sem depender de dailies reais:
//   npm run demo      → http://127.0.0.1:3001  (sem login, banco separado em dados/demo.db)
// Não toca no banco de verdade nem chama Discord, transcrição ou LLM.
import { rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { abrirBanco } from '../nucleo/sqlite/banco.js';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const caminho = path.join(raiz, 'dados/demo.db');
for (const s of ['', '-wal', '-shm']) rmSync(caminho + s, { force: true });
let agora = new Date();
const banco = abrirBanco(caminho, { agora: () => agora });
const time = await banco.obterOuCriarTime({ guildId: 'g', canalVozId: 'v', canalTextoId: 't', nome: 'Squad Pagamentos' });
await banco.obterOuCriarTime({ guildId: 'g', canalVozId: 'v2', nome: 'Squad Cartões' });
const P = {};
for (const n of ['Ana Souza', 'Bruno Lima', 'Carla Mendes', 'Diego Rocha', 'Eduardo Pires']) P[n.split(' ')[0]] = await banco.obterOuCriarParticipante({ discordUserId: n, nome: n });
const felipe = await banco.definirNaoGravar({ discordUserId: 'f', nome: 'Felipe Nunes', naoGravar: true });
const meta = { modelo: 'openai/gpt-oss-120b', versaoPrompt: 'extracao-v1' };

async function daily(dia, falas, montar, presentes = Object.values(P)) {
  agora = new Date(`2026-11-${dia}T12:30:00Z`);
  const d = await banco.criarDaily({ timeId: time.id });
  for (const p of presentes) await banco.registrarEntrada({ dailyId: d.id, participanteId: p.id, gravado: !p.naoGravar });
  agora = new Date(agora.getTime() + 17 * 60_000);
  await banco.encerrarGravacao({ dailyId: d.id });
  let t = 2000;
  await banco.salvarTranscricao({ dailyId: d.id, segmentos: [], falas: falas.map(([p, texto]) => { const f = { participanteId: P[p].id, inicioMs: t, fimMs: t + 9000, texto }; t += 14000; return f; }) });
  const f = (await banco.transcricao(d.id)).map((x) => x.id);
  const ab = (await banco.entradaExtracao(d.id)).bloqueiosAbertos;
  await banco.salvarExtracao({ dailyId: d.id, bruto: {}, meta, resumo: { resumo_geral: '', participantes: [], decisoes: [], pendencias: [], bloqueios_resolvidos: [], ...montar(f, ab) } });
}
const i = (descricao, ...fala_ids) => ({ descricao, fala_ids });
const pes = (nome, fez, vai, bloq = []) => ({ participante_id: P[nome].id, fez, vai_fazer: vai, bloqueios: bloq });

await daily('11', [['Ana', 'Ontem fechei o layout da tela de extrato.'], ['Bruno', 'Estou sem acesso ao ambiente de homologação do banco, não consigo testar o webhook.'], ['Carla', 'Preciso de massa de testes para a regressão de cartão.']], (f) => ({
  resumo_geral: 'Ana fechou o layout do extrato. Bruno e Carla relataram bloqueios de acesso e de massa de testes.',
  participantes: [pes('Ana', [i('Fechou o layout da tela de extrato', f[0])], []), pes('Bruno', [], [], [{ ...i('Sem acesso ao ambiente de homologação do banco', f[1]), bloqueio_existente_id: null }]), pes('Carla', [], [], [{ ...i('Sem massa de testes para a regressão de cartão', f[2]), bloqueio_existente_id: null }])],
}));
await daily('12', [['Ana', 'Terminei a tela de extrato e abri o pull request.'], ['Bruno', 'Continuo sem acesso à homologação, hoje vou adiantar os testes unitários do webhook.'], ['Diego', 'Vou cobrar a infra sobre o acesso do Bruno até o fim do dia.'], ['Eduardo', 'Subi a nova versão do pipeline, o deploy ficou três minutos mais rápido.']], (f, ab) => ({
  resumo_geral: 'Extrato em revisão e pipeline mais rápido. O acesso do Bruno à homologação segue pendente; Diego vai cobrar a infra.',
  participantes: [pes('Ana', [i('Terminou a tela de extrato e abriu o pull request', f[0])], []), pes('Bruno', [], [i('Vai adiantar os testes unitários do webhook', f[1])], [{ ...i('Segue sem acesso à homologação do banco', f[1]), bloqueio_existente_id: ab.find((b) => /homolog/.test(b.descricao)).id }]), pes('Eduardo', [i('Subiu a nova versão do pipeline; deploy 3 min mais rápido', f[3])], [])],
  pendencias: [{ ...i('Cobrar a infra sobre o acesso do Bruno', f[2]), responsavel_id: P.Diego.id, prazo: 'até o fim do dia' }],
}), [P.Ana, P.Bruno, P.Diego, P.Eduardo]);
await daily('13', [
  ['Diego', 'Bom dia, pessoal. Vamos lá, quem quer começar?'],
  ['Ana', 'Ontem o pull request do extrato foi aprovado. Hoje começo os testes de integração com o Pix.'],
  ['Bruno', 'O problema continua, ainda sem acesso à homologação. Terminei os testes unitários do webhook.'],
  ['Carla', 'Recebi a massa de testes ontem à tarde, já rodei metade da regressão de cartão. Hoje termino.'],
  ['Eduardo', 'Hoje vou configurar os alertas do novo pipeline. Preciso que alguém revise a documentação.'],
  ['Diego', 'Combinado então: o deploy fica para quinta. Bruno, atualiza a doc depois que validar.'],
  ['Bruno', 'Fechado, atualizo a documentação assim que conseguir validar em homologação.'],
], (f, ab) => ({
  resumo_geral: 'O extrato foi aprovado e Ana parte para os testes de integração com o Pix. Carla destravou a regressão de cartão. Bruno segue sem acesso à homologação, e o time decidiu fazer o deploy na quinta.',
  participantes: [
    pes('Ana', [i('Teve o pull request do extrato aprovado', f[1])], [i('Vai começar os testes de integração com o Pix', f[1])]),
    pes('Bruno', [i('Terminou os testes unitários do webhook', f[2])], [i('Vai atualizar a documentação depois de validar', f[6])], [{ ...i('Ainda sem acesso à homologação do banco', f[2]), bloqueio_existente_id: ab.find((b) => /homolog/.test(b.descricao)).id }]),
    pes('Carla', [i('Rodou metade da regressão de cartão', f[3])], [i('Vai terminar a regressão hoje', f[3])]),
    pes('Eduardo', [], [i('Vai configurar os alertas do novo pipeline', f[4])], [{ ...i('Precisa de alguém para revisar a documentação do pipeline', f[4]), bloqueio_existente_id: null }]),
  ],
  decisoes: [i('O deploy fica para quinta-feira', f[5])],
  pendencias: [{ ...i('Atualizar a documentação depois de validar em homologação', f[5], f[6]), responsavel_id: P.Bruno.id, prazo: 'depois da validação' }, { ...i('Revisar a documentação do novo pipeline', f[4]), responsavel_id: null, prazo: null }],
  bloqueios_resolvidos: [{ bloqueio_id: ab.find((b) => /massa/.test(b.descricao)).id, fala_ids: [f[3]] }],
}), [...Object.values(P), felipe]);
banco.fechar();

const porta = process.env.DEMO_PORT || '3001';
console.log(`Dados fictícios criados em ${caminho}`);
const painel = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(raiz, 'api/index.js')], {
  cwd: raiz,
  stdio: 'inherit',
  // Sem login e sem LLM: é só para ver a tela.
  env: { ...process.env, SQLITE_PATH: caminho, API_PORT: porta, API_HOST: '127.0.0.1', DISCORD_CLIENT_SECRET: '', LLM_PROVEDOR: 'desligado' },
});
for (const sinal of ['SIGINT', 'SIGTERM']) process.on(sinal, () => painel.kill(sinal));
painel.on('exit', (codigo) => process.exit(codigo ?? 0));
