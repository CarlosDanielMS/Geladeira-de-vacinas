// Aba "Vacinas": cadastro (nome, lote, validade, tipo) guardado no D1 via /api/vacinas.
// Ler e livre; cadastrar/remover exige a chave do painel (PAINEL_TOKEN) quando o Worker pede.
// Dado externo sempre via textContent (nunca innerHTML). As abas e os avisos ficam em app.js.
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const DIA = 86400000;
  let vacinas = [];
  let token = "";
  try { token = localStorage.getItem("painelToken") || ""; } catch (e) { /* sem storage */ }
  let alarmeAtivo = null;          // ultimo estado da geladeira em alarme (vem do app.js)
  let chaveObrigatoria = true;     // o Worker informa (local com PAINEL_LIVRE=1: nao precisa)
  let busca = "";

  const semAcento = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const plural = (n, um, varios) => n + " " + (n === 1 ? um : varios);

  // ---------- validade ----------
  function diasAte(validade) {
    const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
    return Math.round((new Date(validade + "T00:00:00") - hoje) / DIA);
  }
  function situacao(v) {
    const d = diasAte(v.validade);
    if (d < 0) return { txt: "Vencida há " + plural(-d, "dia", "dias"), cls: "perigo", nivel: "perigo" };
    if (d === 0) return { txt: "Vence hoje", cls: "perigo", nivel: "perigo" };
    if (d <= 30) return { txt: "Vence em " + plural(d, "dia", "dias"), cls: "aviso", nivel: "aviso" };
    return { txt: "Dentro da validade", cls: "ok", nivel: "ok" };
  }
  const fmtData = (v) => v.split("-").reverse().join("/");

  // ---------- mensagens ----------
  function msg(t, erro) { const el = $("vac-msg"); el.textContent = t || ""; el.classList.toggle("erro", !!erro); }
  const ERROS = {
    nao_autorizado: "A chave do painel está ausente ou errada.",
    lote_ja_cadastrado: "Esse lote dessa vacina já está cadastrado.",
    validade_invalida: "A data de validade é inválida.",
    nome_invalido: "Informe o nome da vacina.",
    lote_invalido: "Informe o lote.",
    tipo_invalido: "Informe o tipo da vacina.",
    nao_encontrada: "Vacina não encontrada. Ela já foi removida?",
  };
  function pedeChave(motivo) {
    $("vac-chave").hidden = false;
    $("vac-token").focus();
    if (motivo) msg(motivo, true);
  }

  // ---------- desenho ----------
  function desenha() {
    const tb = $("vac-tabela").tBodies[0]; tb.replaceChildren();
    let vencidas = 0, vencendo = 0;
    for (const v of vacinas) { const n = situacao(v).nivel; if (n === "perigo") vencidas++; else if (n === "aviso") vencendo++; }

    const q = semAcento(busca.trim());
    const lista = q ? vacinas.filter((v) => semAcento(v.nome + " " + v.lote + " " + v.tipo).includes(q)) : vacinas;

    for (const v of lista) {
      const s = situacao(v);
      const tr = tb.insertRow();
      if (s.nivel === "perigo") tr.className = "venc";
      const celula = (rotulo, txt, cls) => { const td = tr.insertCell(); td.dataset.rotulo = rotulo; if (cls) td.className = cls; if (txt != null) td.textContent = txt; return td; };
      celula("Nome", v.nome); celula("Lote", v.lote); celula("Tipo", v.tipo); celula("Validade", fmtData(v.validade));
      const st = document.createElement("span"); st.className = "selo " + s.cls; st.textContent = s.txt;
      celula("Situação").append(st);
      const rm = document.createElement("button");
      rm.className = "btn btn-sec btn-peq"; rm.type = "button"; rm.textContent = "Remover";
      rm.setAttribute("aria-label", "Remover " + v.nome + ", lote " + v.lote);
      rm.addEventListener("click", () => {   // confirmacao em dois cliques, sem caixa de dialogo do navegador
        if (rm.dataset.confirma) return remove(v, rm);
        rm.dataset.confirma = "1"; rm.textContent = "Confirmar remoção"; rm.classList.add("btn-perigo");
        setTimeout(() => { if (!rm.isConnected) return; delete rm.dataset.confirma; rm.textContent = "Remover"; rm.classList.remove("btn-perigo"); }, 4000);
      });
      celula("", null, "acao").append(rm);
    }
    if (!lista.length) {
      const td = tb.insertRow().insertCell(); td.colSpan = 6; td.className = "vazio";
      td.textContent = vacinas.length ? "Nenhuma vacina corresponde à busca." : "Nenhuma vacina cadastrada ainda. Use o formulário acima para começar.";
    }

    $("vac-total").textContent = vacinas.length;
    $("vac-vencidas").textContent = vencidas;
    $("vac-vencendo").textContent = vencendo;
    $("est-vencidas").dataset.nivel = vencidas ? "perigo" : "ok";
    $("est-vencendo").dataset.nivel = vencendo ? "aviso" : "ok";
    const atencao = vencidas + vencendo;
    $("vac-badge").hidden = !atencao;
    $("vac-badge").textContent = atencao;
    $("vac-badge").setAttribute("aria-label", plural(atencao, "vacina precisa de atenção", "vacinas precisam de atenção"));
    desenhaAlarme();
  }

  function desenhaAlarme() {
    const el = $("vac-alarme");
    if (!alarmeAtivo || !vacinas.length) { el.hidden = true; return; }
    el.hidden = false;
    const n = vacinas.length;
    el.textContent = "A geladeira está em alarme (" + String(alarmeAtivo.estado).replace("_", " ") +
      (typeof alarmeAtivo.temp_c === "number" ? ", " + alarmeAtivo.temp_c.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + " °C" : "") + "). " +
      plural(n, "vacina guardada aqui pode", "vacinas guardadas aqui podem") + " ter sido " + (n === 1 ? "exposta" : "expostas") + " fora da faixa de 2 a 8 °C. Avalie antes de usar.";
  }
  window.addEventListener("estado-geladeira", (ev) => { alarmeAtivo = ev.detail; desenhaAlarme(); });

  // ---------- API ----------
  async function carrega() {
    try {
      const r = await fetch("/api/vacinas");
      if (!r.ok) throw new Error("HTTP " + r.status);
      const d = await r.json();
      vacinas = d.vacinas || [];
      chaveObrigatoria = d.chave_obrigatoria !== false;
      $("vac-nota-chave").hidden = !chaveObrigatoria || !token;
      if (!chaveObrigatoria) $("vac-chave").hidden = true;
      desenha();
    } catch (e) {
      msg("Não foi possível carregar as vacinas (" + e.message + "). Tente recarregar a página.", true);
    }
  }
  async function chama(metodo, url, corpo) {
    if (chaveObrigatoria && !token) { pedeChave("Informe a chave do painel para continuar."); return null; }
    const headers = { "content-type": "application/json" };
    if (token) headers.Authorization = "Bearer " + token;
    let r, d;
    try {
      r = await fetch(url, { method: metodo, headers, body: corpo ? JSON.stringify(corpo) : undefined });
      d = await r.json().catch(() => ({}));
    } catch (e) { msg("Sem conexão com o servidor. Tente de novo.", true); return null; }
    if (r.status === 401) { pedeChave(ERROS.nao_autorizado); return null; }
    if (!r.ok) { msg(ERROS[d.erro] || "Não foi possível concluir (erro " + (d.erro || r.status) + ").", true); return null; }
    return d;
  }
  async function remove(v, btn) {
    btn.disabled = true;
    const d = await chama("DELETE", "/api/vacinas?id=" + v.id);
    if (d) { toast("Removida: " + v.nome + ", lote " + v.lote + ".", "ok"); await carrega(); }
    else btn.disabled = false;
  }

  $("vac-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const corpo = { nome: $("vac-nome").value.trim(), lote: $("vac-lote").value.trim(), validade: $("vac-validade").value, tipo: $("vac-tipo").value.trim() };
    if (!corpo.nome || !corpo.lote || !corpo.validade || !corpo.tipo) { msg("Preencha todos os campos.", true); return; }
    msg("");
    const btn = ev.submitter || ev.target.querySelector("button[type=submit]");
    btn.disabled = true;
    const vencida = diasAte(corpo.validade) < 0;
    const d = await chama("POST", "/api/vacinas", corpo);
    btn.disabled = false;
    if (!d) return;
    toast("Cadastrada: " + corpo.nome + ", lote " + corpo.lote + "." + (vencida ? " Atenção: a validade já passou." : ""), vencida ? "aviso" : "ok");
    $("vac-form").reset(); $("vac-nome").focus();
    await carrega();
  });
  $("vac-token-salvar").addEventListener("click", () => {
    token = $("vac-token").value.trim();
    try { localStorage.setItem("painelToken", token); } catch (e) { /* so nesta sessao */ }
    $("vac-token").value = ""; $("vac-chave").hidden = true;
    $("vac-nota-chave").hidden = !chaveObrigatoria || !token;
    msg(token ? "Chave salva neste navegador. Clique em Cadastrar de novo." : "Chave apagada.");
  });
  $("vac-token").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("vac-token-salvar").click(); } });
  $("vac-trocar-chave").addEventListener("click", (ev) => { ev.preventDefault(); pedeChave(); });
  $("vac-busca").addEventListener("input", (ev) => { busca = ev.target.value; desenha(); });

  carrega();
  setInterval(desenha, 60 * 60 * 1000);   // a situacao muda com o dia, mesmo sem cadastro novo
})();
