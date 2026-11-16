// Spike de gravação: o bot entra no canal de voz, grava um .ogg por trecho de fala de cada
// usuário e gera um manifest.json. Serve para validar a captura (incluindo DAVE) antes do MVP.

import 'dotenv/config';
import {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import {
  VoiceConnectionStatus,
  entersState,
  joinVoiceChannel,
  generateDependencyReport,
} from '@discordjs/voice';
import { SessaoGravacao } from './gravador.js';

const cfg = {
  token: obrigatorio('DISCORD_TOKEN'),
  pasta: process.env.PASTA_GRAVACOES || './gravacoes',
  silencioMs: Number(process.env.SILENCIO_MS || 1000),
  minSegmentoMs: Number(process.env.MIN_SEGMENTO_MS || 600),
  duracaoMaximaMin: Number(process.env.DURACAO_MAXIMA_MIN || 60),
  naoGravar: new Set((process.env.NAO_GRAVAR || '').split(',').map((s) => s.trim()).filter(Boolean)),
  debugVoz: process.env.DEBUG_VOZ === '1',
};

const comando = new SlashCommandBuilder()
  .setName('gravacao')
  .setDescription('Spike de gravação da daily')
  .addSubcommand((s) => s.setName('iniciar').setDescription('Entra no seu canal de voz e começa a gravar'))
  .addSubcommand((s) => s.setName('parar').setDescription('Para a gravação e salva os arquivos'))
  .addSubcommand((s) => s.setName('status').setDescription('Mostra o estado da gravação'));

/** @type {Map<string, { sessao: SessaoGravacao, conexao: import('@discordjs/voice').VoiceConnection, canalId: string, timer: NodeJS.Timeout }>} */
const ativas = new Map();

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });

client.once(Events.ClientReady, async (c) => {
  console.log(generateDependencyReport());
  console.log(`Conectado como ${c.user.tag}. Registrando /gravacao em ${c.guilds.cache.size} servidor(es)...`);
  for (const guild of c.guilds.cache.values()) {
    await guild.commands.set([comando.toJSON()]).catch((e) => console.error(`  falha em ${guild.name}:`, e.message));
  }
  console.log('Pronto. Use /gravacao iniciar estando num canal de voz.');
});

client.on(Events.GuildCreate, async (guild) => {
  console.log(`Adicionado ao servidor ${guild.name}. Registrando /gravacao...`);
  await guild.commands.set([comando.toJSON()]).catch((e) => console.error(`  falha em ${guild.name}:`, e.message));
});

client.on(Events.InteractionCreate, async (i) => {
  if (!i.isChatInputCommand() || i.commandName !== 'gravacao' || !i.inGuild()) return;
  const sub = i.options.getSubcommand();
  try {
    if (sub === 'iniciar') await iniciar(i);
    else if (sub === 'parar') await parar(i.guildId, (m) => i.reply(m));
    else if (sub === 'status') await status(i);
  } catch (e) {
    console.error(e);
    const msg = { content: `Erro: ${e.message}`, flags: MessageFlags.Ephemeral };
    i.deferred || i.replied ? await i.followUp(msg) : await i.reply(msg);
  }
});

client.on(Events.VoiceStateUpdate, async (antes, depois) => {
  const ativa = ativas.get(depois.guild.id);
  if (!ativa || antes.channelId === depois.channelId) return;
  const userId = depois.id;
  if (depois.channelId === ativa.canalId) await ativa.sessao.registrarEntrada(userId);
  if (antes.channelId === ativa.canalId) {
    ativa.sessao.registrarSaida(userId);
    const canal = depois.guild.channels.cache.get(ativa.canalId);
    const humanos = canal?.members.filter((m) => !m.user.bot).size ?? 0;
    if (humanos === 0) {
      console.log('Canal vazio: encerrando gravação.');
      await parar(depois.guild.id, (m) => console.log(m.content));
    }
  }
});

async function iniciar(i) {
  if (ativas.has(i.guildId)) return i.reply({ content: 'Já existe uma gravação em andamento.', flags: MessageFlags.Ephemeral });

  const membro = await i.guild.members.fetch(i.user.id);
  const canal = membro.voice.channel;
  if (!canal) return i.reply({ content: 'Entre num canal de voz primeiro.', flags: MessageFlags.Ephemeral });

  const perms = canal.permissionsFor(i.guild.members.me);
  if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect])) {
    return i.reply({ content: `Não tenho permissão para entrar em **${canal.name}**.`, flags: MessageFlags.Ephemeral });
  }

  await i.deferReply();

  const conexao = joinVoiceChannel({
    guildId: i.guildId,
    channelId: canal.id,
    adapterCreator: i.guild.voiceAdapterCreator,
    selfDeaf: false, // precisa estar "ouvindo" para receber áudio
    selfMute: true,
    debug: cfg.debugVoz,
  });
  if (cfg.debugVoz) conexao.on('debug', (m) => console.log('[voz]', m));
  conexao.on('stateChange', (a, d) => console.log(`[voz] ${a.status} → ${d.status}`));
  conexao.on('error', (e) => console.error('[voz] erro:', e));

  try {
    await entersState(conexao, VoiceConnectionStatus.Ready, 20_000);
  } catch {
    conexao.destroy();
    return i.editReply('Não consegui conectar ao canal de voz em 20 s. Rode com DEBUG_VOZ=1 para ver o motivo.');
  }

  const sessao = new SessaoGravacao({
    conexao,
    pastaBase: cfg.pasta,
    guildId: i.guildId,
    canalId: canal.id,
    ignorar: cfg.naoGravar,
    silencioMs: cfg.silencioMs,
    minSegmentoMs: cfg.minSegmentoMs,
    resolverNome: async (userId) => {
      const m = await i.guild.members.fetch(userId).catch(() => null);
      return { nome: m?.displayName ?? userId, bot: m?.user.bot ?? false };
    },
  });
  await sessao.iniciar([...canal.members.keys()]);

  // Reconexão: se cair e não voltar em 5 s, encerra salvando o que já foi gravado.
  conexao.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(conexao, VoiceConnectionStatus.Signalling, 5_000),
        entersState(conexao, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      console.log('Conexão de voz perdida: encerrando gravação.');
      await parar(i.guildId, (m) => console.log(m.content));
    }
  });

  const timer = setTimeout(() => {
    console.log(`Duração máxima (${cfg.duracaoMaximaMin} min) atingida.`);
    parar(i.guildId, (m) => i.channel?.send(m));
  }, cfg.duracaoMaximaMin * 60_000);

  ativas.set(i.guildId, { sessao, conexao, canalId: canal.id, timer });

  // O handshake DAVE pode terminar logo depois do Ready.
  await new Promise((r) => setTimeout(r, 1500));
  const dave = sessao.registrarDave();
  console.log(`Gravando em #${canal.name} → ${sessao.pasta}`);
  console.log(`DAVE: ${dave.ativo ? `ativo (protocolo v${dave.protocolVersion})` : 'inativo'}`);

  await i.editReply(
    `🔴 **Esta call está sendo gravada** (teste do bot de resumo das dailies).\n` +
      `Os arquivos ficam só na máquina de teste. Se não quiser ser gravado, avise quem está conduzindo o teste.\n` +
      `-# DAVE: ${dave.ativo ? `ativo, v${dave.protocolVersion}` : 'inativo'} · use /gravacao parar para encerrar`,
  );
}

async function parar(guildId, responder) {
  const ativa = ativas.get(guildId);
  if (!ativa) return responder({ content: 'Nenhuma gravação em andamento.', flags: MessageFlags.Ephemeral });
  ativas.delete(guildId);
  clearTimeout(ativa.timer);

  ativa.sessao.registrarDave();
  const r = await ativa.sessao.encerrar();
  if (ativa.conexao.state.status !== VoiceConnectionStatus.Destroyed) ativa.conexao.destroy();

  console.log('Resumo:', JSON.stringify(r, null, 2));
  const linhas = Object.values(r.porUsuario).map(
    (u) => `• **${u.nome}**: ${u.segmentos} trecho(s), ${u.audioSeg.toFixed(0)} s de áudio`,
  );
  return responder({
    content:
      `⏹️ Gravação encerrada (${Math.round(r.duracaoSeg / 60)} min, ${r.segmentos} trechos, ` +
      `${r.descartados} descartados por serem curtos, ${r.erros} erro(s)).\n` +
      (linhas.join('\n') || '_Nenhum áudio capturado._'),
  });
}

async function status(i) {
  const ativa = ativas.get(i.guildId);
  if (!ativa) return i.reply({ content: 'Nenhuma gravação em andamento.', flags: MessageFlags.Ephemeral });
  const dave = ativa.sessao.registrarDave();
  const r = ativa.sessao.resumo();
  return i.reply({
    content:
      `Gravando há ${Math.round(r.duracaoSeg / 60)} min · ${r.segmentos} trechos salvos · ${r.erros} erro(s) · ` +
      `DAVE ${dave.ativo ? `v${dave.protocolVersion}` : 'inativo'} · conexão: ${ativa.conexao.state.status}`,
    flags: MessageFlags.Ephemeral,
  });
}

async function encerrarTudo() {
  console.log('\nEncerrando...');
  for (const guildId of [...ativas.keys()]) await parar(guildId, (m) => console.log(m.content));
  await client.destroy();
  process.exit(0);
}
process.on('SIGINT', encerrarTudo);
process.on('SIGTERM', encerrarTudo);

function obrigatorio(nome) {
  const v = process.env[nome];
  if (!v) {
    console.error(`Defina ${nome} no arquivo .env (veja .env.example).`);
    process.exit(1);
  }
  return v;
}

client.login(cfg.token);
