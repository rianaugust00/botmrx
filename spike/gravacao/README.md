# Spike — gravação de voz no Discord

Valida o risco nº 1 da arquitetura ([docs/ARQUITETURA.md §11](../../docs/ARQUITETURA.md)):
**um bot consegue receber o áudio de cada pessoa separadamente, com o DAVE (criptografia
ponta a ponta) ativo?**

O bot entra no canal de voz, grava **um `.ogg` por trecho de fala de cada pessoa** e gera um
`manifest.json` com quem falou, quando, presença no canal e erros. Não transcreve nada.

## Stack

- Node 22+, `discord.js` 14 e `@discordjs/voice` 0.19 (DAVE vem embutido via `@snazzah/davey`)
- O áudio é gravado como Opus em container Ogg, **sem recodificar** e sem ffmpeg (muxer
  próprio em `src/ogg-opus-writer.js`)

## 1. Criar o bot (uma vez)

1. https://discord.com/developers/applications → **New Application**.
2. **Bot** → **Reset Token** → copie o token. Nenhum *privileged intent* é necessário.
3. **OAuth2 → General** → copie o **Client ID**.
4. Convide o bot para um servidor **de teste**, trocando `CLIENT_ID` no link:
   ```
   https://discord.com/oauth2/authorize?client_id=CLIENT_ID&scope=bot+applications.commands&permissions=1051648
   ```
   (permissões: Ver canal, Enviar mensagens, Conectar)

## 2. Rodar

```bash
cd spike/gravacao
npm install
cp .env.example .env      # preencha DISCORD_TOKEN
npm test                  # testes sem Discord (muxer Ogg + lógica de trechos)
npm start
```

No Discord, entre num canal de voz e use:

| Comando | Efeito |
|---------|--------|
| `/gravacao iniciar` | Bot entra no seu canal, posta o aviso de gravação e começa a gravar |
| `/gravacao status` | Tempo, trechos salvos, erros, versão do DAVE |
| `/gravacao parar` | Para e salva. Também para sozinho se o canal esvaziar ou passar de `DURACAO_MAXIMA_MIN` |

`Ctrl+C` no terminal também encerra salvando tudo.

## 3. Saída

```
gravacoes/2026-11-14T12-30-04-123Z/
├── manifest.json
├── 123456789012345678/        ← um diretório por usuário (Discord user id)
│   ├── 00005200.ogg           ← trecho que começou 5,2 s após o início
│   └── 00083120.ogg
└── 987654321098765432/
    └── 00012010.ogg
```

`manifest.json` (resumido):

```json
{
  "iniciadaEm": "2026-11-14T12:30:04.123Z",
  "dave": { "ativo": true, "protocolVersion": 1, "voicePrivacyCode": "..." },
  "participantes": { "1234...": { "nome": "Ana", "bot": false, "gravado": true } },
  "presencas": [ { "userId": "1234...", "entrouMs": 0, "saiuMs": 912000 } ],
  "segmentos": [ { "userId": "1234...", "inicioMs": 5200, "fimMs": 19800, "duracaoAudioMs": 13620, "pacotes": 681, "arquivo": "1234.../00005200.ogg" } ],
  "descartados": 3,
  "erros": []
}
```

Para ouvir: abra o `.ogg` no VLC ou use `ffplay arquivo.ogg`.

## 4. Roteiro do teste — o que validar

Faça uma call de 5 a 10 min com 3 ou mais pessoas, simulando uma daily.

| # | Verificar | Como | Esperado |
|---|-----------|------|----------|
| 1 | Conecta com DAVE | log `DAVE: ativo (protocolo vN)` / `/gravacao status` | `ativo` |
| 2 | Áudio decodifica | ouvir alguns `.ogg` | voz clara, sem chiado ou picotes |
| 3 | Identificação correta | cada pasta só tem a voz daquela pessoa | 100% |
| 4 | Falas simultâneas | duas pessoas falando ao mesmo tempo | cada uma no seu arquivo |
| 5 | Entrada no meio | alguém entra depois do início e fala | é gravado normalmente |
| 6 | Opt-out | colocar um id em `NAO_GRAVAR` | nenhum arquivo dessa pessoa |
| 7 | Erros de descriptografia | `manifest.erros` | vazio (ou raro) |
| 8 | Linha do tempo | `inicioMs` dos segmentos bate com a ordem real das falas | sim |
| 9 | Encerramento automático | todos saem do canal | bot sai e salva |

**Se o item 1 ou 2 falhar**, rode com `DEBUG_VOZ=1` e guarde o log. É o sinal de que a
recepção de voz com DAVE não está funcionando nesta versão da biblioteca. Nesse caso, a
alternativa a testar é a mesma captura em Python (py-cord).

**Ajustes finos:**
- Trechos picados demais → aumente `SILENCIO_MS` (ex.: 1500).
- Muitos "ok"/"sim" soltos → aumente `MIN_SEGMENTO_MS`.

## Privacidade

As gravações ficam só na máquina onde o bot roda (`gravacoes/`, fora do git). Avise os
participantes antes do teste; o bot também posta um aviso no canal ao iniciar. Apague a
pasta depois de validar.

## Próximo passo

Com a captura validada, o código de `src/gravador.js` vira o módulo **Captura (M1)**. No lugar
do `manifest.json`, ele passa a gravar em `Dailies`, `DailyParticipantes` e `SegmentosAudio`
no SQL Server e a enfileirar o job `TRANSCREVER`.
