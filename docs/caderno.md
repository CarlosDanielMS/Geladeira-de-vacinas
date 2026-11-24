# TRABALHO N2 — CADERNO DE PROJETO
**Geladeira de vacinas · IoT (G0813) · Turma AMF 2026-02**

| Integrantes (papéis: montagem · código · nuvem e painel · caderno e testes) | Carlos, Vitório |
| :-- | :-- |
| **Desafio escolhido** | Geladeira de vacinas (opção A) |
| **Link do repositório no GitHub** | https://github.com/CarlosDanielMS/Geladeira-de-vacinas |

> Convenção deste caderno: o que **foi executado de verdade** aparece com data/ferramenta; o que depende de conta, hardware ou Wokwi está marcado **A PREENCHER**.

---

## ETAPA 0 — Desafio

| | |
| :-- | :-- |
| Desafio | Geladeira de vacinas |
| Por que importa / frase da ideia | Vacina que passou da faixa de 2–8 °C pode perder eficácia sem que ninguém perceba, e o posto precisa **provar** pelo histórico que isso não aconteceu. **Frase:** *"Para o posto de saúde, que sofre com vacinas que podem ter saído da faixa sem aviso, o Vacina-Vigia sente temperatura e porta, decide (alarme se ficar fora de 2–8 °C por 5 min ou porta aberta por 3 min) e age com um buzzer, mesmo com a internet fora do ar."* Quem ganha: a equipe do posto (alerta na hora), a vigilância sanitária (prova do histórico) e o paciente (vacina segura). |

**Decisão mais difícil do desafio — internet caiu, e as leituras?** A regra de alarme roda no ESP32, então o alarme local nunca depende da rede. As leituras (1 por minuto) vão para um **buffer circular na RAM (1.440 posições = 24 h)** e só saem do buffer depois que o Worker responde HTTP 2xx. Quando a internet volta, o ESP32 reenvia o backlog em lotes de 30, com o horário **original** da medição. O banco ignora duplicatas (`UNIQUE(dispositivo, ts)`), então reenviar é seguro. *Por quê:* para provar a cadeia de frio não pode haver "buraco" no histórico. *Limite assumido:* o buffer está na RAM; se o ESP32 reiniciar durante uma queda longa, o backlog se perde (melhoria futura: gravar em LittleFS/flash). Passando de 24 h offline, descarta-se o mais antigo e isso é contado (`descartadas`).

---

## ETAPA 1 — Problema e requisitos

| Código | Requisito (o dispositivo deve...) | Como vamos comprovar |
| :-- | :-- | :-- |
| RF1 | Medir temperatura a cada 2 s e porta (distância) a cada 2 s. | Serial mostra `T=.. dist=..` a cada 2 s. |
| RF2 | Ligar o buzzer se a temperatura ficar **> 8 °C ou < 2 °C por mais de 5 min**, ou a **porta aberta por mais de 3 min**, em até 2 s depois de cumprida a condição, mesmo sem internet. | Wokwi: forçar 9 °C, esperar o tempo, tirar o Wi-Fi; buzzer toca. |
| RF3 | Registrar 1 leitura por minuto e **entregar 100 % delas** ao histórico, inclusive as feitas durante uma queda de até 24 h. | Desligar Wi-Fi 5 min, religar; contar linhas no D1 (`SELECT COUNT(*)`) sem buracos nem duplicatas. |
| RF4 | Aceitar o comando "silenciar buzzer" (1–30 min) pelo painel e confirmar com ack em até 10 s. | Painel passa de "pendente" a "executado". |

| Código | Requisito não funcional | Por que é importante |
| :-- | :-- | :-- |
| RNF1 | Decisão local em < 2 s e sem depender de Wi-Fi, MQTT ou Worker (rede roda em outra tarefa/núcleo). | Geladeira não pode ficar sem alarme porque o Wi-Fi do posto caiu. |
| RNF2 | Toda comunicação cifrada com TLS validando o servidor (MQTT porta 8883, HTTPS); nenhum segredo no Git. | Dado de saúde/cadeia de frio e comando que silencia alarme exigem autenticidade. |
| RNF3 | Custo de hardware ≤ R$ 80 e nuvem dentro do plano gratuito (Cloudflare Workers/D1/KV + broker MQTT gratuito); histórico de 365 dias. | Posto de saúde público tem orçamento curto. |

---

## ETAPA 2 — Sentir e agir: componentes

| Componente | Mede ou aciona o quê | GPIO | Faixa ou limite | Se falhar, o sistema... |
| :-- | :-- | :-- | :-- | :-- |
| DHT22 (no Wokwi; DHT11 real teria só ±2 °C, ruim para faixa de 6 °C de largura) | Temperatura interna | 15 | alarme fora de 2–8 °C | 3 leituras NaN seguidas (6 s) → **estado seguro `sensor_falha`: alarme ligado** e alerta enviado. Não dá para provar que a vacina está segura, então alarma. |
| HC-SR04 (distância) | Porta: fica na moldura apontando para a porta. Distância > 20 cm = aberta; < 15 cm = fechada (histerese) | TRIG 5 / ECHO 18 | 0–400 cm | Leitura inválida mantém o último estado da porta; o alarme de temperatura continua valendo (degradação controlada). |
| Buzzer | Representa a sirene do posto | 4 | bipa 500 ms on/off; silenciável por até 30 min | Se o buzzer falhar, o alerta MQTT e o painel continuam avisando (redundância). |

*Estado seguro:* qualquer dúvida (sensor sem leitura) **liga** o alarme, nunca o desliga. O silêncio por comando expira sozinho (máx. 30 min), então ninguém esquece o alarme mudo.

---

## ETAPA 3 — Onde decidir

| Regra de decisão (pseudocódigo) | |
| :-- | :-- |
| ```
a cada 2 s:
  se temp é NaN: falhas++ ; se falhas >= 3 -> estado = sensor_falha (alarme)
  senão:
    se temp > 8 por >= 300 s     -> alarme_alta  = ligado
    se temp < 7                  -> alarme_alta  = desligado   (histerese)
    se temp < 2 por >= 300 s     -> alarme_baixa = ligado
    se temp > 3                  -> alarme_baixa = desligado   (histerese)
  porta aberta se dist > 20 cm; fechada se dist < 15 cm
  se porta aberta por >= 180 s   -> alarme_porta = ligado
  buzzer bipa se (algum alarme) e (não silenciado)
``` | |
| **Onde a regra roda e por quê** | **No ESP32** (arquivo `firmware/src/regra.h`). Precisa funcionar sem internet, reagir em < 1 s e não depende de outros dispositivos. A nuvem só guarda e mostra. Os limites ficam em `config.h` (mudar exige regravar; trocar para ler do KV é possível, mas a regra deixaria de ser autônoma se o KV não responder — mantivemos fixo por segurança). Histerese 8/7 °C e 2/3 °C evita alarme "piscando" quando a temperatura oscila no limite; os 5 min filtram a abertura rápida de porta, que sobe a temperatura sem comprometer a vacina. |
| **Internet caiu? E quando voltar?** | Caiu: sensores, regra e buzzer seguem normais (loop sem rede); leituras vão para o buffer; Wi-Fi/MQTT reconectam a cada 5–10 s sem travar nada. O painel mostra "ESP32 offline" porque o broker publica o Last Will (`online:false`). Voltou: a tarefa de rede reconecta, publica o estado atual (retido) e reenvia o backlog por HTTPS em lotes de 30 a cada 10 s, do mais antigo ao mais novo; cada lote só sai do buffer após HTTP 2xx. |

---

## ETAPA 4 — Comunicar

| | |
| :-- | :-- |
| **Protocolos e por quê** | **MQTT/TLS** para tempo real (telemetria, estado, comando, ack, alerta): vários assinantes, comando de volta ao dispositivo e Last Will para online/offline. **HTTPS (Worker)** para gravar o histórico em lote com `Authorization`: o Worker não consegue assinar MQTT, e HTTP com retry por lote é ideal para o reenvio do backlog. **WebSocket** (MQTT sobre `wss`) só no navegador, para o painel atualizar sozinho. |

**Árvore de tópicos** (`g01` = grupo, `geladeira1` = local; troque `g01` pelo código do seu grupo em `config.h` e `painel/config.js`):

| Tópico | Publica | Assina | Obs. |
| :-- | :-- | :-- | :-- |
| `sis1a/g01/geladeira1/telemetria` | ESP32 | painel | a cada 10 s, não retido |
| `sis1a/g01/geladeira1/estado` | ESP32 (e broker, via Last Will) | painel | retido, QoS1; `online`, `estado`, `alarme`, `pendentes` |
| `sis1a/g01/geladeira1/alerta` | ESP32 | painel | cooldown de 5 min por tipo |
| `sis1a/g01/geladeira1/comando` | painel | ESP32 | QoS1; exige `cmd`, `id`, `nonce` |
| `sis1a/g01/geladeira1/ack` | ESP32 | painel | `executado` ou `rejeitado` + motivo |

*Com 1.000 unidades:* o mesmo padrão escala trocando `<local>` (`geladeira1`…`geladeira1000`); o painel assina `sis1a/g01/+/estado`. A ACL do broker dá a cada ESP32 só o próprio `<local>`.

**JSON de exemplo da telemetria:** `{"temp_c": 5.2, "dist_cm": 8}`
**Estado:** `{"online":true,"estado":"ok","alarme":false,"porta_aberta":false,"temp_c":5.2,"silenciado":false,"pendentes":0}`
**Comando:** `{"cmd":"silenciar","min":10,"id":"k3j9x2","nonce":1767225600000}` → **ack:** `{"id":"k3j9x2","cmd":"silenciar","status":"executado"}`

| **TLS: porta e verificação** | MQTT na **8883** (nunca 1883) e HTTPS na 443. O ESP32 chama `setCACert()` com a **CA raiz** do broker e do Worker (arquivo `certs.h`, fora do Git), então confere a cadeia e o nome do servidor. **`setInsecure()` não é usado em nenhum lugar** (`grep` no código não encontra). Horário via NTP também ajuda na validade do certificado. |
| :-- | :-- |

---

## ETAPA 5 — Guardar

| | |
| :-- | :-- |
| **KV, D1 ou os dois?** | **Os dois.** **D1** para o histórico (uma linha por leitura): o objetivo é *provar* o passado, o que exige SQL com `GROUP BY` e filtro por período. **KV** só para o *último estado* (`ultimo:geladeira1`): leitura por chave, rápida, para o painel mostrar "agora" sem consultar o banco. |
| **Estrutura** | Tabela `leituras(id, dispositivo, ts, temp_c, dist_cm, porta, estado, recebido_em)`, `UNIQUE(dispositivo, ts)` (reenvio idempotente) e índice `(dispositivo, ts)`. `temp_c` fica `NULL` quando o sensor falhou (a falha também é prova). `recebido_em` permite medir o atraso do backlog. KV: chave `ultimo:<dispositivo>`. Ver `worker/schema.sql`. |
| **Frequência** | 1 leitura por minuto no D1 (telemetria MQTT a cada 10 s só para o painel ao vivo). Alarmes duram minutos, então 1/min não perde excursões relevantes e dá ~525 mil linhas/ano por unidade. |
| **Consulta de resumo** | `worker/resumo.sql` e rota `GET /api/resumo`: **máx/média/mín por hora nas últimas 24 h e quantas leituras ficaram fora de 2–8 °C**, `GROUP BY hora`. Responde: *"a vacina saiu da faixa em algum momento? Quando?"* |
| **Retenção e dado pessoal** | 365 dias (variável `RETENCAO_DIAS`, limpeza diária por cron do Worker). **Não há dado pessoal**: só temperatura, porta e horário, sem identificar quem abriu. Se um dia houver leitor de crachá, guardar só o necessário, com prazo menor (LGPD). *Observação:* normas de cadeia de frio podem exigir prazo maior; confirmar com a vigilância sanitária. |

---

## ETAPA 6 — Painel

| | |
| :-- | :-- |
| **O que mostra** | Temperatura atual, estado (ok/alarme), porta, buzzer, leituras pendentes no ESP32, online/offline; gráfico das últimas 6 h com a faixa 2–8 °C sombreada e pontos fora da faixa em vermelho; tabela de resumo por hora (24 h). |
| **Comando remoto** | "Silenciar buzzer 10 min" e "Reativar buzzer", publicados em `.../comando` (MQTT sobre WebSocket). |
| **Como sabe que executou** | Cada comando leva um `id`. O item fica **"pendente"** até chegar `ack` com o mesmo `id` → **"executado"** (ou **"rejeitado: motivo"**). Sem ack em **10 s** → **"sem resposta (ESP32 offline?)"**. |
| **Alerta** | Dispara quando o estado deixa `ok` (temp alta/baixa, porta aberta, sensor falho). Chega pelo tópico `alerta` e aparece como faixa vermelha no painel. **Cooldown de 5 min** por tipo, aplicado no ESP32 (não gera spam nem em caso de reconexão do painel). |
| **Polling ou WebSocket?** | **Os dois, cada um onde cabe:** WebSocket (MQTT) para estado/telemetria/ack/alerta ao vivo; polling de 30 s ao Worker para o histórico, que muda devagar e vem do D1. |

---

## ETAPA 7 — Segurança

| Buraco | Existe? | Como fechamos |
| :-- | :-- | :-- |
| 1. MQTT sem TLS (1883) | Existia como risco (brokers aceitam 1883). | Só se usa **8883** (e `wss` 8884 no painel); desabilitar 1883 no broker. |
| 2. `setInsecure()` | Risco ao copiar exemplos. | `setCACert()` com a CA raiz em `MQTT` e `HTTPS`; `setInsecure` ausente do código. |
| 3. Rota de gravação aberta | Sim, `POST /api/leituras` seria pública. | Exige `Authorization: Bearer <INGEST_TOKEN>` (segredo do Worker, comparação em tempo constante; sem segredo configurado **recusa tudo**), corpo ≤ 64 KB e validação do JSON (tipos, faixas, ≤ 100 leituras, `ts` plausível). Testado: sem token/token errado → 401; JSON quebrado ou fora da faixa → 400. |
| 4. Tópico de comando aberto | Sim, em broker sem ACL qualquer um publicaria. | (a) Usuário/senha no broker; (b) **ACL**: ESP32 só assina `comando` e publica nos demais; painel só publica em `comando`; (c) o ESP32 **valida o comando**: JSON, `cmd` em lista fixa, `min` 1–30, `id` obrigatório e **`nonce` crescente persistido na flash** (comando repetido/replay é rejeitado). Pior caso de um comando falso: silenciar o buzzer por no máx. 30 min, e o alerta e o painel continuam avisando. Limite assumido: usuário do painel fica visível no navegador. |
| 5. Segredo no GitHub/Serial | Risco. | `.gitignore` cobre `secrets.h`, `certs.h`, `.dev.vars`, `painel/config.js`; versionamos só `*.example`. Token do Worker via `wrangler secret put`. O Serial nunca imprime senha, token nem payload de login. |

---

## ETAPA 8 — Extra: tempo real (WebSocket)

| | |
| :-- | :-- |
| **Extra e por quê** | **WebSocket**: o painel assina o broker por `wss` (MQTT sobre WebSocket) e atualiza temperatura, estado, alerta e ack **sem recarregar**. Combina com o problema: em cadeia de frio o tempo até o alerta importa, e o mesmo canal traz o ack do comando. |
| **Evidência** | **A PREENCHER** (print ou vídeo curto do painel mudando sozinho; ver `docs/evidencias/`). |

---

## ETAPA 9 — Arquitetura final

| Camada | O que tem |
| :-- | :-- |
| Dispositivo | ESP32 + DHT22 + HC-SR04 + buzzer. Núcleo 1: sensores, regra (`regra.h`), buzzer. Núcleo 0: Wi-Fi, MQTT, HTTPS, buffer circular (`buffer.h`) de 24 h. |
| Rede | Wi-Fi → MQTT/TLS 8883 (broker na nuvem) para tempo real; HTTPS 443 → Worker para histórico; `wss` 8884 para o painel. |
| Nuvem | Cloudflare Worker (validação + token) · D1 (`leituras`) · KV (`ultimo`) · cron de retenção · broker MQTT com TLS e ACL. |
| Interface | Painel web (estático, servido pelo Worker): estado, gráfico, resumo, comando com ack, alerta. |

```
 DHT22, HC-SR04 --> [ESP32: regra + buzzer] --MQTT/TLS--> [Broker] --wss--> [Painel]
                         |  buffer 24 h                                       |
                         +--HTTPS + Bearer (lotes)--> [Worker] --> D1 / KV <--+ (GET /api/*)
```

Desenho/print do Wokwi: **A PREENCHER** (`docs/evidencias/`). O circuito está em `firmware/diagram.json`.

---

## ETAPA 10 — Testes

Legenda: **[feito]** = executado nesta construção; **[A PREENCHER]** = precisa de Wokwi/placa/nuvem.

| Teste | Como fizemos | Resultado |
| :-- | :-- | :-- |
| Isolado | **[feito]** Firmware compilado com PlatformIO (`pio run`, ESP32, sem erros; ~71 % da flash, ~20 % da RAM). **[feito]** Worker publicado de verdade no Cloudflare (`wrangler deploy`, D1/KV reais) e `node worker/test/smoke.mjs` contra o ambiente real: 11 verificações OK (token ausente/errado → 401, JSON/valor inválido → 400, lote válido → 200, reenvio idempotente, resumo `GROUP BY` correto, KV com último estado, painel servido). **[feito]** Sensores e buzzer simulados no Wokwi (DHT22/HC-SR04/buzzer do `diagram.json`), boot e leituras confirmados via Serial Monitor, tanto por `wokwi-cli` (terminal) quanto pelo simulador no navegador (wokwi.com). | Build, deploy do Worker e smoke test: OK (11/11, ambiente real). Sensores/buzzer no Wokwi: OK. |
| Integração MQTT/HTTPS no Wokwi | ESP32 simulado conectando num broker MQTT público (`broker.hivemq.com:8883`, TLS, sem conta) e tentando enviar o backlog por HTTPS pro Worker real (`vacinas-worker.vacinas-n2.workers.dev`). Testado em dois ambientes do Wokwi: `wokwi-cli` (terminal) e o simulador no navegador (wokwi.com), depois na extensão Wokwi do VS Code. Assinado via **HiveMQ WebSocket Client** (`hivemq.com/demos/websocket-client`, sem conta) no tópico `sis1a/g01/geladeira1/#`. | **MQTT: [feito]** — conecta e publica de forma estável nos três ambientes (telemetria a cada 10 s, estado retido, comando/ack). **Efeito colateral encontrado:** enquanto `enviaBuffer()` (HTTPS) ficava travado (até 26 s, ver abaixo), o laço de rede parava de chamar `mqtt.loop()` por tempo demais e o broker derrubava a conexão por falta de keepalive — o MQTT reconectava a cada ~20-25 s. Isolado desativando temporariamente a chamada a `enviaBuffer()` em `tarefaRede()`: a partir daí o MQTT ficou estável de forma contínua. **HTTPS/Cloudflare: [A PREENCHER]** — a conexão TLS trava ou é fechada pelo servidor (erros como `UNKNOWN ERROR CODE` e `SSL - The connection indicated an EOF`) de forma consistente nos ambientes do Wokwi, inclusive contra outro host HTTPS qualquer (testado com `google.com`) — indica um limite da rede simulada do Wokwi para a porta 443, não um bug no firmware/certs/config (confirmado: o mesmo Worker responde certinho via `curl`/`node` fora do Wokwi — ver linha "Isolado"). Esperado funcionar normalmente em hardware real com Wi-Fi de verdade. **Dois bugs de portabilidade encontrados e corrigidos** durante este teste (o PlatformIO local usa Arduino-ESP32 2.0.17, mas o Wokwi usa a série 3.x): watchdog disparando por handshake TLS ser CPU-bound (`disableCore0WDT()` vs `esp_task_wdt_reconfigure()`, selecionado por `ESP_ARDUINO_VERSION`) e API do LEDC do buzzer (`ledcSetup`/`ledcAttachPin` vs `ledcAttach`, idem). |
| No limite (forçar o sensor) | Wokwi: DHT22 em 9 °C e 1 °C, HC-SR04 > 20 cm; para demonstrar, usar `ATRASO_TEMP_S 30`. | **A PREENCHER** |
| Na falha (sem sensor / sem Wi-Fi) | Remover o DHT (esperado: `sensor_falha` e buzzer em ~6 s); desligar o Wi-Fi 5 min, religar e conferir linhas no D1 sem buraco (esperado: backlog entregue, `pendentes` volta a 0). | **A PREENCHER** |
| No reinício | Desligar/ligar o ESP32; conferir que reconecta e que o `nonce` persiste (reenviar comando antigo é rejeitado). | **A PREENCHER** |
| No ataque (comando falso) | Publicar em `.../comando` com `nonce` antigo, `cmd` desconhecido e `min:999` (esperado: `rejeitado`); publicar sem usuário (esperado: broker nega). `curl` no Worker sem token: **[feito]** 401. | Worker: OK. **MQTT: [feito]** — via HiveMQ WebSocket Client: `{"cmd":"silenciar","min":5,"nonce":1}` foi aceito (`ack` `executado`, `estado` passou a `"silenciado":true`); reenviar o **mesmo** `nonce:1` depois foi **rejeitado** com `{"status":"rejeitado","motivo":"nonce_repetido"}` — anti-replay confirmado funcionando. Usuário/senha do broker público não testado (broker é anônimo por design; ACL real só se aplica com HiveMQ Cloud). |
| Na duração (10 min) | Deixar rodando 10 min e conferir ~10 linhas no D1 e memória estável. | **A PREENCHER** |

---

## ETAPA 11 — Apresentação (roteiro de 4 min) e checklist

1. **(30 s) Problema:** a frase da ideia — o posto precisa provar que a vacina nunca saiu de 2–8 °C.
2. **(40 s) Arquitetura:** sensor → ESP32 (decide) → MQTT/TLS → painel; ESP32 → Worker → D1 (histórico).
3. **(60 s) Escolhas e porquê:** regra no ESP32 (funciona offline, histerese, 5 min de tolerância, sensor falho = alarme); MQTT para tempo real e HTTPS em lote para o histórico; D1 para provar o passado e KV para o "agora"; TLS validado, token, ACL, nonce.
4. **(90 s) Demonstração:** esquentar o DHT no Wokwi → alarme; silenciar pelo painel (pendente → executado); derrubar o Wi-Fi e mostrar o backlog chegando.
5. **(20 s) Para virar produto:** 1.000 unidades (tópico por local, ACL por dispositivo, D1 particionado), bateria/backup de energia, buffer em flash, certificação do sensor.

**Respostas prontas:** *"E se a internet cair?"* — o alarme é local e as leituras ficam no buffer de 24 h e são reenviadas sem duplicar. *"E se alguém publicar no tópico?"* — exige usuário (ACL) e o ESP32 valida formato, faixa e nonce; o pior efeito é silenciar por até 30 min. *"E com 1.000 unidades?"* — mesma árvore com `<local>` diferente, ACL por dispositivo e `GROUP BY dispositivo` no D1.

| ☐ | Item |
| :-- | :-- |
| ☐ | Este caderno convertido para .docx/PDF em `docs/` e no Classroom |
| ☐ | Integrantes e link do GitHub preenchidos |
| ☑ | Código ESP32 e Worker sem senhas/chaves (apenas `*.example`) |
| ☑ | README curto |
| ☐ | Print/vídeo do sistema funcionando (`docs/evidencias/`) |
