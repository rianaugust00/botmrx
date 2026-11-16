// Comandos do bot (docs/CONTRATOS.md §5).
import { SlashCommandBuilder } from 'discord.js';

export const comandoDaily = new SlashCommandBuilder()
  .setName('daily')
  .setDescription('Gravação e resumo da daily')
  .addSubcommand((s) => s.setName('iniciar').setDescription('Entra no seu canal de voz e começa a gravar a daily'))
  .addSubcommand((s) => s.setName('encerrar').setDescription('Encerra a gravação e gera o resumo'))
  .addSubcommand((s) => s.setName('status').setDescription('Mostra a daily em andamento ou a última'))
  .addSubcommand((s) => s.setName('nao-gravar').setDescription('Não quero ser gravado nas dailies (vale até eu mudar)'))
  .addSubcommand((s) => s.setName('gravar').setDescription('Volto a ser gravado nas dailies'))
  .addSubcommand((s) =>
    s
      .setName('gestor')
      .setDescription('Define o cargo que pode ver o dashboard deste time (só administradores)')
      .addRoleOption((o) => o.setName('cargo').setDescription('Cargo com acesso; deixe vazio para voltar a só administradores')),
  );

export const AVISO_GRAVACAO =
  '🔴 **Esta daily está sendo gravada** para gerar o resumo. ' +
  'O áudio é apagado depois de transcrito. Quem não quiser ser gravado: `/daily nao-gravar`.';

const ROTULO_STATUS = {
  GRAVANDO: 'gravando',
  AGUARDANDO_TRANSCRICAO: 'na fila para transcrever',
  TRANSCREVENDO: 'transcrevendo',
  AGUARDANDO_EXTRACAO: 'na fila para resumir',
  EXTRAINDO: 'gerando o resumo',
  CONCLUIDA: 'concluída',
  ERRO: 'com erro',
};
export const rotuloStatus = (status) => ROTULO_STATUS[status] ?? status;
