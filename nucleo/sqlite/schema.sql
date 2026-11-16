-- BotMRX — schema SQLite (desenvolvimento local e testes).
-- Espelha db/schema.sql (SQL Server): mesmas tabelas, colunas e estados.
-- Datas/horas em UTC, texto ISO-8601 (ex.: 2026-11-14T12:30:04.123Z); Dailies.Data no fuso do time.

CREATE TABLE IF NOT EXISTS Times (
    Id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    Nome                TEXT NOT NULL,
    DiscordGuildId      TEXT NOT NULL,
    DiscordCanalVozId   TEXT NOT NULL,
    DiscordCanalTextoId TEXT,
    DiscordRoleGestorId TEXT,
    FusoHorario         TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
    AgendaCron          TEXT,
    Ativo               INTEGER NOT NULL DEFAULT 1,
    CriadoEm            TEXT NOT NULL,
    UNIQUE (DiscordGuildId, DiscordCanalVozId)
);

CREATE TABLE IF NOT EXISTS Participantes (
    Id              INTEGER PRIMARY KEY AUTOINCREMENT,
    DiscordUserId   TEXT NOT NULL UNIQUE,
    NomeExibicao    TEXT NOT NULL,
    NaoGravar       INTEGER NOT NULL DEFAULT 0,
    Ativo           INTEGER NOT NULL DEFAULT 1,
    CriadoEm        TEXT NOT NULL,
    AtualizadoEm    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS Dailies (
    Id              INTEGER PRIMARY KEY AUTOINCREMENT,
    TimeId          INTEGER NOT NULL REFERENCES Times(Id),
    Data            TEXT NOT NULL,
    IniciadaEm      TEXT NOT NULL,
    EncerradaEm     TEXT,
    Status          TEXT NOT NULL DEFAULT 'GRAVANDO' CHECK (Status IN (
        'GRAVANDO','AGUARDANDO_TRANSCRICAO','TRANSCREVENDO',
        'AGUARDANDO_EXTRACAO','EXTRAINDO','CONCLUIDA','ERRO')),
    ErroMensagem    TEXT,
    ResumoGeral     TEXT,
    CriadaEm        TEXT NOT NULL,
    AtualizadaEm    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS IX_Dailies_Time_Data ON Dailies (TimeId, Data);

CREATE TABLE IF NOT EXISTS DailyParticipantes (
    DailyId         INTEGER NOT NULL REFERENCES Dailies(Id) ON DELETE CASCADE,
    ParticipanteId  INTEGER NOT NULL REFERENCES Participantes(Id),
    EntrouEm        TEXT NOT NULL,
    SaiuEm          TEXT,
    Gravado         INTEGER NOT NULL,
    PRIMARY KEY (DailyId, ParticipanteId)
);

CREATE TABLE IF NOT EXISTS SegmentosAudio (
    Id              INTEGER PRIMARY KEY AUTOINCREMENT,
    DailyId         INTEGER NOT NULL REFERENCES Dailies(Id) ON DELETE CASCADE,
    ParticipanteId  INTEGER NOT NULL REFERENCES Participantes(Id),
    InicioMs        INTEGER NOT NULL,
    FimMs           INTEGER NOT NULL,
    Caminho         TEXT NOT NULL,
    Formato         TEXT NOT NULL,
    Status          TEXT NOT NULL DEFAULT 'PENDENTE'
        CHECK (Status IN ('PENDENTE','TRANSCRITO','DESCARTADO','ERRO')),
    ApagadoEm       TEXT
);
CREATE INDEX IF NOT EXISTS IX_SA_Daily ON SegmentosAudio (DailyId, Status);

CREATE TABLE IF NOT EXISTS Falas (
    Id              INTEGER PRIMARY KEY AUTOINCREMENT,
    DailyId         INTEGER NOT NULL REFERENCES Dailies(Id) ON DELETE CASCADE,
    ParticipanteId  INTEGER NOT NULL REFERENCES Participantes(Id),
    InicioMs        INTEGER NOT NULL,
    FimMs           INTEGER NOT NULL,
    Texto           TEXT NOT NULL,
    Confianca       REAL
);
CREATE INDEX IF NOT EXISTS IX_Falas_Daily_Inicio ON Falas (DailyId, InicioMs);
CREATE INDEX IF NOT EXISTS IX_Falas_Participante ON Falas (ParticipanteId, DailyId);

CREATE TABLE IF NOT EXISTS Bloqueios (
    Id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    TimeId              INTEGER NOT NULL REFERENCES Times(Id),
    ParticipanteId      INTEGER NOT NULL REFERENCES Participantes(Id),
    Descricao           TEXT NOT NULL,
    Status              TEXT NOT NULL DEFAULT 'ABERTO' CHECK (Status IN ('ABERTO','RESOLVIDO')),
    PrimeiraDailyId     INTEGER NOT NULL REFERENCES Dailies(Id),
    UltimaDailyId       INTEGER NOT NULL REFERENCES Dailies(Id),
    ResolvidoNaDailyId  INTEGER REFERENCES Dailies(Id)
);
CREATE INDEX IF NOT EXISTS IX_Bloqueios_Time_Status ON Bloqueios (TimeId, Status);

CREATE TABLE IF NOT EXISTS ItensResumo (
    Id              INTEGER PRIMARY KEY AUTOINCREMENT,
    DailyId         INTEGER NOT NULL REFERENCES Dailies(Id) ON DELETE CASCADE,
    ParticipanteId  INTEGER REFERENCES Participantes(Id),
    Tipo            TEXT NOT NULL CHECK (Tipo IN ('FEZ','VAI_FAZER','BLOQUEIO','DECISAO','PENDENCIA')),
    Descricao       TEXT NOT NULL,
    ResponsavelId   INTEGER REFERENCES Participantes(Id),
    Prazo           TEXT,
    BloqueioId      INTEGER REFERENCES Bloqueios(Id),
    Ordem           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS IX_IR_Daily ON ItensResumo (DailyId, Tipo);
CREATE INDEX IF NOT EXISTS IX_IR_Participante ON ItensResumo (ParticipanteId, DailyId);

CREATE TABLE IF NOT EXISTS ItensResumoEvidencias (
    ItemResumoId    INTEGER NOT NULL REFERENCES ItensResumo(Id) ON DELETE CASCADE,
    FalaId          INTEGER NOT NULL REFERENCES Falas(Id),
    PRIMARY KEY (ItemResumoId, FalaId)
);

CREATE TABLE IF NOT EXISTS ExtracoesLlm (
    Id              INTEGER PRIMARY KEY AUTOINCREMENT,
    DailyId         INTEGER NOT NULL REFERENCES Dailies(Id) ON DELETE CASCADE,
    Modelo          TEXT NOT NULL,
    VersaoPrompt    TEXT NOT NULL,
    JsonResposta    TEXT NOT NULL CHECK (json_valid(JsonResposta)),
    TokensEntrada   INTEGER,
    TokensSaida     INTEGER,
    Ativa           INTEGER NOT NULL DEFAULT 1,
    CriadaEm        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS IX_EL_Daily ON ExtracoesLlm (DailyId, Ativa);

CREATE TABLE IF NOT EXISTS Jobs (
    Id              INTEGER PRIMARY KEY AUTOINCREMENT,
    Tipo            TEXT NOT NULL,
    DailyId         INTEGER REFERENCES Dailies(Id) ON DELETE CASCADE,
    Status          TEXT NOT NULL DEFAULT 'PENDENTE'
        CHECK (Status IN ('PENDENTE','EM_EXECUCAO','CONCLUIDO','FALHOU')),
    Tentativas      INTEGER NOT NULL DEFAULT 0,
    ExecutarApos    TEXT NOT NULL,
    ReservadoPor    TEXT,
    ReservadoAte    TEXT,
    UltimoErro      TEXT,
    CriadoEm        TEXT NOT NULL,
    AtualizadoEm    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS IX_Jobs_Fila ON Jobs (Status, ExecutarApos);

-- Sessões do dashboard (login com Discord). Guarda só o hash do token; o token fica no cookie.
CREATE TABLE IF NOT EXISTS Sessoes (
    TokenHash       TEXT PRIMARY KEY,
    DiscordUserId   TEXT NOT NULL,
    Nome            TEXT NOT NULL,
    CriadaEm        TEXT NOT NULL,
    ExpiraEm        TEXT NOT NULL
);
