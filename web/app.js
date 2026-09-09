const KEY = "oscp-track-v1";
const MACHINES = window.OSCP_DATA.machines;
const BY_ID = new Map(MACHINES.map((m) => [m.id, m]));
const STATUSES = { todo: "未開始", active: "進行中", done: "已完成", stuck: "卡關" };
const OS_LABEL = { Linux: "Linux", Windows: "Windows", "Active Directory and Networks": "AD / 網段" };
const REQUIRED = MACHINES.filter((m) => m.required);

let state = { entries: {}, history: [], theme: null, plan: {}, updatedAt: null };
let ui = { editingPlan: false, noteId: null, noteQ: "", noteMode: "write", view: "overview", track: "OSCP", q: "", platform: "", os: "", status: "", level: "", sort: "list", requiredOnly: false, open: null, scope: "required", drawOs: "", drawLevel: "", skipDone: true, weekOffset: 0, current: null };

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
      state = {
        entries: parsed.entries || {},
        history: parsed.history || [],
        theme: parsed.theme || null,
        plan: parsed.plan || {},
        updatedAt: parsed.updatedAt || null,
      };
    }
  } catch (err) {
    console.warn("無法讀取本機進度", err);
  }
  if (state.theme) document.documentElement.setAttribute("data-theme", state.theme);
}

function save() {
  state.updatedAt = new Date().toISOString();
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch (err) {
    toast("瀏覽器拒絕儲存，進度只留在這個分頁");
  }
  scheduleBackup();
  scheduleDb();
  scheduleServer();
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

let dbDoc = null;
let dbState = "off";
let dbTimer = null;

const SERVER_PROFILE = (new URLSearchParams(location.search).get("profile") || "default").slice(0, 64);
let serverSync = false;
let serverState = "off";
let serverTimer = null;

async function serverApi(method, body) {
  const opts = { method };
  if (body) {
    opts.headers = { "Content-Type": "application/json" };
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(`api/state?profile=${encodeURIComponent(SERVER_PROFILE)}`, opts);
  if (!r.ok) throw new Error("http " + r.status);
  return r.json();
}

async function pushServer() {
  if (!serverSync) return;
  try {
    await serverApi("PUT", syncPayload());
    serverState = "on";
  } catch (err) {
    serverState = "error";
  }
  renderSync();
}

function scheduleServer() {
  if (!serverSync) return;
  clearTimeout(serverTimer);
  serverTimer = setTimeout(pushServer, 1500);
}

async function pollServer() {
  if (!serverSync) return;
  try {
    const { state: remote } = await serverApi("GET");
    if (remote) applyRemote(remote);
    serverState = "on";
  } catch (err) {
    serverState = "error";
  }
  renderSync();
}

async function initServer() {
  if (HOSTED) return; // Claude Artifact 版由 db capability 處理
  try {
    const h = await fetch("api/health");
    if (!h.ok) return;
    const info = await h.json();
    if (!info.db) return;
  } catch (err) {
    return; // 沒有後端（單檔或純靜態）就維持本機模式
  }
  serverSync = true;
  serverState = "syncing";
  renderSync();
  // 先讀回伺服器、逐台合併，再把本機獨有／較新的推回去（順序同檔案備份，不會覆蓋）
  try {
    const { state: remote } = await serverApi("GET");
    if (remote) applyRemote(remote);
    await pushServer();
  } catch (err) {
    serverState = "error";
  }
  renderSync();
  setInterval(pollServer, 30000);
}

function syncPayload() {
  return {
    entries: state.entries,
    history: state.history,
    plan: state.plan || {},
    updatedAt: state.updatedAt || new Date().toISOString(),
  };
}

function applyRemote(remote) {
  if (!remote) return;
  let changed = false;
  Object.entries(remote.entries || {}).forEach(([id, r]) => {
    const local = state.entries[id];
    if (!local || (r.updatedAt || "") > (local.updatedAt || "")) {
      state.entries[id] = r;
      changed = true;
    }
  });
  if ((remote.updatedAt || "") > (state.updatedAt || "")) {
    state.plan = remote.plan || state.plan;
    state.history = remote.history || state.history;
    state.updatedAt = remote.updatedAt;
    changed = true;
  }
  if (!changed) return;
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch (err) {
    /* 同步下來的資料寫不進本機快取也還能用 */
  }
  render();
}

async function pushDb() {
  if (!dbDoc) return;
  const payload = syncPayload();
  if (JSON.stringify(payload).length > 200000) {
    dbState = "too-big";
    return renderSync();
  }
  try {
    await dbDoc.set(payload);
    dbState = "on";
  } catch (err) {
    dbState = err && err.code === "invalid_argument" ? "readonly" : "error";
  }
  renderSync();
}

function scheduleDb() {
  if (!dbDoc) return;
  clearTimeout(dbTimer);
  dbTimer = setTimeout(pushDb, 2000);
}

async function initDb() {
  if (!HOSTED) return;
  const api = await window.claude.use("db");
  if (!api) return renderSync();
  dbDoc = api.doc("progress/state");
  dbState = "syncing";
  renderSync();
  try {
    const snap = await dbDoc.get();
    if (snap.exists) {
      applyRemote(snap.data());
      // 合併後把本機獨有／較新的進度推回雲端，不必等下次編輯
      await pushDb();
    } else {
      await pushDb();
    }
    dbState = "on";
  } catch (err) {
    dbState = "error";
  }
  dbDoc.onSnapshot(
    (snap) => snap.exists && applyRemote(snap.data()),
    () => {
      dbState = "error";
      renderSync();
    }
  );
  renderSync();
}

function renderSync() {
  const panel = $("#sync-panel");
  if (!panel) return;
  if (!HOSTED && !serverSync) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;

  if (serverSync) {
    const serverBlocks = {
      syncing: `<div class="backup-head"><span class="badge warn">連線中</span><h3>正在對伺服器資料庫</h3></div>`,
      on: `<div class="backup-head"><span class="badge ok">資料庫同步中</span><h3>存在伺服器，換裝置與瀏覽器都同步</h3></div>
        <p class="backup-body">進度存在這台伺服器的 SQLite 裡（設定檔 <code>profile=${esc(SERVER_PROFILE)}</code>），
          清瀏覽器快取、換瀏覽器、換裝置都不影響。逐台比對時間戳合併，多台裝置各打各的不會互相蓋掉，每 30 秒對一次。</p>`,
      error: `<div class="backup-head"><span class="badge warn">同步中斷</span><h3>暫時連不上伺服器</h3></div>
        <p class="backup-body">改動仍存在這個瀏覽器裡，連線恢復後會自己補上。真的不放心就先手動備份一份。</p>`,
    };
    panel.innerHTML = serverBlocks[serverState] || serverBlocks.syncing;
    return;
  }

  const blocks = {
    off: `<div class="backup-head"><span class="badge off">未啟用</span><h3>這個版本沒有雲端同步</h3></div>
      <p class="backup-body">進度只留在這個瀏覽器，記得手動備份。</p>`,
    syncing: `<div class="backup-head"><span class="badge warn">連線中</span><h3>正在對雲端資料庫</h3></div>`,
    on: `<div class="backup-head"><span class="badge ok">雲端同步中</span><h3>換裝置也看得到同一份進度</h3></div>
      <p class="backup-body">進度存在這個 artifact 專屬的資料庫裡，用你的帳號在任何裝置打開這個連結都會同步，
        清瀏覽器快取也不會影響。逐台合併，兩台裝置各打各的不會互相蓋掉。</p>`,
    readonly: `<div class="backup-head"><span class="badge off">唯讀</span><h3>這份進度屬於建立者</h3></div>
      <p class="backup-body">你看到的是別人的紀錄，你自己的操作只會留在這個瀏覽器裡，不會蓋掉對方的資料。
        想自己用一份，把專案 clone 下來或下載單檔版在本機開。</p>`,
    error: `<div class="backup-head"><span class="badge warn">同步中斷</span><h3>暫時連不上雲端</h3></div>
      <p class="backup-body">改動仍存在這個瀏覽器裡，連線恢復後會自己補上。真的不放心就先手動備份一份。</p>`,
    "too-big": `<div class="backup-head"><span class="badge warn">超過單筆上限</span><h3>資料太大，雲端停止同步</h3></div>
      <p class="backup-body">筆記累積超過 200 KB 了，超出單一文件上限。請改用檔案備份，或精簡一些筆記。</p>`,
  };
  panel.innerHTML = blocks[dbState] || blocks.off;
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

async function saveFile(filename, text, mime) {
  if (HOSTED) {
    if (!downloadsApi) {
      toast("這裡無法存檔，改用「複製 JSON」");
      return false;
    }
    try {
      await downloadsApi.save({ filename, data: text });
      return true;
    } catch (err) {
      if (!err || err.code !== "declined") toast("存檔沒有完成");
      return false;
    }
  }
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}

async function downloadBackup() {
  const ok = await saveFile(`oscp-tracker-${today()}.json`, JSON.stringify(state, null, 2), "application/json");
  if (!ok) return;
  markBackedUp();
  toast("備份檔已儲存");
}

function buildMarkdown() {
  const out = [`# OSCP 練習紀錄`, "", `匯出於 ${today()}`, ""];

  const target = planDate("exam") || planDate("end");
  if (target) {
    const left = Math.round((target - new Date(today() + "T00:00:00")) / DAY);
    out.push("## 期程", "");
    if (state.plan.start) out.push(`- 開始準備：${state.plan.start}`);
    if (state.plan.exam) out.push(`- 考試日期：${state.plan.exam}${planDate("exam") ? `（${left >= 0 ? "還剩 " + left : "已過 " + -left} 天）` : ""}`);
    if (state.plan.end) out.push(`- 方案到期：${state.plan.end}`);
    out.push("");
  }

  const reqDone = REQUIRED.filter((m) => statusOf(m.id) === "done").length;
  const minutes = Object.values(state.entries).reduce((a, e) => a + (Number(e.minutes) || 0), 0);
  out.push("## 進度", "", `- Proving Grounds Practice（必練）：${reqDone} / ${REQUIRED.length}（${pct(reqDone, REQUIRED.length)}%）`);
  const groups = new Map();
  trackPool("OSCP").forEach((m) => {
    if (m.required) return;
    if (!groups.has(m.platform)) groups.set(m.platform, { done: 0, total: 0 });
    const g = groups.get(m.platform);
    g.total += 1;
    if (statusOf(m.id) === "done") g.done += 1;
  });
  groups.forEach((g, name) => {
    if (g.done) out.push(`- ${shortPlatform(name)}：${g.done} / ${g.total}`);
  });
  out.push(`- 累積投入：${(minutes / 60).toFixed(1)} 小時`, "");

  const counts = {};
  Object.values(state.entries).forEach((e) => (e.phases || []).forEach((id) => (counts[id] = (counts[id] || 0) + 1)));
  if (Object.keys(counts).length) {
    out.push("## 卡關分布", "");
    PHASES.filter((p) => counts[p.id])
      .sort((a, b) => counts[b.id] - counts[a.id])
      .forEach((p) => out.push(`- ${p.label}：${counts[p.id]} 台`));
    out.push("");
  }

  const worked = MACHINES.filter((m) => {
    const e = peek(m.id);
    return e.status !== "todo" || e.notes || (e.phases || []).length;
  });
  if (worked.length) {
    out.push("## 靶機紀錄", "");
    worked.forEach((m) => {
      const e = peek(m.id);
      const facts = [STATUSES[e.status]];
      if (e.notes && !e.noteDone) facts.push("筆記草稿");
      if (e.doneAt) facts.push(e.doneAt.slice(0, 10));
      if (e.minutes) facts.push(`${e.minutes} 分鐘`);
      if (e.rating) facts.push(`自評 ${e.rating}`);
      const head = [shortPlatform(m.platform), OS_LABEL[m.category] || m.category, m.difficulty].filter(Boolean).join(" · ");
      out.push(`### ${m.name}`, "", `${head}`, "", facts.join(" · "));
      const phases = (e.phases || []).map((id) => (PHASES.find((p) => p.id === id) || {}).label).filter(Boolean);
      if (phases.length) out.push("", `卡關：${phases.join("、")}`);
      if (e.url) out.push("", `Writeup: ${e.url}`);
      if (e.notes) out.push("", e.notes.trim());
      out.push("");
    });
  }

  out.push("---", "", "由 OSCP 靶機作戰台匯出。清單與難度僅供參考，不代表考試內容。");
  return out.join("\n");
}

async function exportMarkdown() {
  const ok = await saveFile(`oscp-notes-${today()}.md`, buildMarkdown(), "text/markdown");
  if (ok) toast("筆記已匯出為 Markdown");
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
  const md = $("#btn-markdown");
  if (md) md.hidden = !canDownload();

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
  // 先把檔案讀回來逐台合併（檔案較新的一方會贏），再寫回。
  // 順序很重要：絕不能在讀取前就寫入，否則被清空的 localStorage 會蓋掉好的備份。
  if (backupState === "linked") {
    try {
      const perm = await fileHandle.queryPermission({ mode: "read" });
      if (perm === "granted") {
        const file = await fileHandle.getFile();
        const text = (await file.text()).trim();
        if (text) applyRemote(JSON.parse(text));
      }
    } catch (err) {
      /* 檔案讀不到或壞掉就跳過合併，本機資料仍在 */
    }
    writeBackup(false);
  }
}

function entry(id) {
  if (!state.entries[id]) state.entries[id] = { status: "todo", minutes: 0, rating: "", notes: "", doneAt: null, date: null, url: "" };
  const e = state.entries[id];
  e.updatedAt = new Date().toISOString();
  return e;
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

const PHASES = [
  { id: "recon", label: "枚舉偵察", hint: "掃完了但找不到攻擊面" },
  { id: "foothold", label: "初始立足點", hint: "看到漏洞卻打不進去" },
  { id: "privesc", label: "提權", hint: "進去了但升不上去" },
  { id: "lateral", label: "橫向移動 / AD", hint: "網段內跳不過去" },
  { id: "report", label: "紀錄與報告", hint: "截圖跟步驟沒留好" },
];

const NOTE_TEMPLATE = `## 枚舉
- 開放埠：
- 服務／版本：
- 值得追的線索：

## 立足點
- 漏洞：
- 利用方式：

## 提權
- 線索：
- 手法：

## 學到什麼
- `;

function weekKey(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return iso(x);
}

function weeklyStats(weeks = 12) {
  const buckets = new Map();
  for (let i = weeks - 1; i >= 0; i -= 1) {
    buckets.set(iso(weekStart(-i)), { done: 0, minutes: 0 });
  }
  Object.entries(state.entries).forEach(([id, e]) => {
    if (!e.doneAt) return;
    const key = weekKey(new Date(e.doneAt));
    const bucket = buckets.get(key);
    if (!bucket) return;
    bucket.done += 1;
    bucket.minutes += Number(e.minutes) || 0;
  });
  return [...buckets.entries()].map(([week, v]) => ({ week, ...v }));
}

function goalPerWeek() {
  const target = planDate("exam") || planDate("end");
  if (!target) return null;
  const left = (target - new Date(today() + "T00:00:00")) / DAY;
  if (left <= 0) return null;
  const remaining = REQUIRED.length - REQUIRED.filter((m) => statusOf(m.id) === "done").length;
  if (!remaining) return null;
  return remaining / Math.max(left / 7, 0.15);
}

function renderTrend() {
  const host = $("#trend");
  if (!host) return;
  const data = weeklyStats();
  const total = data.reduce((a, d) => a + d.done, 0);
  const scope = $("#trend-scope");

  if (!total) {
    if (scope) scope.textContent = "";
    host.innerHTML = '<p class="empty">還沒有完成紀錄。打完第一台之後，這裡會顯示每週的節奏。</p>';
    return;
  }

  const goal = goalPerWeek();
  const peak = Math.max(...data.map((d) => d.done), goal || 0, 1);
  const top = Math.ceil(peak);
  const W = 480;
  const H = 132;
  const padL = 22;
  const padB = 16;
  const plotW = W - padL;
  const plotH = H - padB;
  const step = plotW / data.length;
  const barW = Math.min(step - 6, 26);
  const y = (v) => plotH - (v / top) * (plotH - 6);

  const minutes = data.reduce((a, d) => a + d.minutes, 0);
  if (scope) scope.textContent = `近 12 週 · ${total} 台 · ${(minutes / 60).toFixed(1)} 小時`;

  const gridLines = [0, top / 2, top]
    .map((v) => `<line class="grid" x1="${padL}" x2="${W}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"></line>
      <text x="${padL - 6}" y="${(y(v) + 3).toFixed(1)}" text-anchor="end">${Math.round(v)}</text>`)
    .join("");

  const bars = data
    .map((d, i) => {
      const x = padL + i * step + (step - barW) / 2;
      const h = plotH - y(d.done);
      const label = i === data.length - 1 && d.done ? `<text class="value" x="${(x + barW / 2).toFixed(1)}" y="${(y(d.done) - 5).toFixed(1)}" text-anchor="middle">${d.done}</text>` : "";
      return `${
        d.done
          ? `<rect class="bar-mark" x="${x.toFixed(1)}" y="${y(d.done).toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="4"></rect>
             <rect class="bar-mark" x="${x.toFixed(1)}" y="${(plotH - Math.min(h, 4)).toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.min(h, 4).toFixed(1)}"></rect>`
          : ""
      }<rect class="bar-hit" data-i="${i}" x="${(padL + i * step).toFixed(1)}" y="0" width="${step.toFixed(1)}" height="${plotH}"></rect>${label}`;
    })
    .join("");

  const goalLine = goal
    ? `<line class="goal" x1="${padL}" x2="${W}" y1="${y(goal).toFixed(1)}" y2="${y(goal).toFixed(1)}"></line>`
    : "";

  const ticks = data
    .map((d, i) =>
      i % 3 === 0 || i === data.length - 1
        ? `<text x="${(padL + i * step + step / 2).toFixed(1)}" y="${H - 3}" text-anchor="middle">${d.week.slice(5)}</text>`
        : ""
    )
    .join("");

  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="近 12 週每週完成靶機數">
      ${gridLines}${goalLine}${bars}${ticks}
    </svg>
    <div class="chart-tip" id="trend-tip"></div>
    <div class="chart-legend">
      <span><i></i>每週完成</span>
      ${goal ? `<span><i class="goal"></i>考前打完必練所需（${goal.toFixed(1)} 台）</span>` : ""}
    </div>`;

  const tip = $("#trend-tip");
  host.querySelectorAll(".bar-hit").forEach((hit) => {
    hit.addEventListener("mouseenter", (ev) => {
      const d = data[Number(ev.target.dataset.i)];
      const box = host.getBoundingClientRect();
      const r = ev.target.getBoundingClientRect();
      tip.innerHTML = `${d.week.slice(5)} 那週<br><b>${d.done}</b> 台 · <b>${(d.minutes / 60).toFixed(1)}</b> 小時`;
      tip.style.left = `${r.left - box.left + r.width / 2}px`;
      tip.style.top = `${r.bottom - box.top - 8}px`;
      tip.classList.add("show");
    });
    hit.addEventListener("mouseleave", () => tip.classList.remove("show"));
  });
}

function renderPhases() {
  const host = $("#phase-breakdown");
  if (!host) return;
  const counts = {};
  let tagged = 0;
  Object.values(state.entries).forEach((e) => {
    if (!Array.isArray(e.phases) || !e.phases.length) return;
    tagged += 1;
    e.phases.forEach((id) => (counts[id] = (counts[id] || 0) + 1));
  });

  const scope = $("#phase-scope");
  if (!tagged) {
    if (scope) scope.textContent = "";
    host.innerHTML = `<p class="empty">展開任一台靶機，標記你卡在哪個階段。累積幾台之後，這裡會告訴你弱點集中在哪。</p>`;
    return;
  }
  if (scope) scope.textContent = `${tagged} 台有標記`;

  const peak = Math.max(...Object.values(counts));
  host.innerHTML = `<div class="phase-list">${PHASES.filter((p) => counts[p.id])
    .sort((a, b) => counts[b.id] - counts[a.id])
    .map(
      (p) => `<div class="phase-row">
        <span class="pname">${esc(p.label)}</span>
        <span class="pnum">${counts[p.id]} 台</span>
        <span class="pbar"><span style="width:${(counts[p.id] / peak) * 100}%"></span></span>
        <small>${esc(p.hint)}</small>
      </div>`
    )
    .join("")}</div>`;
}

const TIMER_KEY = "oscp-track-timer";
const MAX_SESSION = 12 * 3600 * 1000;

let timer = null;
let tick = null;

function loadTimer() {
  try {
    const raw = localStorage.getItem(TIMER_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed || !BY_ID.has(parsed.id)) return;
    if (Date.now() - parsed.startedAt > MAX_SESSION) {
      localStorage.removeItem(TIMER_KEY);
      return;
    }
    timer = parsed;
  } catch (err) {
    /* 壞掉的計時紀錄直接忽略 */
  }
}

function saveTimer() {
  try {
    if (timer) localStorage.setItem(TIMER_KEY, JSON.stringify(timer));
    else localStorage.removeItem(TIMER_KEY);
  } catch (err) {
    /* 計時只是輔助，存不進去不影響 */
  }
}

function elapsedText() {
  const secs = Math.floor((Date.now() - timer.startedAt) / 1000);
  return [Math.floor(secs / 3600), Math.floor(secs / 60) % 60, secs % 60]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
}

function startTick() {
  clearInterval(tick);
  tick = setInterval(() => {
    const clock = $("#timer-clock");
    if (!timer) return clearInterval(tick);
    if (clock) clock.textContent = elapsedText();
    if (Date.now() - timer.startedAt > MAX_SESSION) stopTimer();
  }, 1000);
}

function startTimer(id) {
  if (timer) stopTimer(true);
  timer = { id, startedAt: Date.now() };
  saveTimer();
  const e = entry(id);
  if (e.status === "todo") e.status = "active";
  save();
  render();
  startTick();
  toast(`${BY_ID.get(id).name} 開始計時`);
}

function stopTimer(quiet) {
  if (!timer) return;
  const minutes = Math.max(Math.round((Date.now() - timer.startedAt) / 60000), 1);
  const name = BY_ID.get(timer.id).name;
  const e = entry(timer.id);
  e.minutes = (Number(e.minutes) || 0) + minutes;
  timer = null;
  saveTimer();
  clearInterval(tick);
  save();
  render();
  if (!quiet) toast(`${name} 記錄 ${minutes} 分鐘`);
}

function renderTimer() {
  const host = $("#timer-slot");
  if (!host) return;
  if (!timer) {
    host.innerHTML = "";
    return;
  }
  host.innerHTML = `<div class="timer">
    <span class="eyebrow">計時中</span>
    <span class="tname">${esc(BY_ID.get(timer.id).name)}</span>
    <b id="timer-clock">${elapsedText()}</b>
    <button class="btn sm" data-act="stop-timer">停止並記錄</button>
  </div>`;
}

const DAY = 86400000;
const DOW = ["日", "一", "二", "三", "四", "五", "六"];

function planDate(key) {
  const v = state.plan && state.plan[key];
  if (!v) return null;
  const d = new Date(v + "T00:00:00");
  return isNaN(d) ? null : d;
}

function fmtDate(d) {
  return `${iso(d).slice(5)}（${DOW[d.getDay()]}）`;
}

function daysBetween(a, b) {
  return Math.round((b.setHours ? new Date(iso(b) + "T00:00:00") : b) - new Date(iso(a) + "T00:00:00")) / DAY;
}

function renderPlan() {
  const host = $("#plan-bar");
  if (!host) return;

  if (ui.editingPlan) {
    host.innerHTML = `<div class="panel">
      <div class="panel-head"><h3>備考期程</h3><span class="result-line">留白的欄位會被忽略</span></div>
      <div class="plan-form">
        <div class="field"><label>開始準備</label><input type="date" id="plan-start" value="${esc(state.plan.start || "")}"></div>
        <div class="field"><label>考試日期</label><input type="date" id="plan-exam" value="${esc(state.plan.exam || "")}"></div>
        <div class="field"><label>方案／實驗室到期</label><input type="date" id="plan-end" value="${esc(state.plan.end || "")}"></div>
        <div class="actions">
          <button class="btn" data-act="cancel-plan">取消</button>
          ${state.plan.start || state.plan.exam || state.plan.end ? '<button class="btn ghost" data-act="clear-plan">清除</button>' : ""}
          <button class="btn primary" data-act="save-plan">儲存</button>
        </div>
      </div>
      <p class="result-line" style="margin:10px 0 0">
        考試日跟到期日可以不一樣——有些方案一年內能考兩次，到期日是實驗室時數用完的那天。
      </p>
    </div>`;
    return;
  }

  const start = planDate("start");
  const exam = planDate("exam");
  const end = planDate("end");
  const target = exam || end;

  if (!target) {
    host.innerHTML = `<div class="plan is-empty">
      <div>
        <span class="eyebrow">備考期程</span>
        <p>設定開始、考試與方案到期日，就能看到時間走得多快、練習跟不跟得上。</p>
      </div>
      <button class="btn primary" data-act="edit-plan">設定期程</button>
    </div>`;
    return;
  }

  const now = new Date();
  const todayD = new Date(iso(now) + "T00:00:00");
  const left = Math.round((target - todayD) / DAY);
  const from = start || new Date(Math.min(todayD, target - 60 * DAY));
  const span = Math.max((target - from) / DAY, 1);
  const elapsed = Math.min(Math.max((todayD - from) / DAY, 0), span);
  const timePct = Math.round((elapsed / span) * 100);

  const reqDone = REQUIRED.filter((m) => statusOf(m.id) === "done").length;
  const donePct = pct(reqDone, REQUIRED.length);
  const gap = donePct - timePct;
  const remaining = REQUIRED.length - reqDone;
  const weeks = Math.max(left / 7, 0.15);
  const perWeek = (remaining / weeks).toFixed(1);

  const rightEdge = end && exam && end > exam ? end : target;
  const examLeft = exam ? Math.min(Math.max(((exam - from) / DAY / ((rightEdge - from) / DAY)) * 100, 0), 100) : null;
  const todayLeft = Math.min(Math.max(((todayD - from) / DAY / ((rightEdge - from) / DAY)) * 100, 0), 100);

  const overdue = left < 0;
  const paceClass = gap < -8 ? "behind" : gap > 8 ? "ahead" : "";
  const paceText = overdue ? "期程已過" : gap < -8 ? `落後 ${Math.abs(gap)}%` : gap > 8 ? `超前 ${gap}%` : "跟得上";

  host.innerHTML = `<div class="plan">
    <div class="countdown${overdue ? " over" : ""}">
      <span class="eyebrow">${exam ? "距離考試" : "距離到期"}</span>
      <b>${overdue ? `D+${Math.abs(left)}` : `D-${left}`}</b>
      <span class="when">${fmtDate(target)}</span>
    </div>

    <div class="timeline">
      <div class="track">
        <span class="elapsed" style="width:${todayLeft}%"></span>
        <span class="filled" style="width:${(Math.min(donePct, 100) * (examLeft === null ? 100 : examLeft)) / 100}%"></span>
        ${examLeft !== null ? `<span class="marker" style="left:${examLeft}%" title="考試日"></span>` : ""}
        <span class="marker today" style="left:${todayLeft}%" title="今天"></span>
      </div>
      <div class="ticks">
        <span>${start ? "開始 " + iso(start).slice(5) : "—"}</span>
        <span>時間 ${timePct}% · 必練 ${donePct}%</span>
        <span>${end ? "到期 " + iso(end).slice(5) : exam ? "考試 " + iso(exam).slice(5) : ""}</span>
      </div>
    </div>

    <div class="pace">
      <span class="eyebrow">節奏</span>
      <b class="${paceClass}">${paceText}</b>
      <small>${
        overdue
          ? `必練還剩 ${remaining} 台`
          : remaining
            ? `考前打完必練，每週要 ${perWeek} 台`
            : "必練已經全部完成"
      }</small>
    </div>

    <button class="btn ghost sm" data-act="edit-plan">調整</button>
  </div>`;
}

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
      <div class="field"><label>耗時（分鐘）</label>
        <input type="number" min="0" step="15" value="${e.minutes || ""}" data-act="minutes" data-id="${esc(m.id)}">
        ${
          timer && timer.id === m.id
            ? '<button type="button" class="btn sm" data-act="stop-timer" style="margin-top:4px;align-self:flex-start">停止計時 · ' + elapsedText() + "</button>"
            : `<button type="button" class="btn sm" data-act="start-timer" data-id="${esc(m.id)}" style="margin-top:4px;align-self:flex-start">開始計時</button>`
        }
      </div>
      <div class="field"><label>排定日期</label><input type="date" value="${e.date || ""}" data-act="date" data-id="${esc(m.id)}"></div>
      <div class="field"><label>Writeup 連結</label><input type="url" placeholder="https://" value="${esc(e.url || "")}" data-act="url" data-id="${esc(m.id)}"></div>
      <div class="field wide"><label>難度自評（跟 OffSec 給的分級比起來如何）</label>
        <div class="rating-row">
          ${["很簡單", "偏易", "剛好", "偏難", "打不動"]
            .map((r) => `<button type="button" data-act="rating" data-id="${esc(m.id)}" data-value="${r}" aria-pressed="${e.rating === r}">${r}</button>`)
            .join("")}
          ${e.rating ? `<button type="button" class="btn ghost sm" data-act="rating" data-id="${esc(m.id)}" data-value="">清除</button>` : ""}
        </div>
      </div>
      <div class="field wide"><label>卡在哪（可複選，累積起來就是弱點分布）</label>
        <div class="phase-picks">
          ${PHASES.map(
            (ph) =>
              `<button type="button" data-act="phase" data-id="${esc(m.id)}" data-value="${ph.id}" title="${esc(ph.hint)}" aria-pressed="${(e.phases || []).includes(ph.id)}">${esc(ph.label)}</button>`
          ).join("")}
        </div>
      </div>
      <div class="field wide">
        <label>筆記</label>
        <div style="display:flex;gap:10px;align-items:center">
          <span class="result-line" style="flex:1">${noteSummary(e)}</span>
          <button type="button" class="btn sm" data-act="edit-note" data-id="${esc(m.id)}">${e.notes ? "編輯筆記 →" : "寫筆記 →"}</button>
        </div>
      </div>
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
  SEL.noteAdd = createSelect("note-add", {
    options: MACHINES.map((m) => ({
      value: m.id,
      label: m.name,
      hint: shortPlatform(m.platform),
      group: m.track === "OSCP" ? "OSCP 清單" : "Red Team 清單",
    })),
    placeholder: "挑一台開始寫…",
    searchable: true,
    onChange: (v) => {
      if (!v) return;
      ui.noteId = v;
      ui.noteMode = "write";
      SEL.noteAdd.set("");
      renderNotes();
    },
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

/* ---------- notes ---------- */

function mdInline(text) {
  return esc(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
}

function renderMarkdown(src) {
  if (!src || !src.trim()) return '<p class="md-empty">還沒有內容。切到「寫」開始記錄。</p>';
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const html = [];
  let list = null;
  let inCode = false;
  let code = [];

  const closeList = () => {
    if (list) {
      html.push(`</${list}>`);
      list = null;
    }
  };

  lines.forEach((raw) => {
    if (raw.trim().startsWith("```")) {
      if (inCode) {
        html.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`);
        code = [];
        inCode = false;
      } else {
        closeList();
        inCode = true;
      }
      return;
    }
    if (inCode) {
      code.push(raw);
      return;
    }

    const line = raw.trim();
    if (!line) {
      closeList();
      return;
    }
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      closeList();
      html.push(`<h${heading[1].length}>${mdInline(heading[2])}</h${heading[1].length}>`);
      return;
    }
    if (line === "---" || line === "***") {
      closeList();
      html.push("<hr>");
      return;
    }
    if (line.startsWith(">")) {
      closeList();
      html.push(`<blockquote>${mdInline(line.replace(/^>\s?/, ""))}</blockquote>`);
      return;
    }
    const ol = line.match(/^\d+\.\s+(.*)$/);
    const ul = line.match(/^[-*]\s+(.*)$/);
    if (ol || ul) {
      const want = ol ? "ol" : "ul";
      if (list !== want) {
        closeList();
        html.push(`<${want}>`);
        list = want;
      }
      html.push(`<li>${mdInline((ol || ul)[1])}</li>`);
      return;
    }
    closeList();
    html.push(`<p>${mdInline(line)}</p>`);
  });
  if (inCode) html.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`);
  closeList();
  return html.join("");
}

function noteFirstLine(notes) {
  const line = (notes || "").split("\n").find((l) => l.trim() && !l.startsWith("#"));
  return line ? line.trim() : "";
}

function noteSummary(e) {
  if (!e.notes) return "還沒寫筆記";
  const first = noteFirstLine(e.notes) || e.notes.length + " 字";
  const prefix = e.noteDone ? "✓ " : "草稿 · ";
  return prefix + esc(first.slice(0, 50));
}

function noteMachines() {
  const q = ui.noteQ.trim().toLowerCase();
  return MACHINES.filter((m) => {
    const e = peek(m.id);
    if (!e.notes) return false;
    if (!q) return true;
    return m.name.toLowerCase().includes(q) || e.notes.toLowerCase().includes(q);
  }).sort((a, b) => {
    const ea = peek(a.id);
    const eb = peek(b.id);
    if (!!eb.noteDone !== !!ea.noteDone) return ea.noteDone ? 1 : -1;
    return (eb.updatedAt || "").localeCompare(ea.updatedAt || "");
  });
}

function noteList() {
  const list = noteMachines();
  if (ui.noteId && BY_ID.has(ui.noteId) && !list.some((m) => m.id === ui.noteId)) {
    list.unshift(BY_ID.get(ui.noteId));
  }
  return list;
}

function renderNotes() {
  const list = noteList();
  const listHost = $("#note-list");
  const editHost = $("#note-editor");
  if (!listHost || !editHost) return;

  if (ui.noteId && !BY_ID.has(ui.noteId)) ui.noteId = null;
  if (!ui.noteId && list.length) ui.noteId = list[0].id;

  listHost.innerHTML = list.length
    ? list
        .map((m) => {
          const e = peek(m.id);
          const first = (e.notes || "").split("\n").find((l) => l.trim() && !l.startsWith("#"));
          return `<button class="note-item" data-act="pick-note" data-id="${esc(m.id)}" aria-current="${ui.noteId === m.id}">
            <span class="nhead">
              <span class="dot ${e.status}${e.notes ? (e.noteDone ? " note-done" : " note-draft") : ""}" title="${e.notes ? (e.noteDone ? "筆記完成 · " : "草稿 · ") : ""}${STATUSES[e.status]}"></span>
              <span class="nname">${esc(m.name)}</span>
              ${e.notes && e.noteDone ? '<span class="nflag done">✓</span>' : e.notes ? '<span class="nflag draft">草稿</span>' : ""}
              <span class="nmeta">${e.minutes ? e.minutes + "m" : ""}</span>
            </span>
            <span class="npeek${first ? "" : " blank"}">${first ? esc(first.trim().slice(0, 40)) : "還沒寫筆記"}</span>
          </button>`;
        })
        .join("")
    : `<p class="empty" style="padding:20px;text-align:center">還沒有筆記。用右上角的下拉挑一台靶機開始寫。</p>`;

  const m = ui.noteId ? BY_ID.get(ui.noteId) : null;
  if (!m) {
    editHost.innerHTML = `<div class="note-blank">
      <b>選一台靶機開始寫</b>
      <span>筆記寫的是方法論，不是通關步驟。下次遇到同類服務，你會想看到什麼？</span>
    </div>`;
    return;
  }

  const e = peek(m.id);
  editHost.innerHTML = `
    <div class="nhead">
      <h3>${esc(m.name)}</h3>
      <span class="facts">
        <span class="chip">${esc(shortPlatform(m.platform))}</span>
        <span class="chip">${esc(OS_LABEL[m.category] || m.category)}</span>
        ${m.level ? `<span class="chip">${levelMeter(m)}</span>` : ""}
        ${e.doneAt ? `<span class="chip mono">${esc(e.doneAt.slice(0, 10))}</span>` : ""}
        ${e.minutes ? `<span class="chip mono">${e.minutes} 分</span>` : ""}
      </span>
    </div>

    <div class="phase-picks">
      ${PHASES.map(
        (ph) =>
          `<button type="button" data-act="phase" data-id="${esc(m.id)}" data-value="${ph.id}" title="${esc(ph.hint)}" aria-pressed="${(e.phases || []).includes(ph.id)}">${esc(ph.label)}</button>`
      ).join("")}
    </div>

    <div class="toolrow">
      <div class="seg">
        <button data-act="note-mode" data-mode="write" aria-pressed="${ui.noteMode === "write"}">寫</button>
        <button data-act="note-mode" data-mode="preview" aria-pressed="${ui.noteMode === "preview"}">預覽</button>
      </div>
      ${ui.noteMode === "write" && !e.notes ? `<button class="btn sm" data-act="template" data-id="${esc(m.id)}">插入模板</button>` : ""}
      <span class="right">
        <span class="result-line">${e.notes ? e.notes.length + " 字" : "支援 Markdown"}</span>
        ${e.notes ? `<button class="btn sm${e.noteDone ? " done" : ""}" data-act="note-done" data-id="${esc(m.id)}" aria-pressed="${!!e.noteDone}">${e.noteDone ? "已完成 ✓" : "標記完成"}</button>` : ""}
        ${e.notes ? `<button class="btn sm" data-act="delete-note" data-id="${esc(m.id)}" style="color:var(--stuck)">刪除</button>` : ""}
      </span>
    </div>

    ${
      ui.noteMode === "preview"
        ? `<div class="note-md">${renderMarkdown(e.notes)}</div>`
        : `<textarea data-act="notes" data-id="${esc(m.id)}" placeholder="這台的攻擊面、卡在哪、下次怎麼更快。支援 Markdown。">${esc(e.notes || "")}</textarea>`
    }

    <div class="toolrow">
      <input type="url" placeholder="Writeup 連結 https://" value="${esc(e.url || "")}" data-act="url" data-id="${esc(m.id)}"
        style="flex:1 1 200px;min-width:160px;border:1px solid var(--line-strong);border-radius:6px;padding:6px 9px;background:var(--surface)">
      <button class="btn sm right" data-act="open-in-list" data-id="${esc(m.id)}">在清單中開啟</button>
    </div>`;
}

/* ---------- render root ---------- */

function render() {
  renderTimer();
  renderOverview();
  renderTrend();
  renderPhases();
  renderPlan();
  renderBackup();
  if (ui.view === "machines") renderMachines();
  if (ui.view === "draw") renderPool();
  if (ui.view === "schedule") renderSchedule();
  if (ui.view === "notes") renderNotes();
  const withNotes = Object.values(state.entries).filter((e) => e.notes);
  const doneNotes = withNotes.filter((e) => e.noteDone).length;
  let noteLabel = "";
  if (withNotes.length) noteLabel = doneNotes < withNotes.length ? doneNotes + "/" + withNotes.length : String(withNotes.length);
  $("#nav-count-notes").textContent = noteLabel;
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

  const noteMode = ev.target.closest('[data-act="note-mode"]');
  if (noteMode) {
    ui.noteMode = noteMode.dataset.mode;
    return renderNotes();
  }

  const noteDone = ev.target.closest('[data-act="note-done"]');
  if (noteDone) {
    const e = entry(noteDone.dataset.id);
    e.noteDone = !e.noteDone;
    save();
    renderNotes();
    renderMachines();
    return toast(e.noteDone ? "已標記為完成" : "改回草稿");
  }

  const delNote = ev.target.closest('[data-act="delete-note"]');
  if (delNote) {
    const m = BY_ID.get(delNote.dataset.id);
    if (!confirm(`刪除「${m.name}」的筆記？狀態、耗時與卡關標記會保留，只清掉筆記文字。`)) return;
    const e = entry(delNote.dataset.id);
    e.notes = "";
    e.noteDone = false;
    ui.noteMode = "write";
    ui.noteId = null;
    save();
    renderNotes();
    renderMachines();
    return toast("筆記已刪除");
  }

  const pick = ev.target.closest('[data-act="pick-note"]');
  if (pick) {
    ui.noteId = pick.dataset.id;
    ui.noteMode = "write";
    return renderNotes();
  }

  const editNote = ev.target.closest('[data-act="edit-note"]');
  if (editNote) {
    ev.stopPropagation();
    ui.noteId = editNote.dataset.id;
    ui.noteQ = "";
    ui.noteMode = "write";
    $("#note-q").value = "";
    return setView("notes");
  }

  const openIn = ev.target.closest('[data-act="open-in-list"]');
  if (openIn) {
    const m = BY_ID.get(openIn.dataset.id);
    Object.assign(ui, { track: m.track, q: m.name, platform: "", os: "", level: "", status: "", requiredOnly: false, open: m.id });
    $("#q").value = m.name;
    $("#f-required").checked = false;
    ["platform", "os", "level", "status"].forEach((k) => SEL[k].set(""));
    document.querySelectorAll("#track-seg button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.track === m.track)));
    renderPlatformFilter();
    return setView("machines");
  }

  const phase = ev.target.closest('[data-act="phase"]');
  if (phase) {
    ev.stopPropagation();
    const e = entry(phase.dataset.id);
    const list = new Set(e.phases || []);
    if (list.has(phase.dataset.value)) list.delete(phase.dataset.value);
    else list.add(phase.dataset.value);
    e.phases = [...list];
    save();
    renderMachines();
    renderPhases();
    if (ui.view === "notes") renderNotes();
    return;
  }

  const tpl = ev.target.closest('[data-act="template"]');
  if (tpl) {
    ev.stopPropagation();
    entry(tpl.dataset.id).notes = NOTE_TEMPLATE;
    save();
    if (ui.view === "notes") renderNotes();
    else renderMachines();
    const box = document.querySelector(`textarea[data-id="${tpl.dataset.id}"]`);
    if (box) {
      box.focus();
      box.setSelectionRange(box.value.indexOf("開放埠：") + 4, box.value.indexOf("開放埠：") + 4);
    }
    return;
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

  const startT = ev.target.closest('[data-act="start-timer"]');
  if (startT) {
    ev.stopPropagation();
    return startTimer(startT.dataset.id);
  }
  if (ev.target.closest('[data-act="stop-timer"]')) {
    ev.stopPropagation();
    return stopTimer();
  }

  if (ev.target.closest('[data-act="edit-plan"]')) {
    ui.editingPlan = true;
    return renderPlan();
  }
  if (ev.target.closest('[data-act="cancel-plan"]')) {
    ui.editingPlan = false;
    return renderPlan();
  }
  if (ev.target.closest('[data-act="save-plan"]')) {
    state.plan = { start: $("#plan-start").value || "", exam: $("#plan-exam").value || "", end: $("#plan-end").value || "" };
    ui.editingPlan = false;
    save();
    render();
    return toast("期程已更新");
  }
  if (ev.target.closest('[data-act="clear-plan"]')) {
    state.plan = {};
    ui.editingPlan = false;
    save();
    render();
    return toast("期程已清除");
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
  if (ev.target.id === "note-q") { ui.noteQ = ev.target.value; ui.noteId = null; renderNotes(); }
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
    state = {
      entries: parsed.entries,
      history: parsed.history || [],
      theme: state.theme,
      plan: parsed.plan || {},
      updatedAt: parsed.updatedAt || null,
    };
    save();
    render();
    toast("匯入完成");
  } catch (err) {
    toast("匯入失敗：不是有效的備份 JSON");
  }
};

$("#btn-reset").onclick = () => {
  if (!confirm("清除所有狀態、筆記與排程？此動作無法復原。")) return;
  state = { entries: {}, history: [], theme: state.theme, plan: {}, updatedAt: null };
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

$("#btn-markdown").onclick = exportMarkdown;

$("#notes-export").onclick = exportMarkdown;

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
loadTimer();
initSelects();
renderPlatformFilter();
paintTheme();
render();
if (timer) startTick();
initBackup();
renderSync();
initDb();
initServer();
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
