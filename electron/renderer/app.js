(() => {
const api = window.api;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function setOutput(el, text) { el.textContent = text == null ? "" : String(text); }
function pill(el, state, text) { el.className = "pill " + (state || "pill-unknown"); el.textContent = text; }

const tabs = document.querySelectorAll(".tab");
const panels = document.querySelectorAll(".panel");
tabs.forEach((t) => t.addEventListener("click", () => {
  tabs.forEach((x) => x.classList.remove("active"));
  panels.forEach((x) => x.classList.remove("active"));
  t.classList.add("active");
  $(`tab-${t.dataset.tab}`).classList.add("active");
  if (t.dataset.tab === "status") refreshStatus();
  if (t.dataset.tab === "models") loadModels();
  if (t.dataset.tab === "service") refreshServiceStatus();
  if (t.dataset.tab === "logs") loadLogs();
  if (t.dataset.tab === "settings") loadSettings();
}));

function busy(btn, on) {
  if (on) { btn.dataset.label = btn.textContent; btn.textContent = "执行中…"; btn.disabled = true; }
  else { btn.textContent = btn.dataset.label || btn.textContent; btn.disabled = false; }
}

async function refreshStatus() {
  const health = await api.health();
  const models = await api.models();
  const dbInfo = await api.dbInfo();
  if (health.ok) {
    pill($("healthPill"), "pill-ok", `网关在线 · ${health.body.models ?? "?"} 模型`);
    $("stGateway").textContent = "在线";
    $("stGatewaySub").textContent = `127.0.0.1:15721 · providers ${health.body.providers ?? "?"}`;
    $("stProviders").textContent = health.body.providers ?? "—";
  } else {
    pill($("healthPill"), "pill-err", "网关离线");
    $("stGateway").textContent = "离线";
    $("stGatewaySub").textContent = health.body?.error || "无法连接 127.0.0.1:15721";
    $("stProviders").textContent = "—";
  }
  if (models.ok) {
    $("stModels").textContent = models.body.data ? models.body.data.length : "—";
    $("stModelsSub").textContent = "读取自 /v1/models";
  } else {
    $("stModels").textContent = "—";
    $("stModelsSub").textContent = "无法读取模型列表";
  }
  if (dbInfo.ok && dbInfo.exists) {
    $("stDb").textContent = "存在";
    $("stDbSub").textContent = `${Math.round(dbInfo.size / 1024)} KB · ${new Date(dbInfo.mtime).toLocaleString()}`;
    pill($("dbPill"), "pill-ok", "DB 已就绪");
  } else {
    $("stDb").textContent = "缺失";
    $("stDbSub").textContent = dbInfo.path || "—";
    pill($("dbPill"), "pill-err", "DB 缺失");
  }
}

async function loadModels() {
  const models = await api.models();
  const tbody = $("modelsTable").querySelector("tbody");
  tbody.innerHTML = "";
  if (!models.ok) { setOutput($("modelsOutput"), `读取 /v1/models 失败：${models.body?.error || models.status}`); return; }
  const data = models.body.data || [];
  $("modelsHint").textContent = `${data.length} 个模型`;
  const config = await api.config();
  const cfgMap = {};
  if (config.ok && config.body.providers) {
    for (const p of config.body.providers) cfgMap[p.id] = p;
  }
  const rows = [];
  for (const m of data) {
    const provId = m.owned_by || "";
    const prov = cfgMap[provId] || {};
    const tr = document.createElement("tr");
    tr.innerHTML = `<td><code>${esc(m.id)}</code></td><td>${esc(m.owned_by || "")}</td><td>${esc(prov.kind || "")}</td><td>${esc(prov.wire_api || "")}</td><td>${prov.has_api_key ? "是" : "—"}</td>`;
    tr.addEventListener("click", () => {
      $("testModel").value = m.id;
      document.querySelector('.tab[data-tab="test"]').click();
    });
    tbody.appendChild(tr);
    rows.push(m.id);
  }
  setOutput($("modelsOutput"), `共 ${data.length} 个模型。点击行可在"模型测试"中测试。\n` + JSON.stringify(data.slice(0, 8), null, 2));
  populateTestSelect(rows);
}

function populateTestSelect(slugs) {
  const sel = $("testModel");
  const cur = sel.value;
  sel.innerHTML = "";
  for (const s of slugs) {
    const opt = document.createElement("option");
    opt.value = s; opt.textContent = s;
    sel.appendChild(opt);
  }
  if (cur && slugs.includes(cur)) sel.value = cur;
}

async function loadCatalogDisk() {
  const cat = await api.catalog();
  if (!cat.ok) { setOutput($("modelsOutput"), `本地 catalog 不可用：${cat.error}`); return; }
  const slugs = (cat.models || []).map((m) => m.slug);
  setOutput($("modelsOutput"), `本地 catalog（${cat.models?.length || 0} 模型，${cat.generatedAt || "无时间"}）\n路径: ${cat.path}\n${JSON.stringify(slugs, null, 2)}`);
  populateTestSelect(slugs);
}

async function loadConfig() {
  const cfg = await api.config();
  if (!cfg.ok) { setOutput($("modelsOutput"), `读取 /v1/config 失败：${cfg.body?.error}`); return; }
  setOutput($("modelsOutput"), JSON.stringify(cfg.body, null, 2));
}

async function runRefresh() {
  const btn = $("btnRefresh"); busy(btn, true);
  setOutput($("statusOutput"), "刷新中…");
  const res = await api.refresh();
  busy(btn, false);
  setOutput($("statusOutput"), `catalog: ${JSON.stringify(res.catalog?.json || res.catalog, null, 2)}\nreload: ${JSON.stringify(res.reload, null, 2)}`);
  refreshStatus();
}

async function runDoctor() {
  const btn = $("btnDoctor"); busy(btn, true);
  setOutput($("statusOutput"), "运行 doctor…");
  const res = await api.doctor();
  busy(btn, false);
  setOutput($("statusOutput"), JSON.stringify(res.json || res, null, 2));
}

async function runProfile() {
  const btn = $("btnProfile"); busy(btn, true);
  setOutput($("statusOutput"), "生成 profile…");
  const res = await api.profile();
  busy(btn, false);
  setOutput($("statusOutput"), JSON.stringify(res.json || res, null, 2));
}

async function refreshServiceStatus() {
  const [st, health] = await Promise.all([api.serviceStatus(), api.health()]);
  const svc = $("svcState");
  if (st.ok && st.loaded) { svc.textContent = "运行中"; svc.style.color = "var(--ok)"; }
  else if (st.ok && !st.loaded) { svc.textContent = "已加载未运行"; svc.style.color = "var(--warn)"; }
  else { svc.textContent = "未安装"; svc.style.color = "var(--err)"; }
  $("svcPort").textContent = health.ok ? "15721" : "—";
  $("svcPortSub").textContent = health.ok ? "在线" : "离线";
}

async function svcInstall() {
  const btn = $("btnSvcInstall"); busy(btn, true);
  setOutput($("serviceOutput"), "安装并启动服务…");
  const res = await api.serviceInstall();
  busy(btn, false);
  setOutput($("serviceOutput"), JSON.stringify(res.json || res, null, 2));
  refreshServiceStatus(); refreshStatus();
}
async function svcUninstall() {
  if (!confirm("确认停止并卸载 launchd 服务？")) return;
  const btn = $("btnSvcUninstall"); busy(btn, true);
  setOutput($("serviceOutput"), "停止并卸载…");
  const res = await api.serviceUninstall();
  busy(btn, false);
  setOutput($("serviceOutput"), JSON.stringify(res.json || res, null, 2));
  refreshServiceStatus(); refreshStatus();
}
async function svcRestart() {
  if (!confirm("确认重启服务？")) return;
  const btn = $("btnSvcRestart"); busy(btn, true);
  setOutput($("serviceOutput"), "重启中…");
  const res = await api.serviceRestart();
  busy(btn, false);
  setOutput($("serviceOutput"), JSON.stringify(res, null, 2));
  refreshServiceStatus(); refreshStatus();
}

async function runTest() {
  const slug = $("testModel").value;
  if (!slug) { $("testResult").textContent = "请先选择模型。"; return; }
  const prompt = $("testPrompt").value || "只回复 OK";
  const stream = $("testStream").checked;
  const box = $("testResult");
  box.className = "result-box";
  box.textContent = `测试 ${slug}…\nPrompt: ${prompt}\n流式: ${stream}`;
  const res = await api.testModel(slug, { prompt, stream });
  if (res.ok && res.content) {
    box.className = "result-box result-ok";
    box.textContent = `成功 ${slug}\n\n返回内容:\n${res.content}`;
  } else {
    box.className = "result-box result-err";
    box.textContent = `失败 ${slug}\n${res.error || res.content || JSON.stringify(res)}`;
  }
}

async function loadLogs() {
  const res = await api.logs();
  setOutput($("logOut"), res.out?.content || "(无 stdout 日志)");
  setOutput($("logErr"), res.err?.content || "(无 stderr 日志)");
}

async function loadSettings() {
  const paths = await api.paths();
  const list = $("pathList");
  list.innerHTML = "";
  const items = [
    ["项目根", paths.projectRoot],
    ["CLI", paths.cliPath],
    ["Node", paths.nodeBin],
    ["网关地址", paths.gatewayBase],
    ["CC Switch DB", paths.ccswitchDb],
    ["网关目录", paths.gatewayHome],
    ["catalog", paths.catalogPath],
    ["stdout 日志", paths.logOut],
    ["stderr 日志", paths.logErr]
  ];
  for (const [k, v] of items) {
    const li = document.createElement("li");
    li.innerHTML = `${k}: <code>${esc(v)}</code>`;
    li.querySelector("code").addEventListener("click", () => api.showItem(v));
    list.appendChild(li);
  }
}

$("btnRefresh").addEventListener("click", runRefresh);
$("btnDoctor").addEventListener("click", runDoctor);
$("btnProfile").addEventListener("click", runProfile);
$("btnReloadModels").addEventListener("click", refreshStatus);
$("btnModelsLoad").addEventListener("click", loadModels);
$("btnCatalogDisk").addEventListener("click", loadCatalogDisk);
$("btnConfigLoad").addEventListener("click", loadConfig);
$("btnSvcInstall").addEventListener("click", svcInstall);
$("btnSvcUninstall").addEventListener("click", svcUninstall);
$("btnSvcRestart").addEventListener("click", svcRestart);
$("btnSvcStatus").addEventListener("click", refreshServiceStatus);
$("btnTestRun").addEventListener("click", runTest);
$("btnLogsRead").addEventListener("click", loadLogs);
$("btnRecheck").addEventListener("click", refreshStatus);

$("watchToggle").addEventListener("change", async (e) => {
  const r = await api.setWatch(e.target.checked);
  pill($("watchPill"), r.enabled ? "pill-on" : "pill-off", `自动监听 ${r.enabled ? "开" : "关"}`);
});

api.onDbChanged((info) => {
  if (info.ok && info.exists) pill($("dbPill"), "pill-warn", "DB 变化，刷新中…");
});
api.onRefreshDone((res) => {
  const ok = res.reload?.ok && res.catalog?.ok;
  pill($("healthPill"), ok ? "pill-ok" : "pill-err", ok ? "已自动刷新" : "自动刷新失败");
  const active = document.querySelector(".tab.active");
  if (!active) return;
  if (active.dataset.tab === "status") refreshStatus();
  if (active.dataset.tab === "models") loadModels();
});

let logTimer = null;
$("logsAuto").addEventListener("change", (e) => {
  if (e.target.checked) { logTimer = setInterval(loadLogs, 4000); } else if (logTimer) { clearInterval(logTimer); logTimer = null; }
});

refreshStatus();
populateTestSelect(["gpt-5.4-mini"]);
})();
