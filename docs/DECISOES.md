# Registro de decisões

Formato curto: contexto → decisão → consequência. Revisar ao migrar para o framework da empresa.

### D1 — Sem avaliação de desempenho
Contexto: medir esforço a partir da fala é impreciso e afeta a confiança do time.
Decisão: o produto mostra apenas o que foi dito; nada de score, ranking ou tempo de fala.
Consequência: o schema não guarda métricas por pessoa; o prompt proíbe julgamentos.

### D2 — Identificação de quem falou pelo stream do Discord
Contexto: o Discord entrega áudio separado por usuário.
Decisão: não usar diarização; cada segmento carrega o `discordUserId`.
Consequência: identificação 100% correta; depende de a biblioteca suportar recebimento de voz (inclusive DAVE).

### D3 — Pipeline assíncrono com fila em tabela SQL Server
Contexto: transcrição e LLM são lentos e falham ocasionalmente; não queremos nova infraestrutura.
Decisão: tabela `Jobs` + `UPDLOCK, READPAST`; jobs idempotentes.
Consequência: reprocessamento simples; se o volume crescer muito, troca-se o adaptador por uma fila dedicada.

### D4 — Bot de captura isolado
Contexto: recebimento de voz só é maduro em Node/Python; o framework da empresa pode ser outro.
Decisão: o Bot é um serviço separado que só escreve no banco e no armazenamento de áudio.
Consequência: Worker, API e Dashboard podem ser migrados sem tocar no Bot.

### D5 — Áudio temporário
Contexto: LGPD e minimização de dados.
Decisão: áudio apagado após transcrição bem-sucedida; só texto é retido, por prazo configurável.
Consequência: não é possível "ouvir de novo"; retranscrever exige que o áudio ainda exista.

### D6 — Saída estruturada com evidências
Contexto: resumos de LLM podem conter itens não ditos.
Decisão: JSON Schema obrigatório e cada item referencia `fala_ids`; validação descarta itens sem evidência.
Consequência: dashboard navega do item para a fala; erros do LLM são verificáveis.

### D7 — Uma extração por daily, versionada
Contexto: o prompt vai evoluir.
Decisão: gravar JSON bruto, modelo e versão do prompt em `ExtracoesLlm`; reextração substitui os itens.
Consequência: dá para comparar versões e reprocessar o histórico.

### D8 — Banco local em SQLite até existir o SQL Server
Contexto: o ambiente de desenvolvimento não tem SQL Server nem Docker.
Decisão: os repositórios e a fila ficam atrás de uma única classe (`nucleo/sqlite/banco.js`), com o mesmo desenho de `db/schema.sql`.
Consequência: o MVP roda sem infraestrutura; migrar para SQL Server é reescrever esse adaptador.

### D9 — LLM e transcrição trocáveis por configuração
Contexto: a API do Claude é paga e o projeto precisa rodar sem custo na fase de testes.
Decisão: além do adaptador do Claude, o worker tem um adaptador para APIs no formato OpenAI (`LLM_PROVEDOR=openai`), que serve para Groq, Gemini, OpenRouter ou um modelo local. Prompt, schema e validação de evidências são os mesmos.
Consequência: modelos que não garantem o JSON Schema passam por uma normalização (`worker/normalizar.js`); a qualidade do resumo depende do modelo escolhido e deve ser conferida. Com provedores gratuitos, confirmar os termos de uso de dados antes de gravar dailies reais.
