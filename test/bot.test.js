// Serviço do bot sem Discord: conexão de voz falsa (com o AudioReceiveStream real), banco em
// memória e áudio em pasta temporária. O último teste liga o bot ao worker de ponta a ponta.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AudioReceiveStream } from '@discordjs/voice';
import { abrirBanco } from '../nucleo/sqlite/banco.js';
import { criarArmazenamentoDisco } from '../nucleo/armazenamento-disco.js';
import { ServicoDailies, ErroDaily } from '../bot/dailies.js';
import { comandoDaily } from '../bot/comandos.js';
import { executarProximo } from '../worker/processar.js';

// TOC 0xFC = CELT 20 ms, 1 frame → cada pacote vale 20 ms de áudio
const pacoteFalso = (i) => Buffer.from([0xfc, i & 0xff, 0xaa, 0xbb, 0xcc]);
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

function conexaoFalsa() {
  const subscriptions = new Map();
  return {
    state: { status: 'ready', networking: { state: { dave: { protocolVersion: 1, voicePrivacyCode: '123' } } } },
    receiver: {
      speaking: new EventEmitter(),
      subscriptions,
      subscribe(userId, options) {
        const s = new AudioReceiveStream({ end: options.end });
        s.once('close', () => subscriptions.delete(userId));
        subscriptions.set(userId, s);
        return s;
      },
    },
  };
}

const USUARIOS = {
  ana: { nome: 'Ana', bot: false },
  bruno: { nome: 'Bruno', bot: false },
  carla: { nome: 'Carla', bot: false },
  musica: { nome: 'Bot de música', bot: true },
};

async function ambiente(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'botmrx-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const banco = abrirBanco(':memory:');
  t.after(() => banco.fechar());
  const armazenamento = criarArmazenamentoDisco(dir);
  const servico = new ServicoDailies({ banco, armazenamento, opcoes: { silencioMs: 150, minSegmentoMs: 300 } });
  const conexao = conexaoFalsa();

  const iniciar = (presentes = ['ana', 'bruno', 'musica', 'carla']) =>
    servico.iniciar({
      guildId: 'g1',
      canalVozId: 'v1',
      canalVozNome: 'Daily Pagamentos',
      canalTextoId: 't1',
      conexao,
      presentes,
      resolverMembro: async (id) => USUARIOS[id],
    });

  /** Simula o receiver: dispara 'start' e empurra pacotes para quem tem assinatura. */
  const falar = async (userId, pacotes) => {
    conexao.receiver.speaking.emit('start', userId);
    await esperar(25); // tempo da assinatura ser criada
    for (let i = 0; i < pacotes; i++) {
      conexao.receiver.subscriptions.get(userId)?.push(pacoteFalso(i));
      await esperar(2);
    }
  };
  const presencas = (dailyId) =>
    banco.db
      .prepare(
        `SELECT p.NomeExibicao nome, dp.Gravado gravado, dp.SaiuEm IS NOT NULL saiu
           FROM DailyParticipantes dp JOIN Participantes p ON p.Id = dp.ParticipanteId WHERE dp.DailyId = ? ORDER BY p.NomeExibicao`,
      )
      .all(dailyId)
      .map((r) => ({ ...r }));

  return { dir, banco, armazenamento, servico, conexao, iniciar, falar, presencas };
}

test('comando /daily tem os subcomandos do contrato', () => {
  const json = comandoDaily.toJSON();
  assert.equal(json.name, 'daily');
  assert.deepEqual(json.options.map((o) => o.name), ['iniciar', 'encerrar', 'status', 'nao-gravar', 'gravar', 'gestor']);
  assert.deepEqual(json.options.at(-1).options.map((o) => [o.name, o.required ?? false]), [['cargo', false]]);
});

test('daily: grava um trecho por fala no banco, respeita opt-out e entrega ao worker', async (t) => {
  const { dir, banco, servico, iniciar, falar, presencas } = await ambiente(t);
  await servico.definirOptOut({ userId: 'carla', nome: 'Carla', naoGravar: true }); // opt-out de dias anteriores

  const ativa = await iniciar();
  const { dailyId } = ativa;
  assert.equal(ativa.time.nome, 'Daily Pagamentos');
  assert.equal((await banco.obterDaily(dailyId)).status, 'GRAVANDO');
  await assert.rejects(iniciar(), ErroDaily, 'só uma daily por servidor');
  assert.deepEqual(await presencas(dailyId), [
    { nome: 'Ana', gravado: 1, saiu: 0 },
    { nome: 'Bruno', gravado: 1, saiu: 0 },
    { nome: 'Carla', gravado: 0, saiu: 0 }, // presente, não gravada; o bot de música não entra
  ]);

  await falar('ana', 25); // 500 ms → grava
  await esperar(250); // silêncio > 150 ms fecha o trecho
  await falar('ana', 30); // segundo trecho
  await falar('bruno', 5); // 100 ms → curto demais, descartado
  await falar('musica', 30); // bot → ignorado
  await falar('carla', 30); // opt-out → nunca assinado
  await esperar(250);
  await servico.saiu('g1', 'bruno');
  await servico.entrou('g1', 'bruno'); // reentrada reabre a presença

  assert.deepEqual(ativa.sessao.dave(), { ativo: true, protocolVersion: 1 });
  const r = await servico.encerrar('g1');
  assert.equal(r.dailyId, dailyId);
  assert.equal(r.segmentos, 2);
  assert.equal(r.descartados, 1);
  assert.equal(r.erros, 0);
  assert.deepEqual(Object.keys(r.porUsuario), ['ana']);
  assert.equal(servico.ativa('g1'), null);
  assert.equal(await servico.encerrar('g1'), null);

  // banco: segmentos da Ana com o caminho do contrato, daily na fila de transcrição
  const segs = await banco.segmentosDaDaily(dailyId);
  assert.equal(segs.length, 2);
  assert.ok(segs.every((s) => s.nome === 'Ana' && s.status === 'PENDENTE' && s.formato === 'ogg'));
  assert.ok(segs[0].inicioMs < segs[1].inicioMs);
  assert.equal(segs[0].fimMs - segs[0].inicioMs, 25 * 20, 'fim = início + duração real do áudio');
  assert.equal(segs[0].caminho, path.join(dir, String(dailyId), `${segs[0].participanteId}-${segs[0].inicioMs}.ogg`));
  assert.equal((await readFile(segs[0].caminho)).subarray(0, 4).toString(), 'OggS');
  assert.equal((await readdir(path.join(dir, String(dailyId)))).length, 2, 'nada em disco de bots, opt-out ou trechos curtos');

  const d = await banco.obterDaily(dailyId);
  assert.equal(d.status, 'AGUARDANDO_TRANSCRICAO');
  assert.ok(d.encerradaEm);
  assert.deepEqual((await banco.listarJobs({ dailyId })).map((j) => [j.tipo, j.status]), [['TRANSCREVER', 'PENDENTE']]);
  assert.ok((await presencas(dailyId)).every((p) => p.saiu === 1), 'presenças fechadas no encerramento');

  // worker: o que o bot gravou vira transcrição, resumo e o áudio some
  const postados = [];
  const deps = {
    banco,
    armazenamento: criarArmazenamentoDisco(dir),
    transcrever: async (audio, nome) => (assert.equal(audio.subarray(0, 4).toString(), 'OggS'), `fala do arquivo ${nome}`),
    extrair: async (entrada) => {
      assert.deepEqual(entrada.participantes.map((p) => p.nome), ['Carla', 'Ana', 'Bruno']);
      return {
        resumo: {
          resumo_geral: 'Ana deu a atualização.',
          participantes: [{ participante_id: entrada.falas[0].participanteId, fez: [{ descricao: 'Falou', fala_ids: [entrada.falas[0].id] }], vai_fazer: [], bloqueios: [] }],
          decisoes: [], pendencias: [], bloqueios_resolvidos: [],
        },
        avisos: [], bruto: {}, meta: { modelo: 'falso', versaoPrompt: 'v-teste' },
      };
    },
    notificar: async (canal, msg) => void postados.push({ canal, msg }),
  };
  assert.equal((await executarProximo(deps)).ok, true);
  assert.equal((await executarProximo(deps)).ok, true);
  assert.equal((await banco.obterDaily(dailyId)).status, 'CONCLUIDA');
  assert.ok(!existsSync(segs[0].caminho) && !existsSync(segs[1].caminho));
  assert.equal(postados[0].canal, 't1');
  assert.match(postados[0].msg, /\*\*Ana\*\*\n- ✅ Falou/);
  assert.match(postados[0].msg, /Presentes sem atualização: Bruno/);
  assert.match(postados[0].msg, /Presentes, não gravados: Carla/);
});

test('opt-out no meio da daily: para de gravar e apaga o que já tinha sido gravado da pessoa', async (t) => {
  const { banco, servico, conexao, iniciar, falar, presencas } = await ambiente(t);
  const { dailyId } = await iniciar(['ana', 'bruno']);

  await falar('bruno', 25);
  await falar('ana', 25);
  await esperar(250);
  const antes = await banco.segmentosDaDaily(dailyId);
  assert.deepEqual(antes.map((s) => s.nome), ['Bruno', 'Ana']);
  const arquivoBruno = antes[0].caminho;
  assert.ok(existsSync(arquivoBruno));

  // Bruno começa a falar e pede para não ser gravado no meio da frase
  conexao.receiver.speaking.emit('start', 'bruno');
  await esperar(25);
  for (let i = 0; i < 20; i++) conexao.receiver.subscriptions.get('bruno').push(pacoteFalso(i));
  await servico.definirOptOut({ userId: 'bruno', nome: 'Bruno', naoGravar: true });
  await esperar(50);
  await falar('bruno', 30); // continua falando: nada é assinado
  await esperar(250);

  assert.ok(!existsSync(arquivoBruno));
  const depois = await banco.segmentosDaDaily(dailyId);
  assert.deepEqual(depois.map((s) => [s.nome, s.status, Boolean(s.apagadoEm)]), [['Bruno', 'DESCARTADO', true], ['Ana', 'PENDENTE', false]]);
  assert.deepEqual((await presencas(dailyId)).find((p) => p.nome === 'Bruno').gravado, 0);

  // /daily gravar: volta a ser gravado na mesma daily
  await servico.definirOptOut({ userId: 'bruno', nome: 'Bruno', naoGravar: false });
  await falar('bruno', 25);
  await esperar(250);
  await servico.encerrar('g1');
  const fim = await banco.segmentosDaDaily(dailyId, { status: 'PENDENTE' });
  assert.deepEqual(fim.map((s) => s.nome), ['Ana', 'Bruno']);
  assert.equal((await readdir(path.dirname(arquivoBruno))).length, 2);
});

test('bot caiu no meio: ao religar, a daily segue para o worker com o que já estava salvo', async (t) => {
  const { dir, banco, armazenamento, servico } = await ambiente(t);
  const time = await banco.obterOuCriarTime({ guildId: 'g1', canalVozId: 'v1', nome: 'Squad' });
  const ana = await banco.obterOuCriarParticipante({ discordUserId: 'ana', nome: 'Ana' });
  const daily = await banco.criarDaily({ timeId: time.id });
  await banco.registrarEntrada({ dailyId: daily.id, participanteId: ana.id, gravado: true });

  const salvo = armazenamento.caminhoSegmento(daily.id, ana.id, 1000);
  const incompleto = armazenamento.caminhoSegmento(daily.id, ana.id, 9000); // trecho aberto quando caiu
  await mkdir(path.dirname(salvo), { recursive: true });
  await writeFile(salvo, 'ok');
  await writeFile(incompleto, 'pela metade');
  await banco.registrarSegmento({ dailyId: daily.id, participanteId: ana.id, inicioMs: 1000, fimMs: 3000, caminho: salvo });

  assert.deepEqual(await servico.recuperarOrfas(), [daily.id]);
  assert.ok(existsSync(salvo));
  assert.ok(!existsSync(incompleto));
  assert.equal((await banco.obterDaily(daily.id)).status, 'AGUARDANDO_TRANSCRICAO');
  assert.equal((await banco.listarJobs({ dailyId: daily.id })).length, 1);
  assert.deepEqual(await servico.recuperarOrfas(), [], 'não repete');
  assert.ok(dir);
});
