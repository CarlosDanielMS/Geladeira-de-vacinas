// Teste de fumaca contra `npm run dev` (http://localhost:8787). Uso: node test/smoke.mjs [token]
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
const lote = Array.from({ length: 6 }, (_, i) => ({
  ts: agora - (5 - i) * 60, temp_c: i === 5 ? 9.1 : 5 + i * 0.2, dist_cm: 8, porta: 0, estado: i === 5 ? "temp_alta" : "ok",
}));

let r = await post({ dispositivo: "geladeira1", leituras: lote });
check("sem token -> 401", r.status === 401, r.status);
r = await post({ dispositivo: "geladeira1", leituras: lote }, "token-errado");
check("token errado -> 401", r.status === 401, r.status);
r = await post("{nao e json", token);
check("JSON quebrado -> 400", r.status === 400, r.status);
r = await post({ dispositivo: "geladeira1", leituras: [{ ts: agora, temp_c: 999, estado: "ok" }] }, token);
check("temp_c absurda -> 400", r.status === 400, r.status);
r = await post({ dispositivo: "../x", leituras: lote }, token);
check("dispositivo invalido -> 400", r.status === 400, r.status);
r = await post({ dispositivo: "geladeira1", leituras: lote }, token);
check("lote valido -> 200", r.status === 200, r.status);
r = await post({ dispositivo: "geladeira1", leituras: lote }, token);
check("reenvio do mesmo lote -> 200 (idempotente)", r.status === 200, r.status);

r = await fetch(base + "/api/resumo?horas=24"); const res = await r.json();
const total = res.resumo.reduce((s, h) => s + h.leituras, 0);
check("resumo conta 6 leituras (sem duplicar)", total === 6, `total=${total}`);
check("resumo: 1 leitura fora da faixa", res.resumo.reduce((s, h) => s + h.fora_da_faixa, 0) === 1);
r = await fetch(base + "/api/ultimo"); const ult = await r.json();
check("KV guarda o ultimo estado", ult.estado === "temp_alta", JSON.stringify(ult));
r = await fetch(base + "/");
check("painel servido em /", r.status === 200, r.status);

console.log(falhas ? `\n${falhas} falha(s)` : "\nTudo certo");
process.exit(falhas ? 1 : 0);
