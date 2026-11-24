-- Uma linha por leitura (D1). UNIQUE evita duplicar quando o ESP32 reenvia o backlog.
CREATE TABLE IF NOT EXISTS leituras (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  dispositivo TEXT    NOT NULL,
  ts          INTEGER NOT NULL,            -- epoch em segundos (momento da medicao)
  temp_c      REAL,                        -- NULL = leitura invalida (sensor falhou)
  umid_pct    REAL,                        -- umidade relativa (%), NULL = sem leitura
  dist_cm     INTEGER,
  porta       INTEGER NOT NULL DEFAULT 0,  -- 1 = aberta
  estado      TEXT    NOT NULL,            -- ok | temp_alta | temp_baixa | porta_aberta | sensor_falha
  recebido_em INTEGER NOT NULL,            -- quando o Worker recebeu (mostra atraso do backlog)
  UNIQUE (dispositivo, ts)
);
CREATE INDEX IF NOT EXISTS idx_leituras_disp_ts ON leituras (dispositivo, ts);

-- Historico de eventos (alertas, mudancas de estado/porta/buzzer, comandos, leituras dos sensores).
CREATE TABLE IF NOT EXISTS eventos (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  dispositivo TEXT    NOT NULL,
  ts          INTEGER NOT NULL,            -- epoch em segundos
  tipo        TEXT    NOT NULL,            -- alerta | estado | porta | buzzer | conexao | comando | sensores
  detalhe     TEXT    NOT NULL,
  UNIQUE (dispositivo, ts, tipo, detalhe)
);
CREATE INDEX IF NOT EXISTS idx_eventos_disp_ts ON eventos (dispositivo, ts);

-- Cadastro das vacinas guardadas em cada geladeira (feito pelo painel, exige PAINEL_TOKEN).
CREATE TABLE IF NOT EXISTS vacinas (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  dispositivo TEXT    NOT NULL,            -- qual geladeira
  nome        TEXT    NOT NULL,
  lote        TEXT    NOT NULL,
  validade    TEXT    NOT NULL,            -- AAAA-MM-DD
  tipo        TEXT    NOT NULL,
  criado_em   INTEGER NOT NULL,
  UNIQUE (dispositivo, nome, lote)         -- o mesmo lote nao entra duas vezes
);
CREATE INDEX IF NOT EXISTS idx_vacinas_disp_val ON vacinas (dispositivo, validade);
