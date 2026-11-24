-- Uma linha por leitura (D1). UNIQUE evita duplicar quando o ESP32 reenvia o backlog.
CREATE TABLE IF NOT EXISTS leituras (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  dispositivo TEXT    NOT NULL,
  ts          INTEGER NOT NULL,            -- epoch em segundos (momento da medicao)
  temp_c      REAL,                        -- NULL = leitura invalida (sensor falhou)
  dist_cm     INTEGER,
  porta       INTEGER NOT NULL DEFAULT 0,  -- 1 = aberta
  estado      TEXT    NOT NULL,            -- ok | temp_alta | temp_baixa | porta_aberta | sensor_falha
  recebido_em INTEGER NOT NULL,            -- quando o Worker recebeu (mostra atraso do backlog)
  UNIQUE (dispositivo, ts)
);
CREATE INDEX IF NOT EXISTS idx_leituras_disp_ts ON leituras (dispositivo, ts);
