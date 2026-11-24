-- Bancos criados ANTES da umidade: adiciona a coluna. Rode UMA vez (rodar de novo da erro "duplicate column", sem prejuizo).
ALTER TABLE leituras ADD COLUMN umid_pct REAL;
