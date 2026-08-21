import {
  changeMasterPassword,
  createVault,
  exportVaultKey,
  generatePassword,
  importVaultKey,
  open,
  saveVault,
  unlockVault,
} from "./crypto.js";
import { originFromTab, queryActiveTab } from "./tab-context.js";

const storageGet = (key) => new Promise((resolve) => chrome.storage.local.get(key, resolve));
const storageSet = (value) => new Promise((resolve) => chrome.storage.local.set(value, resolve));
const storageClear = () => new Promise((resolve) => chrome.storage.local.clear(resolve));
const sessionArea = chrome.storage.session;
const sessionGet = (key) => sessionArea ? new Promise((resolve) => sessionArea.get(key, resolve)) : Promise.resolve({});
const sessionSet = (value) => sessionArea ? new Promise((resolve) => sessionArea.set(value, resolve)) : Promise.resolve();
const sessionRemove = (key) => sessionArea ? new Promise((resolve) => sessionArea.remove(key, resolve)) : Promise.resolve();
const requestOriginAccess = (origin) => new Promise((resolve) => {
  if (!chrome.permissions?.request) return resolve(false);
  const origins = { origins: [`${origin}/*`] };
  chrome.permissions.contains(origins, (alreadyGranted) => {
    if (alreadyGranted) return resolve(true);
    chrome.permissions.request(origins, resolve);
  });
});

const SESSION_IDLE_MS = 15 * 60 * 1000;
const state = { record: null, key: null, rawVaultKey: null, vault: null, recoveryKey: null, pendingImport: null, tab: null, origin: null, manualOrigin: false, generated: null };
const screen = document.querySelector("#screen");
let lockTimer;

const esc = (value) => String(value ?? "").replace(/[&<>\"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const showError = (message) => { const node = document.querySelector(".error"); if (node) node.textContent = message; };
const hostname = (origin) => { try { return new URL(origin).hostname; } catch { return origin || "当前网站"; } };
const isWebOrigin = (origin) => {
  try {
    const url = new URL(origin);
    return url.protocol === "https:" && Boolean(url.hostname);
  } catch { return false; }
};

const clearUnlocked = async () => {
  clearTimeout(lockTimer);
  state.key = state.rawVaultKey = state.vault = null;
  await sessionRemove("unlockSession");
};

const saveSession = async () => {
  if (!state.vault || !state.rawVaultKey) return;
  await sessionSet({ unlockSession: { rawVaultKey: state.rawVaultKey, lastActivity: Date.now() } });
};

const armAutoLock = (delay = SESSION_IDLE_MS) => {
  clearTimeout(lockTimer);
  lockTimer = setTimeout(() => { clearUnlocked(); renderUnlock(); }, delay);
};

const markActivity = () => {
  if (!state.vault) return;
  armAutoLock();
  void saveSession();
};

const copyAndClear = async (value) => {
  try {
    await navigator.clipboard.writeText(value);
    setTimeout(async () => { try { if (await navigator.clipboard.readText() === value) await navigator.clipboard.writeText(""); } catch { /* best effort */ } }, 30_000);
  } catch { showError("无法访问剪贴板，请手动复制"); }
};

document.addEventListener("click", markActivity);
document.addEventListener("keydown", markActivity);
document.addEventListener("input", markActivity);

const refreshContext = async () => {
  if (state.manualOrigin) return;
  state.tab = await queryActiveTab(chrome.tabs);
  state.origin = originFromTab(state.tab);
};

const renderSetup = () => {
  screen.innerHTML = `<div class="card"><h2>创建你的保险库</h2><div class="notice">主密码不会被保存。请使用你能记住的长密码，并把恢复密钥离线备份好。</div><label>主密码</label><input id="master" type="password" autocomplete="new-password"><label>确认主密码</label><input id="confirm" type="password" autocomplete="new-password"><div class="actions"><button id="create">创建保险库</button><button class="secondary" id="import">导入加密备份</button><input id="backup-file" type="file" accept="application/json" hidden></div><div class="error"></div></div>`;
  document.querySelector("#create").onclick = async () => {
    const master = document.querySelector("#master").value;
    if (master.length < 12) return showError("主密码至少需要 12 个字符");
    if (master !== document.querySelector("#confirm").value) return showError("两次输入的主密码不一致");
    const created = await createVault(master);
    state.record = created.record;
    state.recoveryKey = created.recoveryKey;
    await storageSet({ vault: state.record });
    const opened = await unlockVault(state.record, master, "master");
    validateVault(opened.vault);
    state.key = opened.vaultKey;
    state.rawVaultKey = await exportVaultKey(opened.vaultKey);
    state.vault = opened.vault;
    armAutoLock();
    renderRecovery();
  };
  document.querySelector("#import").onclick = () => document.querySelector("#backup-file").click();
  document.querySelector("#backup-file").onchange = importBackup;
};

const renderRecovery = () => {
  screen.innerHTML = `<div class="card"><h2>备份恢复密钥</h2><div class="notice">这是唯一的恢复入口，只显示一次。请复制到密码管理器或离线纸张保存，不要截图或发送给任何人。</div><div class="recovery">${esc(state.recoveryKey)}</div><div class="actions"><button id="copied">我已安全备份</button></div></div>`;
  document.querySelector("#copied").onclick = async () => { await saveSession(); armAutoLock(); state.recoveryKey = null; await renderVaultHome(); };
};

const renderUnlock = () => {
  screen.innerHTML = `<div class="card"><h2>解锁保险库</h2><div class="notice">解锁后，本次浏览器会话内可直接使用；闲置 15 分钟或重启浏览器后会再次锁定。</div><label>主密码</label><input id="master" type="password" autocomplete="current-password"><div class="actions"><button id="unlock">解锁并继续</button><button class="secondary" id="recover">用恢复密钥</button></div><div class="actions"><button class="secondary" id="import">导入加密备份</button><input id="backup-file" type="file" accept="application/json" hidden></div><div class="error"></div></div>`;
  document.querySelector("#unlock").onclick = () => unlock(document.querySelector("#master").value, "master");
  document.querySelector("#import").onclick = () => document.querySelector("#backup-file").click();
  document.querySelector("#backup-file").onchange = importBackup;
  document.querySelector("#recover").onclick = () => {
    screen.innerHTML = `<div class="card"><h2>恢复保险库</h2><div class="notice">恢复成功后，旧恢复密钥会立即失效。</div><label>恢复密钥</label><input id="recovery" autocomplete="off"><label>新主密码</label><input id="master" type="password" autocomplete="new-password"><div class="actions"><button id="reset">验证并重设</button></div><div class="error"></div></div>`;
    document.querySelector("#reset").onclick = async () => {
      const next = document.querySelector("#master").value;
      if (next.length < 12) return showError("主密码至少需要 12 个字符");
      try {
        const rotated = await changeMasterPassword(state.record, document.querySelector("#recovery").value.trim(), next, "recovery");
        state.record = rotated.record;
        state.recoveryKey = rotated.recoveryKey;
        await storageSet({ vault: state.record });
        const opened = await unlockVault(state.record, next, "master");
        validateVault(opened.vault);
        state.key = opened.vaultKey;
        state.rawVaultKey = await exportVaultKey(opened.vaultKey);
        state.vault = opened.vault;
        armAutoLock();
        renderRecovery();
      } catch { showError("恢复密钥无效"); }
    };
  };
};

const unlock = async (secret, mode) => {
  try {
    const opened = await unlockVault(state.record, secret, mode);
    validateVault(opened.vault);
    state.key = opened.vaultKey;
    state.rawVaultKey = await exportVaultKey(opened.vaultKey);
    state.vault = opened.vault;
    if (state.pendingImport) {
      state.record = state.pendingImport;
      state.pendingImport = null;
      await storageSet({ vault: state.record });
    }
    await saveSession();
    armAutoLock();
    await renderVaultHome();
  } catch { showError("密码不正确或保险库已损坏"); }
};

const findCurrentEntry = () => state.vault?.entries.find((entry) => entry.origin === state.origin);
const validateVault = (vault) => {
  if (!vault || !Array.isArray(vault.entries)) throw new Error("保险库数据格式无效");
  for (const entry of vault.entries) {
    if (!entry || typeof entry !== "object" || typeof entry.origin !== "string" || typeof entry.password !== "string") throw new Error("保险库条目格式无效");
  }
};
const entryRow = (entry, index) => `<div class="entry"><div class="entry-info"><div class="entry-title">${esc(entry.name || entry.origin)}</div><div class="entry-meta">${esc(entry.username || "未填写用户名")} · ${esc(entry.origin)}</div></div><button data-fill="${index}">填充</button><button class="secondary" data-copy="${index}">复制</button></div>`;

const renderVaultHome = async () => {
  await refreshContext();
  const current = findCurrentEntry();
  state.generated = current ? null : generatePassword({ length: 24 });
  const hasOrigin = Boolean(state.origin && isWebOrigin(state.origin));
  const originLabel = hasOrigin ? state.origin : "尚未读取当前网站";
  const otherEntries = state.vault.entries.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry !== current);
  const currentCard = current ? `<div class="card current-card"><div class="card-kicker">已匹配当前网站</div><h2>${esc(current.name || hostname(current.origin))}</h2><div class="site-line">${esc(current.origin)}</div><label>用户名</label><div class="readonly">${esc(current.username || "未填写")}</div><label>已保存密码</label><div class="secret-row"><input id="stored-password" type="password" readonly value="${esc(current.password)}"><button class="secondary" id="reveal">显示</button></div><div class="actions"><button id="fill-current">填充当前页面</button><button class="secondary" id="copy-current">复制密码</button></div><div class="success">已找到这个网站的密码。</div></div>` : `<div class="card current-card"><div class="card-kicker">当前网站</div><h2>${hasOrigin ? `为 ${esc(hostname(state.origin))} 生成密码` : "正在识别当前网站"}</h2>${hasOrigin ? `<div class="site-line">${esc(originLabel)}</div><label>名称</label><input id="name" value="${esc(hostname(state.origin))}" placeholder="例如：GitHub"><label>用户名（可选）</label><input id="username" autocomplete="username" placeholder="可以稍后补充"><label>新密码</label><input id="generated" readonly value="${esc(state.generated)}"><div class="actions"><button class="secondary" id="regen">重新生成</button><button class="secondary" id="copygen">复制</button></div><button class="wide-primary" id="save-fill">生成、保存并填充</button>` : `<div class="notice">暂时无法读取当前页面地址。请点击重试；如果浏览器仍不提供地址，再展开备用方式手动输入。</div><button class="wide-primary" id="read-page">重试读取当前页面</button><details class="manual-fallback"><summary>备用：手动输入网站</summary><label>网站 origin</label><input id="manual-origin" placeholder="https://example.com"><button class="wide-primary" id="use-origin">确认网站</button></details>`}</div>`;
  const list = otherEntries.length ? `<details class="card other-card"><summary>其他已保存条目（${otherEntries.length}）</summary>${otherEntries.map(({ entry, index }) => entryRow(entry, index)).join("")}</details>` : "";
  screen.innerHTML = `${currentCard}${list}<div class="card utility-card"><div class="actions"><button class="secondary" id="lock">立即锁定</button><button class="secondary" id="export">导出备份</button><button class="danger" id="wipe">清空保险库</button></div><div class="error"></div></div>`;

  if (current) {
    document.querySelector("#fill-current").onclick = () => fillEntry(current);
    document.querySelector("#copy-current").onclick = () => copyAndClear(current.password);
    document.querySelector("#reveal").onclick = () => { const input = document.querySelector("#stored-password"); input.type = input.type === "password" ? "text" : "password"; document.querySelector("#reveal").textContent = input.type === "password" ? "显示" : "隐藏"; };
  } else {
    const useOrigin = document.querySelector("#use-origin");
    if (useOrigin) useOrigin.onclick = async () => {
      try {
        const value = document.querySelector("#manual-origin").value.trim();
        const parsed = new URL(value);
        if (!isWebOrigin(parsed.origin)) throw new Error("请输入 HTTPS 网站地址，例如 https://example.com");
        state.origin = parsed.origin;
        state.manualOrigin = true;
        await renderVaultHome();
      } catch (error) { showError(error.message); }
    };
    const readPage = document.querySelector("#read-page");
    if (readPage) readPage.onclick = async () => {
      state.manualOrigin = false;
      await renderVaultHome();
    };
  }
  if (!current && state.origin && isWebOrigin(state.origin)) {
    document.querySelector("#regen").onclick = () => { state.generated = generatePassword({ length: 24 }); document.querySelector("#generated").value = state.generated; };
    document.querySelector("#copygen").onclick = () => copyAndClear(state.generated);
    document.querySelector("#save-fill").onclick = saveCurrentEntry;
  }
  document.querySelectorAll("[data-copy]").forEach((button) => button.onclick = () => copyAndClear(state.vault.entries[button.dataset.copy].password));
  document.querySelectorAll("[data-fill]").forEach((button) => button.onclick = () => fillEntry(state.vault.entries[button.dataset.fill]));
  document.querySelector("#lock").onclick = async () => { await clearUnlocked(); renderUnlock(); };
  document.querySelector("#wipe").onclick = async () => { if (confirm("确定清空保险库？此操作不可恢复。")) { await clearUnlocked(); await storageClear(); location.reload(); } };
  document.querySelector("#export").onclick = exportBackup;
};

const saveCurrentEntry = async () => {
  try {
    if (!state.origin || !isWebOrigin(state.origin)) throw new Error("当前页面不是普通 HTTPS 网站");
    if (!await requestOriginAccess(state.origin)) throw new Error("需要允许扩展访问此网站，才能填充登录框");
    const entry = { id: crypto.randomUUID(), name: document.querySelector("#name").value.trim() || hostname(state.origin), origin: state.origin, username: document.querySelector("#username").value.trim(), password: state.generated, notes: "" };
    state.vault.entries.push(entry);
    state.record = await saveVault(state.record, state.key, state.vault);
    await storageSet({ vault: state.record });
    await saveSession();
    await renderVaultHome();
    if (!state.manualOrigin) await fillEntry(entry);
  } catch (error) { showError(error.message); }
};

const fillEntry = async (entry) => {
  const tab = await queryActiveTab(chrome.tabs);
  if (!tab?.id || !tab.url) return showError("无法获取当前标签页");
  try {
    if (new URL(tab.url).origin !== entry.origin) throw new Error("当前页面已不是该条目对应的网站");
    const granted = await requestOriginAccess(entry.origin);
    if (!granted) throw new Error("需要允许扩展访问此网站，才能填充登录框");
    const [{ result }] = await new Promise((resolve, reject) => chrome.scripting.executeScript({ target: { tabId: tab.id }, func: (payload) => {
      if (window.location.origin !== payload.origin) return { ok: false, error: "当前网站与条目 origin 不匹配" };
      const visible = (element) => { const style = getComputedStyle(element); return !element.disabled && style.display !== "none" && style.visibility !== "hidden"; };
      const passwords = Array.from(document.querySelectorAll('input[type="password"]')).filter(visible);
      if (!passwords.length) return { ok: false, error: "没有找到密码输入框" };
      const primaryPassword = passwords.find((field) => /current-password|new-password/i.test(field.autocomplete)) || passwords[0];
      const form = primaryPassword.form;
      const scope = form || document;
      const username = Array.from(scope.querySelectorAll('input[autocomplete="username"], input[type="email"], input[name*="user" i], input[name*="email" i], input[id*="user" i], input[id*="email" i]')).filter(visible).find((field) => field !== primaryPassword);
      const emit = (element, type) => element.dispatchEvent(new Event(type, { bubbles: true }));
      const setValue = (element, value) => {
        const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
        if (setter) setter.call(element, value); else element.value = value;
        emit(element, "input"); emit(element, "change");
      };
      if (username && payload.username) setValue(username, payload.username);
      const formPasswords = Array.from(scope.querySelectorAll('input[type="password"]')).filter(visible);
      const confirmationFields = formPasswords.filter((field) => /confirm|confirmation|repeat|again/i.test(`${field.autocomplete} ${field.name} ${field.id}`));
      const targets = [primaryPassword, ...confirmationFields.filter((field) => field !== primaryPassword)];
      targets.forEach((field) => setValue(field, payload.password));
      return { ok: true, filledPasswords: targets.length, filledUsername: Boolean(username && payload.username) };
    }, args: [{ origin: entry.origin, username: entry.username, password: entry.password }] }, (results) => chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve(results)));
    if (!result?.ok) throw new Error(result?.error || "填充失败");
  } catch (error) { showError(error.message); }
};

const exportBackup = async () => { const blob = new Blob([JSON.stringify({ format: "strong-vault-backup", vault: state.record }, null, 2)], { type: "application/json" }); const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = "strong-vault-backup.json"; anchor.click(); URL.revokeObjectURL(url); };

const importBackup = async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    if (parsed.format !== "strong-vault-backup" || parsed.vault?.version !== 1 || !parsed.vault.masterWrap || !parsed.vault.recoveryWrap || !parsed.vault.data) throw new Error("备份文件格式无效");
    await clearUnlocked();
    state.pendingImport = parsed.vault;
    state.record = parsed.vault;
    renderUnlock();
  } catch (error) { showError(error.message || "无法导入备份"); }
};

const restoreSession = async () => {
  const stored = await storageGet("vault");
  if (!stored.vault) return renderSetup();
  state.record = stored.vault;
  const session = (await sessionGet("unlockSession")).unlockSession;
  if (session && Date.now() - session.lastActivity < SESSION_IDLE_MS && session.rawVaultKey) {
    try {
      state.rawVaultKey = session.rawVaultKey;
      state.key = await importVaultKey(session.rawVaultKey);
      state.vault = JSON.parse(await open(state.record.data, state.key));
      validateVault(state.vault);
      armAutoLock(Math.max(1, SESSION_IDLE_MS - (Date.now() - session.lastActivity)));
      return renderVaultHome();
    } catch { await sessionRemove("unlockSession"); }
  }
  await sessionRemove("unlockSession");
  renderUnlock();
};

if (document.body.classList.contains("sidepanel")) {
  chrome.tabs.onActivated?.addListener(() => { if (state.vault) void renderVaultHome(); });
  chrome.tabs.onUpdated?.addListener((_tabId, changeInfo) => { if (state.vault && changeInfo.status === "complete") void renderVaultHome(); });
}

restoreSession();
