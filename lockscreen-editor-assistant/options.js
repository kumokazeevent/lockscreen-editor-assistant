const DEFAULT_SETTINGS = {
  titleLimit: 12,
  summaryLimit: 50,
  batchLimit: 30,
  batchConcurrency: 2,
  rewriteMode: "ai",
  thinkingLevel: "medium",
  autoSearch: true,
  duplicateCheck: true,
  usageThreshold: 3,
  usageWindowDays: 90,
  aiTimeoutMs: 30000,
  aiEndpoint: "https://api.deepseek.com/chat/completions",
  aiModel: "",
  aiFallbackModel: "",
  reviewAiEnabled: false,
  reviewAiEndpoint: "",
  reviewAiModel: "",
  pexelsEndpoint: "https://api.pexels.com/v1/search",
  pixabayEndpoint: "https://pixabay.com/api/",
  preferredRatio: "auto",
  originalFolder: "锁屏批次/原始内容",
  imageFolder: "锁屏批次/成品图片",
  stockProvider: "auto",
  siteRules: {},
};

const fields = {
  rewriteMode: document.querySelector("#rewriteMode"),
  thinkingLevel: document.querySelector("#thinkingLevel"),
  autoSearch: document.querySelector("#autoSearch"),
  duplicateCheck: document.querySelector("#duplicateCheck"),
  usageThreshold: document.querySelector("#usageThreshold"),
  usageWindowDays: document.querySelector("#usageWindowDays"),
  rewritePrompt: document.querySelector("#rewritePrompt"),
  titleLimit: document.querySelector("#titleLimit"),
  summaryLimit: document.querySelector("#summaryLimit"),
  batchLimit: document.querySelector("#batchLimit"),
  batchConcurrency: document.querySelector("#batchConcurrency"),
  aiTimeoutSeconds: document.querySelector("#aiTimeoutSeconds"),
  aiEndpoint: document.querySelector("#aiEndpoint"),
  aiModel: document.querySelector("#aiModel"),
  aiFallbackModel: document.querySelector("#aiFallbackModel"),
  reviewAiEnabled: document.querySelector("#reviewAiEnabled"),
  reviewAiEndpoint: document.querySelector("#reviewAiEndpoint"),
  reviewAiModel: document.querySelector("#reviewAiModel"),
  pexelsEndpoint: document.querySelector("#pexelsEndpoint"),
  pixabayEndpoint: document.querySelector("#pixabayEndpoint"),
  preferredRatio: document.querySelector("#preferredRatio"),
  originalFolder: document.querySelector("#originalFolder"),
  imageFolder: document.querySelector("#imageFolder"),
};

const aiApiKey = document.querySelector("#aiApiKey");
const reviewAiApiKey = document.querySelector("#reviewAiApiKey");
const pexelsApiKey = document.querySelector("#pexelsApiKey");
const pixabayApiKey = document.querySelector("#pixabayApiKey");
const ruleList = document.querySelector("#ruleList");
const saveMessage = document.querySelector("#saveMessage");
const duplicateLibraryList = document.querySelector("#duplicateLibraryList");
const duplicateLibraryStatus = document.querySelector("#duplicateLibraryStatus");
const duplicateLibraryFile = document.querySelector("#duplicateLibraryFile");

async function sendRuntime(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, action: type, ...payload });
  if (!response || response.ok === false) throw new Error(response?.error || `${type} 执行失败`);
  return response;
}

function clamp(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.round(number))) : fallback;
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
  const [{ settings: saved = {} }, { localSecrets = {}, rewritePrompt = "" }] = await Promise.all([
    chrome.storage.sync.get("settings"),
    chrome.storage.local.get(["localSecrets", "rewritePrompt"]),
  ]);
  const settings = { ...DEFAULT_SETTINGS, ...saved, siteRules: saved.siteRules || {} };
  for (const key of ["rewriteMode", "thinkingLevel"]) fields[key].value = settings[key];
  for (const key of ["autoSearch", "duplicateCheck"]) fields[key].checked = settings[key];
  fields.rewritePrompt.value = LSAWorkflow.wordPrompt(rewritePrompt);
  fields.titleLimit.value = settings.titleLimit;
  fields.summaryLimit.value = settings.summaryLimit;
  fields.usageThreshold.value = settings.usageThreshold;
  fields.usageWindowDays.value = settings.usageWindowDays;
  fields.batchLimit.value = LSAWorkflow.batchSize(settings.batchLimit);
  fields.batchConcurrency.value = settings.batchConcurrency;
  fields.aiTimeoutSeconds.value = Math.round(settings.aiTimeoutMs / 1000);
  fields.aiEndpoint.value = settings.aiEndpoint || "";
  fields.aiModel.value = settings.aiModel || "";
  fields.aiFallbackModel.value = settings.aiFallbackModel || "";
  fields.reviewAiEnabled.checked = Boolean(settings.reviewAiEnabled);
  fields.reviewAiEndpoint.value = settings.reviewAiEndpoint || "";
  fields.reviewAiModel.value = settings.reviewAiModel || "";
  fields.pexelsEndpoint.value = settings.pexelsEndpoint || DEFAULT_SETTINGS.pexelsEndpoint;
  fields.pixabayEndpoint.value = settings.pixabayEndpoint || DEFAULT_SETTINGS.pixabayEndpoint;
  fields.preferredRatio.value = ["auto", "9:16", "9:20"].includes(settings.preferredRatio)
    ? settings.preferredRatio
    : "auto";
  fields.originalFolder.value = settings.originalFolder;
  fields.imageFolder.value = settings.imageFolder;
  setSecretPlaceholder(aiApiKey, Boolean(localSecrets.aiApiKey), "API Key");
  setSecretPlaceholder(reviewAiApiKey, Boolean(localSecrets.reviewAiApiKey), "审核 AI API Key");
  setSecretPlaceholder(pexelsApiKey, Boolean(localSecrets.pexelsApiKey), "Pexels API Key");
  setSecretPlaceholder(pixabayApiKey, Boolean(localSecrets.pixabayApiKey), "Pixabay API Key");
  renderRules(settings.siteRules);
  loadDuplicateLibrary().catch((error) => { duplicateLibraryStatus.textContent = error.message; });
}

async function loadDuplicateLibrary() {
  const library = await sendRuntime("GET_DUPLICATE_LIBRARY");
  duplicateLibraryList.replaceChildren();
  const heading = document.createElement("p");
  heading.className = "section-description";
  heading.textContent = `当前共 ${library.count || 0} 条全局手动重复标记`;
  duplicateLibraryList.append(heading);
  const sources = Object.entries(library.bySource || {}).sort((left, right) => right[1] - left[1]);
  if (!sources.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "暂无手动重复标记";
    duplicateLibraryList.append(empty);
    return;
  }
  for (const [source, count] of sources) {
    const card = document.createElement("div");
    card.className = "rule-card";
    const label = document.createElement("span");
    label.textContent = `${source}：${count} 条`;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "delete-rule";
    remove.textContent = "解除此来源全部标记";
    remove.addEventListener("click", async () => {
      if (!confirm(`确认解除 ${source} 的 ${count} 条全局重复标记？下载历史会保留。`)) return;
      try {
        const result = await sendRuntime("REMOVE_DUPLICATES_BY_SOURCE", { source });
        duplicateLibraryStatus.textContent = `已解除 ${result.removed || 0} 条 ${source} 标记`;
        await loadDuplicateLibrary();
      } catch (error) { duplicateLibraryStatus.textContent = error.message; }
    });
    card.append(label, remove);
    duplicateLibraryList.append(card);
  }
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
    const reviewAiEndpoint = fields.reviewAiEndpoint.value.trim();
    const pexelsEndpoint = fields.pexelsEndpoint.value.trim();
    const pixabayEndpoint = fields.pixabayEndpoint.value.trim();
    for (const [label, value] of [["AI", endpoint], ["审核 AI", reviewAiEndpoint], ["Pexels", pexelsEndpoint], ["Pixabay", pixabayEndpoint]]) {
      if (value && !/^https?:\/\//i.test(value)) throw new Error(`${label} 接口地址必须以 http:// 或 https:// 开头`);
    }
    if (fields.reviewAiEnabled.checked && (!reviewAiEndpoint || !fields.reviewAiModel.value.trim())) {
      throw new Error("启用审核 AI 时必须填写审核接口地址和模型名称");
    }
    const { settings: saved = {} } = await chrome.storage.sync.get("settings");
    const settings = {
      ...DEFAULT_SETTINGS,
      ...saved,
      rewriteMode: fields.rewriteMode.value,
      thinkingLevel: fields.thinkingLevel.value,
      autoSearch: fields.autoSearch.checked,
      duplicateCheck: fields.duplicateCheck.checked,
      titleLimit: clamp(fields.titleLimit.value, 1, 100, 12),
      summaryLimit: clamp(fields.summaryLimit.value, 1, 500, 50),
      usageThreshold: clamp(fields.usageThreshold.value, 1, 40, 3),
      usageWindowDays: clamp(fields.usageWindowDays.value, 1, 365, 90),
      batchLimit: LSAWorkflow.batchSize(fields.batchLimit.value),
      batchConcurrency: clamp(fields.batchConcurrency.value, 1, 2, 2),
      aiTimeoutMs: clamp(fields.aiTimeoutSeconds.value, 10, 120, 30) * 1000,
      aiEndpoint: endpoint,
      aiModel: fields.aiModel.value.trim(),
      aiFallbackModel: fields.aiFallbackModel.value.trim(),
      reviewAiEnabled: fields.reviewAiEnabled.checked,
      reviewAiEndpoint,
      reviewAiModel: fields.reviewAiModel.value.trim(),
      pexelsEndpoint,
      pixabayEndpoint,
      preferredRatio: fields.preferredRatio.value,
      originalFolder: cleanDownloadFolder(fields.originalFolder.value, DEFAULT_SETTINGS.originalFolder),
      imageFolder: cleanDownloadFolder(fields.imageFolder.value, DEFAULT_SETTINGS.imageFolder),
      siteRules: saved.siteRules || {},
    };
    const { localSecrets: savedSecrets = {} } = await chrome.storage.local.get("localSecrets");
    if (fields.reviewAiEnabled.checked && !reviewAiApiKey.value.trim() && !savedSecrets.reviewAiApiKey) {
      throw new Error("启用审核 AI 时必须填写审核 AI API Key");
    }
    const localSecrets = {
      ...savedSecrets,
      ...(aiApiKey.value.trim() ? { aiApiKey: aiApiKey.value.trim() } : {}),
      ...(reviewAiApiKey.value.trim() ? { reviewAiApiKey: reviewAiApiKey.value.trim() } : {}),
      ...(pexelsApiKey.value.trim() ? { pexelsApiKey: pexelsApiKey.value.trim() } : {}),
      ...(pixabayApiKey.value.trim() ? { pixabayApiKey: pixabayApiKey.value.trim() } : {}),
    };
    await Promise.all([
      chrome.storage.sync.set({ settings }),
      chrome.storage.local.set({ localSecrets, rewritePrompt: fields.rewritePrompt.value.trim().slice(0, 12000) }),
    ]);
    aiApiKey.value = "";
    reviewAiApiKey.value = "";
    pexelsApiKey.value = "";
    pixabayApiKey.value = "";
    setSecretPlaceholder(aiApiKey, Boolean(localSecrets.aiApiKey), "API Key");
    setSecretPlaceholder(reviewAiApiKey, Boolean(localSecrets.reviewAiApiKey), "审核 AI API Key");
    setSecretPlaceholder(pexelsApiKey, Boolean(localSecrets.pexelsApiKey), "Pexels API Key");
    setSecretPlaceholder(pixabayApiKey, Boolean(localSecrets.pixabayApiKey), "Pixabay API Key");
    fields.originalFolder.value = settings.originalFolder;
    fields.imageFolder.value = settings.imageFolder;
    saveMessage.textContent = "已保存；后续处理将使用新配置";
  } catch (error) {
    saveMessage.classList.add("error");
    saveMessage.textContent = error?.message || "保存失败";
  }
}

document.querySelector("#saveSettings").addEventListener("click", saveAllSettings);
document.querySelector("#resetPrompt").addEventListener("click", () => { fields.rewritePrompt.value = LSAWorkflow.DEFAULT_PROMPT; });
document.querySelector("#clearSecrets").addEventListener("click", async () => {
  await chrome.storage.local.set({ localSecrets: {} });
  aiApiKey.value = "";
  reviewAiApiKey.value = "";
  pexelsApiKey.value = "";
  pixabayApiKey.value = "";
  setSecretPlaceholder(aiApiKey, false, "API Key");
  setSecretPlaceholder(reviewAiApiKey, false, "审核 AI API Key");
  setSecretPlaceholder(pexelsApiKey, false, "Pexels API Key");
  setSecretPlaceholder(pixabayApiKey, false, "Pixabay API Key");
  saveMessage.classList.remove("error");
  saveMessage.textContent = "本机密钥已清除";
});
document.querySelector("#refreshRules").addEventListener("click", loadSettings);
document.querySelector("#refreshDuplicateLibrary").addEventListener("click", () => loadDuplicateLibrary()
  .catch((error) => { duplicateLibraryStatus.textContent = error.message; }));
document.querySelector("#exportDuplicateLibrary").addEventListener("click", async () => {
  try {
    const result = await sendRuntime("EXPORT_DUPLICATE_LIBRARY", { download: true });
    duplicateLibraryStatus.textContent = `已导出 ${result.library ? Object.keys(result.library.entries || {}).length : 0} 条标记${result.path ? `：${result.path}` : ""}`;
  } catch (error) { duplicateLibraryStatus.textContent = error.message; }
});
document.querySelector("#importDuplicateLibrary").addEventListener("click", () => duplicateLibraryFile.click());
duplicateLibraryFile.addEventListener("change", async () => {
  const file = duplicateLibraryFile.files?.[0];
  duplicateLibraryFile.value = "";
  if (!file) return;
  try {
    if (file.size > 16 * 1024 * 1024) throw new Error("标记库文件超过 16MB");
    const library = JSON.parse(await file.text());
    const result = await sendRuntime("IMPORT_DUPLICATE_LIBRARY", { library });
    duplicateLibraryStatus.textContent = `导入完成，当前共 ${result.count || 0} 条标记`;
    await loadDuplicateLibrary();
  } catch (error) { duplicateLibraryStatus.textContent = `导入失败：${error.message}`; }
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.lsaManualDuplicates) loadDuplicateLibrary().catch(() => {});
});
loadSettings();
