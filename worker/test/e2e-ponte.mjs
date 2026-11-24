// Teste de ponta a ponta do caminho dos dados SEM o Wokwi:
//   "ESP32 falso" --MQTT--> broker publico --> ponte (tools/mqtt-bridge.mjs) --HTTP--> Worker --> D1/KV --> API
// Publica as mesmas mensagens do firmware num grupo de teste e confere o que foi gravado.
// Uso (Worker rodando, de preferencia numa instancia isolada):
//   BASE=http://localhost:8788 GRUPO=e2e-xxxx  (ponte rodando com o mesmo GRUPO e WORKER_URL=BASE)
//   node test/e2e-ponte.mjs
import mqtt from "mqtt";
import { readFileSync } from "fs";

const BASE = process.env.BASE || "http://localhost:8788";
const GRUPO = process.env.GRUPO;
if (!GRUPO) { console.error("defina GRUPO (o mesmo da ponte)"); process.exit(2); }
const secretsH = (() => { try { return readFileSync(new URL("../../firmware/include/secrets.h", import.meta.url), "utf8"); } catch { return ""; } })();
const MQTT_URL = process.env.MQTT_URL || ((/^#define MQTT_TLS\s+0/m.test(secretsH) ? "mqtt://" : "mqtts://")) + ((secretsH.match(/^#define MQTT_HOST\s+"([^"]+)"/m) || [])[1] || "broker.emqx.io") + ":" + ((secretsH.match(/^#define MQTT_PORT\s+(\d+)/m) || [])[1] || "8883");
const T = "sis1a/" + GRUPO + "/geladeira1/";
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
let falhas = 0;
const check = (nome, ok, extra = "") => { console.log(`${ok ? "OK  " : "FALHA"} ${nome} ${extra}`); if (!ok) falhas++; };
const fase = process.argv[2];

if (fase === "retido") {
  // antes da ponte subir: deixa no broker um estado VELHO e retido (temp 99.9) que nao pode virar leitura
  const c = mqtt.connect(MQTT_URL);
  await new Promise((r) => c.on("connect", r));
  await c.publishAsync(T + "estado", JSON.stringify({ online: true, estado: "temp_alta", alarme: true, temp_c: 99.9 }), { retain: true, qos: 1 });
  await c.endAsync();
  console.log("estado velho retido publicado");
  process.exit(0);
}

// ESP32 falso, com Last Will igual ao firmware
const dev = mqtt.connect(MQTT_URL, {
  clientId: "e2e-" + Math.random().toString(16).slice(2, 8), keepalive: 5,
  will: { topic: T + "estado", payload: JSON.stringify({ online: false }), qos: 1, retain: true },
});
await new Promise((r) => dev.on("connect", r));
const pub = (t, o, retain = false) => dev.publishAsync(T + t, JSON.stringify(o), { qos: 1, retain });
const est = (estado, temp, alarme) => pub("estado", { online: true, estado, alarme, porta_aberta: false, temp_c: temp, silenciado: false, pendentes: 0 }, true);

await est("ok", 5, false);
for (let i = 0; i < 12; i++) {                     // ~24 s de telemetria a cada 2 s
  const temp = i < 6 ? 5 : 20;
  await pub("telemetria", { temp_c: temp, dist_cm: 8 });
  if (i === 8) { await est("temp_alta", 20, true); await pub("alerta", { tipo: "temp_alta", temp_c: 20, cooldown_s: 300 }); }
  if (i === 10) await pub("ack", { id: "e2e1", cmd: "silenciar", status: "rejeitado", motivo: "sem_alarme_ativo" });
  await espera(2000);
}
dev.stream.destroy();                              // queda abrupta: o broker dispara o Last Will
console.log("ESP32 falso derrubado; aguardando Last Will e a ponte gravar...");
await espera(20000);

const lj = await (await fetch(BASE + "/api/leituras?horas=1")).json();
const temps = lj.leituras.map((l) => l.temp_c);
check("ponte gravou leituras da telemetria", lj.leituras.length >= 2, `n=${lj.leituras.length} temps=${temps}`);
check("estado retido velho (99.9) NAO virou leitura", !temps.includes(99.9));
check("leitura com 20 C gravada com estado temp_alta", lj.leituras.some((l) => l.temp_c === 20 && l.estado === "temp_alta"));
const ev = (await (await fetch(BASE + "/api/eventos?limite=100")).json()).eventos;
const tem = (tipo, txt) => ev.some((e) => e.tipo === tipo && e.detalhe.includes(txt));
check("evento: ESP32 online", tem("conexao", "online"));
check("evento: estado ok -> temp_alta", tem("estado", "ok → temp_alta"));
check("evento: alerta temp alta", tem("alerta", "temp alta"));
check("evento: buzzer tocando", tem("buzzer", "tocando"));
check("evento: comando rejeitado com motivo", tem("comando", "sem_alarme_ativo"));
check("evento: ESP32 offline (Last Will)", tem("conexao", "offline"));
check("nenhum evento veio do estado retido velho (99.9)", !ev.some((e) => e.detalhe.includes("99.9")));
const res = (await (await fetch(BASE + "/api/resumo?horas=1&passo=minuto")).json()).resumo;
check("resumo conta leituras fora da faixa", res.reduce((s, l) => s + l.fora_da_faixa, 0) >= 1, JSON.stringify(res));

// limpa o retido do grupo de teste no broker
const c = mqtt.connect(MQTT_URL); await new Promise((r) => c.on("connect", r));
await c.publishAsync(T + "estado", "", { retain: true }); await c.endAsync();
console.log(falhas ? `\n${falhas} falha(s)` : "\nTudo certo");
process.exit(falhas ? 1 : 0);
