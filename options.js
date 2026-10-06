const DEFAULT_SETTINGS = {
  titleLimit: 12,
  summaryLimit: 50,
  defaultEngine: "baidu",
  siteRules: {},
};

const titleLimit = document.querySelector("#titleLimit");
const summaryLimit = document.querySelector("#summaryLimit");
const defaultEngine = document.querySelector("#defaultEngine");
const ruleList = document.querySelector("#ruleList");
const saveMessage = document.querySelector("#saveMessage");

async function loadSettings() {
  const { settings: saved = {} } = await chrome.storage.sync.get("settings");
  const settings = { ...DEFAULT_SETTINGS, ...saved, siteRules: saved.siteRules || {} };
  titleLimit.value = settings.titleLimit;
  summaryLimit.value = settings.summaryLimit;
  defaultEngine.value = settings.defaultEngine;
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
      `图片：${rule.imageSelector || "未绑定"}`,
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

document.querySelector("#saveSettings").addEventListener("click", async () => {
  const { settings: saved = {} } = await chrome.storage.sync.get("settings");
  const settings = {
    ...DEFAULT_SETTINGS,
    ...saved,
    titleLimit: Math.max(1, Math.min(100, Number(titleLimit.value) || 12)),
    summaryLimit: Math.max(1, Math.min(500, Number(summaryLimit.value) || 50)),
    defaultEngine: defaultEngine.value,
    siteRules: saved.siteRules || {},
  };
  await chrome.storage.sync.set({ settings });
  titleLimit.value = settings.titleLimit;
  summaryLimit.value = settings.summaryLimit;
  saveMessage.textContent = "已保存";
  setTimeout(() => (saveMessage.textContent = ""), 1800);
});

document.querySelector("#refreshRules").addEventListener("click", loadSettings);
loadSettings();
