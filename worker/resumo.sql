-- Consulta de resumo: temperatura maxima, media e minima por hora nas ultimas 24 h,
-- e quantos minutos (leituras de 1/min) ficaram fora da faixa 2-8 C.
-- Pergunta que responde: "a vacina saiu da faixa em algum momento? Quando?"
SELECT strftime('%Y-%m-%d %H:00', ts, 'unixepoch') AS hora,
       MAX(temp_c)                                  AS max_c,
       ROUND(AVG(temp_c), 2)                        AS media_c,
       MIN(temp_c)                                  AS min_c,
       COUNT(*)                                     AS leituras,
       SUM(CASE WHEN temp_c > 8 OR temp_c < 2 THEN 1 ELSE 0 END) AS fora_da_faixa
FROM leituras
WHERE dispositivo = 'geladeira1'
  AND ts >= CAST(strftime('%s','now') AS INTEGER) - 24*3600
GROUP BY hora
ORDER BY hora;
