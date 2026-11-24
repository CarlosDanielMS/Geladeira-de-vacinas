// Painel: MQTT sobre WebSocket (tempo real) + HTTP no Worker (historico).
// Dado externo sempre via textContent (nunca innerHTML).
const $ = (id) => document.getElementById(id);
const CFG = window.CONFIG;
const TIMEOUT_ACK_MS = 10000;
let ultimoMqtt = 0;
let client = null;

function pill(el, txt, cls) { el.textContent = txt; el.className = "pill " + cls; }

function mostraEstado(e) {
  if (typeof e.online === "boolean") pill($("conexao"), e.online ? "ESP32 online" : "ESP32 offline", e.online ? "on" : "off");
  if (typeof e.temp_c === "number") $("temp").textContent = e.temp_c.toFixed(1) + " °C";
  if (typeof e.estado === "string") pill($("estado"), e.estado.replace("_", " "), e.estado === "ok" ? "ok" : e.estado === "iniciando" ? "" : "bad");
  if (e.porta_aberta !== undefined) $("porta").textContent = e.porta_aberta ? "aberta" : "fechada";
  if (e.alarme !== undefined) $("buzzer").textContent = !e.alarme ? "desligado" : e.silenciado ? "silenciado" : "tocando";
  if (e.pendentes !== undefined) $("pendentes").textContent = e.pendentes;
  $("quando").textContent = new Date().toLocaleTimeString("pt-BR");
}

// ---------- alerta (o ESP32 ja aplica o cooldown de 5 min; o painel so exibe) ----------
function mostraAlerta(a) {
  const el = $("alerta");
  el.hidden = false;
  el.textContent = "ALERTA: " + String(a.tipo).replace("_", " ") + (typeof a.temp_c === "number" ? " (" + a.temp_c + " °C)" : "") +
    " às " + new Date().toLocaleTimeString("pt-BR") + ". Novo alerta igual só após " + Math.round((a.cooldown_s || 300) / 60) + " min.";
}

// ---------- comandos com ack ----------
const pendentes = new Map();
function novoCmd(cmd, extra) {
  if (!client || !client.connected) { alert("Sem conexão MQTT"); return; }
  const id = Math.random().toString(36).slice(2, 10);
  const msg = Object.assign({ cmd, id, nonce: Date.now() }, extra);   // nonce crescente: o ESP32 recusa repetido
  const li = document.createElement("li");
  const nome = document.createElement("span"); nome.textContent = cmd + (extra && extra.min ? " " + extra.min + " min" : "");
  const st = document.createElement("span"); st.textContent = "pendente...";
  li.append(nome, st); $("cmds").prepend(li);
  const t = setTimeout(() => { st.textContent = "sem resposta (ESP32 offline?)"; pendentes.delete(id); }, TIMEOUT_ACK_MS);
  pendentes.set(id, { st, t });
  client.publish(CFG.base + "comando", JSON.stringify(msg), { qos: 1 });
}
function recebeAck(a) {
  const p = pendentes.get(a.id); if (!p) return;
  clearTimeout(p.t); pendentes.delete(a.id);
  p.st.textContent = a.status === "executado" ? "executado" : "rejeitado: " + (a.motivo || "");
}
$("btn-silenciar").onclick = () => novoCmd("silenciar", { min: 10 });
$("btn-reativar").onclick = () => novoCmd("reativar");

// ---------- MQTT sobre WebSocket ----------
if (CFG && window.mqtt) {
  client = mqtt.connect(CFG.mqttUrl, { username: CFG.mqttUser, password: CFG.mqttPass, reconnectPeriod: 3000 });
  client.on("connect", () => client.subscribe(CFG.base + "#"));
  client.on("close", () => pill($("conexao"), "sem conexão com o broker", "amb"));
  client.on("message", (topic, buf) => {
    let d; try { d = JSON.parse(buf.toString()); } catch (e) { return; }
    if (typeof d !== "object" || d === null) return;
    const tipo = topic.slice(CFG.base.length);
    if (tipo === "telemetria") { ultimoMqtt = Date.now(); mostraEstado({ temp_c: d.temp_c }); }
    else if (tipo === "estado") mostraEstado(d);
    else if (tipo === "alerta") mostraAlerta(d);
    else if (tipo === "ack") recebeAck(d);
  });
} else {
  $("btn-silenciar").disabled = $("btn-reativar").disabled = true;
  pill($("conexao"), "sem MQTT (falta config.js): só histórico", "amb");
}

// ---------- historico (Worker) ----------
async function carregaHistorico() {
  const disp = (CFG && CFG.dispositivo) || "geladeira1";
  try {
    const [rl, rr, ru] = await Promise.all([
      fetch("/api/leituras?dispositivo=" + disp + "&horas=6").then((r) => r.json()),
      fetch("/api/resumo?dispositivo=" + disp + "&horas=24").then((r) => r.json()),
      fetch("/api/ultimo?dispositivo=" + disp).then((r) => r.json()),
    ]);
    desenha(rl.leituras || []);
    tabela(rr.resumo || []);
    if (!client && ru.ts) mostraEstado({ temp_c: ru.temp_c === null ? undefined : ru.temp_c, estado: ru.estado, porta_aberta: !!ru.porta, online: Date.now() / 1000 - ru.recebido_em < 180 });
  } catch (e) { console.warn("historico indisponivel", e); }
}

function tabela(linhas) {
  const tb = $("resumo").tBodies[0]; tb.replaceChildren();
  for (const l of linhas) {
    const tr = tb.insertRow();
    [l.hora.slice(0, 16).replace("T", " "), l.max_c, l.media_c, l.min_c, l.leituras, l.fora_da_faixa].forEach((v, i) => {
      const td = tr.insertCell(); td.textContent = v == null ? "-" : v;
      if (i === 5 && v > 0) td.className = "fora";
    });
  }
}

function desenha(pts) {
  const svg = $("grafico"); svg.replaceChildren();
  const NS = "http://www.w3.org/2000/svg", W = 600, H = 220, m = { l: 36, r: 8, t: 8, b: 20 };
  const mk = (n, a) => { const e = document.createElementNS(NS, n); for (const k in a) e.setAttribute(k, a[k]); svg.append(e); return e; };
  const y = (v) => m.t + (H - m.t - m.b) * (1 - Math.min(Math.max(v, 0), 12) / 12);
  mk("rect", { x: m.l, y: y(8), width: W - m.l - m.r, height: y(2) - y(8), fill: "#1b8a4b", opacity: 0.15 });
  for (const v of [0, 2, 4, 6, 8, 10, 12]) {
    mk("line", { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), stroke: "currentColor", opacity: 0.12 });
    const t = mk("text", { x: m.l - 4, y: y(v) + 4, "text-anchor": "end", "font-size": 10, fill: "currentColor" }); t.textContent = v;
  }
  const v = pts.filter((p) => p.temp_c !== null);
  if (v.length < 2) { const t = mk("text", { x: W / 2, y: H / 2, "text-anchor": "middle", fill: "currentColor" }); t.textContent = "sem dados no período"; return; }
  const t0 = v[0].ts, t1 = v[v.length - 1].ts, x = (ts) => m.l + (W - m.l - m.r) * ((ts - t0) / Math.max(t1 - t0, 1));
  mk("polyline", { points: v.map((p) => x(p.ts) + "," + y(p.temp_c)).join(" "), fill: "none", stroke: "#1f6feb", "stroke-width": 2 });
  for (const p of v) if (p.temp_c > 8 || p.temp_c < 2) mk("circle", { cx: x(p.ts), cy: y(p.temp_c), r: 3, fill: "#c0392b" });
}

carregaHistorico(); setInterval(carregaHistorico, 30000);
// Sem telemetria por 40 s: nao confie so no ultimo estado retido
setInterval(() => { if (client && ultimoMqtt && Date.now() - ultimoMqtt > 40000) pill($("conexao"), "sem telemetria há 40 s", "off"); }, 5000);
