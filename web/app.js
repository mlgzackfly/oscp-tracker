const KEY = "oscp-track-v1";
const MACHINES = window.OSCP_DATA.machines;
const BY_ID = new Map(MACHINES.map((m) => [m.id, m]));
const STATUSES = { todo: "未開始", active: "進行中", done: "已完成", stuck: "卡關" };
const OS_LABEL = { Linux: "Linux", Windows: "Windows", "Active Directory and Networks": "AD / 網段" };
const REQUIRED = MACHINES.filter((m) => m.required);

let state = { entries: {}, history: [], theme: null };
let ui = { view: "overview", track: "OSCP", q: "", platform: "", os: "", status: "", level: "", sort: "list", requiredOnly: false, open: null, scope: "required", drawOs: "", drawLevel: "", skipDone: true, weekOffset: 0, current: null };

const LEVEL_ORDER = ["100", "200", "300", "400"];
const LEVEL_NAME = { 100: "Fundamental", 200: "Intermediate", 300: "Advanced", 400: "Insane" };

function levelMeter(m) {
  if (!m.level) return '<span class="lvl unknown" title="OffSec portal 沒有這台的難度資料">—</span>';
  const filled = LEVEL_ORDER.indexOf(m.level) + 1;
  const bars = LEVEL_ORDER.map((_, i) => `<i class="${i < filled ? "on" : ""}"></i>`).join("");
  return `<span class="lvl" data-lv="${m.level}" title="OffSec 難度：${m.difficulty}"><span class="bars">${bars}</span>${m.difficulty}</span>`;
}

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
  scheduleBackup();
}

const META_KEY = "oscp-track-meta";
const FS_SUPPORTED = typeof window.showSaveFilePicker === "function";
const HOSTED = typeof window.claude?.use === "function";

let downloadsApi = null;

function canDownload() {
  return HOSTED ? !!downloadsApi : true;
}

let meta = { lastBackupAt: null, fileName: null };
let fileHandle = null;
let backupState = FS_SUPPORTED ? "none" : "unsupported";
let backupTimer = null;

function loadMeta() {
  try {
    const raw = localStorage.getItem(META_KEY);
    if (raw) meta = Object.assign(meta, JSON.parse(raw));
  } catch (err) {
    /* 沒有備份紀錄就用預設值 */
  }
}

function saveMeta() {
  try {
    localStorage.setItem(META_KEY, JSON.stringify(meta));
  } catch (err) {
    /* 存不進去不影響主要流程 */
  }
}

function idb(mode, fn) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("oscp-track", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("kv");
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const tx = req.result.transaction("kv", mode);
      const op = fn(tx.objectStore("kv"));
      op.onsuccess = () => resolve(op.result);
      op.onerror = () => reject(op.error);
    };
  });
}

const HANDLE_KEY = "backup-handle";

async function linkBackup() {
  try {
    fileHandle = await window.showSaveFilePicker({
      suggestedName: "oscp-tracker-backup.json",
      types: [{ description: "JSON 備份", accept: { "application/json": [".json"] } }],
    });
  } catch (err) {
    return;
  }
  meta.fileName = fileHandle.name;
  saveMeta();
  try {
    await idb("readwrite", (store) => store.put(fileHandle, HANDLE_KEY));
  } catch (err) {
    /* 記不住 handle 只影響下次開啟，這次仍能寫 */
  }
  if (await writeBackup(true)) toast("已接上備份檔，之後每次變更都會自動寫入");
}

async function writeBackup(manual) {
  if (!fileHandle) return false;
  try {
    let perm = await fileHandle.queryPermission({ mode: "readwrite" });
    if (perm !== "granted") {
      if (!manual) {
        backupState = "needs-permission";
        renderBackup();
        return false;
      }
      perm = await fileHandle.requestPermission({ mode: "readwrite" });
      if (perm !== "granted") return false;
    }
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(state, null, 2));
    await writable.close();
    meta.lastBackupAt = new Date().toISOString();
    saveMeta();
    backupState = "linked";
    renderBackup();
    return true;
  } catch (err) {
    backupState = "needs-permission";
    renderBackup();
    return false;
  }
}

function scheduleBackup() {
  if (!fileHandle || backupState === "needs-permission") return;
  clearTimeout(backupTimer);
  backupTimer = setTimeout(() => writeBackup(false), 1500);
}

async function unlinkBackup() {
  fileHandle = null;
  meta.fileName = null;
  meta.lastBackupAt = meta.lastBackupAt;
  saveMeta();
  try {
    await idb("readwrite", (store) => store.delete(HANDLE_KEY));
  } catch (err) {
    /* handle 本來就不在 */
  }
  backupState = "none";
  renderBackup();
  toast("已解除連結，檔案本身沒有被刪除");
}

function applyBackup(text) {
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed.entries !== "object") throw new Error("格式不符");
  state = { entries: parsed.entries, history: parsed.history || [], theme: state.theme };
  save();
  render();
  renderBackup();
}

async function readFromLinked() {
  if (!fileHandle) return;
  try {
    const perm = await fileHandle.queryPermission({ mode: "read" });
    if (perm !== "granted" && (await fileHandle.requestPermission({ mode: "read" })) !== "granted") return;
    const file = await fileHandle.getFile();
    applyBackup(await file.text());
    toast("已從備份檔讀回進度");
  } catch (err) {
    toast("讀取失敗：備份檔可能被移動或不是有效的 JSON");
  }
}

function markBackedUp() {
  meta.lastBackupAt = new Date().toISOString();
  saveMeta();
  renderBackup();
}

async function downloadBackup() {
  const text = JSON.stringify(state, null, 2);
  const filename = `oscp-tracker-${today()}.json`;

  if (HOSTED) {
    if (!downloadsApi) return toast("這裡無法存檔，改用「複製 JSON」");
    try {
      await downloadsApi.save({ filename, data: text });
      markBackedUp();
      toast("備份檔已儲存");
    } catch (err) {
      if (err && err.code === "declined") return;
      toast("存檔沒有完成，改用「複製 JSON」");
    }
    return;
  }

  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  markBackedUp();
  toast("已下載備份檔");
}

function daysSince(isoDate) {
  if (!isoDate) return null;
  return Math.floor((Date.now() - new Date(isoDate).getTime()) / 86400000);
}

function lastBackupText() {
  const days = daysSince(meta.lastBackupAt);
  if (days === null) return "還沒備份過";
  if (days === 0) return "今天備份過";
  return `上次備份 ${days} 天前`;
}

function renderBackup() {
  const panel = $("#backup-panel");
  if (!panel) return;
  const blocks = {
    unsupported: () => `
      <div class="backup-head"><span class="badge off">無法自動備份</span><h3>這個環境不能接本機檔案</h3></div>
      <p class="backup-body">${
        HOSTED
          ? "自動寫入本機檔案只在你自己電腦上開啟的版本可用。在這裡請養成手動備份的習慣，或下載單檔版放到電腦上跑。"
          : "Chrome、Edge 這類 Chromium 瀏覽器可以把進度接到一個本機檔案自動寫入；你目前的瀏覽器只能手動備份。"
      }建議每週備份一次，放進雲端同步資料夾。</p>
      <div class="data-actions">${
        canDownload()
          ? '<button class="btn primary" id="btn-download-2">下載備份檔</button>'
          : '<button class="btn primary" id="btn-copy-2">複製 JSON 保存</button>'
      }</div>`,
    none: () => `
      <div class="backup-head"><span class="badge warn">尚未啟用</span><h3>把進度接到一個本機檔案</h3></div>
      <p class="backup-body">選一個位置存備份檔——放在 <b>iCloud Drive、Dropbox、Google Drive</b> 這類會同步的資料夾裡最好。
        接上之後每次改動都會自動寫入，換電腦時在新機器上接同一個檔案再讀回來就行。</p>
      <div class="data-actions"><button class="btn primary" id="btn-link-backup">選擇備份檔位置</button></div>`,
    linked: () => `
      <div class="backup-head"><span class="badge ok">自動備份中</span><h3>每次改動都會寫入</h3></div>
      <div class="backup-file">📄 ${esc(meta.fileName || "備份檔")} · ${lastBackupText()}</div>
      <div class="data-actions">
        <button class="btn" id="btn-backup-now">立即備份</button>
        <button class="btn" id="btn-read-backup">從這個檔案讀回</button>
        <button class="btn ghost" id="btn-unlink">解除連結</button>
      </div>`,
    "needs-permission": () => `
      <div class="backup-head"><span class="badge warn">等待授權</span><h3>重開瀏覽器後要再點一次</h3></div>
      <p class="backup-body">瀏覽器基於安全考量，重新開啟後需要你確認一次才能繼續寫入
        <b>${esc(meta.fileName || "備份檔")}</b>。在那之前的改動只存在這個瀏覽器裡。</p>
      <div class="data-actions">
        <button class="btn primary" id="btn-reauth">重新授權並備份</button>
        <button class="btn ghost" id="btn-unlink">解除連結</button>
      </div>`,
  };
  panel.innerHTML = blocks[backupState]();

  const dl = $("#btn-download");
  if (dl) dl.hidden = !canDownload();

  const line = $("#storage-line");
  if (line) line.textContent = `已記錄 ${Object.keys(state.entries).length} 台 · ${lastBackupText()}`;

  const nudge = $("#backup-nudge");
  if (!nudge) return;
  const days = daysSince(meta.lastBackupAt);
  const hasWork = Object.keys(state.entries).length > 0;
  const stale = hasWork && backupState !== "linked" && (days === null || days >= 7);
  nudge.innerHTML = stale
    ? `<div class="nudge"><span>⚠</span><span><b>進度只存在這個瀏覽器。</b>${
        days === null ? "還沒備份過" : `上次備份是 ${days} 天前`
      }——清快取或換電腦就會不見。</span><button class="btn sm" data-goto="data">去備份</button></div>`
    : "";
}

async function initBackup() {
  if (!FS_SUPPORTED) return renderBackup();
  try {
    const handle = await idb("readonly", (store) => store.get(HANDLE_KEY));
    if (handle) {
      fileHandle = handle;
      meta.fileName = handle.name;
      backupState = (await handle.queryPermission({ mode: "readwrite" })) === "granted" ? "linked" : "needs-permission";
    }
  } catch (err) {
    backupState = "none";
  }
  renderBackup();
  if (backupState === "linked") writeBackup(false);
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

let openPop = null;

function closePop() {
  if (!openPop) return;
  openPop.pop.remove();
  openPop.host.classList.remove("is-open");
  const btn = openPop.host.querySelector("button[aria-haspopup]");
  if (btn) btn.setAttribute("aria-expanded", "false");
  openPop = null;
}

function placePop(host, pop) {
  const box = host.getBoundingClientRect();
  if (box.bottom + 320 > window.innerHeight && box.top > 340) pop.classList.add("up");
  if (box.left + 320 > window.innerWidth) pop.classList.add("right");
}

function popList(items, current) {
  let html = "";
  let group = null;
  items.forEach((o, i) => {
    if (o.group && o.group !== group) {
      group = o.group;
      html += `<li class="group" role="presentation">${esc(group)}</li>`;
    }
    html += `<li role="option" data-i="${i}" data-value="${esc(o.value)}" aria-selected="${o.value === current}">
      <span>${o.html || esc(o.label)}</span>${o.hint ? `<span class="hint">${esc(o.hint)}</span>` : ""}</li>`;
  });
  return html || '<li class="sel-empty" role="presentation">沒有符合的項目</li>';
}

function createSelect(id, config) {
  const host = $("#" + id);
  const self = {
    options: config.options || [],
    value: config.value || "",
    placeholder: config.placeholder || "請選擇",
    searchable: config.searchable || false,
    defaultValue: config.defaultValue || "",
    onChange: config.onChange || (() => {}),
  };

  host.innerHTML = `<button type="button" aria-haspopup="listbox" aria-expanded="false"><span class="val"></span><span class="caret">▼</span></button>`;
  const btn = host.querySelector("button");

  function label() {
    const hit = self.options.find((o) => o.value === self.value);
    return hit && hit.value !== "" ? hit.label : self.placeholder;
  }

  function paint() {
    btn.querySelector(".val").textContent = label();
    host.classList.toggle("is-set", self.value !== self.defaultValue);
    btn.title = label();
  }

  function open() {
    closePop();
    const pop = document.createElement("div");
    pop.className = "sel-pop";
    pop.innerHTML =
      (self.searchable ? '<input class="sel-search" type="search" placeholder="輸入以過濾…">' : "") +
      `<ul class="sel-list" role="listbox">${popList(self.options, self.value)}</ul>`;
    host.appendChild(pop);
    host.classList.add("is-open");
    btn.setAttribute("aria-expanded", "true");
    placePop(host, pop);
    openPop = { host, pop, select: self, filtered: self.options };

    const search = pop.querySelector(".sel-search");
    if (search) {
      search.focus();
      search.oninput = () => {
        const q = search.value.trim().toLowerCase();
        const items = q ? self.options.filter((o) => o.label.toLowerCase().includes(q)) : self.options;
        openPop.filtered = items;
        pop.querySelector(".sel-list").innerHTML = popList(items, self.value);
      };
    }
    const sel = pop.querySelector('[aria-selected="true"]');
    if (sel) sel.scrollIntoView({ block: "nearest" });
  }

  btn.onclick = (ev) => {
    ev.stopPropagation();
    if (openPop && openPop.host === host) closePop();
    else open();
  };

  host.addEventListener("click", (ev) => {
    const li = ev.target.closest("li[role=option]");
    if (!li) return;
    ev.stopPropagation();
    self.value = li.dataset.value;
    closePop();
    paint();
    self.onChange(self.value);
  });

  host.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") return closePop();
    if (!openPop || openPop.host !== host) {
      if (ev.key === "ArrowDown" || ev.key === "Enter") { ev.preventDefault(); open(); }
      return;
    }
    const items = [...host.querySelectorAll("li[role=option]")];
    if (!items.length) return;
    let idx = items.findIndex((li) => li.classList.contains("cursor"));
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      idx = ev.key === "ArrowDown" ? Math.min(idx + 1, items.length - 1) : Math.max(idx - 1, 0);
      items.forEach((li) => li.classList.remove("cursor"));
      items[idx].classList.add("cursor");
      items[idx].scrollIntoView({ block: "nearest" });
    } else if (ev.key === "Enter" && idx >= 0) {
      ev.preventDefault();
      items[idx].click();
    }
  });

  self.setOptions = (options) => { self.options = options; paint(); };
  self.set = (value) => { self.value = value; paint(); };
  paint();
  return self;
}

function statusMenu(pill, id) {
  closePop();
  const host = pill.parentElement;
  const pop = document.createElement("div");
  pop.className = "sel-pop right";
  const current = statusOf(id);
  pop.innerHTML = `<ul class="sel-list" role="listbox">${popList(
    Object.entries(STATUSES).map(([value, label]) => ({
      value,
      label,
      html: `<span class="dot ${value}" style="display:inline-block;margin-right:7px;vertical-align:middle"></span>${label}`,
    })),
    current
  )}</ul>`;
  host.appendChild(pop);
  host.classList.add("is-open");
  placePop(host, pop);
  openPop = { host, pop };
  pop.addEventListener("click", (ev) => {
    const li = ev.target.closest("li[role=option]");
    if (!li) return;
    ev.stopPropagation();
    const next = li.dataset.value;
    closePop();
    setStatus(id, next);
  });
}

function setStatus(id, value) {
  const e = entry(id);
  e.status = value;
  e.doneAt = value === "done" ? e.doneAt || new Date().toISOString() : null;
  save();
  render();
}

document.addEventListener("click", (ev) => {
  if (openPop && !ev.target.closest(".sel-pop") && !ev.target.closest(".is-open")) closePop();
});
window.addEventListener("resize", closePop);

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
    if (ui.level && m.level !== ui.level) return false;
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
  if (ui.drawLevel) pool = pool.filter((m) => m.level === ui.drawLevel);
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
  const byLevel = {};
  REQUIRED.forEach((m) => {
    const key = m.level || "?";
    byLevel[key] = byLevel[key] || { done: 0, total: 0 };
    byLevel[key].total += 1;
    if (statusOf(m.id) === "done") byLevel[key].done += 1;
  });
  $("#pg-levels").innerHTML = LEVEL_ORDER.concat("?")
    .filter((lv) => byLevel[lv])
    .map((lv) => {
      const v = byLevel[lv];
      if (lv === "?") return `<span class="lvl-item lvl unknown" title="OffSec portal 已無此靶機">未列於 portal <b class="mono">${v.done}/${v.total}</b></span>`;
      const meter = levelMeter({ level: lv, difficulty: LEVEL_NAME[lv] });
      return `<span class="lvl-item">${meter} <b class="mono">${v.done}/${v.total}</b></span>`;
    })
    .join("");

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
  if (m.section) tags.push(`<span class="chip">${esc(m.section)}</span>`);
  if (m.note) tags.push(`<span class="chip${/harder/i.test(m.note) ? " warn" : ""}">${esc(m.note)}</span>`);
  if (e.date) tags.push(`<span class="chip mono" title="已排程">${esc(e.date.slice(5))}</span>`);
  if (e.rating) tags.push(`<span class="chip" title="難度自評">${esc(e.rating)}</span>`);
  return `<div class="row state-${e.status}${ui.open === m.id ? " is-open" : ""}" data-id="${esc(m.id)}">
      <span class="dot ${e.status}"></span>
      <span class="title"><span class="n">${esc(m.name)}</span></span>
      <span class="os-cell chip">${esc(OS_LABEL[m.category] || m.category)}</span>
      <span class="lvl-cell">${levelMeter(m)}</span>
      <span class="tags">${tags.join("")}</span>
      <button class="quick" data-act="quick-done" data-id="${esc(m.id)}" title="${e.status === "done" ? "取消完成" : "標為已完成"}" aria-label="${e.status === "done" ? "取消完成" : "標為已完成"}">✓</button>
      <span class="status-cell sel">
        <button class="status-pill" data-status="${e.status}" data-act="status" data-id="${esc(m.id)}" aria-haspopup="listbox">
          ${STATUSES[e.status]}<span class="caret">▼</span>
        </button>
      </span>
    </div>${ui.open === m.id ? detailHtml(m) : ""}`;
}

function detailHtml(m) {
  const e = peek(m.id);
  return `<div class="detail" data-detail="${esc(m.id)}">
    <div class="detail-grid">
      <div class="field"><label>耗時（分鐘）</label><input type="number" min="0" step="15" value="${e.minutes || ""}" data-act="minutes" data-id="${esc(m.id)}"></div>
      <div class="field wide"><label>難度自評（跟 OffSec 給的分級比起來如何）</label>
        <div class="rating-row">
          ${["很簡單", "偏易", "剛好", "偏難", "打不動"]
            .map((r) => `<button type="button" data-act="rating" data-id="${esc(m.id)}" data-value="${r}" aria-pressed="${e.rating === r}">${r}</button>`)
            .join("")}
          ${e.rating ? `<button type="button" class="btn ghost sm" data-act="rating" data-id="${esc(m.id)}" data-value="">清除</button>` : ""}
        </div>
      </div>
      <div class="field"><label>排定日期</label><input type="date" value="${e.date || ""}" data-act="date" data-id="${esc(m.id)}"></div>
      <div class="field"><label>Writeup 連結</label><input type="url" placeholder="https://" value="${esc(e.url || "")}" data-act="url" data-id="${esc(m.id)}"></div>
      <div class="field wide"><label>筆記（攻擊面、卡在哪、學到什麼）</label><textarea data-act="notes" data-id="${esc(m.id)}" placeholder="例：80/tcp 有舊版 CMS，作者路徑遍歷拿到憑證；提權靠 sudo 誤設。">${esc(e.notes || "")}</textarea></div>
    </div>
  </div>`;
}

const STATUS_ORDER = { active: 0, stuck: 1, todo: 2, done: 3 };

function sortList(items) {
  const base = items.map((m, i) => ({ m, i }));
  const cmp = {
    list: (a, b) => a.i - b.i,
    name: (a, b) => a.m.name.localeCompare(b.m.name),
    level: (a, b) => (a.m.level || "999").localeCompare(b.m.level || "999") || a.i - b.i,
    status: (a, b) => STATUS_ORDER[statusOf(a.m.id)] - STATUS_ORDER[statusOf(b.m.id)] || a.i - b.i,
  }[ui.sort];
  return base.sort(cmp).map((x) => x.m);
}

function renderChips() {
  const chips = [];
  if (ui.q) chips.push(["q", `搜尋「${ui.q}」`]);
  if (ui.requiredOnly) chips.push(["requiredOnly", "只看必練"]);
  if (ui.platform) chips.push(["platform", shortPlatform(ui.platform)]);
  if (ui.os) chips.push(["os", OS_LABEL[ui.os] || ui.os]);
  if (ui.level) chips.push(["level", LEVEL_NAME[ui.level]]);
  if (ui.status) chips.push(["status", STATUSES[ui.status]]);
  $("#filter-chips").innerHTML =
    chips.map(([key, text]) => `<button data-act="drop-filter" data-key="${key}">${esc(text)}<span class="x">×</span></button>`).join("") +
    (chips.length > 1 ? '<button class="clear-all" data-act="drop-filter" data-key="all">全部清除</button>' : "");
}

function renderMachines() {
  const list = filtered();
  const done = list.filter((m) => statusOf(m.id) === "done").length;
  const scope = ui.track === "all" ? "全部清單" : ui.track + " 清單";
  $("#machines-eyebrow").textContent = `${scope} · ${trackPool(ui.track).length} 台`;
  $("#result-line").textContent = `${list.length} 台 · 完成 ${done} · ${pct(done, list.length)}%`;
  $("#list-bar").style.width = pct(done, list.length) + "%";
  renderChips();

  if (!list.length) {
    $("#table").innerHTML = '<div class="empty" style="padding:28px;text-align:center">沒有符合條件的靶機，放寬篩選試試。</div>';
    return;
  }

  const groups = new Map();
  list.forEach((m) => {
    const key = `${m.track}|${m.platform}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  });

  const head = `<div class="table-head"><span></span><span>靶機</span><span>系統</span><span>難度</span><span>標記</span><span></span><span style="text-align:right">狀態</span></div>`;
  let html = head;
  groups.forEach((items, key) => {
    const [track, platform] = key.split("|");
    const gdone = items.filter((m) => statusOf(m.id) === "done").length;
    html += `<div class="group-head">
        <span class="gname">${esc(shortPlatform(platform))}</span>
        ${items[0].required ? '<span class="chip required">必練</span>' : `<span class="gsec">${esc(track)}</span>`}
        <span class="gbar bar"><span class="${gdone === items.length ? "done" : ""}" style="width:${pct(gdone, items.length)}%"></span></span>
        <span class="gnum">${gdone}/${items.length}</span>
      </div>`;
    html += sortList(items).map(rowHtml).join("");
  });
  $("#table").innerHTML = html;
}

const SEL = {};

function platformOptions() {
  const counts = new Map();
  trackPool(ui.track).forEach((m) => counts.set(m.platform, (counts.get(m.platform) || 0) + 1));
  return [{ value: "", label: "全部平台" }].concat(
    [...counts.entries()].map(([p, n]) => ({ value: p, label: shortPlatform(p), hint: String(n) }))
  );
}

function renderPlatformFilter() {
  if (!trackPool(ui.track).some((m) => m.platform === ui.platform)) ui.platform = "";
  SEL.platform.setOptions(platformOptions());
  SEL.platform.set(ui.platform);
}

function initSelects() {
  const osOptions = (all) => [{ value: "", label: all }].concat(
    Object.entries(OS_LABEL).map(([value, label]) => ({ value, label }))
  );
  const levelOptions = (all, levels) => [{ value: "", label: all }].concat(
    levels.map((lv) => ({ value: lv, label: LEVEL_NAME[lv] }))
  );

  SEL.platform = createSelect("f-platform", {
    options: platformOptions(),
    placeholder: "全部平台",
    searchable: true,
    onChange: (v) => { ui.platform = v; renderMachines(); },
  });
  SEL.os = createSelect("f-os", {
    options: osOptions("全部系統"),
    placeholder: "全部系統",
    onChange: (v) => { ui.os = v; renderMachines(); },
  });
  SEL.level = createSelect("f-level", {
    options: levelOptions("全部難度", ["100", "200", "300", "400"]),
    placeholder: "全部難度",
    onChange: (v) => { ui.level = v; renderMachines(); },
  });
  SEL.status = createSelect("f-status", {
    options: [{ value: "", label: "全部狀態" }].concat(
      Object.entries(STATUSES).map(([value, label]) => ({ value, label }))
    ),
    placeholder: "全部狀態",
    onChange: (v) => { ui.status = v; renderMachines(); },
  });
  SEL.sort = createSelect("f-sort", {
    options: [
      { value: "list", label: "清單順序" },
      { value: "name", label: "依名稱" },
      { value: "level", label: "依難度" },
      { value: "status", label: "依狀態" },
    ],
    value: "list",
    defaultValue: "list",
    placeholder: "清單順序",
    onChange: (v) => { ui.sort = v; renderMachines(); },
  });
  SEL.drawOs = createSelect("draw-os", {
    options: osOptions("不限系統"),
    placeholder: "不限系統",
    onChange: (v) => { ui.drawOs = v; renderPool(); },
  });
  SEL.drawLevel = createSelect("draw-level", {
    options: levelOptions("不限難度", ["100", "200", "300"]),
    placeholder: "不限難度",
    onChange: (v) => { ui.drawLevel = v; renderPool(); },
  });
  SEL.assignMachine = createSelect("assign-machine", {
    options: [],
    placeholder: "選一台靶機…",
    searchable: true,
    onChange: () => {},
  });
}

/* ---------- draw ---------- */

function renderPool() {
  const pool = drawPool();
  const byOs = {};
  const byLevel = {};
  pool.forEach((m) => {
    byOs[m.category] = (byOs[m.category] || 0) + 1;
    byLevel[m.level || "?"] = (byLevel[m.level || "?"] || 0) + 1;
  });
  $("#pool-note").innerHTML =
    `<div class="pool-stat"><span>候選總數</span><b>${pool.length}</b></div>` +
    Object.entries(byOs).map(([os, n]) => `<div class="pool-stat"><span>${esc(OS_LABEL[os] || os)}</span><b>${n}</b></div>`).join("") +
    LEVEL_ORDER.concat("?")
      .filter((lv) => byLevel[lv])
      .map((lv) => `<div class="pool-stat"><span>${lv === "?" ? "難度未知" : LEVEL_NAME[lv]}</span><b>${byLevel[lv]}</b></div>`)
      .join("");
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
    m.level ? `<span class="chip">${levelMeter(m)}</span>` : "",
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

  const free = (m) => statusOf(m.id) !== "done" && !peek(m.id).date;
  const options = REQUIRED.filter(free)
    .map((m) => ({ value: m.id, label: m.name, hint: m.difficulty || "", group: "必練 PG Practice" }))
    .concat(
      trackPool("OSCP")
        .filter((m) => !m.required && free(m))
        .map((m) => ({ value: m.id, label: m.name, hint: shortPlatform(m.platform), group: "其他 OSCP 清單" }))
    );
  SEL.assignMachine.setOptions(options);
  if (!$("#assign-date").value) $("#assign-date").value = today();
}

/* ---------- render root ---------- */

function render() {
  renderOverview();
  renderBackup();
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
    closePop();
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

  const quickAdd = ev.target.closest('[data-act="quick-add"]');
  if (quickAdd) {
    const pool = REQUIRED.filter((m) => statusOf(m.id) !== "done" && !peek(m.id).date);
    if (!pool.length) return toast("必練靶機都排完了");
    const pick = pool[Math.floor(Math.random() * pool.length)];
    entry(pick.id).date = quickAdd.dataset.date;
    save();
    render();
    return toast(`${pick.name} 已排入 ${quickAdd.dataset.date.slice(5)}`);
  }

  const pill = ev.target.closest('[data-act="status"]');
  if (pill) {
    ev.stopPropagation();
    if (openPop && openPop.host === pill.parentElement) return closePop();
    return statusMenu(pill, pill.dataset.id);
  }

  const quick = ev.target.closest('[data-act="quick-done"]');
  if (quick) {
    ev.stopPropagation();
    return setStatus(quick.dataset.id, statusOf(quick.dataset.id) === "done" ? "todo" : "done");
  }

  const rate = ev.target.closest('[data-act="rating"]');
  if (rate) {
    ev.stopPropagation();
    entry(rate.dataset.id).rating = rate.dataset.value;
    save();
    return renderMachines();
  }

  const drop = ev.target.closest('[data-act="drop-filter"]');
  if (drop) {
    const key = drop.dataset.key;
    const reset = { q: "", platform: "", os: "", level: "", status: "", requiredOnly: false };
    if (key === "all") Object.assign(ui, reset);
    else ui[key] = reset[key];
    $("#q").value = ui.q;
    $("#f-required").checked = ui.requiredOnly;
    ["platform", "os", "level", "status"].forEach((k) => SEL[k].set(ui[k]));
    return renderMachines();
  }

  if (ev.target.closest("#btn-link-backup")) return linkBackup();
  if (ev.target.closest("#btn-backup-now") || ev.target.closest("#btn-reauth")) {
    return writeBackup(true).then((ok) => ok && toast("已寫入備份檔"));
  }
  if (ev.target.closest("#btn-read-backup")) return readFromLinked();
  if (ev.target.closest("#btn-unlink")) return unlinkBackup();
  if (ev.target.closest("#btn-download-2")) return downloadBackup();
  if (ev.target.closest("#btn-copy-2")) return $("#btn-copy").click();

  const row = ev.target.closest(".row");
  if (row && !ev.target.closest("button")) {
    ui.open = ui.open === row.dataset.id ? null : row.dataset.id;
    return renderMachines();
  }
});

document.addEventListener("change", (ev) => {
  const t = ev.target;
  const act = t.dataset.act;
  if (act === "minutes") { entry(t.dataset.id).minutes = Number(t.value) || 0; return save(); }
  if (act === "url") { entry(t.dataset.id).url = t.value; return save(); }
  if (act === "date") { entry(t.dataset.id).date = t.value || null; save(); return render(); }

  if (t.id === "f-required") { ui.requiredOnly = t.checked; return renderMachines(); }
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
  const id = SEL.assignMachine.value;
  const date = $("#assign-date").value;
  if (!id || !date) return toast("先選日期跟靶機");
  entry(id).date = date;
  SEL.assignMachine.set("");
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

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

function isDark() {
  const attr = document.documentElement.getAttribute("data-theme");
  return attr ? attr === "dark" : darkQuery.matches;
}

function paintTheme() {
  const dark = isDark();
  $("#theme-icon").textContent = dark ? "☀" : "☾";
  $("#theme-label").textContent = dark ? "淺色模式" : "深色模式";
  $("#theme-toggle").title = dark ? "切換到淺色模式" : "切換到深色模式";
}

$("#theme-toggle").onclick = () => {
  state.theme = isDark() ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", state.theme);
  paintTheme();
  save();
};

darkQuery.addEventListener("change", () => {
  if (!state.theme) paintTheme();
});

$("#rail-focus").onclick = () => {
  Object.assign(ui, { track: "OSCP", q: "", platform: "", os: "", level: "", status: "", requiredOnly: true });
  $("#q").value = "";
  $("#f-required").checked = true;
  ["platform", "os", "level", "status"].forEach((k) => SEL[k].set(""));
  document.querySelectorAll("#track-seg button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.track === "OSCP")));
  renderPlatformFilter();
  setView("machines");
};

$("#btn-download").onclick = downloadBackup;

$("#btn-restore-file").onclick = () => $("#file-input").click();

$("#file-input").onchange = async (ev) => {
  const file = ev.target.files[0];
  if (!file) return;
  try {
    applyBackup(await file.text());
    toast(`已從 ${file.name} 還原`);
  } catch (err) {
    toast("還原失敗：不是有效的備份 JSON");
  }
  ev.target.value = "";
};

/* ---------- boot ---------- */

load();
loadMeta();
initSelects();
renderPlatformFilter();
paintTheme();
render();
initBackup();
if (HOSTED) {
  window.claude
    .use("downloads")
    .then((api) => {
      downloadsApi = api;
      renderBackup();
    })
    .catch(() => renderBackup());
}
$("#storage-line").textContent = `已記錄 ${Object.keys(state.entries).length} 台 · ${lastBackupText()}`;
$("#source-line").textContent = `OSCP 分頁 ${trackPool("OSCP").length} 台 · Red Teaming 分頁 ${trackPool("Red Team").length} 台 · 必練 ${REQUIRED.length} 台`;
