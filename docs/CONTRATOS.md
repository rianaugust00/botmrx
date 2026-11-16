# Contratos

Formatos trocados entre os módulos. Independem de framework; JSON em `camelCase` na API HTTP,
`snake_case` no contrato do LLM (`contracts/resumo-daily.schema.json`).

---

## 1. Jobs (fila)

| Tipo | Quem enfileira | Quem consome | Pré-condição | Efeito |
|------|----------------|--------------|--------------|--------|
| `TRANSCREVER` | Bot, ao encerrar a daily | Worker | Daily em `AGUARDANDO_TRANSCRICAO` | Cria `Falas`, apaga áudio, enfileira `EXTRAIR` |
| `EXTRAIR` | Worker (após transcrição) ou admin (reprocessar) | Worker | Daily com `Falas` | Cria `ItensResumo`, atualiza `Bloqueios`, daily `CONCLUIDA` |
| `LIMPAR_RETENCAO` | Agendador diário | Worker | — | Remove transcrições além de `RETENCAO_TRANSCRICAO_DIAS` e áudios órfãos |

**Idempotência:** todo job precisa poder rodar duas vezes sem duplicar dados (o worker pode cair
depois de gravar e antes de `concluir`).
- `TRANSCREVER`: pula segmentos já `TRANSCRITO`.
- `EXTRAIR`: dentro de uma transação, apaga `ItensResumo` da daily, marca extrações anteriores
  `Ativa = 0` e grava a nova.

---

## 2. Segmento de áudio (Bot → Armazenamento/Banco)

```json
{
  "dailyId": 42,
  "participanteId": 7,
  "inicioMs": 83120,
  "fimMs": 97480,
  "caminho": "/data/audio/42/7-83120.ogg",
  "formato": "ogg"
}
```

Áudio: Opus em container OGG (o que o Discord entrega, sem recodificar), 48 kHz, mono.
Segmentos com menos de 600 ms são descartados.

---

## 3. Entrada do extrator (Worker → LLM)

Montada a partir do banco e renderizada no template de `prompts/extracao-daily.md`:

```json
{
  "time": { "id": 1, "nome": "Squad Pagamentos" },
  "data": "2026-11-14",
  "participantes": [ { "id": 7, "nome": "Ana" }, { "id": 9, "nome": "Bruno" } ],
  "bloqueiosAbertos": [
    { "id": 15, "participanteId": 9, "desde": "2026-11-12", "descricao": "Aguardando acesso ao ambiente de homologação" }
  ],
  "falas": [
    { "id": 1201, "participanteId": 7, "inicioMs": 5200, "texto": "Ontem terminei a tela de extrato..." }
  ]
}
```

Saída: JSON conforme `contracts/resumo-daily.schema.json`.

**Validação pós-LLM (obrigatória):**
- `participante_id`, `responsavel_id` ∈ participantes enviados;
- `fala_ids` ∈ falas da daily (itens sem nenhuma fala válida são descartados);
- `bloqueio_existente_id`, `bloqueio_id` ∈ bloqueios abertos enviados (inválido → tratar como novo / ignorar).

---

## 4. API HTTP

Na implementação atual as rotas ficam sob o prefixo `/api` (ex.: `GET /api/dailies/42`). Com o
login ligado, toda rota exige sessão (`401 NAO_AUTENTICADO` sem ela), as consultas precisam informar
`timeId`, e um time fora do acesso da pessoa responde `403 SEM_ACESSO`.

### `GET /dailies?timeId=1&datas=2026-11-10,2026-11-12,2026-11-14`

Também aceita `de` / `ate` em vez de `datas`.

```json
[
  { "id": 40, "data": "2026-11-10", "status": "CONCLUIDA", "iniciadaEm": "2026-11-10T12:30:04Z",
    "duracaoMin": 14, "participantes": 6, "bloqueios": 1 }
]
```

### `GET /dailies/{id}`

```json
{
  "id": 42,
  "data": "2026-11-14",
  "status": "CONCLUIDA",
  "resumoGeral": "Time fechou a integração do PIX...",
  "presentes": [
    { "id": 7, "nome": "Ana", "gravado": true },
    { "id": 11, "nome": "Carla", "gravado": false }
  ],
  "pessoas": [
    {
      "participante": { "id": 7, "nome": "Ana" },
      "fez":      [ { "id": 501, "descricao": "Terminou a tela de extrato", "falaIds": [1201] } ],
      "vaiFazer": [ { "id": 502, "descricao": "Vai iniciar os testes de integração", "falaIds": [1201, 1204] } ],
      "bloqueios": []
    }
  ],
  "decisoes":   [ { "id": 520, "descricao": "Deploy fica para quinta", "falaIds": [1230] } ],
  "pendencias": [ { "id": 521, "descricao": "Pedir acesso à homologação", "responsavel": { "id": 9, "nome": "Bruno" },
                    "prazo": "hoje", "falaIds": [1233] } ],
  "extracao":   { "modelo": "claude-opus-5-5", "versaoPrompt": "extracao-v1" }
}
```

### `GET /dailies/{id}/transcricao`

```json
[ { "id": 1201, "participante": { "id": 7, "nome": "Ana" }, "inicioMs": 5200, "fimMs": 19800, "texto": "..." } ]
```

### `GET /dailies/comparar?ids=40,41,42`

```json
{
  "dailies": [ { "id": 40, "data": "2026-11-10" }, { "id": 41, "data": "2026-11-12" }, { "id": 42, "data": "2026-11-14" } ],
  "linhas": [
    {
      "participante": { "id": 7, "nome": "Ana" },
      "porDaily": {
        "40": { "fez": [], "vaiFazer": [], "bloqueios": [] },
        "41": null,
        "42": { "fez": [], "vaiFazer": [], "bloqueios": [] }
      }
    }
  ]
}
```
(`null` = não esteve/não falou naquela daily.)

### `GET /participantes/{id}/historico?de=2026-11-01&ate=2026-11-14`

```json
[ { "dailyId": 42, "data": "2026-11-14", "fez": [], "vaiFazer": [], "bloqueios": [] } ]
```

### `GET /bloqueios?timeId=1&status=ABERTO`

```json
[ { "id": 15, "participante": { "id": 9, "nome": "Bruno" }, "descricao": "Aguardando acesso à homologação",
    "status": "ABERTO", "desde": "2026-11-12", "ultimaMencao": "2026-11-14", "dailies": [41, 42] } ]
```

### `GET /busca?q=homologação&timeId=1&de=&ate=&participanteId=`

```json
[ { "falaId": 1233, "dailyId": 42, "data": "2026-11-14", "participante": { "id": 9, "nome": "Bruno" },
    "trecho": "...ainda sem acesso à <mark>homologação</mark>...", "inicioMs": 402000 } ]
```

### `POST /perguntas`

Pergunta livre sobre um período; a resposta cita as falas de origem (já conferidas no servidor).

```json
{ "pergunta": "O que ficou pendente?", "timeId": 1, "de": "2026-11-10", "ate": "2026-11-14", "participanteId": null }
```

```json
{
  "resposta": "Bruno ficou de atualizar a documentação...",
  "citacoes": [ { "falaId": 1233, "dailyId": 42, "data": "2026-11-14", "participante": { "id": 9, "nome": "Bruno" }, "inicioMs": 402000, "texto": "..." } ],
  "dailiesConsideradas": 3,
  "periodoCortado": false,
  "modelo": "openai/gpt-oss-120b",
  "versaoPrompt": "perguntas-v1"
}
```

### Administração

| Rota | Corpo | Efeito |
|------|-------|--------|
| `POST /admin/dailies/{id}/reprocessar` | `{ "etapa": "EXTRAIR" \| "TRANSCREVER" }` | Recoloca a daily na fila (`409` se o áudio já foi apagado) |
| `PUT /admin/participantes/{id}` | `{ "nome"?, "naoGravar"? }` | Nome de exibição e opt-out |

### Login (`/auth`)

| Rota | Efeito |
|------|--------|
| `GET /auth/eu` | `{ "login": true\|false, "usuario": { "id", "nome" } \| null }` |
| `GET /auth/entrar` | Redireciona para o Discord (OAuth2, escopo `identify`) |
| `GET /auth/retorno` | Retorno do Discord: cria a sessão (cookie `HttpOnly`) e volta para `/` |
| `POST /auth/sair` | Encerra a sessão |

### Erros

```json
{ "erro": { "codigo": "DAILY_NAO_ENCONTRADA", "mensagem": "Daily 99 não existe." } }
```

---

## 5. Comandos do bot (Discord)

| Comando | Quem | Efeito |
|---------|------|--------|
| `/daily iniciar` | Qualquer membro no canal de voz do time | Bot entra e começa a gravar |
| `/daily encerrar` | Qualquer membro | Encerra e dispara o processamento |
| `/daily status` | Qualquer membro | Mostra status da daily atual / última |
| `/daily nao-gravar` | Próprio usuário | Ativa opt-out (persistente) |
| `/daily gravar` | Próprio usuário | Remove opt-out |
| `/daily gestor [cargo]` | Quem gerencia o servidor | Define o cargo com acesso ao dashboard do time; sem cargo, volta a só administradores |
