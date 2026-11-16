# BotMRX

Bot que grava as dailies do Discord, transcreve, identifica quem falou e gera um resumo por pessoa
(fez / vai fazer / bloqueios), além de decisões e pendências. O resumo é postado no canal de texto e
o gestor consulta qualquer dia, ou compara vários, num dashboard.

> Fora do escopo, por decisão de projeto: avaliação de desempenho, ranking ou métricas de esforço.
> O sistema registra só o que foi dito ([D1](docs/DECISOES.md)).

## Como funciona

```
Canal de voz ──▶ Bot ──▶ áudio por pessoa ──▶ Worker ──▶ transcrição ──▶ LLM ──▶ resumo
                  │        (.ogg temporário)     │                                  │
                  └──── banco (SQLite) + fila de jobs ◀────────────────────────────┘
                                   │
                         API + Dashboard (login com Discord)
```

- O Discord entrega o áudio separado por usuário, então quem falou é identificado sem diarização.
- Cada item do resumo aponta para as falas de origem; no dashboard, um clique abre a transcrição
  naquele trecho.
- O áudio é apagado assim que a transcrição dá certo, e as transcrições expiram depois de um prazo
  configurável.

## Status

| Parte | Pasta | Situação |
|-------|-------|----------|
| Bot (captura, comandos `/daily`) | [`bot/`](bot) | Pronto; validado em call real com DAVE (uma pessoa) |
| Worker (transcrição, resumo, bloqueios, retenção) | [`worker/`](worker) | Pronto; validado com Groq (Whisper + LLM) |
| Banco e fila de jobs | [`nucleo/`](nucleo) | SQLite local (mesmo desenho de `db/schema.sql`); adaptador SQL Server ainda não escrito |
| API de leitura e administração | [`api/`](api) | Pronta, com login Discord e acesso por time |
| Dashboard | [`web/`](web) | Pronto: dias, comparação, visão por pessoa, bloqueios, busca e perguntas livres |

Falta validar com várias pessoas na mesma call (separação por pessoa, falas simultâneas, opt-out).

## Rodar

Requer Node 22.13 ou mais novo.

```bash
npm install
cp .env.example .env     # preencha token do bot e chaves (ver "Configuração")
npm run verificar        # confere chaves e nomes de modelos, sem gastar nada
npm test                 # 39 testes, sem rede

npm start                # liga bot, worker e dashboard (http://127.0.0.1:3000)
```

Ou cada serviço no seu terminal: `npm run bot`, `npm run worker`, `npm run painel`.

Para ver o dashboard sem dailies reais:

```bash
npm run demo             # http://127.0.0.1:3001, dados fictícios, sem login, banco separado
```

## Comandos no Discord

Dentro de um canal de voz:

| Comando | Efeito |
|---------|--------|
| `/daily iniciar` | Bot entra, avisa que está gravando e começa. Na primeira vez, o canal de voz vira um "time" e o resumo passa a ser postado no canal de texto onde o comando foi usado |
| `/daily encerrar` | Encerra e manda para o worker. Também encerra sozinha se o canal esvaziar, a conexão cair ou passar de `DAILY_DURACAO_MAXIMA_MIN` |
| `/daily status` | Daily em andamento ou situação da última |
| `/daily nao-gravar` | Opt-out persistente. Numa daily em andamento, apaga o que já foi gravado da pessoa |
| `/daily gravar` | Desfaz o opt-out |
| `/daily gestor` | Define o cargo que pode ver o dashboard do time (só para quem gerencia o servidor) |

## Configuração

Tudo fica no `.env` (modelo comentado em [`.env.example`](.env.example)).

### Discord

1. Crie uma aplicação em https://discord.com/developers/applications e, em **Bot**, gere o token
   (`DISCORD_BOT_TOKEN`). Nenhum *privileged intent* é necessário.
2. Convide o bot com as permissões Ver canal, Enviar mensagens e Conectar.
3. Para o login do dashboard: em **OAuth2**, copie o Client ID e gere o Client Secret
   (`DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`) e cadastre em **Redirects**
   `http://127.0.0.1:3000/api/auth/retorno` (ou `<PAINEL_URL>/api/auth/retorno`).

### Transcrição e resumo

| Etapa | Variáveis | Opções |
|-------|-----------|--------|
| Transcrição | `TRANSCRICAO_URL`, `TRANSCRICAO_API_KEY`, `TRANSCRICAO_MODELO` | Qualquer endpoint no formato OpenAI `/audio/transcriptions`: Groq, OpenAI ou Whisper local |
| Resumo e perguntas | `LLM_PROVEDOR` e as variáveis do provedor | `anthropic` (Claude) ou `openai` (Groq, Gemini, OpenRouter, Ollama…) |

O `.env.example` traz o exemplo do Groq, em que uma única chave gratuita serve para as duas etapas.
Antes de gravar dailies reais com um provedor gratuito, confira os termos de uso de dados dele.

### Acesso ao dashboard

- Sem `DISCORD_CLIENT_SECRET`, o dashboard abre sem login e só aceita conexões desta máquina.
- Com o login ligado, entram o dono e os administradores do servidor e quem tiver o cargo definido
  com `/daily gestor`. Cada pessoa só vê os times a que tem acesso.
- Para abrir na rede (`API_HOST=0.0.0.0`) o login é obrigatório; sem ele o servidor não sobe.

## Segurança e privacidade

- **Segredos** (token do bot, Client Secret, chaves de API) ficam só no `.env`, que está no
  `.gitignore`. Nunca coloque valores reais no `.env.example`. Se um segredo vazar, gere outro no
  painel do provedor; apagar do git não basta.
- **Dados pessoais**: o banco, o áudio e as gravações de teste ficam em `dados/` e `gravacoes/`,
  também fora do git.
- **Gravação**: o bot avisa no canal ao começar e respeita o opt-out; o áudio de quem pediu para não
  ser gravado nunca é capturado.
- **Retenção**: áudio apagado após a transcrição; transcrições apagadas após
  `RETENCAO_TRANSCRICAO_DIAS` (o resumo fica).
- **Dashboard**: sessão em cookie `HttpOnly` e `SameSite=Lax`, guardada no banco só como hash;
  pedidos de outra origem são recusados; todo texto vindo do banco é exibido como texto, nunca como HTML.

## Ferramentas de linha de comando

```bash
npm run importar -- <pasta>          # coloca no banco uma gravação do spike ou um falas.json
npm run ver                          # lista as dailies
npm run ver -- <id> --transcricao    # resumo com as falas de origem
npm run reprocessar -- <id>          # refaz o resumo (ex.: depois de mudar o prompt)
npm run reprocessar -- <id> transcrever  # refaz a transcrição, se o áudio ainda existir
```

## Onde fica cada coisa

| Caminho | Papel na arquitetura |
|---------|----------------------|
| `bot/index.js` | Adaptador do Discord (comandos, eventos de voz) |
| `bot/dailies.js` | Casos de uso IniciarDaily, EncerrarDaily, presença, opt-out, recuperação após queda |
| `bot/captura.js` | Captura (M1): um `.ogg` por trecho de fala de cada pessoa |
| `worker/processar.js` | Laço da fila: reserva, executa, conclui ou falha com retry |
| `worker/transcrever-daily.js` | TranscreverDaily (M4) |
| `worker/extrair-resumo.js`, `worker/validar.js` | ExtrairResumo (M5) e validação das evidências |
| `worker/extrator.js`, `worker/extrator-openai.js` | Adaptadores do LLM: Claude e APIs no formato OpenAI |
| `worker/limpar-retencao.js` | LimparRetencao (LGPD) |
| `worker/notificador-discord.js`, `worker/resumo-texto.js` | Resumo postado no canal de texto |
| `api/rotas.js`, `api/servidor.js` | API de leitura e administração (M6/M8) e servidor do dashboard |
| `api/perguntas.js`, `prompts/perguntas.md`, `nucleo/llm.js` | Perguntas livres sobre um período, com as falas de origem citadas |
| `api/auth.js`, `api/discord.js` | Login com Discord (OAuth2), sessões e regra de acesso por time |
| `web/` | Dashboard (M7): HTML, CSS e JavaScript sem framework nem build. Tema escuro; as cores ficam nas variáveis do topo de `web/estilo.css` |
| `nucleo/sqlite/banco.js` | Repositórios e FilaDeJobs. Para migrar para SQL Server, é este arquivo que se reescreve |
| `nucleo/armazenamento-disco.js` | ArmazenamentoDeAudio em disco |
| `ferramentas/` | `iniciar` (`npm start`), `importar`, `ver`, `reprocessar`, `verificar`, `demo` |
| `spike/` | Protótipos da Fase 0 (gravação com DAVE, transcrição + resumo) |

## Documentação

| Arquivo | Conteúdo |
|---------|----------|
| [docs/ARQUITETURA.md](docs/ARQUITETURA.md) | Módulos, fluxo, portas/adaptadores, dados, API, dashboard, LGPD, roadmap |
| [docs/CONTRATOS.md](docs/CONTRATOS.md) | Jobs, payloads, entrada/saída do LLM, API HTTP, comandos do bot |
| [docs/DECISOES.md](docs/DECISOES.md) | Decisões de arquitetura e por quê |
| [db/schema.sql](db/schema.sql) | Schema SQL Server (tabelas, fila de jobs, full-text) |
| [contracts/resumo-daily.schema.json](contracts/resumo-daily.schema.json) | JSON Schema da saída do LLM |
| [prompts/](prompts) | Prompts versionados (extração e perguntas) |
