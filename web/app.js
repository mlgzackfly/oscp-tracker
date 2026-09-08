const KEY = "oscp-track-v1";
const MACHINES = window.OSCP_DATA.machines;
const BY_ID = new Map(MACHINES.map((m) => [m.id, m]));
const STATUSES = { todo: "未開始", active: "進行中", done: "已完成", stuck: "卡關" };
const OS_LABEL = { Linux: "Linux", Windows: "Windows", "Active Directory and Networks": "AD / 網段" };
const REQUIRED = MACHINES.filter((m) => m.required);

let state = { entries: {}, history: [], theme: null };
let ui = { view: "overview", track: "OSCP", q: "", platform: "", os: "", status: "", requiredOnly: false, open: null, scope: "required", drawOs: "", skipDone: true, weekOffset: 0, current: null };

/* ---------- storage ---------- */

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      state = { entries: parsed.entries || {}, history: parsed.history || [], theme: parsed.theme || null };
    }
  } catch (err) {
    console.warn("無法讀取本機進度", err);
  }
  if (state.theme) document.documentElement.setAttribute("data-theme", state.theme);
}

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch (err) {
    toast("瀏覽器拒絕儲存，進度只留在這個分頁");
  }
}

function entry(id) {
  if (!state.entries[id]) state.entries[id] = { status: "todo", minutes: 0, rating: "", notes: "", doneAt: null, date: null, url: "" };
  return state.entries[id];
}

function peek(id) {
  return state.entries[id] || { status: "todo", minutes: 0, rating: "", notes: "", doneAt: null, date: null, url: "" };
}

/* ---------- helpers ---------- */

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const today = () => iso(new Date());

let toastTimer;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2200);
}

function pct(done, total) {
  return total ? Math.round((done / total) * 100) : 0;
}

function statusOf(id) {
  return peek(id).status || "todo";
}

function shortPlatform(name) {
  return name.replace(" (Not updated)", "").replace(" (Deprecated)", "").replace("VulnLab / Hackthebox", "VulnLab");
}

function trackPool(track) {
  return track === "all" ? MACHINES : MACHINES.filter((m) => m.track === track);
}

/* ---------- filtering ---------- */

function filtered() {
  const q = ui.q.trim().toLowerCase();
  return trackPool(ui.track).filter((m) => {
    if (ui.requiredOnly && !m.required) return false;
    if (ui.platform && m.platform !== ui.platform) return false;
    if (ui.os && m.category !== ui.os) return false;
    if (ui.status && statusOf(m.id) !== ui.status) return false;
    if (q && !(m.name.toLowerCase().includes(q) || m.platform.toLowerCase().includes(q))) return false;
    return true;
  });
}

function drawPool() {
  let pool;
  if (ui.scope === "required") pool = REQUIRED;
  else if (ui.scope === "oscp") pool = trackPool("OSCP");
  else pool = filtered();
  if (ui.drawOs) pool = pool.filter((m) => m.category === ui.drawOs);
  if (ui.skipDone) pool = pool.filter((m) => statusOf(m.id) !== "done");
  return pool;
}

/* ---------- overview ---------- */

function ring(done, total) {
  const p = pct(done, total);
  const r = 50;
  const c = 2 * Math.PI * r;
  return `<svg viewBox="0 0 118 118" width="118" height="118" role="img" aria-label="完成 ${p}%">
    <circle cx="59" cy="59" r="${r}" fill="none" stroke="var(--todo-soft)" stroke-width="9"></circle>
    <circle cx="59" cy="59" r="${r}" fill="none" stroke="var(--accent)" stroke-width="9" stroke-linecap="round"
      stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${(c * (1 - p / 100)).toFixed(1)}"></circle>
  </svg><div class="label"><b>${p}<span style="font-size:15px">%</span></b><span>${done}/${total}</span></div>`;
}

function weekStart(offset = 0) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + offset * 7);
  return d;
}

function streak() {
  const days = new Set(Object.values(state.entries).filter((e) => e.doneAt).map((e) => e.doneAt.slice(0, 10)));
  let n = 0;
  const d = new Date();
  if (!days.has(iso(d))) d.setDate(d.getDate() - 1);
  while (days.has(iso(d))) {
    n += 1;
    d.setDate(d.getDate() - 1);
  }
  return n;
}

function renderOverview() {
  const reqDone = REQUIRED.filter((m) => statusOf(m.id) === "done").length;
  $("#pg-ring").innerHTML = ring(reqDone, REQUIRED.length);
  $("#pg-summary").textContent = `清單裡的 ${REQUIRED.length} 台 Proving Grounds Practice 靶機是必修，還剩 ${REQUIRED.length - reqDone} 台。`;

  const byOs = {};
  REQUIRED.forEach((m) => {
    byOs[m.category] = byOs[m.category] || { done: 0, total: 0 };
    byOs[m.category].total += 1;
    if (statusOf(m.id) === "done") byOs[m.category].done += 1;
  });
  $("#pg-breakdown").innerHTML = Object.entries(byOs)
    .map(([os, v]) => `<span class="chip">${esc(OS_LABEL[os] || os)} <b class="mono">${v.done}/${v.total}</b></span>`)
    .join("");

  const oscp = trackPool("OSCP");
  const oscpDone = oscp.filter((m) => statusOf(m.id) === "done").length;
  const ws = iso(weekStart());
  const weekDone = Object.values(state.entries).filter((e) => e.doneAt && e.doneAt.slice(0, 10) >= ws).length;
  const minutes = Object.values(state.entries).reduce((a, e) => a + (Number(e.minutes) || 0), 0);
  const activeCount = Object.values(state.entries).filter((e) => e.status === "active").length;
  const stuckCount = Object.values(state.entries).filter((e) => e.status === "stuck").length;

  $("#stat-grid").innerHTML = [
    ["OSCP 清單完成", `${oscpDone}<span class="unit">/ ${oscp.length}</span>`, `含 HTB、PG、VulnLab 等平台`],
    ["本週完成", `${weekDone}<span class="unit">台</span>`, `連續打靶 ${streak()} 天`],
    ["累積投入", `${(minutes / 60).toFixed(1)}<span class="unit">小時</span>`, `平均每台 ${oscpDone ? Math.round(minutes / Math.max(oscpDone, 1)) : 0} 分`],
    ["手上進行中", `${activeCount}<span class="unit">台</span>`, stuckCount ? `另有 ${stuckCount} 台卡關` : "沒有卡關中的機器"],
  ]
    .map(([label, value, sub]) => `<div class="stat"><span class="eyebrow">${label}</span><b>${value}</b><small>${esc(sub)}</small></div>`)
    .join("");

  const groups = new Map();
  trackPool("OSCP").forEach((m) => {
    if (!groups.has(m.platform)) groups.set(m.platform, { done: 0, total: 0, required: m.required });
    const g = groups.get(m.platform);
    g.total += 1;
    if (statusOf(m.id) === "done") g.done += 1;
  });
  $("#platform-list").innerHTML = [...groups.entries()]
    .map(
      ([name, g]) => `<div class="platform-row">
        <span class="name">${esc(shortPlatform(name))}${g.required ? ' <span class="chip required">必練</span>' : ""}</span>
        <span class="num">${g.done}/${g.total}</span>
        <span class="bar"><span class="${g.done === g.total ? "done" : ""}" style="width:${pct(g.done, g.total)}%"></span></span>
      </div>`
    )
    .join("");

  const todays = MACHINES.filter((m) => peek(m.id).date === today());
  $("#today-list").innerHTML = todays.length
    ? todays
        .map((m) => `<li><span class="dot ${statusOf(m.id)}"></span><span class="name">${esc(m.name)}</span><span class="when">${esc(shortPlatform(m.platform))}</span></li>`)
        .join("")
    : '<li class="empty">今天還沒排靶機。</li>';

  const recent = Object.entries(state.entries)
    .filter(([, e]) => e.doneAt)
    .sort((a, b) => b[1].doneAt.localeCompare(a[1].doneAt))
    .slice(0, 6);
  if (recent.length) {
    $("#recent-title").textContent = "最近完成";
    $("#recent-list").innerHTML = recent
      .map(([id, e]) => {
        const m = BY_ID.get(id);
        if (!m) return "";
        return `<li><span class="dot done"></span><span class="name">${esc(m.name)}</span><span class="when">${e.doneAt.slice(5, 10)}${e.minutes ? " · " + e.minutes + "m" : ""}</span></li>`;
      })
      .join("");
  } else {
    $("#recent-title").textContent = "起手清單";
    $("#recent-list").innerHTML = REQUIRED.filter((m) => !peek(m.id).date)
      .slice(0, 5)
      .map(
        (m) => `<li><span class="dot"></span><span class="name">${esc(m.name)}</span>
          <span class="chip">${esc(OS_LABEL[m.category] || m.category)}</span>
          <button class="btn ghost sm when" data-act="plan" data-id="${esc(m.id)}">排到今天</button></li>`
      )
      .join("");
  }

  $("#rail-pg").textContent = `${reqDone} / ${REQUIRED.length}`;
  $("#rail-pg-pct").textContent = pct(reqDone, REQUIRED.length) + "%";
  $("#rail-pg-bar").style.width = pct(reqDone, REQUIRED.length) + "%";
  $("#nav-count-machines").textContent = MACHINES.length;
  $("#nav-count-sched").textContent = Object.values(state.entries).filter((e) => e.date && e.date >= today()).length || "";
}

/* ---------- machines ---------- */

function rowHtml(m) {
  const e = peek(m.id);
  const tags = [];
  if (m.required) tags.push('<span class="chip required">必練</span>');
  if (m.note) tags.push(`<span class="chip${/harder/i.test(m.note) ? " warn" : ""}">${esc(m.note)}</span>`);
  if (m.section) tags.push(`<span class="chip">${esc(m.section)}</span>`);
  if (e.date) tags.push(`<span class="chip mono">${esc(e.date.slice(5))}</span>`);
  return `<div class="row${ui.open === m.id ? " is-open" : ""}" data-id="${esc(m.id)}">
      <span class="dot ${e.status}"></span>
      <span class="title"><span class="n">${esc(m.name)}</span></span>
      <span class="platform">${esc(shortPlatform(m.platform))}</span>
      <span class="os-cell chip">${esc(OS_LABEL[m.category] || m.category)}</span>
      <span class="tags">${tags.join("")}</span>
      <span class="status-cell">
        <select class="status-select" data-status="${e.status}" data-act="status" data-id="${esc(m.id)}">
          ${Object.entries(STATUSES).map(([k, v]) => `<option value="${k}"${e.status === k ? " selected" : ""}>${v}</option>`).join("")}
        </select>
      </span>
    </div>${ui.open === m.id ? detailHtml(m) : ""}`;
}

function detailHtml(m) {
  const e = peek(m.id);
  return `<div class="detail" data-detail="${esc(m.id)}">
    <div class="detail-grid">
      <div class="field"><label>耗時（分鐘）</label><input type="number" min="0" step="15" value="${e.minutes || ""}" data-act="minutes" data-id="${esc(m.id)}"></div>
      <div class="field"><label>難度自評</label>
        <select data-act="rating" data-id="${esc(m.id)}">
          <option value=""${!e.rating ? " selected" : ""}>—</option>
          ${["很簡單", "偏易", "剛好", "偏難", "打不動"].map((r) => `<option${e.rating === r ? " selected" : ""}>${r}</option>`).join("")}
        </select>
      </div>
      <div class="field"><label>排定日期</label><input type="date" value="${e.date || ""}" data-act="date" data-id="${esc(m.id)}"></div>
      <div class="field"><label>Writeup 連結</label><input type="url" placeholder="https://" value="${esc(e.url || "")}" data-act="url" data-id="${esc(m.id)}"></div>
      <div class="field wide"><label>筆記（攻擊面、卡在哪、學到什麼）</label><textarea data-act="notes" data-id="${esc(m.id)}" placeholder="例：80/tcp 有舊版 CMS，作者路徑遍歷拿到憑證；提權靠 sudo 誤設。">${esc(e.notes || "")}</textarea></div>
    </div>
  </div>`;
}

function renderMachines() {
  const list = filtered();
  const done = list.filter((m) => statusOf(m.id) === "done").length;
  $("#result-line").textContent = `${list.length} 台符合條件 · 已完成 ${done} · ${pct(done, list.length)}%`;
  $("#table").innerHTML = list.length
    ? `<div class="table-head"><span></span><span>靶機</span><span>平台</span><span>系統</span><span>標記</span><span style="text-align:right">狀態</span></div>` +
      list.map(rowHtml).join("")
    : '<div class="empty" style="padding:24px;text-align:center">沒有符合條件的靶機。</div>';
}

function renderPlatformFilter() {
  const platforms = [...new Set(trackPool(ui.track).map((m) => m.platform))];
  if (!platforms.includes(ui.platform)) ui.platform = "";
  $("#f-platform").innerHTML =
    '<option value="">全部平台</option>' +
    platforms.map((p) => `<option value="${esc(p)}"${ui.platform === p ? " selected" : ""}>${esc(shortPlatform(p))}</option>`).join("");
}

/* ---------- draw ---------- */

function renderPool() {
  const pool = drawPool();
  const byOs = {};
  pool.forEach((m) => (byOs[m.category] = (byOs[m.category] || 0) + 1));
  $("#pool-note").innerHTML =
    `<div class="pool-stat"><span>候選總數</span><b>${pool.length}</b></div>` +
    Object.entries(byOs).map(([os, n]) => `<div class="pool-stat"><span>${esc(OS_LABEL[os] || os)}</span><b>${n}</b></div>`).join("");
  $("#slot-eyebrow").textContent = pool.length ? `候選池 ${pool.length} 台` : "候選池是空的";

  $("#draw-history").innerHTML = state.history.length
    ? state.history
        .slice(0, 8)
        .map((id) => {
          const m = BY_ID.get(id);
          if (!m) return "";
          return `<li><span class="dot ${statusOf(id)}"></span><span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(m.name)}</span><span class="result-line">${esc(shortPlatform(m.platform))}</span></li>`;
        })
        .join("")
    : '<li class="empty">還沒抽過。</li>';
}

function showResult(m) {
  ui.current = m.id;
  $("#reel").textContent = m.name;
  $("#slot-meta").innerHTML = [
    `<span class="chip">${esc(shortPlatform(m.platform))}</span>`,
    `<span class="chip">${esc(OS_LABEL[m.category] || m.category)}</span>`,
    m.required ? '<span class="chip required">必練</span>' : "",
    m.note ? `<span class="chip${/harder/i.test(m.note) ? " warn" : ""}">${esc(m.note)}</span>` : "",
    m.section ? `<span class="chip">${esc(m.section)}</span>` : "",
  ].join("");
  const e = peek(m.id);
  $("#slot-hint").textContent = e.status === "todo" ? "還沒碰過這台。開機、列舉、計時開始。" : `目前狀態：${STATUSES[e.status]}`;
  $("#slot-actions").innerHTML = `
    <button class="btn primary" id="btn-start">標為進行中</button>
    <button class="btn" id="btn-plan-today">排到今天</button>
    <button class="btn ghost" id="btn-draw">再抽一台</button>`;
}

function draw() {
  const pool = drawPool();
  if (!pool.length) {
    toast("候選池是空的，放寬條件試試");
    return;
  }
  const pick = pool[Math.floor(Math.random() * pool.length)];
  const slot = $("#slot");
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduced || pool.length < 3) {
    showResult(pick);
    finishDraw(pick);
    return;
  }
  slot.classList.add("is-spinning");
  $("#slot-meta").innerHTML = "";
  $("#slot-hint").textContent = "掃描候選池…";
  let ticks = 0;
  const timer = setInterval(() => {
    $("#reel").textContent = pool[Math.floor(Math.random() * pool.length)].name;
    ticks += 1;
    if (ticks > 18) {
      clearInterval(timer);
      slot.classList.remove("is-spinning");
      showResult(pick);
      finishDraw(pick);
    }
  }, 65);
}

function finishDraw(m) {
  state.history = [m.id, ...state.history.filter((id) => id !== m.id)].slice(0, 20);
  save();
  renderPool();
}

/* ---------- schedule ---------- */

function renderSchedule() {
  const start = weekStart(ui.weekOffset);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  $("#week-label").textContent = `${iso(start).slice(5)} – ${iso(end).slice(5)}`;

  const scheduled = {};
  MACHINES.forEach((m) => {
    const d = peek(m.id).date;
    if (d) (scheduled[d] = scheduled[d] || []).push(m);
  });

  const dows = ["一", "二", "三", "四", "五", "六", "日"];
  let html = "";
  for (let i = 0; i < 7; i += 1) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    const key = iso(d);
    const items = scheduled[key] || [];
    const cls = key === today() ? " today" : key < today() ? " past" : "";
    html += `<div class="day${cls}">
      <div class="day-head"><span class="dow">週${dows[i]}</span><span class="dnum">${d.getDate()}</span></div>
      <ul>${items
        .map(
          (m) => `<li class="${statusOf(m.id)}"><span class="dot ${statusOf(m.id)}"></span><span class="n" title="${esc(m.name)} · ${esc(m.platform)}">${esc(m.name)}</span><button class="x" data-act="unschedule" data-id="${esc(m.id)}" aria-label="移除 ${esc(m.name)}">×</button></li>`
        )
        .join("")}</ul>
      <button class="add" data-act="quick-add" data-date="${key}">＋ 抽一台排這天</button>
    </div>`;
  }
  $("#week-grid").innerHTML = html;

  const pool = REQUIRED.filter((m) => statusOf(m.id) !== "done" && !peek(m.id).date).slice(0, 400);
  $("#assign-machine").innerHTML =
    '<option value="">選一台未完成的必練靶機…</option>' +
    pool.map((m) => `<option value="${esc(m.id)}">${esc(m.name)} — ${esc(OS_LABEL[m.category] || m.category)}</option>`).join("") +
    '<optgroup label="其他 OSCP 清單">' +
    trackPool("OSCP")
      .filter((m) => !m.required && statusOf(m.id) !== "done" && !peek(m.id).date)
      .map((m) => `<option value="${esc(m.id)}">${esc(m.name)} — ${esc(shortPlatform(m.platform))}</option>`)
      .join("") +
    "</optgroup>";
  if (!$("#assign-date").value) $("#assign-date").value = today();
}

/* ---------- render root ---------- */

function render() {
  renderOverview();
  if (ui.view === "machines") renderMachines();
  if (ui.view === "draw") renderPool();
  if (ui.view === "schedule") renderSchedule();
}

function setView(name) {
  ui.view = name;
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("is-active", v.id === "view-" + name));
  document.querySelectorAll("#nav button").forEach((b) => b.setAttribute("aria-current", String(b.dataset.view === name)));
  render();
  window.scrollTo({ top: 0 });
}

/* ---------- events ---------- */

document.addEventListener("click", (ev) => {
  const nav = ev.target.closest("#nav button");
  if (nav) return setView(nav.dataset.view);

  const goto = ev.target.closest("[data-goto]");
  if (goto) return setView(goto.dataset.goto);

  const seg = ev.target.closest("#track-seg button");
  if (seg) {
    ui.track = seg.dataset.track;
    document.querySelectorAll("#track-seg button").forEach((b) => b.setAttribute("aria-pressed", String(b === seg)));
    renderPlatformFilter();
    return renderMachines();
  }

  const scope = ev.target.closest("#draw-scope button");
  if (scope) {
    ui.scope = scope.dataset.scope;
    document.querySelectorAll("#draw-scope button").forEach((b) => b.setAttribute("aria-pressed", String(b === scope)));
    return renderPool();
  }

  if (ev.target.closest("#btn-draw")) return draw();

  if (ev.target.closest("#btn-start")) {
    const e = entry(ui.current);
    e.status = "active";
    save();
    render();
    return toast("已標為進行中");
  }

  if (ev.target.closest("#btn-plan-today")) {
    entry(ui.current).date = today();
    save();
    render();
    return toast("已排到今天");
  }

  if (ev.target.closest("#clear-history")) {
    state.history = [];
    save();
    return renderPool();
  }

  const unsched = ev.target.closest('[data-act="unschedule"]');
  if (unsched) {
    entry(unsched.dataset.id).date = null;
    save();
    return render();
  }

  const plan = ev.target.closest('[data-act="plan"]');
  if (plan) {
    entry(plan.dataset.id).date = today();
    save();
    render();
    return toast(`${BY_ID.get(plan.dataset.id).name} 已排到今天`);
  }

  const quick = ev.target.closest('[data-act="quick-add"]');
  if (quick) {
    const pool = REQUIRED.filter((m) => statusOf(m.id) !== "done" && !peek(m.id).date);
    if (!pool.length) return toast("必練靶機都排完了");
    const pick = pool[Math.floor(Math.random() * pool.length)];
    entry(pick.id).date = quick.dataset.date;
    save();
    render();
    return toast(`${pick.name} 已排入 ${quick.dataset.date.slice(5)}`);
  }

  const row = ev.target.closest(".row");
  if (row && !ev.target.closest("select")) {
    ui.open = ui.open === row.dataset.id ? null : row.dataset.id;
    return renderMachines();
  }
});

document.addEventListener("change", (ev) => {
  const t = ev.target;
  const act = t.dataset.act;
  if (act === "status") {
    const e = entry(t.dataset.id);
    e.status = t.value;
    e.doneAt = t.value === "done" ? e.doneAt || new Date().toISOString() : null;
    save();
    return render();
  }
  if (act === "minutes") { entry(t.dataset.id).minutes = Number(t.value) || 0; return save(); }
  if (act === "rating") { entry(t.dataset.id).rating = t.value; return save(); }
  if (act === "url") { entry(t.dataset.id).url = t.value; return save(); }
  if (act === "date") { entry(t.dataset.id).date = t.value || null; save(); return render(); }

  if (t.id === "f-platform") { ui.platform = t.value; return renderMachines(); }
  if (t.id === "f-os") { ui.os = t.value; return renderMachines(); }
  if (t.id === "f-status") { ui.status = t.value; return renderMachines(); }
  if (t.id === "f-required") { ui.requiredOnly = t.checked; return renderMachines(); }
  if (t.id === "draw-os") { ui.drawOs = t.value; return renderPool(); }
  if (t.id === "draw-skip-done") { ui.skipDone = t.checked; return renderPool(); }
});

document.addEventListener("input", (ev) => {
  if (ev.target.id === "q") { ui.q = ev.target.value; renderMachines(); }
  if (ev.target.dataset.act === "notes") { entry(ev.target.dataset.id).notes = ev.target.value; save(); }
});

document.addEventListener("keydown", (ev) => {
  if (ev.key === "/" && !/input|textarea|select/i.test(ev.target.tagName)) {
    ev.preventDefault();
    setView("machines");
    $("#q").focus();
  }
});

$("#week-prev").onclick = () => { ui.weekOffset -= 1; renderSchedule(); };
$("#week-next").onclick = () => { ui.weekOffset += 1; renderSchedule(); };
$("#week-today").onclick = () => { ui.weekOffset = 0; renderSchedule(); };

$("#assign-add").onclick = () => {
  const id = $("#assign-machine").value;
  const date = $("#assign-date").value;
  if (!id || !date) return toast("先選日期跟靶機");
  entry(id).date = date;
  save();
  render();
  toast(`${BY_ID.get(id).name} 已排入 ${date.slice(5)}`);
};

$("#assign-auto").onclick = () => {
  const start = weekStart(ui.weekOffset);
  const pool = REQUIRED.filter((m) => statusOf(m.id) !== "done" && !peek(m.id).date);
  if (!pool.length) return toast("沒有可排的必練靶機");
  const picks = [];
  const copy = [...pool];
  while (picks.length < 5 && copy.length) picks.push(copy.splice(Math.floor(Math.random() * copy.length), 1)[0]);
  picks.forEach((m, i) => {
    const d = new Date(start);
    d.setDate(d.getDate() + [0, 1, 3, 4, 5][i % 5]);
    entry(m.id).date = iso(d);
  });
  save();
  render();
  toast(`排入 ${picks.length} 台`);
};

$("#btn-export").onclick = () => {
  $("#io").value = JSON.stringify(state, null, 2);
  toast("已匯出，可自行複製保存");
};

$("#btn-copy").onclick = async () => {
  const text = JSON.stringify(state, null, 2);
  $("#io").value = text;
  try {
    await navigator.clipboard.writeText(text);
    toast("已複製到剪貼簿");
  } catch (err) {
    $("#io").select();
    toast("瀏覽器擋下剪貼簿，請手動複製");
  }
};

$("#btn-import").onclick = () => {
  try {
    const parsed = JSON.parse($("#io").value);
    if (!parsed || typeof parsed.entries !== "object") throw new Error("格式不符");
    state = { entries: parsed.entries, history: parsed.history || [], theme: state.theme };
    save();
    render();
    toast("匯入完成");
  } catch (err) {
    toast("匯入失敗：不是有效的備份 JSON");
  }
};

$("#btn-reset").onclick = () => {
  if (!confirm("清除所有狀態、筆記與排程？此動作無法復原。")) return;
  state = { entries: {}, history: [], theme: state.theme };
  save();
  render();
  toast("已清空");
};

$("#theme-toggle").onclick = () => {
  const now = document.documentElement.getAttribute("data-theme");
  const dark = now ? now === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
  state.theme = dark ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", state.theme);
  save();
};

/* ---------- boot ---------- */

load();
renderPlatformFilter();
render();
$("#storage-line").textContent = `目前紀錄 ${Object.keys(state.entries).length} 台靶機的狀態，存在 localStorage 的 ${KEY}。`;
$("#source-line").textContent = `OSCP 分頁 ${trackPool("OSCP").length} 台 · Red Teaming 分頁 ${trackPool("Red Team").length} 台 · 必練 ${REQUIRED.length} 台`;
