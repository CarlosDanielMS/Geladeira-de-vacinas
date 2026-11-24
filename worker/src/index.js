// Worker da geladeira de vacinas
//  POST /api/leituras   (ESP32, exige Bearer INGEST_TOKEN) -> grava lote no D1 + ultimo estado no KV
//  GET  /api/ultimo     -> ultimo estado (KV)
//  GET  /api/resumo     -> max/media/min por hora (D1, GROUP BY)
//  GET  /api/leituras   -> leituras recentes para o grafico
// O painel (../painel) e servido como arquivos estaticos.

const ESTADOS = new Set(["ok", "temp_alta", "temp_baixa", "porta_aberta", "sensor_falha", "iniciando"]);
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

async function tokenOk(request, env) {
  const esperado = env.INGEST_TOKEN;
  if (!esperado) return false; // sem segredo configurado: recusa tudo (falha fechada)
  const dado = (request.headers.get("Authorization") || "").replace(/^Bearer /, "");
  const enc = new TextEncoder();
  const a = enc.encode(dado), b = enc.encode(esperado);
  if (a.length !== b.length) return false;
  return crypto.subtle.timingSafeEqual(a, b);
}

// Valida o JSON; devolve { erro } ou { disp, itens }
export function valida(corpo, agora = Math.floor(Date.now() / 1000)) {
  if (!corpo || typeof corpo !== "object") return { erro: "json_invalido" };
  const disp = corpo.dispositivo;
  if (typeof disp !== "string" || !/^[a-z0-9_]{1,32}$/.test(disp)) return { erro: "dispositivo_invalido" };
  const arr = corpo.leituras;
  if (!Array.isArray(arr) || arr.length < 1 || arr.length > 100) return { erro: "leituras_deve_ter_1_a_100" };
  const itens = [];
  for (const l of arr) {
    if (!l || typeof l !== "object") return { erro: "leitura_invalida" };
    if (!Number.isInteger(l.ts) || l.ts < 1_600_000_000 || l.ts > agora + 86400) return { erro: "ts_invalido" };
    if (l.temp_c !== undefined && (typeof l.temp_c !== "number" || l.temp_c < -40 || l.temp_c > 85)) return { erro: "temp_c_fora_da_faixa" };
    if (l.dist_cm !== undefined && (!Number.isInteger(l.dist_cm) || l.dist_cm < 0 || l.dist_cm > 500)) return { erro: "dist_cm_fora_da_faixa" };
    if (l.porta !== undefined && l.porta !== 0 && l.porta !== 1) return { erro: "porta_invalida" };
    if (!ESTADOS.has(l.estado)) return { erro: "estado_invalido" };
    itens.push({ ts: l.ts, temp_c: l.temp_c ?? null, dist_cm: l.dist_cm ?? null, porta: l.porta ?? 0, estado: l.estado });
  }
  return { disp, itens };
}

async function gravaLeituras(request, env) {
  if (!(await tokenOk(request, env))) return json({ erro: "nao_autorizado" }, 401);
  const texto = await request.text();
  if (texto.length > 65536) return json({ erro: "corpo_grande_demais" }, 413);
  let corpo;
  try { corpo = JSON.parse(texto); } catch { return json({ erro: "json_invalido" }, 400); }
  const v = valida(corpo);
  if (v.erro) return json({ erro: v.erro }, 400);

  const agora = Math.floor(Date.now() / 1000);
  const stmt = env.DB.prepare(
    "INSERT OR IGNORE INTO leituras (dispositivo, ts, temp_c, dist_cm, porta, estado, recebido_em) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  await env.DB.batch(v.itens.map((i) => stmt.bind(v.disp, i.ts, i.temp_c, i.dist_cm, i.porta, i.estado, agora)));

  // KV guarda so o "ultimo valor": a leitura mais recente do lote
  const ultima = v.itens.reduce((a, b) => (b.ts > a.ts ? b : a));
  const atual = await env.ESTADO.get(`ultimo:${v.disp}`, "json");
  if (!atual || ultima.ts >= atual.ts) {
    await env.ESTADO.put(`ultimo:${v.disp}`, JSON.stringify({ ...ultima, recebido_em: agora }));
  }
  return json({ ok: true, gravadas: v.itens.length });
}

function disp(url) {
  const d = url.searchParams.get("dispositivo") || "geladeira1";
  return /^[a-z0-9_]{1,32}$/.test(d) ? d : null;
}

async function resumo(url, env) {
  const d = disp(url); if (!d) return json({ erro: "dispositivo_invalido" }, 400);
  const horas = Math.min(Math.max(parseInt(url.searchParams.get("horas") || "24", 10) || 24, 1), 168);
  const { results } = await env.DB.prepare(
    `SELECT strftime('%Y-%m-%dT%H:00:00Z', ts, 'unixepoch') AS hora,
            MAX(temp_c) AS max_c, ROUND(AVG(temp_c), 2) AS media_c, MIN(temp_c) AS min_c,
            COUNT(*) AS leituras,
            SUM(CASE WHEN temp_c > 8 OR temp_c < 2 THEN 1 ELSE 0 END) AS fora_da_faixa
       FROM leituras
      WHERE dispositivo = ? AND ts >= CAST(strftime('%s','now') AS INTEGER) - ? * 3600
      GROUP BY hora ORDER BY hora`
  ).bind(d, horas).all();
  return json({ dispositivo: d, horas, resumo: results });
}

async function recentes(url, env) {
  const d = disp(url); if (!d) return json({ erro: "dispositivo_invalido" }, 400);
  const horas = Math.min(Math.max(parseInt(url.searchParams.get("horas") || "6", 10) || 6, 1), 48);
  const { results } = await env.DB.prepare(
    `SELECT ts, temp_c, dist_cm, porta, estado FROM leituras
      WHERE dispositivo = ? AND ts >= CAST(strftime('%s','now') AS INTEGER) - ? * 3600
      ORDER BY ts LIMIT 2000`
  ).bind(d, horas).all();
  return json({ dispositivo: d, leituras: results });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname: p } = url;
    if (p === "/api/leituras" && request.method === "POST") return gravaLeituras(request, env);
    if (request.method !== "GET") return json({ erro: "metodo_nao_permitido" }, 405);
    if (p === "/api/ultimo") {
      const d = disp(url); if (!d) return json({ erro: "dispositivo_invalido" }, 400);
      return json((await env.ESTADO.get(`ultimo:${d}`, "json")) || {});
    }
    if (p === "/api/resumo") return resumo(url, env);
    if (p === "/api/leituras") return recentes(url, env);
    if (p.startsWith("/api/")) return json({ erro: "nao_encontrado" }, 404);
    return env.ASSETS ? env.ASSETS.fetch(request) : new Response("ok");
  },

  // Retencao: apaga leituras mais antigas que RETENCAO_DIAS (cron diario)
  async scheduled(_evt, env) {
    const dias = parseInt(env.RETENCAO_DIAS || "365", 10);
    await env.DB.prepare("DELETE FROM leituras WHERE ts < CAST(strftime('%s','now') AS INTEGER) - ? * 86400").bind(dias).run();
  },
};
