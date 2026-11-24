// Ponte MQTT -> painel/dados.json. Roda no seu PC: assina o mesmo broker MQTT
// publico que o firmware usa, junta 1 leitura/min e grava um JSON estatico que o
// painel serve direto (sem precisar do D1/Worker pra isso - mais simples e
// reproduz os dados na dashboard mesmo com o Wokwi sem alcancar o Cloudflare).
//
// Uso:
//   cd worker
//   node tools/mqtt-bridge.mjs
import mqtt from "mqtt";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { exec } from "child_process";
import { promisify } from "util";
const execAsync = promisify(exec);

const MQTT_URL = "mqtts://broker.hivemq.com:8883";
const TOPIC_BASE = "sis1a/g01/geladeira1/";
const DISPOSITIVO = "geladeira1";
const INTERVALO_MS = 60000;      // 1 leitura/min, igual ao firmware (REGISTRO_S)
const JANELA_GRAFICO_H = 6;
const JANELA_RESUMO_H = 24;
const WORKER_DIR = fileURLToPath(new URL("..", import.meta.url));
const DADOS_JSON = fileURLToPath(new URL("../../painel/dados.json", import.meta.url));
let publicando = false;

// carrega o que ja existe no dados.json (ex.: demo anterior) pra nao perder o historico
let leituras = [];
if (existsSync(DADOS_JSON)) {
  try { leituras = JSON.parse(readFileSync(DADOS_JSON, "utf8")).leituras || []; } catch {}
}

let ultimaLeitura = { temp_c: null, dist_cm: null, porta: 0, estado: "ok" };
let temDadoNovo = false;

const client = mqtt.connect(MQTT_URL, { reconnectPeriod: 3000 });
client.on("connect", () => { console.log("[ponte] conectado ao broker MQTT"); client.subscribe(TOPIC_BASE + "#"); });
client.on("reconnect", () => console.log("[ponte] reconectando ao broker..."));
client.on("error", (e) => console.error("[ponte] erro MQTT:", e.message));

client.on("message", (topic, buf) => {
  let d; try { d = JSON.parse(buf.toString()); } catch { return; }
  const tipo = topic.slice(TOPIC_BASE.length);
  if (tipo === "telemetria") {
    if (typeof d.temp_c === "number") ultimaLeitura.temp_c = d.temp_c;
    if (typeof d.dist_cm === "number") ultimaLeitura.dist_cm = d.dist_cm;
    temDadoNovo = true;
  } else if (tipo === "estado") {
    if (typeof d.estado === "string") ultimaLeitura.estado = d.estado;
    if (typeof d.porta_aberta === "boolean") ultimaLeitura.porta = d.porta_aberta ? 1 : 0;
    if (typeof d.temp_c === "number") ultimaLeitura.temp_c = d.temp_c;
    temDadoNovo = true;
  }
});

function horaUTC(ts) {
  const d = new Date(ts * 1000);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()).toISOString().slice(0, 13) + ":00:00Z";
}

function calculaResumo(janela) {
  const porHora = new Map();
  for (const l of janela) {
    const h = horaUTC(l.ts);
    if (!porHora.has(h)) porHora.set(h, { temps: [], fora: 0 });
    const bucket = porHora.get(h);
    if (l.temp_c !== null) { bucket.temps.push(l.temp_c); if (l.temp_c > 8 || l.temp_c < 2) bucket.fora++; }
  }
  return [...porHora.entries()].sort().map(([hora, b]) => ({
    hora,
    max_c: b.temps.length ? Math.max(...b.temps) : null,
    media_c: b.temps.length ? Math.round((b.temps.reduce((s, v) => s + v, 0) / b.temps.length) * 100) / 100 : null,
    min_c: b.temps.length ? Math.min(...b.temps) : null,
    leituras: b.temps.length,
    fora_da_faixa: b.fora,
  }));
}

async function publica() {
  if (publicando) { console.log("[ponte] deploy anterior ainda rodando, pulei esta rodada"); return; }
  publicando = true;
  try {
    await execAsync("npx wrangler deploy", { cwd: WORKER_DIR });
    console.log("[ponte] dados.json publicado no painel (wrangler deploy OK)");
  } catch (e) {
    console.error("[ponte] falha no deploy:", e.message.split("\n")[0]);
  } finally {
    publicando = false;
  }
}

async function salva() {
  if (!temDadoNovo || ultimaLeitura.temp_c === null) return;
  const ts = Math.floor(Date.now() / 1000);
  leituras.push({ ts, temp_c: ultimaLeitura.temp_c, dist_cm: ultimaLeitura.dist_cm ?? 8, porta: ultimaLeitura.porta, estado: ultimaLeitura.estado });
  const corteResumo = ts - JANELA_RESUMO_H * 3600;
  leituras = leituras.filter((l) => l.ts >= corteResumo);

  const corteGrafico = ts - JANELA_GRAFICO_H * 3600;
  const dados = {
    leituras: leituras.filter((l) => l.ts >= corteGrafico),
    resumo: calculaResumo(leituras),
    ultimo: { ts, temp_c: ultimaLeitura.temp_c, dist_cm: ultimaLeitura.dist_cm, porta: ultimaLeitura.porta, estado: ultimaLeitura.estado, recebido_em: ts },
  };
  writeFileSync(DADOS_JSON, JSON.stringify(dados));
  console.log(`[ponte] dados.json atualizado — ts=${ts} temp=${ultimaLeitura.temp_c} estado=${ultimaLeitura.estado} (${dados.leituras.length} pts no grafico)`);
  publica();   // nao espera o deploy terminar para continuar lendo o MQTT
}

setInterval(salva, INTERVALO_MS);
console.log(`[ponte] rodando (${leituras.length} leituras carregadas) — Ctrl+C para parar.`);
