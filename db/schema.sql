/* =====================================================================
   BotMRX — Schema SQL Server
   Convenções: datas/horas em UTC (DATETIME2(3)); Dailies.Data no fuso do time.
   ===================================================================== */

/* ---------- Times e pessoas ---------- */

CREATE TABLE dbo.Times (
    Id                  BIGINT IDENTITY(1,1) CONSTRAINT PK_Times PRIMARY KEY,
    Nome                NVARCHAR(100)  NOT NULL,
    DiscordGuildId      NVARCHAR(32)   NOT NULL,
    DiscordCanalVozId   NVARCHAR(32)   NOT NULL,
    DiscordCanalTextoId NVARCHAR(32)   NULL,
    DiscordRoleGestorId NVARCHAR(32)   NULL,          -- role com acesso ao dashboard
    FusoHorario         NVARCHAR(64)   NOT NULL CONSTRAINT DF_Times_Fuso DEFAULT N'America/Sao_Paulo',
    AgendaCron          NVARCHAR(64)   NULL,          -- ex.: '30 9 * * 1-5' (entrada automática)
    Ativo               BIT            NOT NULL CONSTRAINT DF_Times_Ativo DEFAULT 1,
    CriadoEm            DATETIME2(3)   NOT NULL CONSTRAINT DF_Times_CriadoEm DEFAULT SYSUTCDATETIME(),
    CONSTRAINT UQ_Times_CanalVoz UNIQUE (DiscordGuildId, DiscordCanalVozId)
);

CREATE TABLE dbo.Participantes (
    Id              BIGINT IDENTITY(1,1) CONSTRAINT PK_Participantes PRIMARY KEY,
    DiscordUserId   NVARCHAR(32)   NOT NULL CONSTRAINT UQ_Participantes_Discord UNIQUE,
    NomeExibicao    NVARCHAR(100)  NOT NULL,
    NaoGravar       BIT            NOT NULL CONSTRAINT DF_Participantes_NaoGravar DEFAULT 0,  -- opt-out
    Ativo           BIT            NOT NULL CONSTRAINT DF_Participantes_Ativo DEFAULT 1,
    CriadoEm        DATETIME2(3)   NOT NULL CONSTRAINT DF_Participantes_CriadoEm DEFAULT SYSUTCDATETIME(),
    AtualizadoEm    DATETIME2(3)   NOT NULL CONSTRAINT DF_Participantes_AtualizadoEm DEFAULT SYSUTCDATETIME()
);

/* ---------- Dailies ---------- */

CREATE TABLE dbo.Dailies (
    Id              BIGINT IDENTITY(1,1) CONSTRAINT PK_Dailies PRIMARY KEY,
    TimeId          BIGINT         NOT NULL CONSTRAINT FK_Dailies_Times REFERENCES dbo.Times(Id),
    Data            DATE           NOT NULL,          -- dia da daily no fuso do time
    IniciadaEm      DATETIME2(3)   NOT NULL,
    EncerradaEm     DATETIME2(3)   NULL,
    Status          VARCHAR(30)    NOT NULL CONSTRAINT DF_Dailies_Status DEFAULT 'GRAVANDO',
    ErroMensagem    NVARCHAR(2000) NULL,
    ResumoGeral     NVARCHAR(MAX)  NULL,
    CriadaEm        DATETIME2(3)   NOT NULL CONSTRAINT DF_Dailies_CriadaEm DEFAULT SYSUTCDATETIME(),
    AtualizadaEm    DATETIME2(3)   NOT NULL CONSTRAINT DF_Dailies_AtualizadaEm DEFAULT SYSUTCDATETIME(),
    CONSTRAINT CK_Dailies_Status CHECK (Status IN (
        'GRAVANDO','AGUARDANDO_TRANSCRICAO','TRANSCREVENDO',
        'AGUARDANDO_EXTRACAO','EXTRAINDO','CONCLUIDA','ERRO'))
);
CREATE INDEX IX_Dailies_Time_Data ON dbo.Dailies (TimeId, Data) INCLUDE (Status);

CREATE TABLE dbo.DailyParticipantes (
    DailyId         BIGINT       NOT NULL CONSTRAINT FK_DP_Dailies REFERENCES dbo.Dailies(Id) ON DELETE CASCADE,
    ParticipanteId  BIGINT       NOT NULL CONSTRAINT FK_DP_Participantes REFERENCES dbo.Participantes(Id),
    EntrouEm        DATETIME2(3) NOT NULL,
    SaiuEm          DATETIME2(3) NULL,
    Gravado         BIT          NOT NULL,           -- 0 quando o participante tem opt-out
    CONSTRAINT PK_DailyParticipantes PRIMARY KEY (DailyId, ParticipanteId)
);

/* ---------- Áudio (temporário) ---------- */

CREATE TABLE dbo.SegmentosAudio (
    Id              BIGINT IDENTITY(1,1) CONSTRAINT PK_SegmentosAudio PRIMARY KEY,
    DailyId         BIGINT         NOT NULL CONSTRAINT FK_SA_Dailies REFERENCES dbo.Dailies(Id) ON DELETE CASCADE,
    ParticipanteId  BIGINT         NOT NULL CONSTRAINT FK_SA_Participantes REFERENCES dbo.Participantes(Id),
    InicioMs        INT            NOT NULL,         -- relativo a Dailies.IniciadaEm
    FimMs           INT            NOT NULL,
    Caminho         NVARCHAR(500)  NOT NULL,
    Formato         VARCHAR(10)    NOT NULL,         -- 'ogg' | 'wav'
    Status          VARCHAR(20)    NOT NULL CONSTRAINT DF_SA_Status DEFAULT 'PENDENTE',
    ApagadoEm       DATETIME2(3)   NULL,
    CONSTRAINT CK_SA_Status CHECK (Status IN ('PENDENTE','TRANSCRITO','DESCARTADO','ERRO'))
);
CREATE INDEX IX_SA_Daily ON dbo.SegmentosAudio (DailyId, Status);

/* ---------- Transcrição ---------- */

CREATE TABLE dbo.Falas (
    Id              BIGINT IDENTITY(1,1) CONSTRAINT PK_Falas PRIMARY KEY,
    DailyId         BIGINT         NOT NULL CONSTRAINT FK_Falas_Dailies REFERENCES dbo.Dailies(Id) ON DELETE CASCADE,
    ParticipanteId  BIGINT         NOT NULL CONSTRAINT FK_Falas_Participantes REFERENCES dbo.Participantes(Id),
    InicioMs        INT            NOT NULL,
    FimMs           INT            NOT NULL,
    Texto           NVARCHAR(MAX)  NOT NULL,
    Confianca       DECIMAL(4,3)   NULL
);
CREATE INDEX IX_Falas_Daily_Inicio ON dbo.Falas (DailyId, InicioMs);
CREATE INDEX IX_Falas_Participante ON dbo.Falas (ParticipanteId, DailyId);

/* ---------- Bloqueios entre dailies ---------- */

CREATE TABLE dbo.Bloqueios (
    Id                  BIGINT IDENTITY(1,1) CONSTRAINT PK_Bloqueios PRIMARY KEY,
    TimeId              BIGINT         NOT NULL CONSTRAINT FK_Bloqueios_Times REFERENCES dbo.Times(Id),
    ParticipanteId      BIGINT         NOT NULL CONSTRAINT FK_Bloqueios_Participantes REFERENCES dbo.Participantes(Id),
    Descricao           NVARCHAR(1000) NOT NULL,
    Status              VARCHAR(20)    NOT NULL CONSTRAINT DF_Bloqueios_Status DEFAULT 'ABERTO',
    PrimeiraDailyId     BIGINT         NOT NULL CONSTRAINT FK_Bloqueios_Primeira REFERENCES dbo.Dailies(Id),
    UltimaDailyId       BIGINT         NOT NULL CONSTRAINT FK_Bloqueios_Ultima REFERENCES dbo.Dailies(Id),
    ResolvidoNaDailyId  BIGINT         NULL     CONSTRAINT FK_Bloqueios_Resolvido REFERENCES dbo.Dailies(Id),
    CONSTRAINT CK_Bloqueios_Status CHECK (Status IN ('ABERTO','RESOLVIDO'))
);
CREATE INDEX IX_Bloqueios_Time_Status ON dbo.Bloqueios (TimeId, Status);

/* ---------- Resumo extraído ---------- */

CREATE TABLE dbo.ItensResumo (
    Id              BIGINT IDENTITY(1,1) CONSTRAINT PK_ItensResumo PRIMARY KEY,
    DailyId         BIGINT         NOT NULL CONSTRAINT FK_IR_Dailies REFERENCES dbo.Dailies(Id) ON DELETE CASCADE,
    ParticipanteId  BIGINT         NULL     CONSTRAINT FK_IR_Participantes REFERENCES dbo.Participantes(Id), -- NULL p/ DECISAO
    Tipo            VARCHAR(20)    NOT NULL,
    Descricao       NVARCHAR(1000) NOT NULL,
    ResponsavelId   BIGINT         NULL     CONSTRAINT FK_IR_Responsavel REFERENCES dbo.Participantes(Id),   -- PENDENCIA
    Prazo           NVARCHAR(100)  NULL,                -- texto livre como foi dito ("até sexta")
    BloqueioId      BIGINT         NULL     CONSTRAINT FK_IR_Bloqueios REFERENCES dbo.Bloqueios(Id),
    Ordem           INT            NOT NULL,
    CONSTRAINT CK_IR_Tipo CHECK (Tipo IN ('FEZ','VAI_FAZER','BLOQUEIO','DECISAO','PENDENCIA'))
);
CREATE INDEX IX_IR_Daily ON dbo.ItensResumo (DailyId, Tipo);
CREATE INDEX IX_IR_Participante ON dbo.ItensResumo (ParticipanteId, DailyId);

CREATE TABLE dbo.ItensResumoEvidencias (
    ItemResumoId    BIGINT NOT NULL CONSTRAINT FK_IRE_Itens REFERENCES dbo.ItensResumo(Id) ON DELETE CASCADE,
    FalaId          BIGINT NOT NULL CONSTRAINT FK_IRE_Falas REFERENCES dbo.Falas(Id),
    CONSTRAINT PK_ItensResumoEvidencias PRIMARY KEY (ItemResumoId, FalaId)
);

CREATE TABLE dbo.ExtracoesLlm (
    Id              BIGINT IDENTITY(1,1) CONSTRAINT PK_ExtracoesLlm PRIMARY KEY,
    DailyId         BIGINT         NOT NULL CONSTRAINT FK_EL_Dailies REFERENCES dbo.Dailies(Id) ON DELETE CASCADE,
    Modelo          VARCHAR(64)    NOT NULL,
    VersaoPrompt    VARCHAR(32)    NOT NULL,
    JsonResposta    NVARCHAR(MAX)  NOT NULL CONSTRAINT CK_EL_Json CHECK (ISJSON(JsonResposta) = 1),
    TokensEntrada   INT            NULL,
    TokensSaida     INT            NULL,
    Ativa           BIT            NOT NULL CONSTRAINT DF_EL_Ativa DEFAULT 1, -- a extração usada pelos ItensResumo atuais
    CriadaEm        DATETIME2(3)   NOT NULL CONSTRAINT DF_EL_CriadaEm DEFAULT SYSUTCDATETIME()
);
CREATE INDEX IX_EL_Daily ON dbo.ExtracoesLlm (DailyId, Ativa);

/* ---------- Fila de jobs ---------- */

CREATE TABLE dbo.Jobs (
    Id                  BIGINT IDENTITY(1,1) CONSTRAINT PK_Jobs PRIMARY KEY,
    Tipo                VARCHAR(30)    NOT NULL,   -- TRANSCREVER | EXTRAIR | LIMPAR_RETENCAO
    DailyId             BIGINT         NULL CONSTRAINT FK_Jobs_Dailies REFERENCES dbo.Dailies(Id) ON DELETE CASCADE,
    Status              VARCHAR(20)    NOT NULL CONSTRAINT DF_Jobs_Status DEFAULT 'PENDENTE',
    Tentativas          INT            NOT NULL CONSTRAINT DF_Jobs_Tentativas DEFAULT 0,
    ExecutarApos        DATETIME2(3)   NOT NULL CONSTRAINT DF_Jobs_ExecutarApos DEFAULT SYSUTCDATETIME(),
    ReservadoPor        NVARCHAR(100)  NULL,
    ReservadoAte        DATETIME2(3)   NULL,
    UltimoErro          NVARCHAR(2000) NULL,
    CriadoEm            DATETIME2(3)   NOT NULL CONSTRAINT DF_Jobs_CriadoEm DEFAULT SYSUTCDATETIME(),
    AtualizadoEm        DATETIME2(3)   NOT NULL CONSTRAINT DF_Jobs_AtualizadoEm DEFAULT SYSUTCDATETIME(),
    CONSTRAINT CK_Jobs_Status CHECK (Status IN ('PENDENTE','EM_EXECUCAO','CONCLUIDO','FALHOU'))
);
CREATE INDEX IX_Jobs_Fila ON dbo.Jobs (Status, ExecutarApos) INCLUDE (Tipo, ReservadoAte);
GO

/* Reserva o próximo job (seguro para N workers concorrentes).
   Também recupera jobs cuja reserva expirou (worker caiu). */
CREATE OR ALTER PROCEDURE dbo.Jobs_ReservarProximo
    @Tipos          NVARCHAR(200),    -- CSV: 'TRANSCREVER,EXTRAIR'
    @WorkerId       NVARCHAR(100),
    @ReservaMinutos INT = 10
AS
BEGIN
    SET NOCOUNT ON;
    DECLARE @agora DATETIME2(3) = SYSUTCDATETIME();

    WITH proximo AS (
        SELECT TOP (1) *
        FROM dbo.Jobs WITH (UPDLOCK, READPAST, ROWLOCK)
        WHERE Tipo IN (SELECT LTRIM(RTRIM(value)) FROM STRING_SPLIT(@Tipos, ','))
          AND (
                (Status = 'PENDENTE'    AND ExecutarApos <= @agora)
             OR (Status = 'EM_EXECUCAO' AND ReservadoAte <  @agora)
          )
        ORDER BY ExecutarApos, Id
    )
    UPDATE proximo
       SET Status       = 'EM_EXECUCAO',
           Tentativas   = Tentativas + 1,
           ReservadoPor = @WorkerId,
           ReservadoAte = DATEADD(MINUTE, @ReservaMinutos, @agora),
           AtualizadoEm = @agora
    OUTPUT inserted.Id, inserted.Tipo, inserted.DailyId, inserted.Tentativas;
END
GO

/* Falha com backoff exponencial (1, 2, 4, 8... min); após @MaxTentativas vira FALHOU. */
CREATE OR ALTER PROCEDURE dbo.Jobs_Falhar
    @JobId          BIGINT,
    @Erro           NVARCHAR(2000),
    @MaxTentativas  INT = 5
AS
BEGIN
    SET NOCOUNT ON;
    UPDATE dbo.Jobs
       SET Status       = CASE WHEN Tentativas >= @MaxTentativas THEN 'FALHOU' ELSE 'PENDENTE' END,
           ExecutarApos = DATEADD(MINUTE, POWER(2, Tentativas - 1), SYSUTCDATETIME()),
           ReservadoPor = NULL,
           ReservadoAte = NULL,
           UltimoErro   = @Erro,
           AtualizadoEm = SYSUTCDATETIME()
     WHERE Id = @JobId;
END
GO

/* ---------- Busca full-text (requer o componente Full-Text Search instalado) ---------- */
IF FULLTEXTSERVICEPROPERTY('IsFullTextInstalled') = 1
BEGIN
    IF NOT EXISTS (SELECT 1 FROM sys.fulltext_catalogs WHERE name = 'FtBotMrx')
        CREATE FULLTEXT CATALOG FtBotMrx;

    -- 1046 = Português (Brasil)
    CREATE FULLTEXT INDEX ON dbo.Falas (Texto LANGUAGE 1046)
        KEY INDEX PK_Falas ON FtBotMrx WITH CHANGE_TRACKING AUTO;
END
GO
