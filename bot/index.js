// Serviço Bot: entra no canal de voz, grava o áudio de cada pessoa e entrega a daily ao worker.
// Aqui fica só a adaptação do Discord; as regras estão em dailies.js e captura.js.

import { Client, Events, GatewayIntentBits, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { VoiceConnectionStatus, entersState, joinVoiceChannel } from '@discordjs/voice';
import { config } from '../nucleo/config.js';
import { abrirBanco } from '../nucleo/sqlite/banco.js';
import { criarArmazenamentoDisco } from '../nucleo/armazenamento-disco.js';
import { dataBr } from '../nucleo/tempo.js';
import { ServicoDailies, ErroDaily } from './dailies.js';
import { AVISO_GRAVACAO, comandoDaily, rotuloStatus } from './comandos.js';

if (!config.discord.token) {
  console.error('Defina DISCORD_BOT_TOKEN no arquivo .env (veja .env.example).');
  process.exit(1);
}

const log = (msg) => console.log(`${new Date().toISOString().slice(11, 19)} ${msg}`);
const banco = abrirBanco(config.banco.caminho);
const servico = new ServicoDailies({
  banco,
  armazenamento: criarArmazenamentoDisco(config.audio.pasta),
  opcoes: { silencioMs: config.audio.silencioMs, minSegmentoMs: config.audio.minSegmentoMs },
  log,
});

/** Conexão de voz e temporizador de cada daily em andamento (por guild). */
const conexoes = new Map();
const efemera = (content) => ({ content, flags: MessageFlags.Ephemeral });

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });

const registrarComandos = (guild) =>
  // create() faz upsert pelo nome e não mexe nos outros comandos do servidor
  guild.commands.create(comandoDaily.toJSON()).catch((e) => console.error(`  falha ao registrar /daily em ${guild.name}:`, e.message));

client.once(Events.ClientReady, async (c) => {
  const orfas = await servico.recuperarOrfas();
  if (orfas.length) log(`Dailies interrompidas enviadas para processamento: ${orfas.join(', ')}`);
  log(`Conectado como ${c.user.tag}. Registrando /daily em ${c.guilds.cache.size} servidor(es)...`);
  for (const guild of c.guilds.cache.values()) await registrarComandos(guild);
  log('Pronto. Use /daily iniciar estando num canal de voz.');
});

client.on(Events.GuildCreate, async (guild) => {
  log(`Adicionado ao servidor ${guild.name}.`);
  await registrarComandos(guild);
});

client.on(Events.InteractionCreate, async (i) => {
  if (!i.isChatInputCommand() || i.commandName !== 'daily' || !i.inGuild()) return;
  try {
    const sub = i.options.getSubcommand();
    if (sub === 'iniciar') await iniciar(i);
    else if (sub === 'encerrar') await comandoEncerrar(i);
    else if (sub === 'status') await status(i);
    else if (sub === 'nao-gravar') await optOut(i, true);
    else if (sub === 'gravar') await optOut(i, false);
    else if (sub === 'gestor') await definirGestor(i);
  } catch (e) {
    if (!(e instanceof ErroDaily)) console.error(e);
    const msg = efemera(e instanceof ErroDaily ? e.message : `Erro: ${e.message}`);
    await (i.deferred || i.replied ? i.followUp(msg) : i.reply(msg)).catch(() => {});
  }
});

client.on(Events.VoiceStateUpdate, async (antes, depois) => {
  const guildId = depois.guild.id;
  const ativa = servico.ativa(guildId);
  if (!ativa || antes.channelId === depois.channelId) return;
  try {
    if (depois.channelId === ativa.canalVozId) await servico.entrou(guildId, depois.id);
    if (antes.channelId === ativa.canalVozId) {
      await servico.saiu(guildId, depois.id);
      const canal = depois.guild.channels.cache.get(ativa.canalVozId);
      const humanos = canal?.members.filter((m) => !m.user.bot).size ?? 0;
      if (humanos === 0) await encerrar(guildId, 'o canal esvaziou');
    }
  } catch (e) {
    console.error('Erro ao tratar mudança no canal de voz:', e);
  }
});

async function iniciar(i) {
  if (servico.ativa(i.guildId)) return i.reply(efemera('Já existe uma daily sendo gravada neste servidor.'));

  const membro = await i.guild.members.fetch(i.user.id);
  const canal = membro.voice.channel;
  if (!canal) return i.reply(efemera('Entre num canal de voz primeiro.'));

  const perms = canal.permissionsFor(i.guild.members.me);
  if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect])) {
    return i.reply(efemera(`Não tenho permissão para entrar em **${canal.name}**.`));
  }

  await i.deferReply();

  const conexao = joinVoiceChannel({
    guildId: i.guildId,
    channelId: canal.id,
    adapterCreator: i.guild.voiceAdapterCreator,
    selfDeaf: false, // precisa estar "ouvindo" para receber áudio
    selfMute: true,
    debug: config.discord.debugVoz,
  });
  if (config.discord.debugVoz) conexao.on('debug', (m) => log(`[voz] ${m}`));
  conexao.on('error', (e) => console.error('[voz] erro:', e));

  try {
    await entersState(conexao, VoiceConnectionStatus.Ready, 20_000);
  } catch {
    conexao.destroy();
    return i.editReply('Não consegui conectar ao canal de voz em 20 s. Rode com DEBUG_VOZ=1 para ver o motivo.');
  }

  let ativa;
  try {
    ativa = await servico.iniciar({
      guildId: i.guildId,
      canalVozId: canal.id,
      canalVozNome: canal.name,
      canalTextoId: i.channelId,
      conexao,
      presentes: [...canal.members.keys()],
      resolverMembro: async (userId) => {
        const m = await i.guild.members.fetch(userId).catch(() => null);
        return { nome: m?.displayName ?? userId, bot: m?.user.bot ?? false };
      },
    });
  } catch (e) {
    conexao.destroy();
    throw e;
  }

  // Reconexão: se cair e não voltar em 5 s, encerra com o que já foi gravado.
  conexao.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(conexao, VoiceConnectionStatus.Signalling, 5_000),
        entersState(conexao, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      await encerrar(i.guildId, 'a conexão de voz caiu');
    }
  });

  const timer = setTimeout(
    () => encerrar(i.guildId, `passou de ${config.audio.duracaoMaximaMin} min`),
    config.audio.duracaoMaximaMin * 60_000,
  );
  conexoes.set(i.guildId, { conexao, timer, canalTexto: i.channel });

  // O handshake DAVE pode terminar logo depois do Ready.
  await new Promise((r) => setTimeout(r, 1500));
  const dave = ativa.sessao.dave();
  log(`Daily ${ativa.dailyId} (${ativa.time.nome}): gravando em #${canal.name} · DAVE ${dave.ativo ? `v${dave.protocolVersion}` : 'inativo'}`);
  await i.editReply(`${AVISO_GRAVACAO}\n-# Use /daily encerrar ao terminar.`);
}

async function comandoEncerrar(i) {
  if (!servico.ativa(i.guildId)) return i.reply(efemera('Nenhuma daily em andamento.'));
  await i.deferReply();
  const msg = await encerrar(i.guildId, null, { avisarCanal: false });
  await i.editReply(msg ?? 'Nenhuma daily em andamento.');
}

/**
 * Encerra a daily do servidor. Chamado pelo comando e pelos gatilhos automáticos
 * (canal vazio, tempo máximo, queda de conexão, desligamento do bot).
 */
async function encerrar(guildId, motivo, { avisarCanal = true } = {}) {
  const c = conexoes.get(guildId);
  conexoes.delete(guildId);
  if (c) clearTimeout(c.timer);

  const r = await servico.encerrar(guildId);
  if (c && c.conexao.state.status !== VoiceConnectionStatus.Destroyed) c.conexao.destroy();
  if (!r) return null;

  log(`Daily ${r.dailyId} encerrada${motivo ? ` (${motivo})` : ''}: ${JSON.stringify({ ...r, time: r.time.nome })}`);
  const min = Math.max(1, Math.round(r.duracaoSeg / 60));
  const msg =
    r.segmentos > 0
      ? `⏹️ Daily encerrada${motivo ? ` (${motivo})` : ''}: ${min} min, ${r.segmentos} trechos de fala. O resumo chega aqui em instantes.`
      : `⏹️ Daily encerrada${motivo ? ` (${motivo})` : ''}: ${min} min, nenhuma fala capturada.`;
  if (avisarCanal) await c?.canalTexto?.send(msg).catch((e) => log(`  ⚠ não consegui avisar no canal: ${e.message}`));
  return msg;
}

async function status(i) {
  const ativa = servico.ativa(i.guildId);
  if (ativa) {
    const s = ativa.sessao.estatisticas();
    const dave = ativa.sessao.dave();
    return i.reply(
      efemera(
        `🔴 Gravando há ${Math.round(s.duracaoSeg / 60)} min · ${s.segmentos} trechos salvos · ${s.erros} erro(s) · ` +
          `DAVE ${dave.ativo ? `v${dave.protocolVersion}` : 'inativo'}`,
      ),
    );
  }
  const ultima = await banco.ultimaDailyDaGuild(i.guildId);
  if (!ultima) return i.reply(efemera('Nenhuma daily registrada ainda. Use `/daily iniciar` num canal de voz.'));
  const erro = ultima.status === 'ERRO' && ultima.erroMensagem ? `\n${ultima.erroMensagem}` : '';
  return i.reply(efemera(`Última daily: ${dataBr(ultima.data)} (${ultima.time.nome}) — ${rotuloStatus(ultima.status)}.${erro}`));
}

async function optOut(i, naoGravar) {
  const membro = await i.guild.members.fetch(i.user.id).catch(() => null);
  await servico.definirOptOut({ userId: i.user.id, nome: membro?.displayName ?? i.user.username, naoGravar });
  return i.reply(
    efemera(
      naoGravar
        ? 'Combinado: seu áudio não será gravado nas dailies (se houver uma em andamento, o que já foi gravado de você nela foi apagado). ' +
          'Você aparece só como "presente, não gravado". Para voltar atrás: `/daily gravar`.'
        : 'Combinado: você volta a ser gravado nas dailies.',
    ),
  );
}

/** /daily gestor: escolhe o cargo que dá acesso ao dashboard do time. */
async function definirGestor(i) {
  if (!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    return i.reply(efemera('Só quem pode gerenciar o servidor define o cargo de gestor.'));
  }
  // O time é o do canal de voz em que a pessoa está; fora de um canal, vale se o servidor só tiver um time.
  const membro = await i.guild.members.fetch(i.user.id).catch(() => null);
  const canalVozId = membro?.voice.channelId;
  const times = await banco.timesDaGuild(i.guildId);
  const time = (canalVozId && times.find((t) => t.canalVozId === canalVozId)) || (times.length === 1 ? times[0] : null);
  if (!time) {
    return i.reply(
      efemera(
        times.length
          ? 'Este servidor tem mais de um time: entre no canal de voz do time e rode o comando de novo.'
          : 'Ainda não há time neste servidor. Ele é criado na primeira `/daily iniciar`.',
      ),
    );
  }
  const cargo = i.options.getRole('cargo');
  await banco.definirRoleGestor(time.id, cargo?.id ?? null);
  return i.reply(
    efemera(
      cargo
        ? `Pronto: quem tem o cargo **${cargo.name}** pode ver o dashboard do time **${time.nome}** (além dos administradores). A mudança vale em até 5 minutos.`
        : `Pronto: o dashboard do time **${time.nome}** volta a ser só dos administradores do servidor.`,
    ),
  );
}

let desligando = false;
async function desligar() {
  if (desligando) process.exit(1);
  desligando = true;
  log('Encerrando...');
  for (const guildId of servico.guildsAtivas()) await encerrar(guildId, 'o bot foi desligado').catch((e) => console.error(e));
  await client.destroy();
  banco.fechar();
  process.exit(0);
}
process.on('SIGINT', desligar);
process.on('SIGTERM', desligar);

client.login(config.discord.token);
