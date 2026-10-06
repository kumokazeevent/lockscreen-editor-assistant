const DEFAULT_SETTINGS = {
  titleLimit: 12,
  summaryLimit: 50,
  defaultEngine: "baidu",
  siteRules: {},
};

const titleLimit = document.querySelector("#titleLimit");
const summaryLimit = document.querySelector("#summaryLimit");
const defaultEngine = document.querySelector("#defaultEngine");
const aiEndpoint = document.querySelector("#aiEndpoint");
const aiModel = document.querySelector("#aiModel");
const aiApiKey = document.querySelector("#aiApiKey");
const pexelsApiKey = document.querySelector("#pexelsApiKey");
const ruleList = document.querySelector("#ruleList");
const saveMessage = document.querySelector("#saveMessage");

async function loadSettings() {
  const [{ settings: saved = {} }, { localSecrets = {} }] = await Promise.all([
    chrome.storage.sync.get("settings"),
    chrome.storage.local.get("localSecrets"),
  ]);
  const settings = { ...DEFAULT_SETTINGS, ...saved, siteRules: saved.siteRules || {} };
  titleLimit.value = settings.titleLimit;
  summaryLimit.value = settings.summaryLimit;
  defaultEngine.value = settings.defaultEngine;
  aiEndpoint.value = settings.aiEndpoint || "";
  aiModel.value = settings.aiModel || "";
  aiApiKey.placeholder = localSecrets.aiApiKey ? "已保存；留空则保持不变" : "输入 API Key";
  pexelsApiKey.placeholder = localSecrets.pexelsApiKey ? "已保存；留空则保持不变" : "输入 Pexels API Key";
  renderRules(settings.siteRules);
  return settings;
}

function renderRules(rules) {
  ruleList.replaceChildren();
  const entries = Object.entries(rules);
  if (!entries.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "还没有绑定网站";
    ruleList.append(empty);
    return;
  }

  for (const [host, rule] of entries) {
    const card = document.createElement("div");
    card.className = "rule-card";
    const copy = document.createElement("div");
    const hostElement = document.createElement("div");
    hostElement.className = "rule-host";
    hostElement.textContent = host;
    const detail = document.createElement("div");
    detail.className = "rule-detail";
    detail.textContent = [
      `标题：${rule.titleSelector || "未绑定"}`,
      `简介：${rule.summarySelector || "未绑定"}`,
      `图片上传：${rule.imageUploadSelector || "未绑定"}`,
      ...(rule.imageSelector ? [`旧版图片 URL：${rule.imageSelector}`] : []),
    ].join("\n");
    copy.append(hostElement, detail);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "delete-rule";
    remove.textContent = "删除绑定";
    remove.addEventListener("click", () => deleteRule(host));
    card.append(copy, remove);
    ruleList.append(card);
  }
}

async function deleteRule(host) {
  const { settings: saved = {} } = await chrome.storage.sync.get("settings");
  const siteRules = { ...(saved.siteRules || {}) };
  delete siteRules[host];
  await chrome.storage.sync.set({ settings: { ...DEFAULT_SETTINGS, ...saved, siteRules } });
  renderRules(siteRules);
}

async function saveAllSettings() {
  const { settings: saved = {} } = await chrome.storage.sync.get("settings");
  const settings = {
    ...DEFAULT_SETTINGS,
    ...saved,
    titleLimit: Math.max(1, Math.min(100, Number(titleLimit.value) || 12)),
    summaryLimit: Math.max(1, Math.min(500, Number(summaryLimit.value) || 50)),
    defaultEngine: defaultEngine.value,
    aiEndpoint: aiEndpoint.value.trim(),
    aiModel: aiModel.value.trim(),
    siteRules: saved.siteRules || {},
  };
  const { localSecrets: savedSecrets = {} } = await chrome.storage.local.get("localSecrets");
  const localSecrets = {
    ...savedSecrets,
    ...(aiApiKey.value.trim() ? { aiApiKey: aiApiKey.value.trim() } : {}),
    ...(pexelsApiKey.value.trim() ? { pexelsApiKey: pexelsApiKey.value.trim() } : {}),
  };
  await Promise.all([
    chrome.storage.sync.set({ settings }),
    chrome.storage.local.set({ localSecrets }),
  ]);
  titleLimit.value = settings.titleLimit;
  summaryLimit.value = settings.summaryLimit;
  aiApiKey.value = "";
  pexelsApiKey.value = "";
  aiApiKey.placeholder = localSecrets.aiApiKey ? "已保存；留空则保持不变" : "输入 API Key";
  pexelsApiKey.placeholder = localSecrets.pexelsApiKey ? "已保存；留空则保持不变" : "输入 Pexels API Key";
  saveMessage.textContent = "已保存";
  setTimeout(() => (saveMessage.textContent = ""), 1800);
}

document.querySelector("#saveSettings").addEventListener("click", saveAllSettings);
document.querySelector("#saveConnections").addEventListener("click", saveAllSettings);

document.querySelector("#clearSecrets").addEventListener("click", async () => {
  await chrome.storage.local.set({ localSecrets: {} });
  aiApiKey.value = "";
  pexelsApiKey.value = "";
  aiApiKey.placeholder = "输入 API Key";
  pexelsApiKey.placeholder = "输入 Pexels API Key";
  saveMessage.textContent = "本机密钥已清除";
  setTimeout(() => (saveMessage.textContent = ""), 1800);
});

document.querySelector("#refreshRules").addEventListener("click", loadSettings);
loadSettings();
