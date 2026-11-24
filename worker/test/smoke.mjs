// Teste de fumaca contra `npm run dev` (http://localhost:8787). Uso: node test/smoke.mjs [INGEST_TOKEN] [PAINEL_TOKEN]
const base = process.env.BASE || "http://localhost:8787";
const token = process.argv[2] || process.env.INGEST_TOKEN || "troque-por-um-token-longo-e-aleatorio";
let falhas = 0;
const check = (nome, ok, extra = "") => { console.log(`${ok ? "OK  " : "FALHA"} ${nome} ${extra}`); if (!ok) falhas++; };
const post = (corpo, tk) => fetch(base + "/api/leituras", {
  method: "POST",
  headers: { "content-type": "application/json", ...(tk ? { Authorization: "Bearer " + tk } : {}) },
  body: typeof corpo === "string" ? corpo : JSON.stringify(corpo),
});

const agora = Math.floor(Date.now() / 1000);
// dispositivo proprio de cada rodada: o teste pode rodar varias vezes e ate no banco real sem misturar com a geladeira1
const DISP = "teste_" + agora;
const D = "dispositivo=" + DISP;
const lote = Array.from({ length: 6 }, (_, i) => ({
  ts: agora - (5 - i) * 60, temp_c: i === 5 ? 9.1 : 5 + i * 0.2, dist_cm: 8, porta: 0, estado: i === 5 ? "temp_alta" : "ok",
}));

let r = await post({ dispositivo: DISP, leituras: lote });
check("sem token -> 401", r.status === 401, r.status);
r = await post({ dispositivo: DISP, leituras: lote }, "token-errado");
check("token errado -> 401", r.status === 401, r.status);
r = await post("{nao e json", token);
check("JSON quebrado -> 400", r.status === 400, r.status);
r = await post({ dispositivo: DISP, leituras: [{ ts: agora, temp_c: 999, estado: "ok" }] }, token);
check("temp_c absurda -> 400", r.status === 400, r.status);
r = await post({ dispositivo: "../x", leituras: lote }, token);
check("dispositivo invalido -> 400", r.status === 400, r.status);
r = await post({ dispositivo: DISP, leituras: lote }, token);
check("lote valido -> 200", r.status === 200, r.status);
r = await post({ dispositivo: DISP, leituras: lote }, token);
check("reenvio do mesmo lote -> 200 (idempotente)", r.status === 200, r.status);

r = await fetch(base + "/api/resumo?horas=24&" + D); const res = await r.json();
const total = res.resumo.reduce((s, h) => s + h.leituras, 0);
check("resumo conta 6 leituras (sem duplicar)", total === 6, `total=${total}`);
check("resumo: 1 leitura fora da faixa", res.resumo.reduce((s, h) => s + h.fora_da_faixa, 0) === 1);
r = await fetch(base + "/api/ultimo?" + D); const ult = await r.json();
check("KV guarda o ultimo estado", ult.estado === "temp_alta", JSON.stringify(ult));
// periodo (de/ate) e agrupamento (passo)
r = await fetch(base + `/api/leituras?de=${agora - 150}&ate=${agora + 10}&${D}`); let lj = await r.json();
check("periodo de/ate filtra (3 leituras nos ultimos 150 s)", lj.leituras.length === 3, `n=${lj.leituras.length}`);
r = await fetch(base + "/api/leituras?horas=1&passo=hora&" + D); lj = await r.json();
const somaHora = lj.leituras.reduce((s, b) => s + b.leituras, 0);
check("passo=hora agrupa (soma 6 leituras, ts inteiro)", somaHora === 6 && lj.leituras.every((b) => Number.isInteger(b.ts) && b.ts % 3600 === 0), JSON.stringify(lj.leituras));
r = await fetch(base + "/api/resumo?horas=1&passo=minuto&" + D); const rm = await r.json();
check("resumo passo=minuto: 1 linha por minuto", rm.resumo.length === 6 && rm.resumo.every((l) => l.hora.endsWith(":00Z")), `linhas=${rm.resumo.length}`);
check("periodo invalido (> 31 dias) cai no padrao", (await (await fetch(base + "/api/leituras?de=1&ate=99999999999&" + D)).json()).leituras.length === 6);
// eventos
r = await fetch(base + "/api/eventos", { method: "POST", headers: { "content-type": "application/json", Authorization: "Bearer " + token }, body: JSON.stringify({ dispositivo: DISP, eventos: [{ ts: agora, tipo: "alerta", detalhe: "temp alta (9.1 °C)" }] }) });
check("POST /api/eventos -> 200", r.status === 200, r.status);
r = await fetch(base + "/api/eventos", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
check("POST /api/eventos sem token -> 401", r.status === 401, r.status);
r = await fetch(base + "/api/eventos?limite=5&" + D); const ev = await r.json();
check("GET /api/eventos devolve o alerta", ev.eventos.some((e) => e.tipo === "alerta"), JSON.stringify(ev.eventos));
// vacinas (cadastro pelo painel, exige PAINEL_TOKEN)
const painel = process.argv[3] || process.env.PAINEL_TOKEN;
if (painel) {
  const vac = (metodo, corpo, tk = painel, q = "") => fetch(base + "/api/vacinas?" + D + q, { method: metodo, headers: { "content-type": "application/json", ...(tk ? { Authorization: "Bearer " + tk } : {}) }, body: corpo && JSON.stringify(corpo) });
  const v1 = { nome: "Influenza", lote: "TESTE-" + agora, validade: "2027-03-15", tipo: "Inativada" };
  check("vacina sem chave -> 401", (await vac("POST", v1, null)).status === 401);
  check("vacina com INGEST_TOKEN (chave do ESP32) -> 401", (await vac("POST", v1, token)).status === 401);
  check("validade 31/02 -> 400", (await vac("POST", { ...v1, validade: "2026-02-31" })).status === 400);
  check("nome vazio -> 400", (await vac("POST", { ...v1, nome: "  " })).status === 400);
  r = await vac("POST", v1); const nova = await r.json();
  check("cadastra vacina -> 201", r.status === 201 && nova.id > 0, r.status);
  check("mesmo lote de novo -> 409", (await vac("POST", v1)).status === 409);
  const lista = (await (await fetch(base + "/api/vacinas?" + D)).json()).vacinas;
  check("lista traz a vacina", lista.some((v) => v.id === nova.id && v.validade === "2027-03-15"));
  check("remover sem chave -> 401", (await vac("DELETE", null, null, "&id=" + nova.id)).status === 401);
  check("remove -> 200", (await vac("DELETE", null, painel, "&id=" + nova.id)).status === 200);
  check("remover de novo -> 404", (await vac("DELETE", null, painel, "&id=" + nova.id)).status === 404);
} else console.log("(pulei vacinas: passe o PAINEL_TOKEN como 2o argumento)");
r = await fetch(base + "/");
check("painel servido em /", r.status === 200, r.status);

console.log(falhas ? `\n${falhas} falha(s)` : "\nTudo certo");
process.exit(falhas ? 1 : 0);
