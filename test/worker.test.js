// Banco, fila e pipeline do worker. Sem rede: transcrição, Claude e Discord são simulados.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { abrirBanco } from '../nucleo/sqlite/banco.js';
import { criarArmazenamentoDisco } from '../nucleo/armazenamento-disco.js';
import { criarExtrator } from '../worker/extrator.js';
import { executarProximo } from '../worker/processar.js';
import { resumoEmTexto, dividirMensagem } from '../worker/resumo-texto.js';
import { criarNotificadorDiscord } from '../worker/notificador-discord.js';

const MIN = 60_000;

/** Relógio controlado pelo teste. */
function relogio(inicio = '2026-11-16T12:30:00.000Z') {
  let t = new Date(inicio).getTime();
  const agora = () => new Date(t);
  agora.avancar = (ms) => (t += ms);
  return agora;
}

/** Cliente Anthropic falso: devolve o JSON produzido por `responder(mensagemDoUsuario)`. */
function clienteFalso(responder) {
  const chamadas = [];
  return {
    chamadas,
    beta: {
      messages: {
        async create(req) {
          chamadas.push(req);
          const r = responder(req.messages[0].content, req);
          if (r.stop_reason) return r;
          return {
            model: req.model,
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: JSON.stringify(r) }],
            usage: { input_tokens: 100, output_tokens: 50 },
          };
        },
      },
    },
  };
}

const resumoVazio = { resumo_geral: 'Daily curta.', participantes: [], decisoes: [], pendencias: [], bloqueios_resolvidos: [] };

async function ambiente(t, { responder = () => resumoVazio, textos = {} } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'botmrx-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const agora = relogio();
  const banco = abrirBanco(':memory:', { agora });
  t.after(() => banco.fechar());
  const armazenamento = criarArmazenamentoDisco(dir);
  const postados = [];
  const client = clienteFalso(responder);
  const deps = {
    banco,
    armazenamento,
    // O "áudio" de teste é o próprio texto; `textos` permite simular vazio/erro por conteúdo.
    transcrever: async (audio) => {
      const fala = audio.toString();
      if (textos[fala] instanceof Error) throw textos[fala];
      return textos[fala] ?? fala;
    },
    extrair: criarExtrator({ client }),
    notificar: async (canal, msg) => void postados.push({ canal, msg }),
    opcoes: { maxTentativas: 3 },
    agora,
  };

  const time = await banco.obterOuCriarTime({ guildId: 'g1', canalVozId: 'v1', canalTextoId: 't1', nome: 'Squad Pagamentos' });
  const ana = await banco.obterOuCriarParticipante({ discordUserId: 'u-ana', nome: 'Ana' });
  const bruno = await banco.obterOuCriarParticipante({ discordUserId: 'u-bruno', nome: 'Bruno' });

  /** Cria uma daily já encerrada, com um segmento de áudio por fala `[participante, inicioMs, fimMs, texto]`. */
  async function gravarDaily(falas, presentes = [ana, bruno]) {
    const daily = await banco.criarDaily({ timeId: time.id });
    for (const p of presentes) await banco.registrarEntrada({ dailyId: daily.id, participanteId: p.id, gravado: !p.naoGravar });
    for (const [p, inicioMs, fimMs, texto] of falas) {
      const caminho = armazenamento.caminhoSegmento(daily.id, p.id, inicioMs);
      await mkdir(path.dirname(caminho), { recursive: true });
      await writeFile(caminho, texto);
      await banco.registrarSegmento({ dailyId: daily.id, participanteId: p.id, inicioMs, fimMs, caminho });
    }
    agora.avancar(15 * MIN);
    await banco.encerrarGravacao({ dailyId: daily.id });
    return daily;
  }

  /** Roda jobs até a fila esvaziar (sem avançar o relógio, então não pega retries com backoff). */
  async function esvaziarFila() {
    const feitos = [];
    for (let r; (r = await executarProximo(deps)); ) feitos.push(r);
    return feitos;
  }

  return { banco, armazenamento, deps, agora, time, ana, bruno, postados, client, gravarDaily, esvaziarFila, dir };
}

// ------------------------------------------------------------------ fila

test('fila: reserva em ordem, não entrega o mesmo job duas vezes e recupera reserva expirada', async (t) => {
  const { banco, agora } = await ambiente(t);
  const a = await banco.enfileirar('TRANSCREVER');
  agora.avancar(10);
  const b = await banco.enfileirar('EXTRAIR');
  await banco.enfileirar('OUTRO_TIPO');

  const j1 = await banco.reservarProximo(['TRANSCREVER', 'EXTRAIR'], 'w1', 10);
  const j2 = await banco.reservarProximo(['TRANSCREVER', 'EXTRAIR'], 'w2', 10);
  assert.deepEqual([j1.id, j2.id], [a, b]);
  assert.equal(j1.tentativas, 1);
  assert.equal(await banco.reservarProximo(['TRANSCREVER', 'EXTRAIR'], 'w3', 10), null);

  await banco.concluir(j1.id);
  agora.avancar(11 * MIN); // w2 caiu: a reserva do job b expirou
  const j3 = await banco.reservarProximo(['TRANSCREVER', 'EXTRAIR'], 'w3', 10);
  assert.equal(j3.id, b);
  assert.equal(j3.tentativas, 2);
  assert.equal(await banco.reservarProximo(['TRANSCREVER', 'EXTRAIR'], 'w1', 10), null, 'job concluído não volta');
});

test('fila: falha aplica backoff exponencial e desiste depois do máximo de tentativas', async (t) => {
  const { banco, agora } = await ambiente(t);
  const id = await banco.enfileirar('EXTRAIR');
  const reservar = () => banco.reservarProximo(['EXTRAIR'], 'w', 10);

  await reservar();
  assert.equal(await banco.falhar(id, 'erro 1', 3), 'PENDENTE');
  assert.equal(await reservar(), null, 'ainda no backoff de 1 min');
  agora.avancar(1 * MIN);
  assert.equal((await reservar()).tentativas, 2);
  assert.equal(await banco.falhar(id, 'erro 2', 3), 'PENDENTE');
  agora.avancar(1 * MIN);
  assert.equal(await reservar(), null, 'segundo backoff é de 2 min');
  agora.avancar(1 * MIN);
  assert.equal((await reservar()).tentativas, 3);
  assert.equal(await banco.falhar(id, 'erro 3', 3), 'FALHOU');
  agora.avancar(60 * MIN);
  assert.equal(await reservar(), null);
  assert.equal((await banco.listarJobs())[0].ultimoErro, 'erro 3');
});

test('enfileirarSeAusente não duplica job pendente', async (t) => {
  const { banco } = await ambiente(t);
  assert.ok(await banco.enfileirarSeAusente('LIMPAR_RETENCAO'));
  assert.equal(await banco.enfileirarSeAusente('LIMPAR_RETENCAO'), null);
});

// ------------------------------------------------------------------ pipeline

test('pipeline: gravação encerrada → transcrição → extração → resumo postado', async (t) => {
  const responder = (msg) => {
    // A mensagem segue o formato do prompt versionado e traz os ids reais do banco.
    assert.match(msg, /^Time: Squad Pagamentos\nData da daily: 2026-11-16/);
    const f = [...msg.matchAll(/\[F(\d+) \| (\d\d:\d\d) \| (\w+)\] (.*)/g)].map((m) => ({ id: Number(m[1]), nome: m[3], texto: m[4] }));
    assert.deepEqual(f.map((x) => x.nome), ['Ana', 'Bruno', 'Ana']);
    assert.equal(f[0].texto, 'Ontem terminei a tela de extrato. Hoje começo os testes.', 'trechos seguidos da Ana viram uma fala');
    return {
      resumo_geral: 'Ana fechou o extrato; Bruno segue sem acesso.',
      participantes: [
        { participante_id: 1, fez: [{ descricao: 'Terminou a tela de extrato', fala_ids: [f[0].id] }],
          vai_fazer: [{ descricao: 'Vai começar os testes', fala_ids: [f[0].id, f[2].id] }], bloqueios: [] },
        { participante_id: 2, fez: [{ descricao: 'Item inventado', fala_ids: [9999] }], vai_fazer: [],
          bloqueios: [{ descricao: 'Sem acesso à homologação', bloqueio_existente_id: null, fala_ids: [f[1].id] }] },
      ],
      decisoes: [{ descricao: 'Deploy fica para quinta', fala_ids: [f[2].id] }],
      pendencias: [{ descricao: 'Pedir acesso à homologação', responsavel_id: 2, prazo: 'hoje', fala_ids: [f[1].id] }],
      bloqueios_resolvidos: [],
    };
  };
  const { banco, ana, bruno, postados, client, gravarDaily, esvaziarFila, deps } = await ambiente(t, { responder, textos: { ruido: '' } });

  const carla = await banco.definirNaoGravar({ discordUserId: 'u-carla', nome: 'Carla', naoGravar: true });
  const daily = await gravarDaily(
    [
      [ana, 5000, 9000, 'Ontem terminei a tela de extrato.'],
      [ana, 9800, 12000, 'Hoje começo os testes.'], // 0,8 s depois: junta com a anterior
      [bruno, 14000, 20000, 'Continuo sem acesso à homologação.'],
      [bruno, 21000, 21700, 'ruido'], // transcrição vazia → descartado
      [ana, 30000, 33000, 'Então o deploy fica para quinta.'],
    ],
    [ana, bruno, carla],
  );
  assert.equal((await banco.obterDaily(daily.id)).status, 'AGUARDANDO_TRANSCRICAO');
  const caminhos = (await banco.segmentosDaDaily(daily.id)).map((s) => s.caminho);
  assert.ok(caminhos.every((c) => existsSync(c)));

  const feitos = await esvaziarFila();
  assert.deepEqual(feitos.map((r) => [r.job.tipo, r.ok]), [['TRANSCREVER', true], ['EXTRAIR', true]]);
  assert.deepEqual(feitos[0].resultado, { pulada: false, falas: 3, segmentos: 5, descartados: 1, audiosApagados: 5 });

  // D5: áudio apagado depois da transcrição
  assert.ok(caminhos.every((c) => !existsSync(c)));
  const segs = await banco.segmentosDaDaily(daily.id);
  assert.deepEqual(segs.map((s) => s.status), ['TRANSCRITO', 'TRANSCRITO', 'TRANSCRITO', 'DESCARTADO', 'TRANSCRITO']);
  assert.ok(segs.every((s) => s.apagadoEm));

  // chamada ao Claude: saída estruturada, effort e fallback de recusa
  const req = client.chamadas[0];
  assert.equal(req.model, 'claude-opus-5-5');
  assert.equal(req.output_config.format.type, 'json_schema');
  assert.equal(req.output_config.effort, 'medium');
  assert.equal(req.fallbacks, 'default');

  const v = await banco.visaoDaily(daily.id);
  assert.equal(v.status, 'CONCLUIDA');
  assert.equal(v.resumoGeral, 'Ana fechou o extrato; Bruno segue sem acesso.');
  assert.deepEqual(v.presentes, [
    { id: ana.id, nome: 'Ana', gravado: true },
    { id: bruno.id, nome: 'Bruno', gravado: true },
    { id: carla.id, nome: 'Carla', gravado: false },
  ]);
  const [pAna, pBruno] = v.pessoas;
  assert.equal(pAna.fez[0].descricao, 'Terminou a tela de extrato');
  assert.equal(pAna.vaiFazer[0].falaIds.length, 2);
  assert.deepEqual(pBruno.fez, [], 'D6: item sem fala que o sustente é descartado');
  assert.equal(pBruno.bloqueios[0].novo, true);
  assert.equal(v.decisoes[0].descricao, 'Deploy fica para quinta');
  assert.deepEqual(v.pendencias[0].responsavel, { id: bruno.id, nome: 'Bruno' });
  assert.equal(v.pendencias[0].prazo, 'hoje');
  assert.deepEqual(v.extracao, { modelo: 'claude-opus-5-5', versaoPrompt: 'extracao-v1' });

  const transcricao = await banco.transcricao(daily.id);
  assert.equal(transcricao.length, 3);
  assert.deepEqual(pAna.fez[0].falaIds, [transcricao[0].id], 'o item leva à fala de origem');

  // resumo postado no canal de texto do time
  assert.equal(postados.length, 1);
  assert.equal(postados[0].canal, 't1');
  assert.match(postados[0].msg, /📋 \*\*Daily 16\/11\/2026 · Squad Pagamentos\*\*/);
  assert.match(postados[0].msg, /\*\*Bruno\*\*\n- ⛔ Sem acesso à homologação/);
  assert.match(postados[0].msg, /- Pedir acesso à homologação — Bruno · hoje/);
  assert.match(postados[0].msg, /Presentes, não gravados: Carla/);
  assert.doesNotMatch(postados[0].msg, /Item inventado/);

  // rodar de novo os mesmos jobs não muda nada (idempotência)
  await banco.enfileirar('TRANSCREVER', daily.id);
  await banco.enfileirar('EXTRAIR', daily.id);
  const repetidos = await esvaziarFila();
  assert.ok(repetidos.every((r) => r.ok && r.resultado.pulada));
  assert.equal((await banco.transcricao(daily.id)).length, 3);
  assert.equal(postados.length, 1);
  assert.equal(client.chamadas.length, 1);
  assert.equal(deps.opcoes.maxTentativas, 3);
});

test('daily sem falas é concluída sem chamar o LLM', async (t) => {
  const { banco, client, postados, gravarDaily, esvaziarFila } = await ambiente(t);
  const daily = await gravarDaily([]);
  await esvaziarFila();
  const v = await banco.visaoDaily(daily.id);
  assert.equal(v.status, 'CONCLUIDA');
  assert.match(v.resumoGeral, /Nenhuma fala/);
  assert.equal(client.chamadas.length, 0);
  assert.equal(postados.length, 1);
});

test('bloqueios atravessam dailies: novo → continua → resolvido; reextração não duplica', async (t) => {
  let roteiro;
  const responder = (msg) => roteiro(msg, [...msg.matchAll(/\[F(\d+) \|/g)].map((m) => Number(m[1])));
  const { banco, agora, time, bruno, gravarDaily, esvaziarFila } = await ambiente(t, { responder });
  const bloco = (bloqueios, resolvidos = []) => ({
    ...resumoVazio,
    participantes: [{ participante_id: bruno.id, fez: [], vai_fazer: [], bloqueios }],
    bloqueios_resolvidos: resolvidos,
  });
  const abertos = () => banco.db.prepare(`SELECT Id, Status, PrimeiraDailyId p, UltimaDailyId u, ResolvidoNaDailyId r FROM Bloqueios ORDER BY Id`).all().map((b) => ({ ...b }));

  // Dia 1: bloqueio novo
  roteiro = (msg, f) => {
    assert.match(msg, /Bloqueios em aberto[^\n]*\n\(nenhum\)/);
    return bloco([{ descricao: 'Sem acesso à homologação', bloqueio_existente_id: null, fala_ids: f }]);
  };
  const d1 = await gravarDaily([[bruno, 1000, 4000, 'Estou sem acesso à homologação.']]);
  await esvaziarFila();
  const [b] = abertos();
  assert.deepEqual(b, { Id: b.Id, Status: 'ABERTO', p: d1.id, u: d1.id, r: null });

  // Dia 2: o LLM recebe o bloqueio em aberto e diz que continua
  agora.avancar(24 * 60 * MIN);
  roteiro = (msg, f) => {
    assert.match(msg, new RegExp(`- ${b.Id} \\| Bruno \\| 2026-11-16 \\| Sem acesso à homologação`));
    return bloco([{ descricao: 'Segue sem acesso à homologação', bloqueio_existente_id: b.Id, fala_ids: f }]);
  };
  const d2 = await gravarDaily([[bruno, 1000, 4000, 'Ainda sem acesso.']]);
  await esvaziarFila();
  assert.deepEqual(abertos(), [{ Id: b.Id, Status: 'ABERTO', p: d1.id, u: d2.id, r: null }]);
  const v2 = await banco.visaoDaily(d2.id);
  assert.deepEqual(
    { novo: v2.pessoas[0].bloqueios[0].novo, desde: v2.pessoas[0].bloqueios[0].desde },
    { novo: false, desde: '2026-11-16' },
  );
  assert.match(resumoEmTexto(v2), /⛔ Segue sem acesso à homologação \(em aberto desde 16\/11\)/);

  // Reextrair o dia 2 (prompt novo) não duplica nem perde o bloqueio
  await banco.reprocessar(d2.id, 'EXTRAIR');
  await esvaziarFila();
  assert.deepEqual(abertos(), [{ Id: b.Id, Status: 'ABERTO', p: d1.id, u: d2.id, r: null }]);
  assert.equal(banco.db.prepare('SELECT COUNT(*) n FROM ExtracoesLlm WHERE DailyId = ? AND Ativa = 1').get(d2.id).n, 1);
  assert.equal(banco.db.prepare('SELECT COUNT(*) n FROM ExtracoesLlm WHERE DailyId = ?').get(d2.id).n, 2);
  assert.equal((await banco.visaoDaily(d2.id)).pessoas[0].bloqueios.length, 1);

  // Dia 3: resolvido; um id de bloqueio inexistente é ignorado
  agora.avancar(24 * 60 * MIN);
  roteiro = (msg, f) => ({ ...resumoVazio, bloqueios_resolvidos: [{ bloqueio_id: b.Id, fala_ids: f }, { bloqueio_id: 777, fala_ids: f }] });
  const d3 = await gravarDaily([[bruno, 1000, 4000, 'Liberaram meu acesso ontem.']]);
  await esvaziarFila();
  assert.deepEqual(abertos(), [{ Id: b.Id, Status: 'RESOLVIDO', p: d1.id, u: d3.id, r: d3.id }]);
  const v3 = await banco.visaoDaily(d3.id);
  assert.equal(v3.bloqueiosResolvidos[0].descricao, 'Sem acesso à homologação');
  assert.match(resumoEmTexto(v3), /🟢 Sem acesso à homologação \(Bruno\)/);

  // Dia 4: bloqueio resolvido não é mais enviado ao LLM
  agora.avancar(24 * 60 * MIN);
  roteiro = (msg) => (assert.match(msg, /\(nenhum\)/), resumoVazio);
  await gravarDaily([[bruno, 1000, 4000, 'Tudo certo.']]);
  await esvaziarFila();

  // Reextrair o dia 3 volta a receber o bloqueio como "em aberto" e pode resolvê-lo de novo
  roteiro = (msg, f) => {
    assert.match(msg, new RegExp(`- ${b.Id} \\| Bruno`));
    return { ...resumoVazio, bloqueios_resolvidos: [{ bloqueio_id: b.Id, fala_ids: f }] };
  };
  await banco.reprocessar(d3.id, 'EXTRAIR');
  await esvaziarFila();
  assert.deepEqual(abertos(), [{ Id: b.Id, Status: 'RESOLVIDO', p: d1.id, u: d3.id, r: d3.id }]);
  assert.equal(time.id, 1);
});

test('falha do provedor: job tenta de novo com backoff; depois do limite a daily vai para ERRO', async (t) => {
  const { banco, agora, ana, postados, gravarDaily, deps } = await ambiente(t, { textos: { quebra: new Error('Transcrição falhou (503)') } });
  const daily = await gravarDaily([[ana, 1000, 3000, 'quebra']]);
  const caminho = (await banco.segmentosDaDaily(daily.id))[0].caminho;

  for (const tentativa of [1, 2, 3]) {
    const r = await executarProximo(deps);
    assert.equal(r.ok, false);
    assert.equal(r.statusJob, tentativa < 3 ? 'PENDENTE' : 'FALHOU');
    assert.equal((await banco.obterDaily(daily.id)).status, tentativa < 3 ? 'TRANSCREVENDO' : 'ERRO');
    agora.avancar(10 * MIN);
  }
  assert.equal(await executarProximo(deps), null);
  const d = await banco.obterDaily(daily.id);
  assert.match(d.erroMensagem, /503/);
  assert.ok(existsSync(caminho), 'áudio é mantido para reprocessar');
  assert.match(postados.at(-1).msg, /⚠️ Não foi possível processar esta daily/);

  // Provedor voltou: reprocessar a partir da transcrição funciona
  deps.transcrever = async () => 'Agora foi.';
  await banco.reprocessar(daily.id, 'TRANSCREVER');
  assert.equal((await executarProximo(deps)).ok, true);
  assert.equal((await executarProximo(deps)).ok, true);
  assert.equal((await banco.obterDaily(daily.id)).status, 'CONCLUIDA');
  assert.ok(!existsSync(caminho));
  await assert.rejects(banco.reprocessar(daily.id, 'TRANSCREVER'), /áudio da daily .* já foi apagado/);
});

test('extrator: recusa do modelo vira erro claro e o job fica para nova tentativa', async (t) => {
  const { banco, ana, gravarDaily, deps } = await ambiente(t, {
    responder: () => ({ stop_reason: 'refusal', stop_details: { category: 'cyber', explanation: 'x' }, content: [], usage: {} }),
  });
  const daily = await gravarDaily([[ana, 1000, 3000, 'Oi.']]);
  assert.equal((await executarProximo(deps)).ok, true);
  const r = await executarProximo(deps);
  assert.equal(r.ok, false);
  assert.match(r.erro, /recusou a extração \(cyber\)/);
  assert.equal((await banco.obterDaily(daily.id)).status, 'EXTRAINDO');
});

test('retenção: apaga transcrições antigas e áudio de dailies paradas, mantém o resumo', async (t) => {
  const responder = (msg) => {
    const f = [...msg.matchAll(/\[F(\d+) \|/g)].map((m) => Number(m[1]));
    return { ...resumoVazio, decisoes: [{ descricao: 'Decisão antiga', fala_ids: f }] };
  };
  const { banco, agora, ana, gravarDaily, esvaziarFila, deps } = await ambiente(t, { responder, textos: { quebra: new Error('fora do ar') } });
  deps.opcoes = { maxTentativas: 1, retencaoTranscricaoDias: 30, retencaoAudioParadoDias: 7 };

  const antiga = await gravarDaily([[ana, 1000, 3000, 'Decidimos X.']]);
  await esvaziarFila();
  const parada = await gravarDaily([[ana, 1000, 3000, 'quebra']]);
  await esvaziarFila(); // falha de primeira → ERRO, áudio fica
  const audioParado = (await banco.segmentosDaDaily(parada.id))[0].caminho;
  assert.ok(existsSync(audioParado));

  agora.avancar(31 * 24 * 60 * MIN);
  const recente = await gravarDaily([[ana, 1000, 3000, 'Decidimos Y.']]);
  await esvaziarFila();

  await banco.enfileirar('LIMPAR_RETENCAO');
  const [r] = await esvaziarFila();
  assert.deepEqual(r.resultado, { falasApagadas: 1, audiosApagados: 1 });
  assert.ok(!existsSync(audioParado));
  assert.equal((await banco.transcricao(antiga.id)).length, 0);
  assert.equal((await banco.transcricao(recente.id)).length, 1);
  const v = await banco.visaoDaily(antiga.id);
  assert.equal(v.decisoes[0].descricao, 'Decisão antiga');
  assert.deepEqual(v.decisoes[0].falaIds, []);

  // a próxima limpeza já fica agendada para o dia seguinte
  const proxima = (await banco.listarJobs()).filter((j) => j.tipo === 'LIMPAR_RETENCAO' && j.status === 'PENDENTE');
  assert.equal(proxima.length, 1);
  assert.equal(await executarProximo(deps), null);
});

// ------------------------------------------------------------------ Discord (texto)

test('dividirMensagem respeita o limite quebrando em linhas', () => {
  const texto = Array.from({ length: 50 }, (_, i) => `linha ${i} ${'x'.repeat(90)}`).join('\n');
  const partes = dividirMensagem(texto, 2000);
  assert.ok(partes.length > 1);
  assert.ok(partes.every((p) => p.length <= 2000));
  assert.equal(partes.join('\n'), texto);
  assert.deepEqual(dividirMensagem('a'.repeat(4500), 2000).map((p) => p.length), [2000, 2000, 500]);
});

test('notificador: posta em partes, sem permitir menções', async () => {
  const pedidos = [];
  const postar = criarNotificadorDiscord({
    token: 'tok',
    fetch: async (url, init) => (pedidos.push({ url, init }), { ok: true }),
  });
  await postar('123', `@everyone ${'a'.repeat(2500)}`);
  assert.equal(pedidos.length, 2);
  assert.equal(pedidos[0].url, 'https://discord.com/api/v10/channels/123/messages');
  assert.equal(pedidos[0].init.headers.Authorization, 'Bot tok');
  assert.deepEqual(JSON.parse(pedidos[0].init.body).allowed_mentions, { parse: [] });

  const falha = criarNotificadorDiscord({ token: 'tok', fetch: async () => ({ ok: false, status: 403, text: async () => 'Missing Access' }) });
  await assert.rejects(falha('1', 'oi'), /403.*Missing Access/);
});
