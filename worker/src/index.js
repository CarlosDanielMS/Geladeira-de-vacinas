// Worker da geladeira de vacinas
//  POST /api/leituras   (ESP32, exige Bearer INGEST_TOKEN) -> grava lote no D1 + ultimo estado no KV
//  GET  /api/ultimo     -> ultimo estado (KV)
//  GET  /api/resumo     -> max/media/min/fora da faixa por intervalo (D1, GROUP BY)
//  GET  /api/leituras   -> leituras para o grafico/CSV (brutas ou agregadas)
//    parametros: ?horas=N (ultimas N horas) ou ?de=<unix>&ate=<unix> (ate 31 dias); ?passo=segundo|minuto|hora
//  POST /api/eventos    (exige Bearer INGEST_TOKEN) -> grava eventos no D1
//  GET  /api/eventos    -> historico de eventos (alertas, estado, porta, buzzer, comandos, sensores)
//  GET  /api/vacinas    -> vacinas cadastradas na geladeira (ordem de validade)
//  POST /api/vacinas    (painel, exige Bearer PAINEL_TOKEN) -> cadastra { nome, lote, validade, tipo }
//  DELETE /api/vacinas?id=N (painel, exige Bearer PAINEL_TOKEN) -> remove
// O painel (../painel) e servido como arquivos estaticos.

const ESTADOS = new Set(["ok", "temp_alta", "temp_baixa", "porta_aberta", "sensor_falha", "iniciando"]);
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

async function tokenOk(request, env, chave = "INGEST_TOKEN") {
  const esperado = env[chave];
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
    if (l.umid_pct !== undefined && (typeof l.umid_pct !== "number" || l.umid_pct < 0 || l.umid_pct > 100)) return { erro: "umid_pct_fora_da_faixa" };
    if (l.dist_cm !== undefined && (!Number.isInteger(l.dist_cm) || l.dist_cm < 0 || l.dist_cm > 500)) return { erro: "dist_cm_fora_da_faixa" };
    if (l.porta !== undefined && l.porta !== 0 && l.porta !== 1) return { erro: "porta_invalida" };
    if (!ESTADOS.has(l.estado)) return { erro: "estado_invalido" };
    itens.push({ ts: l.ts, temp_c: l.temp_c ?? null, umid_pct: l.umid_pct ?? null, dist_cm: l.dist_cm ?? null, porta: l.porta ?? 0, estado: l.estado });
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
    "INSERT OR IGNORE INTO leituras (dispositivo, ts, temp_c, umid_pct, dist_cm, porta, estado, recebido_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  );
  await env.DB.batch(v.itens.map((i) => stmt.bind(v.disp, i.ts, i.temp_c, i.umid_pct, i.dist_cm, i.porta, i.estado, agora)));

  // KV guarda so o "ultimo valor": a leitura mais recente do lote
  const ultima = v.itens.reduce((a, b) => (b.ts > a.ts ? b : a));
  const atual = await env.ESTADO.get(`ultimo:${v.disp}`, "json");
  if (!atual || ultima.ts >= atual.ts) {
    await env.ESTADO.put(`ultimo:${v.disp}`, JSON.stringify({ ...ultima, recebido_em: agora }));
  }
  return json({ ok: true, gravadas: v.itens.length });
}

const TIPOS = new Set(["alerta", "estado", "porta", "buzzer", "conexao", "comando", "sensores"]);

async function gravaEventos(request, env) {
  if (!(await tokenOk(request, env))) return json({ erro: "nao_autorizado" }, 401);
  const texto = await request.text();
  if (texto.length > 65536) return json({ erro: "corpo_grande_demais" }, 413);
  let c; try { c = JSON.parse(texto); } catch { return json({ erro: "json_invalido" }, 400); }
  if (!c || typeof c.dispositivo !== "string" || !/^[a-z0-9_]{1,32}$/.test(c.dispositivo)) return json({ erro: "dispositivo_invalido" }, 400);
  if (!Array.isArray(c.eventos) || c.eventos.length < 1 || c.eventos.length > 100) return json({ erro: "eventos_deve_ter_1_a_100" }, 400);
  const agora = Math.floor(Date.now() / 1000);
  for (const e of c.eventos) {
    if (!e || !Number.isInteger(e.ts) || e.ts < 1_600_000_000 || e.ts > agora + 86400) return json({ erro: "ts_invalido" }, 400);
    if (!TIPOS.has(e.tipo)) return json({ erro: "tipo_invalido" }, 400);
    if (typeof e.detalhe !== "string" || e.detalhe.length < 1 || e.detalhe.length > 200) return json({ erro: "detalhe_invalido" }, 400);
  }
  const stmt = env.DB.prepare("INSERT OR IGNORE INTO eventos (dispositivo, ts, tipo, detalhe) VALUES (?, ?, ?, ?)");
  await env.DB.batch(c.eventos.map((e) => stmt.bind(c.dispositivo, e.ts, e.tipo, e.detalhe)));
  return json({ ok: true, gravados: c.eventos.length });
}

async function listaEventos(url, env) {
  const d = disp(url); if (!d) return json({ erro: "dispositivo_invalido" }, 400);
  const limite = Math.min(Math.max(parseInt(url.searchParams.get("limite") || "200", 10) || 200, 1), 1000);
  const { results } = await env.DB.prepare(
    "SELECT ts, tipo, detalhe FROM eventos WHERE dispositivo = ? ORDER BY ts DESC, id DESC LIMIT ?"
  ).bind(d, limite).all();
  return json({ dispositivo: d, eventos: results });
}

function disp(url) {
  const d = url.searchParams.get("dispositivo") || "geladeira1";
  return /^[a-z0-9_]{1,32}$/.test(d) ? d : null;
}

// Periodo: ?de=<unix>&ate=<unix> (max 31 dias) ou, sem isso, as ultimas ?horas=
function periodo(url, horasPadrao, horasMax) {
  const de = parseInt(url.searchParams.get("de"), 10), ate = parseInt(url.searchParams.get("ate"), 10);
  if (Number.isInteger(de) && Number.isInteger(ate) && ate > de && ate - de <= 31 * 86400) return { de, ate, custom: true };
  const horas = Math.min(Math.max(parseInt(url.searchParams.get("horas") || String(horasPadrao), 10) || horasPadrao, 1), horasMax);
  const agora = Math.floor(Date.now() / 1000);
  return { de: agora - horas * 3600, ate: agora + 60, custom: false, horas };
}

// Granularidade: ?passo=segundo (leitura bruta) | minuto | hora
const PASSOS = { segundo: 1, minuto: 60, hora: 3600 };
const FMT = { segundo: "%Y-%m-%dT%H:%M:%SZ", minuto: "%Y-%m-%dT%H:%M:00Z", hora: "%Y-%m-%dT%H:00:00Z" };
function passo(url, padrao) { const p = url.searchParams.get("passo") || padrao; return PASSOS[p] ? p : padrao; }

async function resumo(url, env) {
  const d = disp(url); if (!d) return json({ erro: "dispositivo_invalido" }, 400);
  const p = periodo(url, 24, 168), ps = passo(url, "hora");
  // devolve no maximo as 2000 linhas mais recentes do periodo
  const { results } = await env.DB.prepare(
    `SELECT * FROM (
       SELECT strftime(?, CAST(ts / ${PASSOS[ps]} AS INTEGER) * ${PASSOS[ps]}, 'unixepoch') AS hora,
              MAX(temp_c) AS max_c, ROUND(AVG(temp_c), 2) AS media_c, MIN(temp_c) AS min_c,
              COUNT(temp_c) AS leituras, ROUND(AVG(umid_pct), 1) AS umid_media,
              SUM(CASE WHEN temp_c > 8 OR temp_c < 2 THEN 1 ELSE 0 END) AS fora_da_faixa
         FROM leituras
        WHERE dispositivo = ? AND ts >= ? AND ts <= ?
        GROUP BY hora ORDER BY hora DESC LIMIT 2000) ORDER BY hora`
  ).bind(FMT[ps], d, p.de, p.ate).all();
  return json({ dispositivo: d, passo: ps, de: p.de, ate: p.ate, resumo: results });
}

async function recentes(url, env) {
  const d = disp(url); if (!d) return json({ erro: "dispositivo_invalido" }, 400);
  const p = periodo(url, 6, 48), ps = passo(url, "segundo");
  if (ps === "segundo") {
    const { results } = await env.DB.prepare(
      `SELECT ts, temp_c, temp_c AS min_c, temp_c AS max_c, 1 AS leituras, umid_pct, dist_cm, porta, estado FROM leituras
        WHERE dispositivo = ? AND ts >= ? AND ts <= ?
        ORDER BY ts LIMIT 50000`
    ).bind(d, p.de, p.ate).all();
    return json({ dispositivo: d, passo: ps, leituras: results });
  }
  const { results } = await env.DB.prepare(
    `SELECT CAST(ts / ${PASSOS[ps]} AS INTEGER) * ${PASSOS[ps]} AS ts, ROUND(AVG(temp_c), 2) AS temp_c, MIN(temp_c) AS min_c, MAX(temp_c) AS max_c,
            COUNT(temp_c) AS leituras, ROUND(AVG(umid_pct), 1) AS umid_pct, MAX(porta) AS porta
       FROM leituras
      WHERE dispositivo = ? AND ts >= ? AND ts <= ?
      GROUP BY 1 ORDER BY 1 LIMIT 50000`
  ).bind(d, p.de, p.ate).all();
  return json({ dispositivo: d, passo: ps, leituras: results });
}

// ---------- vacinas ----------
// PAINEL_LIVRE=1 (so no .dev.vars, uso local: o wrangler dev so escuta no proprio PC) dispensa a chave.
// Sem essa variavel (producao) cadastrar/remover exige Bearer PAINEL_TOKEN: falha fechada.
const painelLivre = (env) => env.PAINEL_LIVRE === "1";
const painelPode = async (request, env) => painelLivre(env) || tokenOk(request, env, "PAINEL_TOKEN");
const texto = (v, max) => typeof v === "string" && v.trim().length >= 1 && v.trim().length <= max;
function dataValida(v) {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(v + "T00:00:00Z");
  return !isNaN(d) && d.toISOString().slice(0, 10) === v;   // recusa 2026-02-31
}
async function listaVacinas(url, env) {
  const d = disp(url); if (!d) return json({ erro: "dispositivo_invalido" }, 400);
  const { results } = await env.DB.prepare(
    "SELECT id, nome, lote, validade, tipo, criado_em FROM vacinas WHERE dispositivo = ? ORDER BY validade, nome LIMIT 1000"
  ).bind(d).all();
  return json({ dispositivo: d, chave_obrigatoria: !painelLivre(env), vacinas: results });
}
async function cadastraVacina(request, url, env) {
  if (!(await painelPode(request, env))) return json({ erro: "nao_autorizado" }, 401);
  const d = disp(url); if (!d) return json({ erro: "dispositivo_invalido" }, 400);
  const txt = await request.text();
  if (txt.length > 4096) return json({ erro: "corpo_grande_demais" }, 413);
  let c; try { c = JSON.parse(txt); } catch { return json({ erro: "json_invalido" }, 400); }
  if (!c || !texto(c.nome, 80)) return json({ erro: "nome_invalido" }, 400);
  if (!texto(c.lote, 40)) return json({ erro: "lote_invalido" }, 400);
  if (!dataValida(c.validade)) return json({ erro: "validade_invalida" }, 400);
  if (!texto(c.tipo, 40)) return json({ erro: "tipo_invalido" }, 400);
  const r = await env.DB.prepare(
    "INSERT OR IGNORE INTO vacinas (dispositivo, nome, lote, validade, tipo, criado_em) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(d, c.nome.trim(), c.lote.trim(), c.validade, c.tipo.trim(), Math.floor(Date.now() / 1000)).run();
  if (!r.meta.changes) return json({ erro: "lote_ja_cadastrado" }, 409);
  return json({ ok: true, id: r.meta.last_row_id }, 201);
}
async function removeVacina(request, url, env) {
  if (!(await painelPode(request, env))) return json({ erro: "nao_autorizado" }, 401);
  const d = disp(url); if (!d) return json({ erro: "dispositivo_invalido" }, 400);
  const id = parseInt(url.searchParams.get("id"), 10);
  if (!Number.isInteger(id) || id < 1) return json({ erro: "id_invalido" }, 400);
  const r = await env.DB.prepare("DELETE FROM vacinas WHERE id = ? AND dispositivo = ?").bind(id, d).run();
  return r.meta.changes ? json({ ok: true }) : json({ erro: "nao_encontrada" }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname: p } = url;
    if (p === "/api/leituras" && request.method === "POST") return gravaLeituras(request, env);
    if (p === "/api/eventos" && request.method === "POST") return gravaEventos(request, env);
    if (p === "/api/vacinas" && request.method === "POST") return cadastraVacina(request, url, env);
    if (p === "/api/vacinas" && request.method === "DELETE") return removeVacina(request, url, env);
    if (request.method !== "GET") return json({ erro: "metodo_nao_permitido" }, 405);
    if (p === "/api/vacinas") return listaVacinas(url, env);
    if (p === "/api/ultimo") {
      const d = disp(url); if (!d) return json({ erro: "dispositivo_invalido" }, 400);
      return json((await env.ESTADO.get(`ultimo:${d}`, "json")) || {});
    }
    if (p === "/api/resumo") return resumo(url, env);
    if (p === "/api/leituras") return recentes(url, env);
    if (p === "/api/eventos") return listaEventos(url, env);
    if (p.startsWith("/api/")) return json({ erro: "nao_encontrado" }, 404);
    return env.ASSETS ? env.ASSETS.fetch(request) : new Response("ok");
  },

  // Retencao: apaga leituras mais antigas que RETENCAO_DIAS (cron diario)
  async scheduled(_evt, env) {
    const dias = parseInt(env.RETENCAO_DIAS || "365", 10);
    await env.DB.prepare("DELETE FROM leituras WHERE ts < CAST(strftime('%s','now') AS INTEGER) - ? * 86400").bind(dias).run();
    await env.DB.prepare("DELETE FROM eventos WHERE ts < CAST(strftime('%s','now') AS INTEGER) - ? * 86400").bind(dias).run();
  },
};
