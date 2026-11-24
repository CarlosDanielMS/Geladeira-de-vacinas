// Painel da geladeira de vacinas.
// Tempo real: MQTT sobre WebSocket. Historico: API do Worker (D1/KV).
// Todo dado externo entra na pagina por textContent (nunca innerHTML).
"use strict";

const $ = (id) => document.getElementById(id);
const CFG = window.CONFIG;
const TIMEOUT_ACK_MS = 10000;
const SEM_DADOS_MS = 40000;          // sem telemetria por mais que isso = ESP32 sem sinal
const ESCALA = { min: 0, max: 12 };  // regua da faixa segura
const FAIXA = { min: 2, max: 8 };

const fmtT = (v) => v.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const fmtDataHora = (ts) => new Date(ts * 1000).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "medium" });
const mesmoDia = (a, b) => a.toDateString() === b.toDateString();
function fmtEvento(ms) {
  const d = new Date(ms), hoje = new Date();
  const hora = d.toLocaleTimeString("pt-BR");
  return mesmoDia(d, hoje) ? hora : d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }) + " " + hora;
}
function ha(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 5) return "agora";
  if (s < 60) return "há " + s + " s";
  if (s < 3600) return "há " + Math.floor(s / 60) + " min";
  if (s < 86400) return "há " + Math.floor(s / 3600) + " h";
  return "há " + Math.floor(s / 86400) + " d";
}

// ---------- avisos temporarios ----------
function toast(texto, tipo = "info") {
  const box = $("toasts");
  const t = document.createElement("div");
  t.className = "toast toast-" + tipo;
  t.textContent = texto;
  box.append(t);
  while (box.children.length > 3) box.firstElementChild.remove();
  setTimeout(() => t.classList.add("saindo"), 3800);
  setTimeout(() => t.remove(), 4300);
}
window.toast = toast;

// ---------- abas ----------
const ABAS = ["monitor", "vacinas"];
function mostraAba(nome, foco) {
  if (!ABAS.includes(nome)) nome = "monitor";
  for (const b of document.querySelectorAll(".abas button")) {
    const ativa = b.dataset.aba === nome;
    b.setAttribute("aria-selected", String(ativa));
    b.tabIndex = ativa ? 0 : -1;
    if (ativa && foco) b.focus();
  }
  for (const a of ABAS) $("aba-" + a).hidden = a !== nome;
  if (location.hash.slice(1) !== nome) history.replaceState(null, "", "#" + nome);
}
for (const b of document.querySelectorAll(".abas button")) {
  b.addEventListener("click", () => mostraAba(b.dataset.aba));
  b.addEventListener("keydown", (e) => {
    const i = ABAS.indexOf(b.dataset.aba);
    if (e.key === "ArrowRight") { e.preventDefault(); mostraAba(ABAS[(i + 1) % ABAS.length], true); }
    if (e.key === "ArrowLeft") { e.preventDefault(); mostraAba(ABAS[(i + ABAS.length - 1) % ABAS.length], true); }
  });
}
window.addEventListener("hashchange", () => mostraAba(location.hash.slice(1)));
mostraAba(location.hash.slice(1));

// ---------- estado da geladeira (uma fonte de verdade para a tela) ----------
const S = {
  online: null,        // true/false informado pelo ESP32 ou pelo Last Will do broker; null = ainda nao sabemos
  vivoEm: 0,           // quando chegou a ultima mensagem AO VIVO (ms)
  estado: null, alarme: null, silenciado: false, porta: null, pendentes: null,
  umid: null,          // umidade relativa (%) ao vivo ou do ultimo registro
  temp: null,          // ultimo valor conhecido
  tempEm: 0,           // quando esse valor foi medido (ms); 0 = nao sabemos
};
let ultimoMqtt = 0, conectadoEm = 0, client = null;

const SITUACOES = {
  ok: ["ok", "Dentro da faixa segura"],
  iniciando: ["neutro", "Iniciando"],
  temp_alta: ["alerta", "Temperatura acima de 8 °C"],
  temp_baixa: ["alerta", "Temperatura abaixo de 2 °C"],
  porta_aberta: ["alerta", "Porta aberta há mais de 3 minutos"],
  sensor_falha: ["alerta", "Falha no sensor de temperatura"],
};
const semSinal = () => S.online === false || !S.vivoEm || Date.now() - S.vivoEm > SEM_DADOS_MS;

function posicaoRegua(t) { return Math.min(100, Math.max(0, ((t - ESCALA.min) / (ESCALA.max - ESCALA.min)) * 100)); }

function renderChip() {
  let estado, texto;
  if (!CFG || !window.mqtt) { estado = "offline"; texto = "Sem MQTT: só histórico"; }
  else if (!client || !client.connected) { estado = "aguardando"; texto = "Conectando ao broker…"; }
  else if (S.online === false) { estado = "offline"; texto = "ESP32 offline"; }
  else if (S.vivoEm && Date.now() - S.vivoEm > SEM_DADOS_MS) { estado = "offline"; texto = "ESP32 sem dados " + ha(Date.now() - S.vivoEm); }
  else if (S.online === true && S.vivoEm) { estado = "online"; texto = "ESP32 online"; }
  else if (conectadoEm && Date.now() - conectadoEm > SEM_DADOS_MS) { estado = "offline"; texto = "ESP32 não está publicando"; }
  else { estado = "aguardando"; texto = "Broker conectado, aguardando o ESP32"; }
  $("conexao").dataset.estado = estado;
  $("conexao-txt").textContent = texto;
}

function renderSituacao() {
  const sem = semSinal();
  const sit = $("situacao");
  let nivel, titulo, nota = "";

  if (sem) {
    nivel = "neutro";
    titulo = S.online === false ? "ESP32 desconectado" : S.vivoEm ? "Sem dados novos do ESP32" : "Aguardando dados do ESP32";
    if (S.temp != null) nota = "Último valor conhecido" + (S.tempEm ? ", registrado " + ha(Date.now() - S.tempEm) + "." : ".");
    else nota = "Ligue o ESP32 e deixe o simulador visível para os dados chegarem.";
  } else {
    [nivel, titulo] = SITUACOES[S.estado] || ["neutro", "Aguardando dados"];
    // o firmware so alarma depois de alguns minutos fora da faixa; ate la o estado continua "ok".
    // O painel nao pode dizer "dentro da faixa" com a temperatura fora dela.
    const foraDaFaixa = typeof S.temp === "number" && (S.temp > FAIXA.max || S.temp < FAIXA.min);
    if (nivel !== "alerta" && S.estado !== "iniciando" && typeof S.temp === "number") {
      if (foraDaFaixa) {
        nivel = "aviso";
        titulo = S.temp > FAIXA.max ? "Temperatura acima da faixa" : "Temperatura abaixo da faixa";
        nota = "O alarme dispara se ela continuar fora de 2 a 8 °C por alguns minutos.";
      } else { nivel = "ok"; titulo = "Dentro da faixa segura"; }
    }
    if (nivel === "ok") nota = "Última leitura " + ha(Date.now() - S.vivoEm) + ".";
    if (nivel === "alerta" && typeof S.temp === "number") {
      if (S.estado === "temp_alta" && S.temp <= FAIXA.max) nota = "A temperatura já voltou, mas o alarme só desliga abaixo de 7 °C.";
      else if (S.estado === "temp_baixa" && S.temp >= FAIXA.min) nota = "A temperatura já voltou, mas o alarme só desliga acima de 3 °C.";
      else nota = "O alarme dispara depois de alguns minutos fora da faixa e só desliga com folga.";
    }
    if (S.silenciado && S.alarme) nota += " Buzzer silenciado.";
  }

  sit.dataset.nivel = nivel;
  sit.classList.toggle("velho", sem);
  $("sit-estado").textContent = titulo;
  $("sit-nota").textContent = nota;
  $("temp").textContent = S.temp != null ? fmtT(S.temp) : "--";

  const marca = $("faixa-marca");
  marca.hidden = S.temp == null;
  if (S.temp != null) marca.style.left = posicaoRegua(S.temp) + "%";

  $("porta").textContent = sem || S.porta == null ? "--" : S.porta ? "aberta" : "fechada";
  const b = $("buzzer");
  b.textContent = sem || S.alarme == null ? "--" : !S.alarme ? "desligado" : S.silenciado ? "silenciado" : "tocando";
  b.classList.toggle("destaque", !sem && !!S.alarme && !S.silenciado);
  $("umid").textContent = typeof S.umid === "number" ? fmtT(S.umid) + " %" : "--";
  $("pendentes").textContent = S.pendentes == null ? "--" : S.pendentes;
  $("quando").textContent = S.vivoEm ? ha(Date.now() - S.vivoEm) : S.tempEm ? "registrada " + ha(Date.now() - S.tempEm) : "--";

  // comandos so fazem sentido quando ha alarme (silenciar) ou silencio (reativar)
  const conectado = !!(client && client.connected) && !sem;
  const emAlarme = conectado && S.alarme === true;
  $("btn-silenciar").disabled = !(emAlarme && !S.silenciado) || pendentes.size > 0;
  $("btn-reativar").disabled = !(conectado && S.silenciado) || pendentes.size > 0;
  if (!cmdMsgFixa) {
    $("cmd-status").textContent = !conectado ? "Sem conexão com o ESP32: os comandos ficam indisponíveis."
      : emAlarme ? (S.silenciado ? "Buzzer silenciado. Reative para voltar a tocar." : "Há um alarme ativo. Você pode silenciar o buzzer.")
      : "Silenciar só fica disponível quando há alarme.";
  }

  // aviso na aba Monitoramento enquanto houver alarme (some quando o ESP32 desarma)
  const alarmeAtivo = !sem && S.alarme === true;
  $("mon-badge").hidden = !alarmeAtivo;
  window.dispatchEvent(new CustomEvent("estado-geladeira", { detail: alarmeAtivo ? { alarme: true, estado: S.estado, temp_c: S.temp } : null }));
  renderChip();
}

// aplica telemetria/estado vindos do ESP32 (retido = ultimo estado guardado no broker, pode ser antigo)
function aplicaTelemetria(d) {
  const agora = Date.now();
  ultimoMqtt = agora; S.online = true; S.vivoEm = agora;
  S.temp = typeof d.temp_c === "number" ? d.temp_c : null;
  S.tempEm = S.temp != null ? agora : 0;
  if (typeof d.umid_pct === "number") S.umid = d.umid_pct;
  renderSituacao();
}
function aplicaEstado(d, retido) {
  if (retido) {
    if (d.online === false) S.online = false;                                  // Last Will: o ESP32 caiu
    else if (S.temp == null && typeof d.temp_c === "number") S.temp = d.temp_c;  // so como referencia visual
    renderSituacao();
    return;
  }
  registraEstado(d);
  const agora = Date.now();
  if (typeof d.online === "boolean") S.online = d.online;
  if (d.online !== false) {
    S.vivoEm = agora;
    if (typeof d.estado === "string") S.estado = d.estado;
    if (typeof d.alarme === "boolean") S.alarme = d.alarme;
    S.silenciado = !!d.silenciado;
    if (typeof d.porta_aberta === "boolean") S.porta = d.porta_aberta;
    if (d.pendentes !== undefined) S.pendentes = d.pendentes;
    if (typeof d.temp_c === "number") { S.temp = d.temp_c; S.tempEm = agora; }
    if (typeof d.umid_pct === "number") S.umid = d.umid_pct;
  }
  renderSituacao();
}

// ---------- historico de eventos: vem do D1 (/api/eventos, gravado pela ponte); sem API, usa o log local do navegador ----------
const LOG_MAX = 300;
let log = [];
let srv = null;     // eventos do Worker (null = API indisponivel)
let filtroEventos = "importantes";
try { log = JSON.parse(localStorage.getItem("eventos") || "[]"); } catch (e) { log = []; }
let limpoAte = Number(localStorage.getItem("eventosLimposAte") || 0);   // "Limpar tela" so esconde; o D1 continua com tudo
const ult = {};     // ultimo valor visto por campo, para so registrar mudancas
function salvaLog() { try { localStorage.setItem("eventos", JSON.stringify(log)); } catch (e) { /* sem storage: so memoria */ } }

async function carregaEventos() {
  try {
    const r = await fetch("/api/eventos?limite=300");
    if (!r.ok) throw new Error(r.status);
    const d = await r.json();
    srv = (d.eventos || []).map((e) => ({ t: e.ts * 1000, tipo: e.tipo === "conexao" ? "conexão" : e.tipo, detalhe: e.detalhe }));
  } catch (e) { srv = null; }
  desenhaLog();
}
function registra(tipo, detalhe) {
  log.unshift({ t: Date.now(), tipo, detalhe });
  if (log.length > LOG_MAX) log.length = LOG_MAX;
  salvaLog(); desenhaLog();
}
const SELOS = { alerta: "perigo", estado: "aviso", porta: "aviso", buzzer: "aviso", "conexão": "info", comando: "info", sensores: "" };
function desenhaLog() {
  const tb = $("eventos").tBodies[0]; tb.replaceChildren();
  let n = 0;
  for (const e of srv || log) {
    if (e.t <= limpoAte) continue;
    if (filtroEventos === "importantes" && e.tipo === "sensores") continue;
    const tr = tb.insertRow();
    const th = tr.insertCell(); th.className = "hora"; th.textContent = fmtEvento(e.t);
    const tt = tr.insertCell(); const s = document.createElement("span"); s.className = "selo " + (SELOS[e.tipo] ?? ""); s.textContent = e.tipo; tt.append(s);
    const td = tr.insertCell(); td.className = "detalhe"; td.textContent = e.detalhe;
    n++;
  }
  if (!n) {
    const td = tb.insertRow().insertCell(); td.colSpan = 3; td.className = "vazio";
    td.textContent = filtroEventos === "importantes" ? "Nenhum alerta ou mudança de estado. Escolha “Tudo” para ver também as leituras." : "Nenhum evento para mostrar.";
  }
}
for (const b of $("seg-eventos").querySelectorAll("button")) {
  b.addEventListener("click", () => {
    filtroEventos = b.dataset.f;
    for (const x of $("seg-eventos").querySelectorAll("button")) x.setAttribute("aria-pressed", String(x === b));
    desenhaLog();
  });
}
$("btn-limpar").addEventListener("click", () => {
  limpoAte = Date.now();
  try { localStorage.setItem("eventosLimposAte", String(limpoAte)); } catch (e) { /* sem storage */ }
  log = []; salvaLog(); desenhaLog();
  toast("Tela limpa. O histórico continua guardado no banco.");
});

function registraEstado(e) {
  if (typeof e.estado === "string" && e.estado !== ult.estado) { if (ult.estado !== undefined) registra("estado", ult.estado + " → " + e.estado + (typeof e.temp_c === "number" ? " (" + e.temp_c + " °C)" : "")); ult.estado = e.estado; }
  if (typeof e.porta_aberta === "boolean" && e.porta_aberta !== ult.porta) { if (ult.porta !== undefined) registra("porta", e.porta_aberta ? "aberta" : "fechada"); ult.porta = e.porta_aberta; }
  if (e.alarme !== undefined) {
    const b = !e.alarme ? "desligado" : e.silenciado ? "silenciado" : "tocando";
    if (b !== ult.buzzer) { if (ult.buzzer !== undefined) registra("buzzer", b); ult.buzzer = b; }
  }
  if (typeof e.online === "boolean" && e.online !== ult.online) { registra("conexão", e.online ? "ESP32 online" : "ESP32 offline"); ult.online = e.online; }
}

// ---------- comandos com confirmacao (ack) do ESP32 ----------
const pendentes = new Map();
let cmdMsgFixa = false;
const MOTIVOS = { sem_alarme_ativo: "não há alarme para silenciar", nonce_repetido: "comando repetido ou antigo", min_fora_da_faixa: "tempo fora de 1 a 30 min", comando_desconhecido: "comando desconhecido" };
const NOMES_CMD = { silenciar: "Silenciar buzzer", reativar: "Reativar buzzer" };
function statusCmd(texto, fixa) { cmdMsgFixa = !!fixa; $("cmd-status").textContent = texto; }

function novoCmd(cmd, extra) {
  if (!client || !client.connected) { toast("Sem conexão com o broker: o comando não foi enviado.", "erro"); return; }
  const id = Math.random().toString(36).slice(2, 10);
  const msg = Object.assign({ cmd, id, nonce: Date.now() }, extra);   // nonce crescente: o ESP32 recusa repetido
  const nome = NOMES_CMD[cmd] || cmd;
  registra("comando", nome + " enviado");
  statusCmd(nome + ": enviado, aguardando o ESP32…", true);
  const t = setTimeout(() => {
    pendentes.delete(id);
    statusCmd(nome + ": sem resposta. O ESP32 pode estar offline.", false);
    toast(nome + ": o ESP32 não respondeu em 10 s.", "erro");
    renderSituacao();
  }, TIMEOUT_ACK_MS);
  pendentes.set(id, { nome, t });
  client.publish(CFG.base + "comando", JSON.stringify(msg), { qos: 1 });
  renderSituacao();
}
function recebeAck(a) {
  const p = pendentes.get(a.id); if (!p) return;
  clearTimeout(p.t); pendentes.delete(a.id);
  const ok = a.status === "executado";
  registra("comando", p.nome + ": " + (ok ? "executado" : "rejeitado (" + (a.motivo || "") + ")"));
  if (ok) toast(p.nome + ": executado.", "ok");
  else toast(p.nome + ": recusado, " + (MOTIVOS[a.motivo] || a.motivo || "motivo não informado") + ".", "aviso");
  statusCmd(p.nome + (ok ? ": executado." : ": recusado, " + (MOTIVOS[a.motivo] || a.motivo || "motivo não informado") + "."), false);
  renderSituacao();
}
function mostraAlerta(a) {
  const txt = String(a.tipo).replace("_", " ") + (typeof a.temp_c === "number" ? " (" + a.temp_c + " °C)" : "");
  registra("alerta", txt);
  toast("Novo alerta: " + txt + ".", "erro");
}
$("btn-silenciar").addEventListener("click", () => novoCmd("silenciar", { min: 10 }));
$("btn-reativar").addEventListener("click", () => novoCmd("reativar"));

// ---------- MQTT sobre WebSocket ----------
if (CFG && window.mqtt) {
  client = mqtt.connect(CFG.mqttUrl, { username: CFG.mqttUser || undefined, password: CFG.mqttPass || undefined, reconnectPeriod: 3000, connectTimeout: 10000 });
  client.on("connect", () => { conectadoEm = Date.now(); client.subscribe(CFG.base + "#"); renderSituacao(); });
  client.on("close", () => renderSituacao());
  client.on("error", (e) => console.warn("MQTT:", e && e.message));
  client.on("message", (topic, buf, packet) => {
    let d; try { d = JSON.parse(buf.toString()); } catch (e) { return; }
    if (typeof d !== "object" || d === null) return;
    const tipo = topic.slice(CFG.base.length);
    const retido = !!(packet && packet.retain);
    if (tipo === "telemetria") {
      aplicaTelemetria(d);
      registra("sensores", (typeof d.temp_c === "number" ? "temp " + d.temp_c + " °C" : "temp sem leitura") + (typeof d.dist_cm === "number" ? " · dist " + d.dist_cm + " cm" : ""));
    }
    else if (tipo === "estado") aplicaEstado(d, retido);
    else if (tipo === "alerta" && !retido) mostraAlerta(d);
    else if (tipo === "ack") recebeAck(d);
  });
} else {
  $("btn-silenciar").disabled = $("btn-reativar").disabled = true;
}

// ---------- historico (grafico, resumo e CSV) ----------
const PASSO_PADRAO = { 6: "minuto", 24: "minuto", 168: "hora" };
const NOME_PASSO = { segundo: "cada leitura", minuto: "por minuto", hora: "por hora" };
const TITULO_JANELA = { 6: "Últimas 6 horas", 24: "Últimas 24 horas", 168: "Últimos 7 dias" };
let janelaH = 6;      // 0 = periodo personalizado (per)
let per = null;       // { de, ate } em segundos
let ultimosPts = [];
let falhaHistorico = false;

const passo = () => $("p-passo").value;
function intervalo() {
  if (janelaH === 0 && per) return per;
  const ate = Math.floor(Date.now() / 1000);
  return { de: ate - (janelaH || 6) * 3600, ate };
}
function qs() { const r = intervalo(); return "de=" + r.de + "&ate=" + r.ate + "&passo=" + passo(); }
function msg(t, erro) { const el = $("p-msg"); el.textContent = t || ""; el.classList.toggle("erro", !!erro); }

async function carregaHistorico() {
  try {
    const [l, r, u] = await Promise.all([
      fetch("/api/leituras?" + qs()).then((x) => { if (!x.ok) throw new Error("HTTP " + x.status); return x.json(); }),
      fetch("/api/resumo?" + qs()).then((x) => { if (!x.ok) throw new Error("HTTP " + x.status); return x.json(); }),
      fetch("/api/ultimo").then((x) => (x.ok ? x.json() : null)).catch(() => null),
    ]);
    falhaHistorico = false;
    const rot = (janelaH === 0 && per ? "De " + fmtDataHora(per.de) + " a " + fmtDataHora(per.ate) : TITULO_JANELA[janelaH]) + ", " + NOME_PASSO[passo()];
    $("tit-grafico").textContent = rot;
    $("tit-resumo").textContent = rot + ". Mais recentes primeiro.";
    $("th-hora").textContent = passo() === "hora" ? "Hora" : passo() === "minuto" ? "Minuto" : "Leitura";
    ultimosPts = l.leituras || [];
    desenhaGrafico();
    tabela(r.resumo || []);
    usaUltimoRegistrado(u);
  } catch (e) {
    falhaHistorico = true;
    console.warn("historico indisponivel", e);
    desenhaGrafico();
  }
}

// valor guardado no banco: aparece na situacao enquanto o ESP32 ainda nao enviou nada ao vivo
function usaUltimoRegistrado(u) {
  if (!u || !u.ts) return;
  if (!client) {   // sem MQTT: o proprio banco diz se o ESP32 esta vivo
    const vivo = Date.now() / 1000 - u.recebido_em < 180;
    S.online = vivo; S.vivoEm = vivo ? u.recebido_em * 1000 : 0;
    S.estado = u.estado; S.porta = !!u.porta;
  }
  if (typeof u.umid_pct === "number" && (semSinal() || S.umid == null)) S.umid = u.umid_pct;
  if (typeof u.temp_c === "number" && semSinal()) { S.temp = u.temp_c; S.tempEm = u.ts * 1000; }
  renderSituacao();
}

function tabela(linhas) {
  const tb = $("resumo").tBodies[0]; tb.replaceChildren();
  const fmtHora = (iso) => new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: passo() === "segundo" ? "2-digit" : undefined });
  for (const l of linhas.slice().reverse()) {
    const tr = tb.insertRow();
    if (l.fora_da_faixa > 0) tr.className = "fora";
    const c0 = tr.insertCell(); c0.textContent = fmtHora(l.hora);
    for (const v of [l.max_c, l.media_c, l.min_c, l.leituras, l.umid_media]) { const td = tr.insertCell(); td.className = "num"; td.textContent = v == null ? "-" : typeof v === "number" && !Number.isInteger(v) ? fmtT(v) : v; }
    const tf = tr.insertCell(); tf.className = "num";
    if (l.fora_da_faixa > 0) { const s = document.createElement("span"); s.className = "selo perigo"; s.textContent = l.fora_da_faixa; tf.append(s); } else tf.textContent = "0";
  }
  if (!linhas.length) {
    const td = tb.insertRow().insertCell(); td.colSpan = 7; td.className = "vazio";
    td.textContent = "Sem leituras neste período.";
  }
}

// ---------- grafico (SVG desenhado na largura real do container) ----------
const NS = "http://www.w3.org/2000/svg";
let geom = null;   // guarda escalas para a dica do mouse

function desenhaGrafico() {
  const caixa = $("grafico-caixa"), svg = $("grafico"), vazio = $("grafico-vazio");
  const W = caixa.clientWidth;
  if (W < 50) return;   // aba escondida: o ResizeObserver redesenha quando aparecer
  const H = W < 520 ? 250 : 310;
  const m = { l: 40, r: 14, t: 14, b: 30 };
  svg.setAttribute("viewBox", "0 0 " + W + " " + H); svg.setAttribute("height", H);
  svg.replaceChildren();
  $("dica").hidden = true;

  const mk = (tag, attrs, pai = svg) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); pai.append(e); return e; };
  const v = ultimosPts.filter((p) => p.temp_c !== null && p.temp_c !== undefined);
  const { de, ate } = intervalo();

  // escala vertical: sempre mostra 0-12 (a faixa segura bem visivel); cresce ate -10..25 se a temperatura sair disso
  const dMin = v.length ? Math.min(...v.map((p) => p.min_c ?? p.temp_c)) : 0;
  const dMax = v.length ? Math.max(...v.map((p) => p.max_c ?? p.temp_c)) : 12;
  const lo = Math.max(-10, Math.min(0, dMin)), hi = Math.min(25, Math.max(12, dMax));
  const passoY = hi - lo <= 14 ? 2 : hi - lo <= 30 ? 5 : 10;
  const y0 = Math.floor(lo / passoY) * passoY, y1 = Math.ceil(hi / passoY) * passoY;
  const y = (t) => m.t + (H - m.t - m.b) * (1 - (Math.min(y1, Math.max(y0, t)) - y0) / (y1 - y0));
  const x = (ts) => m.l + (W - m.l - m.r) * ((ts - de) / Math.max(1, ate - de));

  mk("rect", { class: "g-banda", x: m.l, y: y(FAIXA.max), width: W - m.l - m.r, height: y(FAIXA.min) - y(FAIXA.max) });
  for (let g = y0; g <= y1; g += passoY) {
    mk("line", { class: "g-grade", x1: m.l, x2: W - m.r, y1: y(g), y2: y(g) });
    mk("text", { class: "g-eixo", x: m.l - 8, y: y(g) + 4, "text-anchor": "end" }).textContent = g;
  }
  mk("line", { class: "g-limite", x1: m.l, x2: W - m.r, y1: y(FAIXA.max), y2: y(FAIXA.max) });
  mk("line", { class: "g-limite", x1: m.l, x2: W - m.r, y1: y(FAIXA.min), y2: y(FAIXA.min) });
  mk("text", { class: "g-rotulo-banda", x: W - m.r - 6, y: y(FAIXA.max) + 15, "text-anchor": "end" }).textContent = "faixa segura";

  // eixo do tempo: marcas em horarios redondos (horario local)
  const passos = [60, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 172800];
  const alvo = Math.max(2, Math.floor((W - m.l - m.r) / 95));
  const s = passos.find((p) => (ate - de) / p <= alvo) || passos[passos.length - 1];
  const off = -new Date().getTimezoneOffset() * 60;
  const mostraDia = ate - de > 86400 || s >= 86400;
  for (let k = Math.ceil((de + off) / s) * s - off; k <= ate; k += s) {
    const d = new Date(k * 1000);
    const txt = s >= 86400 ? d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })
      : (mostraDia ? d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }) + " " : "") + d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    mk("line", { class: "g-grade", x1: x(k), x2: x(k), y1: H - m.b, y2: H - m.b + 4 });
    mk("text", { class: "g-eixo", x: x(k), y: H - 8, "text-anchor": "middle" }).textContent = txt;
  }

  geom = null;
  if (!v.length) {
    vazio.hidden = false;
    vazio.replaceChildren();
    const t = document.createElement("strong"), d = document.createElement("span");
    if (falhaHistorico) { t.textContent = "Não foi possível carregar o histórico."; d.textContent = "O servidor não respondeu. Uma nova tentativa acontece em instantes."; }
    else { t.textContent = "Sem leituras neste período."; d.textContent = "Se o ESP32 está ligado, confira se a ponte MQTT está rodando (npm run ponte)."; }
    vazio.append(t, d);
    return;
  }
  vazio.hidden = true;

  // linha: interrompe onde faltam dados, em vez de ligar pontos distantes com uma reta falsa
  const intervaloS = { segundo: 10, minuto: 60, hora: 3600 }[passo()] || 60;
  let trecho = [];
  const fecha = () => {
    if (trecho.length === 1) { const [cx, cy] = trecho[0].split(","); mk("circle", { class: "g-ponto", cx, cy, r: 2.5 }); }
    else if (trecho.length) mk("polyline", { class: "g-linha", points: trecho.join(" ") });
    trecho = [];
  };
  v.forEach((p, i) => { if (i && p.ts - v[i - 1].ts > intervaloS * 3) fecha(); trecho.push(x(p.ts).toFixed(1) + "," + y(p.temp_c).toFixed(1)); });
  fecha();

  let desenhados = 0;
  for (const p of v) {
    const fora = (p.max_c ?? p.temp_c) > FAIXA.max || (p.min_c ?? p.temp_c) < FAIXA.min;
    if (!fora || desenhados++ > 500) continue;
    const t = p.max_c !== undefined && p.max_c > FAIXA.max ? p.max_c : p.temp_c;
    const cx = x(p.ts);
    if (t > y1 || t < y0) mk("path", { class: "g-corte", d: t > y1 ? `M${cx - 4},${m.t + 7} L${cx + 4},${m.t + 7} L${cx},${m.t} Z` : `M${cx - 4},${H - m.b - 7} L${cx + 4},${H - m.b - 7} L${cx},${H - m.b} Z` });
    else mk("circle", { class: "g-fora", cx, cy: y(p.temp_c), r: 3.5 });
  }

  const cursor = mk("line", { class: "g-cursor", y1: m.t, y2: H - m.b, visibility: "hidden" });
  const foco = mk("circle", { class: "g-foco", r: 5, visibility: "hidden" });
  geom = { W, H, m, x, y, v, cursor, foco, de, ate };
}

// dica ao passar o mouse/dedo: mostra a leitura mais proxima
function moveDica(ev) {
  if (!geom) return;
  const svg = $("grafico"), caixa = $("grafico-caixa"), dica = $("dica");
  const rect = svg.getBoundingClientRect();
  const px = ev.clientX - rect.left;
  const { m, W, v, de, ate } = geom;
  if (px < m.l || px > W - m.r) { escondeDica(); return; }
  const ts = de + ((px - m.l) / (W - m.l - m.r)) * (ate - de);
  let melhor = v[0], dist = Infinity;
  for (const p of v) { const dd = Math.abs(p.ts - ts); if (dd < dist) { dist = dd; melhor = p; } }
  if ((dist / (ate - de)) * (W - m.l - m.r) > 40) { escondeDica(); return; }   // longe de qualquer leitura (buraco nos dados)
  const cx = geom.x(melhor.ts), cy = geom.y(melhor.temp_c);
  geom.cursor.setAttribute("x1", cx); geom.cursor.setAttribute("x2", cx); geom.cursor.setAttribute("visibility", "visible");
  geom.foco.setAttribute("cx", cx); geom.foco.setAttribute("cy", cy); geom.foco.setAttribute("visibility", "visible");
  dica.replaceChildren();
  const b = document.createElement("b"); b.textContent = fmtT(melhor.temp_c) + " °C";
  const t = document.createElement("span"); t.textContent = fmtDataHora(melhor.ts);
  dica.append(b, t);
  if ((melhor.leituras || 1) > 1) {
    const extra = document.createElement("span"); extra.style.display = "block";
    extra.textContent = "mín. " + fmtT(melhor.min_c) + ", máx. " + fmtT(melhor.max_c) + " (" + melhor.leituras + " leituras)";
    dica.append(extra);
  }
  dica.hidden = false;
  const cw = caixa.clientWidth, dw = dica.offsetWidth;
  dica.style.left = Math.min(Math.max(4, cx - dw / 2), cw - dw - 4) + "px";
  dica.style.top = Math.max(0, cy - dica.offsetHeight - 14) + "px";
}
function escondeDica() {
  $("dica").hidden = true;
  if (geom) { geom.cursor.setAttribute("visibility", "hidden"); geom.foco.setAttribute("visibility", "hidden"); }
}
$("grafico").addEventListener("pointermove", moveDica);
$("grafico").addEventListener("pointerleave", escondeDica);
new ResizeObserver(() => desenhaGrafico()).observe($("grafico-caixa"));

// ---------- controles do historico ----------
for (const b of $("seg-janela").querySelectorAll("button")) {
  b.addEventListener("click", () => {
    const h = Number(b.dataset.h);
    janelaH = h;
    for (const x of $("seg-janela").querySelectorAll("button")) x.setAttribute("aria-pressed", String(x === b));
    $("p-custom").hidden = h !== 0;
    msg("");
    if (h === 0) {
      if (!$("p-de").value) {
        const pad = (d) => new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
        const agora = new Date();
        $("p-ate").value = pad(agora); $("p-de").value = pad(new Date(agora - 86400000));
      }
      $("p-de").focus();
      return;   // so busca quando o usuario clicar em "Aplicar período"
    }
    per = null;
    $("p-passo").value = PASSO_PADRAO[h];
    carregaHistorico();
  });
}
$("p-aplicar").addEventListener("click", () => {
  const de = Math.floor(new Date($("p-de").value).getTime() / 1000), ate = Math.floor(new Date($("p-ate").value).getTime() / 1000);
  if (!$("p-de").value || !$("p-ate").value || isNaN(de) || isNaN(ate)) return msg("Preencha as duas datas.", true);
  if (ate <= de) return msg("A data final precisa ser depois da inicial.", true);
  if (ate - de > 31 * 86400) return msg("O período máximo é de 31 dias.", true);
  per = { de, ate }; msg("");
  carregaHistorico();
});
$("p-passo").addEventListener("change", carregaHistorico);
$("p-csv").addEventListener("click", async () => {
  try {
    const d = await fetch("/api/leituras?" + qs()).then((x) => { if (!x.ok) throw new Error("HTTP " + x.status); return x.json(); });
    const ls = d.leituras || [];
    if (!ls.length) { msg("Nenhuma leitura no período: não há o que exportar.", true); return; }
    const q = (v) => (v == null ? "" : String(v).replace(".", ","));   // virgula decimal: abre certo no Excel pt-BR
    const linhas = ["data_hora_local;timestamp_unix;temp_media_c;temp_min_c;temp_max_c;umidade_pct;leituras;porta;estado"].concat(
      ls.map((l) => [fmtDataHora(l.ts), l.ts, q(l.temp_c), q(l.min_c), q(l.max_c), q(l.umid_pct), l.leituras, l.porta ? "aberta" : "fechada", l.estado || ""].join(";")));
    const BOM = String.fromCharCode(0xfeff);   // faz o Excel abrir o CSV em UTF-8 (acentos certos)
    const blob = new Blob([BOM + linhas.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const el = document.createElement("a");
    el.href = URL.createObjectURL(blob);
    el.download = "leituras_" + passo() + "_" + new Date().toISOString().slice(0, 10) + ".csv";
    el.click(); URL.revokeObjectURL(el.href);
    msg(""); toast(ls.length + " leituras exportadas em CSV.", "ok");
  } catch (e) { msg("Falha ao exportar: " + e.message, true); }
});

// ---------- partida e atualizacoes periodicas ----------
renderSituacao();
carregaEventos(); setInterval(carregaEventos, 15000);
carregaHistorico(); setInterval(() => { if (janelaH !== 0 || per) carregaHistorico(); }, 10000);
setInterval(renderSituacao, 1000);   // mantem "ha X s" e o aviso de falta de sinal em dia
