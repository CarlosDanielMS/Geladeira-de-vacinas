# Geladeira de vacinas (Trabalho N2 – IoT)

ESP32 que vigia uma geladeira de vacinas (faixa 2–8 °C), decide **localmente** quando alarmar (temperatura fora da faixa por 5 min, porta aberta por 3 min, sensor com defeito), toca um buzzer, publica por MQTT/TLS e guarda o histórico no Cloudflare D1. Se a internet cair, as leituras ficam num buffer de 24 h e são reenviadas depois. Caderno completo: [`docs/caderno.md`](docs/caderno.md).

```
firmware/  ESP32 (PlatformIO) + diagram.json/wokwi.toml     worker/  Cloudflare Worker, D1, KV
painel/    painel web (servido pelo Worker)                  docs/    caderno e evidências
```

## Como montar
- **Wokwi/placa:** DHT22 → GPIO15, HC-SR04 TRIG → 5 / ECHO → 18, buzzer → GPIO4 (ver `firmware/diagram.json`).

## Configurar segredos (nada disso vai para o Git)
1. `firmware/include/secrets.h.example` → `secrets.h` (Wi-Fi, broker MQTT, URL e token do Worker).
2. `firmware/include/certs.h.example` → `certs.h` (CA raiz do broker e do Worker; veja o comentário no arquivo).
3. `painel/config.example.js` → `config.js` (usuário do painel no broker, só com ACL de comando).
4. `worker/.dev.vars.example` → `worker/.dev.vars` (teste local). Em produção: `wrangler secret put INGEST_TOKEN`.
5. Troque `GRUPO` em `firmware/include/config.h` e `base` em `painel/config.js` pelo código do seu grupo.

## Rodar
```bash
# Firmware
cd firmware && pio run            # compila; no Wokwi aponte para .pio/build/esp32/firmware.*
# Worker (local, sem nuvem)
cd worker && npm install && npm run db:local && npm run dev
node test/smoke.mjs               # em outro terminal
```
Para demonstrar rápido no Wokwi, use `ATRASO_TEMP_S 30` em `config.h`.

## Publicar (manual, na sua conta)
`wrangler d1 create vacinas` e `wrangler kv namespace create ESTADO` → cole os ids em `worker/wrangler.toml` → `wrangler d1 execute vacinas --remote --file=schema.sql` → `wrangler secret put INGEST_TOKEN` → `wrangler deploy`. No broker (ex.: HiveMQ Cloud): crie usuários `dispositivo` e `painel` com as ACLs descritas no caderno.

## Como testar
Wokwi: DHT22 > 8 °C por 5 min (ou 30 s no modo demo) → buzzer e alerta; remova o DHT → `sensor_falha`; derrube o Wi-Fi e religue → backlog chega ao D1; no painel, "Silenciar" passa de *pendente* a *executado*.

### Testado de ponta a ponta (2026-11-23)
- **Worker real**: publicado no Cloudflare, 11/11 do `smoke.mjs` passando contra o ambiente de produção.
- **MQTT no Wokwi**: funciona liso usando o broker público `broker.hivemq.com:8883` (sem conta) — confirmado tanto via `wokwi-cli` (terminal) quanto no simulador do navegador (wokwi.com).
- **HTTPS do Wokwi pro Worker**: **não funciona dentro do simulador** (a porta 443 trava/é fechada pelo servidor, mesmo testando contra outro host qualquer) — é limite da rede simulada do Wokwi, não bug do projeto. Em hardware real (Wi-Fi de verdade) isso deve funcionar normalmente; enquanto isso, o buffer local garante que nada se perde.
- **Compatibilidade de core**: o PlatformIO local usa Arduino-ESP32 2.0.17, mas o Wokwi usa a série 3.x — o código já trata as duas versões (watchdog e API do LEDC) via `#if ESP_ARDUINO_VERSION >= ...`.

Detalhes completos em [`docs/caderno.md`](docs/caderno.md), ETAPA 10.

### Testar as mensagens MQTT manualmente
Sem precisar de conta: abra **https://www.hivemq.com/demos/websocket-client/**, conecte (já vem com `broker.hivemq.com:8884`/wss) e assine `sis1a/g01/geladeira1/#` pra ver telemetria/estado/alerta chegando. Pra testar o comando "silenciar", publique em `sis1a/g01/geladeira1/comando`:
```json
{"id":"teste1","cmd":"silenciar","min":5,"nonce":1}
```
(o `nonce` precisa ser maior a cada novo comando — use um número crescente ou o timestamp atual). A resposta chega em `.../ack`.
