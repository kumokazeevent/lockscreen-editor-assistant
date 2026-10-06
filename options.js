const DEFAULT_SETTINGS = {
  titleLimit: 12,
  summaryLimit: 50,
  batchLimit: 30,
  batchConcurrency: 2,
  aiTimeoutMs: 30000,
  aiEndpoint: "https://api.deepseek.com/chat/completions",
  aiModel: "deepseek-v4-flash",
  preferredRatio: "auto",
  originalFolder: "锁屏批次/原始内容",
  imageFolder: "锁屏批次/成品图片",
  stockProvider: "auto",
  siteRules: {},
};

const fields = {
  titleLimit: document.querySelector("#titleLimit"),
  summaryLimit: document.querySelector("#summaryLimit"),
  batchLimit: document.querySelector("#batchLimit"),
  batchConcurrency: document.querySelector("#batchConcurrency"),
  aiTimeoutSeconds: document.querySelector("#aiTimeoutSeconds"),
  aiEndpoint: document.querySelector("#aiEndpoint"),
  aiModel: document.querySelector("#aiModel"),
  preferredRatio: document.querySelector("#preferredRatio"),
  originalFolder: document.querySelector("#originalFolder"),
  imageFolder: document.querySelector("#imageFolder"),
};

const aiApiKey = document.querySelector("#aiApiKey");
const pexelsApiKey = document.querySelector("#pexelsApiKey");
const pixabayApiKey = document.querySelector("#pixabayApiKey");
const ruleList = document.querySelector("#ruleList");
const saveMessage = document.querySelector("#saveMessage");

function clamp(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.round(number))) : fallback;
}

function normalizeModelId(value) {
  const raw = String(value || "").trim();
  const compact = raw.toLowerCase().replace(/[-_.\s/]+/g, "");
  if (["dsv4flash", "deepseekv4flash"].includes(compact)) return "deepseek-v4-flash";
  return raw;
}

function cleanDownloadFolder(value, fallback) {
  const raw = String(value || "").trim().replace(/\\/g, "/");
  if (raw.startsWith("/") || /^[a-z]:/i.test(raw) || raw.split("/").some((part) => part === "..")) {
    throw new Error("输出目录必须是浏览器下载文件夹内的相对子目录，不能填写盘符、绝对路径或 ..");
  }
  const cleaned = raw
    .replace(/^\/+|\/+$/g, "")
    .replace(/[<>:"|?*\u0000-\u001f]/g, "-")
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .join("/");
  return cleaned || fallback;
}

function setSecretPlaceholder(input, present, label) {
  input.placeholder = present ? "已保存；留空则保持不变" : `输入 ${label}`;
}

async function loadSettings() {
  const [{ settings: saved = {} }, { localSecrets = {} }] = await Promise.all([
    chrome.storage.sync.get("settings"),
    chrome.storage.local.get("localSecrets"),
  ]);
  const settings = { ...DEFAULT_SETTINGS, ...saved, siteRules: saved.siteRules || {} };
  fields.titleLimit.value = settings.titleLimit;
  fields.summaryLimit.value = settings.summaryLimit;
  fields.batchLimit.value = settings.batchLimit;
  fields.batchConcurrency.value = settings.batchConcurrency;
  fields.aiTimeoutSeconds.value = Math.round(settings.aiTimeoutMs / 1000);
  fields.aiEndpoint.value = settings.aiEndpoint || "";
  fields.aiModel.value = normalizeModelId(settings.aiModel || "");
  fields.preferredRatio.value = ["auto", "9:16", "9:20"].includes(settings.preferredRatio)
    ? settings.preferredRatio
    : "auto";
  fields.originalFolder.value = settings.originalFolder;
  fields.imageFolder.value = settings.imageFolder;
  setSecretPlaceholder(aiApiKey, Boolean(localSecrets.aiApiKey), "API Key");
  setSecretPlaceholder(pexelsApiKey, Boolean(localSecrets.pexelsApiKey), "Pexels API Key");
  setSecretPlaceholder(pixabayApiKey, Boolean(localSecrets.pixabayApiKey), "Pixabay API Key");
  renderRules(settings.siteRules);
}

function renderRules(rules) {
  ruleList.replaceChildren();
  const entries = Object.entries(rules || {});
  if (!entries.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "当前使用自动识别；还没有保存手动绑定";
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
      `标题：${rule.titleSelector || "自动识别"}`,
      `简介：${rule.summarySelector || "自动识别"}`,
      `上传：${rule.imageUploadSelector || "自动识别"}`,
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
  saveMessage.classList.remove("error");
  try {
    const endpoint = fields.aiEndpoint.value.trim();
    if (endpoint && !/^https?:\/\//i.test(endpoint)) {
      throw new Error("接口地址必须以 http:// 或 https:// 开头");
    }
    const { settings: saved = {} } = await chrome.storage.sync.get("settings");
    const settings = {
      ...DEFAULT_SETTINGS,
      ...saved,
      titleLimit: clamp(fields.titleLimit.value, 1, 100, 12),
      summaryLimit: clamp(fields.summaryLimit.value, 1, 500, 50),
      batchLimit: clamp(fields.batchLimit.value, 1, 30, 30),
      batchConcurrency: clamp(fields.batchConcurrency.value, 1, 2, 2),
      aiTimeoutMs: clamp(fields.aiTimeoutSeconds.value, 10, 120, 30) * 1000,
      aiEndpoint: endpoint,
      aiModel: normalizeModelId(fields.aiModel.value),
      preferredRatio: fields.preferredRatio.value,
      originalFolder: cleanDownloadFolder(fields.originalFolder.value, DEFAULT_SETTINGS.originalFolder),
      imageFolder: cleanDownloadFolder(fields.imageFolder.value, DEFAULT_SETTINGS.imageFolder),
      siteRules: saved.siteRules || {},
    };
    const { localSecrets: savedSecrets = {} } = await chrome.storage.local.get("localSecrets");
    const localSecrets = {
      ...savedSecrets,
      ...(aiApiKey.value.trim() ? { aiApiKey: aiApiKey.value.trim() } : {}),
      ...(pexelsApiKey.value.trim() ? { pexelsApiKey: pexelsApiKey.value.trim() } : {}),
      ...(pixabayApiKey.value.trim() ? { pixabayApiKey: pixabayApiKey.value.trim() } : {}),
    };
    await Promise.all([
      chrome.storage.sync.set({ settings }),
      chrome.storage.local.set({ localSecrets }),
    ]);
    aiApiKey.value = "";
    pexelsApiKey.value = "";
    pixabayApiKey.value = "";
    setSecretPlaceholder(aiApiKey, Boolean(localSecrets.aiApiKey), "API Key");
    setSecretPlaceholder(pexelsApiKey, Boolean(localSecrets.pexelsApiKey), "Pexels API Key");
    setSecretPlaceholder(pixabayApiKey, Boolean(localSecrets.pixabayApiKey), "Pixabay API Key");
    fields.originalFolder.value = settings.originalFolder;
    fields.imageFolder.value = settings.imageFolder;
    saveMessage.textContent = "已保存；重新加载扩展即可使用新配置";
  } catch (error) {
    saveMessage.classList.add("error");
    saveMessage.textContent = error?.message || "保存失败";
  }
}

document.querySelector("#saveSettings").addEventListener("click", saveAllSettings);
document.querySelector("#clearSecrets").addEventListener("click", async () => {
  await chrome.storage.local.set({ localSecrets: {} });
  aiApiKey.value = "";
  pexelsApiKey.value = "";
  pixabayApiKey.value = "";
  setSecretPlaceholder(aiApiKey, false, "API Key");
  setSecretPlaceholder(pexelsApiKey, false, "Pexels API Key");
  setSecretPlaceholder(pixabayApiKey, false, "Pixabay API Key");
  saveMessage.classList.remove("error");
  saveMessage.textContent = "本机密钥已清除";
});
document.querySelector("#refreshRules").addEventListener("click", loadSettings);
loadSettings();
