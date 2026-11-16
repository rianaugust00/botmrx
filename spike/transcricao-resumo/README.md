# Spike — transcrição + resumo

Protótipo do **Worker** da arquitetura: as etapas M4 (Transcrição) e M5 (Extração) de
[docs/ARQUITETURA.md](../../docs/ARQUITETURA.md). Por enquanto lê e grava arquivos, sem banco.

```
gravação (spike/gravacao)          transcrever                  resumir
manifest.json + <user>/*.ogg  ──────────────────▶  falas.json  ─────────────▶  resumo.md
                                 Whisper (API      transcricao.md   Claude       resumo.json
                                 formato OpenAI)                    + validação  resumo.bruto.json
                                                   bloqueios-abertos.json (opcional) ─┘
```

## Testar o resumo agora (sem gravar nada)

Há uma daily fictícia pronta em `exemplo/daily-exemplo/` (5 pessoas, 25 falas, 2 bloqueios
em aberto de dias anteriores — um continua e outro é resolvido na conversa).

```bash
cd spike/transcricao-resumo
npm install
cp .env.example .env        # preencha ANTHROPIC_API_KEY
npm run resumir -- exemplo/daily-exemplo
```

Abra `exemplo/daily-exemplo/resumo.md`. Cada item mostra as falas de origem
(`F8 01:36`), que você confere em `falas.json`.

O que observar:
- Cada pessoa tem **Fez / Vai fazer / Bloqueios** corretos e nada inventado.
- O bloqueio do Bruno aparece como **em aberto desde 10/11** (o mesmo de antes, não um novo).
- O bloqueio da Carla aparece em **Bloqueios resolvidos**.
- Decisão "deploy na quinta" e pendências com responsável/prazo ("Diego cobra infra até o fim do dia";
  "Bruno atualiza a doc depois de validar").
- Erros de transcrição corrigidos na descrição ("pul request" → "pull request").
- Nenhum julgamento sobre as pessoas.

## Pipeline completo (com uma gravação real)

Depois de gravar com `spike/gravacao`:

```bash
# .env: preencha também TRANSCRICAO_API_KEY (ou TRANSCRICAO_URL de um Whisper local)
npm run processar -- ../gravacao/gravacoes/2026-11-14T12-30-04-123Z
```

Ou em etapas: `npm run transcrever -- <pasta>` e depois `npm run resumir -- <pasta>`.
Assim dá para corrigir `falas.json` à mão e resumir de novo, ou testar outro prompt
sem pagar a transcrição de novo.

Para testar o acompanhamento de bloqueios entre dias, copie o
`exemplo/daily-exemplo/bloqueios-abertos.json` para a pasta e ajuste.

## Arquivos

| Arquivo | Papel na arquitetura |
|---------|----------------------|
| `src/transcritor.js` | Porta **Transcritor** + adaptador para `/audio/transcriptions` (formato OpenAI). Funciona com nuvem e Whisper local; filtra alucinações típicas do Whisper em silêncio ("Legendas pela comunidade Amara.org") |
| `src/transcrever.js` | Caso de uso **TranscreverDaily**: manifest → falas, juntando trechos seguidos da mesma pessoa |
| `src/extrator.js` | Caso de uso **ExtrairResumo**: Claude com saída estruturada (`contracts/resumo-daily.schema.json`) |
| `src/validar.js` | Validação pós-LLM: descarta itens sem fala que os sustente e corrige referências inválidas |
| `src/prompt.js`, `src/template.js` | Lê `prompts/extracao-daily.md` (versionado) e monta a mensagem |
| `src/markdown.js` | Prévia do que o gestor verá no dashboard |
| `src/cli.js` | Linha de comando |

O prompt e o schema ficam na raiz do repositório (`prompts/`, `contracts/`) e são lidos daqui —
é o mesmo arquivo que o Worker definitivo vai usar.

## Configuração do LLM

- Modelo padrão `claude-opus-5-5`, `effort: medium`. Para custo/latência menores, teste
  `LLM_EFFORT=low` e compare o `resumo.md`.
- **Fallback em caso de recusa ligado por padrão** (`LLM_FALLBACK=default`): se o modelo recusar
  a requisição, a própria API refaz com outro modelo. Desligue com `LLM_FALLBACK=off` — necessário
  se trocar para um modelo que não suporta o recurso (ex.: Haiku).
- Recusa, resposta cortada e JSON inválido viram erro claro no terminal; nada é salvo pela metade.
- `resumo.json` guarda modelo, versão do prompt e tokens usados — a mesma informação que irá
  para `ExtracoesLlm` no banco.

## Testes

```bash
npm test     # 12 testes; transcrição e Claude simulados, não gastam crédito
```
