// Geladeira de vacinas - ESP32
// Core 1 (loop): sensores + regra + buzzer  -> funciona SEM internet
// Core 0 (tarefa de rede): Wi-Fi, MQTT/TLS, HTTPS (envia o buffer ao Worker)
#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <DHT.h>
#include <Preferences.h>
#include <esp_arduino_version.h>
#if ESP_ARDUINO_VERSION >= ESP_ARDUINO_VERSION_VAL(3, 0, 0)
#include <esp_task_wdt.h>
#endif
#include <time.h>
#include "config.h"
#if __has_include("secrets.h")
#include "secrets.h"
#else
#warning "secrets.h ausente: usando secrets.h.example (so compila, nao conecta)"
#include "secrets.h.example"
#endif
#if __has_include("certs.h")
#include "certs.h"
#else
#warning "certs.h ausente: usando certs.h.example (so compila)"
#include "certs.h.example"
#endif
#include "regra.h"
#include "buffer.h"

// ---------- estado compartilhado entre as duas tarefas ----------
static SemaphoreHandle_t mtx;
static Regra regra;
static Fila<BUFFER_CAP> fila;
static float g_temp = NAN, g_dist = NAN, g_umid = NAN;
static volatile uint32_t g_muteAte = 0;      // millis() ate quando o buzzer fica mudo (0 = nao)
static volatile uint32_t g_bootEpoch = 0;    // epoch do instante millis()==0 (0 = sem hora)

static DHT dht(PIN_DHT, DHT22);
#ifndef MQTT_TLS
#define MQTT_TLS 1                          // 0 = MQTT sem criptografia (so para diagnostico/simulador; porta 1883)
#endif
static WiFiClientSecure mqttNet, httpNet;
static WiFiClient mqttPlain;                // usado so quando MQTT_TLS 0
static PubSubClient mqtt;
static Preferences prefs;
static uint64_t ultimoNonce = 0;

static const char T_TEL[]    = TOPIC_BASE "telemetria";
static const char T_EST[]    = TOPIC_BASE "estado";
static const char T_CMD[]    = TOPIC_BASE "comando";
static const char T_ALERTA[] = TOPIC_BASE "alerta";
static const char T_ACK[]    = TOPIC_BASE "ack";

void tarefaRede(void*);

// ---------- sensores ----------
static float leDistanciaCm() {
  digitalWrite(PIN_TRIG, LOW); delayMicroseconds(2);
  digitalWrite(PIN_TRIG, HIGH); delayMicroseconds(10);
  digitalWrite(PIN_TRIG, LOW);
  unsigned long us = pulseIn(PIN_ECHO, HIGH, 25000UL);   // timeout 25 ms
  return us == 0 ? NAN : us / 58.0f;
}

// ---------- buzzer ----------
static void buzzer(bool ligado) {
  static bool atual = false;
  if (ligado == atual) return;
  atual = ligado;
#if ESP_ARDUINO_VERSION >= ESP_ARDUINO_VERSION_VAL(3, 0, 0)
  ledcWriteTone(PIN_BUZZER, ligado ? 2000 : 0);   // core 3.x: API por pino
#else
  ledcWriteTone(0, ligado ? 2000 : 0);             // core 2.x: API por canal
#endif
}

void setup() {
  Serial.begin(115200);
  pinMode(PIN_TRIG, OUTPUT); pinMode(PIN_ECHO, INPUT);
#if ESP_ARDUINO_VERSION >= ESP_ARDUINO_VERSION_VAL(3, 0, 0)
  ledcAttach(PIN_BUZZER, 2000, 8); ledcWriteTone(PIN_BUZZER, 0);   // core 3.x: API por pino
#else
  ledcSetup(0, 2000, 8); ledcAttachPin(PIN_BUZZER, 0); ledcWriteTone(0, 0);   // core 2.x: API por canal
#endif
  dht.begin();
  mtx = xSemaphoreCreateMutex();
  prefs.begin("vacina", false);
  ultimoNonce = prefs.getULong64("nonce", 0);        // anti-replay sobrevive a reinicio
  xTaskCreatePinnedToCore(tarefaRede, "rede", 12288, nullptr, 1, nullptr, 0);
  Serial.println("Geladeira de vacinas: regra local ativa");
}

// ---------- loop: sensores + regra + buzzer (nunca espera pela rede) ----------
void loop() {
  static uint32_t tLeitura = 0, tRegistro = 0;
  static bool primeira = true, primeiroReg = true;
  uint32_t now = millis();

  if (primeira || now - tLeitura >= LEITURA_MS) {
    primeira = false; tLeitura = now;
    float t = dht.readTemperature();
    float u = dht.readHumidity();
    float d = leDistanciaCm();
    xSemaphoreTake(mtx, portMAX_DELAY);
    g_temp = t; g_dist = d; g_umid = u;
    regra.atualiza(now, t, d);
    Estado e = regra.estado;
    bool porta = regra.portaAberta;
    if (primeiroReg || now - tRegistro >= REGISTRO_S * 1000UL) {
      primeiroReg = false; tRegistro = now;
      fila.push(Leitura{now / 1000, t, u, (int16_t)(isnan(d) ? -1 : d), (uint8_t)e, (uint8_t)porta});
    }
    xSemaphoreGive(mtx);
    Serial.printf("T=%.1f C  UR=%.0f %%  dist=%.0f cm  estado=%s\n", t, u, d, nomeEstado(e));
  }

  // buzzer: bipa 500 ms on/off enquanto houver alarme e nao estiver silenciado
  uint32_t mute = g_muteAte;
  bool alarme = regra.alarme();
  bool mudo = mute != 0 && (int32_t)(mute - now) > 0;
  // silencio expirou, ou o alarme acabou: o proximo alarme volta a tocar
  if (mute != 0 && (!mudo || !alarme)) { g_muteAte = 0; mudo = false; }
  buzzer(alarme && !mudo && ((now / 500) % 2 == 0));
  delay(20);
}

// =====================  TAREFA DE REDE (core 0)  =====================

static void publicaEstado(bool online) {
  JsonDocument d;
  d["online"] = online;
  xSemaphoreTake(mtx, portMAX_DELAY);
  d["estado"] = nomeEstado(regra.estado);
  d["alarme"] = regra.alarme();
  d["porta_aberta"] = regra.portaAberta;
  if (!isnan(g_temp)) d["temp_c"] = round(g_temp * 10) / 10.0;
  if (!isnan(g_umid)) d["umid_pct"] = round(g_umid * 10) / 10.0;
  int pend = fila.tamanho();
  xSemaphoreGive(mtx);
  d["silenciado"] = g_muteAte != 0;
  d["pendentes"] = pend;
  char buf[256]; size_t n = serializeJson(d, buf);
  mqtt.publish(T_EST, (const uint8_t*)buf, n, true);   // retido: painel novo ja ve o ultimo estado
}

static void ack(const char* id, const char* cmd, const char* status, const char* motivo) {
  JsonDocument d;
  d["id"] = id; d["cmd"] = cmd; d["status"] = status;
  if (motivo) d["motivo"] = motivo;
  char buf[200]; size_t n = serializeJson(d, buf);
  mqtt.publish(T_ACK, (const uint8_t*)buf, n, false);
}

// Valida o comando (formato, faixa, anti-replay) ANTES de agir.
static void aoReceber(char* topic, uint8_t* payload, unsigned int len) {
  if (len == 0 || len > 200) return;
  JsonDocument d;
  if (deserializeJson(d, payload, len)) return;
  const char* cmd = d["cmd"] | "";
  const char* id  = d["id"] | "";
  uint64_t nonce  = d["nonce"] | (uint64_t)0;
  if (strlen(id) == 0 || strlen(id) > 20) return;              // sem id nao ha como confirmar
  if (nonce <= ultimoNonce) { ack(id, cmd, "rejeitado", "nonce_repetido"); return; }

  if (strcmp(cmd, "silenciar") == 0) {
    int min = d["min"] | 0;
    if (min < 1 || min > SILENCIO_MAX_MIN) { ack(id, cmd, "rejeitado", "min_fora_da_faixa"); return; }
    xSemaphoreTake(mtx, portMAX_DELAY);
    bool emAlarme = regra.alarme();
    xSemaphoreGive(mtx);
    // sem alarme nao ha o que silenciar; aceitar aqui deixaria o PROXIMO alarme mudo sem ninguem saber
    if (!emAlarme) { ack(id, cmd, "rejeitado", "sem_alarme_ativo"); return; }
    g_muteAte = (millis() + min * 60000UL) | 1;
  } else if (strcmp(cmd, "reativar") == 0) {
    g_muteAte = 0;
  } else { ack(id, cmd, "rejeitado", "comando_desconhecido"); return; }

  ultimoNonce = nonce; prefs.putULong64("nonce", nonce);
  ack(id, cmd, "executado", nullptr);
  publicaEstado(true);
}

static bool conectaMqtt() {
  String cid = String("vacina-") + String((uint32_t)ESP.getEfuseMac(), HEX);
  // Last Will: se o ESP32 sumir, o broker publica online=false (retido) sozinho
  if (!mqtt.connect(cid.c_str(), MQTT_USER, MQTT_PASS, T_EST, 1, true, "{\"online\":false}")) return false;
  mqtt.subscribe(T_CMD, 1);
  publicaEstado(true);
  return true;
}

static void alertas() {
  static uint32_t ultimo[6] = {0};          // um cooldown por tipo de estado
  static bool enviou[6] = {false};
  xSemaphoreTake(mtx, portMAX_DELAY);
  Estado e = regra.estado; float t = g_temp;
  xSemaphoreGive(mtx);
  if (e == EST_OK || e == EST_INICIANDO) {   // voltou ao normal: o proximo episodio alerta na hora (cooldown so vale dentro do mesmo alarme)
    for (bool& b : enviou) b = false;
    return;
  }
  uint32_t now = millis();
  if (enviou[e] && now - ultimo[e] < COOLDOWN_ALERTA_MS) return;   // cooldown 5 min
  JsonDocument d;
  d["tipo"] = nomeEstado(e);
  if (!isnan(t)) d["temp_c"] = round(t * 10) / 10.0;
  d["cooldown_s"] = COOLDOWN_ALERTA_MS / 1000;
  char buf[160]; size_t n = serializeJson(d, buf);
  if (mqtt.publish(T_ALERTA, (const uint8_t*)buf, n, false)) { ultimo[e] = now; enviou[e] = true; }
}

// Envia o buffer em lotes; so remove do buffer depois do HTTP 2xx.
static void enviaBuffer() {
  if (WORKER_URL[0] == 0) return;                   // sem URL (ex.: Wokwi + Worker local): a ponte MQTT grava no D1
  if (g_bootEpoch == 0) return;                     // sem hora (NTP) nao ha timestamp confiavel
  static Leitura lote[LOTE_MAX];
  xSemaphoreTake(mtx, portMAX_DELAY);
  int k = fila.copia(lote, LOTE_MAX);
  xSemaphoreGive(mtx);
  if (k == 0) return;

  JsonDocument d;
  d["dispositivo"] = LOCAL;
  JsonArray arr = d["leituras"].to<JsonArray>();
  for (int i = 0; i < k; i++) {
    JsonObject o = arr.add<JsonObject>();
    o["ts"] = g_bootEpoch + lote[i].up_s;
    if (!isnan(lote[i].temp_c)) o["temp_c"] = round(lote[i].temp_c * 10) / 10.0;
    if (!isnan(lote[i].umid_pct)) o["umid_pct"] = round(lote[i].umid_pct * 10) / 10.0;
    if (lote[i].dist_cm >= 0) o["dist_cm"] = lote[i].dist_cm;
    o["porta"] = lote[i].porta;
    o["estado"] = nomeEstado((Estado)lote[i].estado);
  }
  String corpo; serializeJson(d, corpo);

  HTTPClient http;
  http.setTimeout(8000);   // handshake TLS via internet simulada do Wokwi pode ser mais lento
  if (!http.begin(httpNet, WORKER_URL)) { Serial.println("[rede] http.begin falhou"); return; }
  http.addHeader("Content-Type", "application/json");
  http.addHeader("Authorization", String("Bearer ") + WORKER_TOKEN);   // nunca impresso no Serial
  uint32_t t0 = millis();
  int code = http.POST(corpo);
  http.end();
  if (code >= 200 && code < 300) {
    xSemaphoreTake(mtx, portMAX_DELAY);
    fila.remove(k);
    xSemaphoreGive(mtx);
    Serial.printf("[rede] %d leituras enviadas (HTTP %d) em %u ms\n", k, code, millis() - t0);
  } else {
    char errbuf[100];
    httpNet.lastError(errbuf, sizeof(errbuf));
    Serial.printf("[rede] envio falhou (HTTP %d, mbedtls:'%s') em %u ms; %d leituras seguem no buffer\n", code, errbuf, millis() - t0, k);
  }
}

void tarefaRede(void*) {
  // handshakes TLS (MQTT/HTTPS) sao CPU-bound e podem passar dos 5s da IDLE0 -> watchdog
#if ESP_ARDUINO_VERSION >= ESP_ARDUINO_VERSION_VAL(3, 0, 0)
  esp_task_wdt_config_t twdt_cfg = { .timeout_ms = 15000, .idle_core_mask = 0, .trigger_panic = true };
  esp_task_wdt_reconfigure(&twdt_cfg);   // core 3.x: para de monitorar as tarefas IDLE
#else
  disableCore0WDT();                     // core 2.x
#endif
#if MQTT_TLS
  mqttNet.setCACert(CA_MQTT);        // valida o servidor MQTT com a CA raiz
  mqtt.setClient(mqttNet);
#else
  mqtt.setClient(mqttPlain);
  Serial.println("[rede] ATENCAO: MQTT SEM TLS (MQTT_TLS 0) - so para diagnostico");
#endif
  httpNet.setCACert(CA_WORKER);      // valida o Worker (sem pular a verificacao)
  httpNet.setTimeout(8);             // segundos: timeout de conexao/TLS do WiFiClientSecure (http.setTimeout() so cobre leitura)
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setCallback(aoReceber);
  mqtt.setBufferSize(512);
  mqtt.setSocketTimeout(4);
  mqtt.setKeepAlive(60);      // tolera o envio HTTPS travar por um tempo sem o broker derrubar a conexao
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  uint32_t tWifi = 0, tMqtt = 0, tTel = 0, tEst = 0, tEnvio = 0;
  bool ntpIniciado = false;

  for (;;) {
    uint32_t now = millis();
    static bool wifiAvisado = false;
    if (WiFi.status() != WL_CONNECTED) {
      wifiAvisado = false;
      if (tWifi == 0 || now - tWifi > 10000) {        // tenta de novo a cada 10 s
        tWifi = now; WiFi.begin(WIFI_SSID, WIFI_PASS);
        Serial.println("[rede] conectando ao Wi-Fi...");
      }
      vTaskDelay(500 / portTICK_PERIOD_MS); continue;
    }
    if (!wifiAvisado) { wifiAvisado = true; Serial.printf("[rede] Wi-Fi conectado (IP %s)\n", WiFi.localIP().toString().c_str()); }
    if (!ntpIniciado) { configTime(0, 0, "pool.ntp.org", "time.google.com"); ntpIniciado = true; }
    if (g_bootEpoch == 0) {
      time_t t = time(nullptr);
      if (t > 1700000000) g_bootEpoch = (uint32_t)t - millis() / 1000;
    }

    if (!mqtt.connected()) {
      if (tMqtt == 0 || now - tMqtt > 5000) {
        tMqtt = now;
        if (conectaMqtt()) Serial.printf("[rede] MQTT conectado (TLS) em %s:%d, topicos %s#\n", MQTT_HOST, MQTT_PORT, TOPIC_BASE);
        else {
          char err[100] = ""; mqttNet.lastError(err, sizeof(err));   // codigo 0050 = NET_CONN_RESET (servidor/rede derrubou o handshake)
          // estado PubSubClient: -4 timeout, -2 falha TCP/TLS (veja mbedtls), 4 usuario/senha, 5 nao autorizado
          Serial.printf("[rede] MQTT falhou (estado %d, TLS: %s) - nova tentativa em 5 s\n", mqtt.state(), err[0] ? err : "sem erro");
        }
      }
    } else {
      mqtt.loop();
      if (now - tTel >= TELEMETRIA_MS) {
        tTel = now;
        JsonDocument d;
        xSemaphoreTake(mtx, portMAX_DELAY);
        if (!isnan(g_temp)) d["temp_c"] = round(g_temp * 10) / 10.0;
        if (!isnan(g_umid)) d["umid_pct"] = round(g_umid * 10) / 10.0;
        if (!isnan(g_dist)) d["dist_cm"] = round(g_dist);
        xSemaphoreGive(mtx);
        char buf[128]; size_t n = serializeJson(d, buf);
        mqtt.publish(T_TEL, (const uint8_t*)buf, n, false);
      }
      // publica o estado na hora em que ele muda (o painel nao espera ate 30 s) e, fora isso, a cada ESTADO_MS
      static Estado estadoPublicado = EST_INICIANDO;
      xSemaphoreTake(mtx, portMAX_DELAY);
      Estado estadoAtual = regra.estado;
      xSemaphoreGive(mtx);
      if (estadoAtual != estadoPublicado || now - tEst >= ESTADO_MS) { estadoPublicado = estadoAtual; tEst = now; publicaEstado(true); }
      alertas();
    }
    if (now - tEnvio >= 10000) { tEnvio = now; enviaBuffer(); }   // reenvio do backlog ao reconectar
    vTaskDelay(50 / portTICK_PERIOD_MS);
  }
}
