// Ponte MQTT -> Worker. Assina o broker publico que o firmware usa e grava no Worker
// (D1/KV) as leituras reais do sensor (1/min) e os eventos. O painel le tudo pela API.
// Uso (Worker local rodando em outro terminal com npm run dev):
//   cd worker && node tools/mqtt-bridge.mjs
// Variaveis opcionais: WORKER_URL, INGEST_TOKEN (padrao: le worker/.dev.vars), GRUPO.
import mqtt from "mqtt";
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";

// broker: o mesmo do firmware (firmware/include/secrets.h); MQTT_URL no ambiente sobrescreve
const secretsH = (() => { try { return readFileSync(fileURLToPath(new URL("../../firmware/include/secrets.h", import.meta.url)), "utf8"); } catch { return ""; } })();
const MQTT_URL = process.env.MQTT_URL || ((/^#define MQTT_TLS\s+0/m.test(secretsH) ? "mqtt://" : "mqtts://")) + ((secretsH.match(/^#define MQTT_HOST\s+"([^"]+)"/m) || [])[1] || "broker.emqx.io") + ":" + ((secretsH.match(/^#define MQTT_PORT\s+(\d+)/m) || [])[1] || "8883");
const GRUPO = process.env.GRUPO || (readFileSync(fileURLToPath(new URL("../../firmware/include/config.h", import.meta.url)), "utf8").match(/#define GRUPO "([^"]+)"/) || [])[1] || "g01";
const TOPIC_BASE = "sis1a/" + GRUPO + "/geladeira1/";
const DISPOSITIVO = "geladeira1";
const INTERVALO_MS = 10000;      // grava cada telemetria do ESP32 (publica a cada 10 s)
const WORKER_URL = process.env.WORKER_URL || "http://localhost:8787";
function lerToken() {
  if (process.env.INGEST_TOKEN) return process.env.INGEST_TOKEN;
  const f = fileURLToPath(new URL("../.dev.vars", import.meta.url));
  if (existsSync(f)) { const m = readFileSync(f, "utf8").match(/^INGEST_TOKEN=(.+)$/m); if (m) return m[1].trim(); }
}
const INGEST_TOKEN = lerToken();
let fila = [];
const ult = {};
let ultSensor = 0;
function evento(tipo, detalhe) { fila.push({ ts: Math.floor(Date.now() / 1000), tipo, detalhe }); }
async function enviaEventos() {
  if (!fila.length) return;
  if (!INGEST_TOKEN) { console.error("[ponte] INGEST_TOKEN nao definido: eventos nao enviados ao D1"); fila = []; return; }
  const lote = fila.splice(0, 100);
  try {
    const r = await fetch(WORKER_URL + "/api/eventos", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: "Bearer " + INGEST_TOKEN },
      body: JSON.stringify({ dispositivo: DISPOSITIVO, eventos: lote }),
    });
    if (r.status === 401) { console.error("[ponte] token recusado (401): INGEST_TOKEN diferente do segredo do Worker. Encerrando."); process.exit(1); }
    if (!r.ok) throw new Error("HTTP " + r.status);
    console.log(`[ponte] ${lote.length} evento(s) gravado(s) no D1`);
  } catch (e) { console.error("[ponte] falha ao enviar eventos:", e.message); fila.unshift(...lote); fila = fila.slice(-500); }
}
setInterval(enviaEventos, 5000);

let ultimaLeitura = { temp_c: null, umid_pct: null, dist_cm: null, porta: 0, estado: "ok" };
let temDadoNovo = false;

const client = mqtt.connect(MQTT_URL, { reconnectPeriod: 3000 });
client.on("connect", () => { console.log("[ponte] conectado ao broker MQTT"); client.subscribe(TOPIC_BASE + "#"); });
client.on("reconnect", () => console.log("[ponte] reconectando ao broker..."));
client.on("error", (e) => console.error("[ponte] erro MQTT:", e.message));

client.on("message", (topic, buf, packet) => {
  let d; try { d = JSON.parse(buf.toString()); } catch { return; }
  const tipo = topic.slice(TOPIC_BASE.length);
  // Mensagem RETIDA = ultimo estado guardado no broker (pode ter horas). Serve so de ponto de partida:
  // nao vira evento nem leitura, senao a ponte grava dados velhos como se fossem de agora.
  if (packet && packet.retain) {
    if (tipo === "estado") {
      // "online" NAO vem do retido: ele pode dizer online de uma sessao antiga e esconder a conexao nova
      if (typeof d.estado === "string") ult.estado = d.estado;
      if (typeof d.porta_aberta === "boolean") ult.porta = d.porta_aberta;
      if (d.alarme !== undefined) ult.buzzer = !d.alarme ? "desligado" : d.silenciado ? "silenciado" : "tocando";
    }
    return;
  }
  if (tipo === "alerta") evento("alerta", String(d.tipo).replace("_", " ") + (typeof d.temp_c === "number" ? ` (${d.temp_c} °C)` : ""));
  else if (tipo === "ack") evento("comando", `${d.cmd || ""}: ${d.status === "executado" ? "executado" : "rejeitado (" + (d.motivo || "") + ")"}`);
  else if (tipo === "estado") {
    if (typeof d.online === "boolean" && d.online !== ult.online) { evento("conexao", d.online ? "ESP32 online" : "ESP32 offline"); ult.online = d.online; }
    if (typeof d.estado === "string" && d.estado !== ult.estado) { if (ult.estado !== undefined) evento("estado", `${ult.estado} → ${d.estado}` + (typeof d.temp_c === "number" ? ` (${d.temp_c} °C)` : "")); ult.estado = d.estado; }
    if (typeof d.porta_aberta === "boolean" && d.porta_aberta !== ult.porta) { if (ult.porta !== undefined) evento("porta", d.porta_aberta ? "aberta" : "fechada"); ult.porta = d.porta_aberta; }
    if (d.alarme !== undefined) { const bz = !d.alarme ? "desligado" : d.silenciado ? "silenciado" : "tocando"; if (bz !== ult.buzzer) { if (ult.buzzer !== undefined) evento("buzzer", bz); ult.buzzer = bz; } }
  } else if (tipo === "telemetria" && Date.now() - ultSensor >= 10000) {
    ultSensor = Date.now();
    evento("sensores", (typeof d.temp_c === "number" ? `temp ${d.temp_c} °C` : "temp sem leitura") + (typeof d.umid_pct === "number" ? ` · umid ${d.umid_pct} %` : "") + (typeof d.dist_cm === "number" ? ` · dist ${d.dist_cm} cm` : ""));
  }
  if (tipo === "telemetria") {
    if (typeof d.temp_c === "number") ultimaLeitura.temp_c = d.temp_c;
    if (typeof d.umid_pct === "number") ultimaLeitura.umid_pct = d.umid_pct;
    if (typeof d.dist_cm === "number") ultimaLeitura.dist_cm = d.dist_cm;
    temDadoNovo = true;
  } else if (tipo === "estado") {
    if (typeof d.estado === "string") ultimaLeitura.estado = d.estado;
    if (typeof d.porta_aberta === "boolean") ultimaLeitura.porta = d.porta_aberta ? 1 : 0;
    if (typeof d.temp_c === "number") ultimaLeitura.temp_c = d.temp_c;
    // estado (ou o Last Will {"online":false}) nao conta como leitura nova: so a telemetria grava ponto
  }
});

async function salva() {
  if (!temDadoNovo || ultimaLeitura.temp_c === null) return;
  if (!INGEST_TOKEN) { console.error("[ponte] INGEST_TOKEN nao definido"); return; }
  temDadoNovo = false;   // so grava de novo quando chegar telemetria nova (ESP32 off = sem pontos falsos)
  const ts = Math.floor(Date.now() / 1000);
  const corpo = { dispositivo: DISPOSITIVO, leituras: [{ ts, temp_c: ultimaLeitura.temp_c, ...(typeof ultimaLeitura.umid_pct === "number" ? { umid_pct: ultimaLeitura.umid_pct } : {}), ...(Number.isInteger(ultimaLeitura.dist_cm) ? { dist_cm: ultimaLeitura.dist_cm } : {}), porta: ultimaLeitura.porta, estado: ultimaLeitura.estado }] };
  try {
    const r = await fetch(WORKER_URL + "/api/leituras", { method: "POST", headers: { "content-type": "application/json", Authorization: "Bearer " + INGEST_TOKEN }, body: JSON.stringify(corpo) });
    if (!r.ok) throw new Error("HTTP " + r.status);
    console.log("[ponte] leitura gravada no Worker — temp=" + ultimaLeitura.temp_c + " estado=" + ultimaLeitura.estado);
  } catch (e) { console.error("[ponte] falha ao gravar leitura:", e.message); }
}

setInterval(salva, INTERVALO_MS);
console.log(`[ponte] rodando — broker ${MQTT_URL} — topicos ${TOPIC_BASE}# → ${WORKER_URL} — Ctrl+C para parar.`);
