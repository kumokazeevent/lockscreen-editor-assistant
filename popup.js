const DEFAULT_SETTINGS = {
  titleLimit: 12,
  summaryLimit: 50,
  defaultEngine: "baidu",
  siteRules: {},
};

const STOP_WORDS = new Set([
  "的", "了", "和", "与", "及", "或", "在", "将", "是", "为", "对", "从", "到", "让",
  "这", "那", "一个", "一种", "如何", "为什么", "最新", "今日", "目前", "相关", "进行",
  "the", "and", "for", "with", "from", "this", "that", "into", "your", "about",
]);

const elements = {
  title: document.querySelector("#titleInput"),
  summary: document.querySelector("#summaryInput"),
  titleCount: document.querySelector("#titleCount"),
  summaryCount: document.querySelector("#summaryCount"),
  chips: document.querySelector("#keywordChips"),
  query: document.querySelector("#searchQuery"),
  pageStatus: document.querySelector("#pageStatus"),
  toast: document.querySelector("#toast"),
  saveState: document.querySelector("#saveState"),
};

let settings = { ...DEFAULT_SETTINGS };
let lastPageContext = {};
let keywords = [];
let selectedKeywords = new Set();
let saveTimer;
let toastTimer;

function graphemes(value) {
  if (typeof Intl.Segmenter === "function") {
    return [...new Intl.Segmenter("zh-CN", { granularity: "grapheme" }).segment(value)].map(
      (part) => part.segment,
    );
  }
  return Array.from(value);
}

function clipText(value, limit) {
  return graphemes(value).slice(0, limit).join("");
}

function cleanText(value = "") {
  return value.replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "");
}

function cleanPageTitle(value = "") {
  return cleanText(value.split(/\s[-_|｜]\s/)[0]);
}

function showToast(message) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.add("visible");
  toastTimer = setTimeout(() => elements.toast.classList.remove("visible"), 2200);
}

function updateCounters() {
  const titleLength = graphemes(elements.title.value).length;
  const summaryLength = graphemes(elements.summary.value).length;
  elements.titleCount.textContent = `${titleLength} / ${settings.titleLimit}`;
  elements.summaryCount.textContent = `${summaryLength} / ${settings.summaryLimit}`;
  elements.titleCount.classList.toggle("at-limit", titleLength >= settings.titleLimit);
  elements.summaryCount.classList.toggle("at-limit", summaryLength >= settings.summaryLimit);
}

function enforceLimit(input, limit, label) {
  const parts = graphemes(input.value);
  if (parts.length > limit) {
    input.value = parts.slice(0, limit).join("");
    showToast(`${label}已按 ${limit} 字要求自动截断`);
  }
}

function scheduleSave() {
  elements.saveState.textContent = "正在保存…";
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await chrome.storage.local.set({
      draft: {
        title: elements.title.value,
        summary: elements.summary.value,
        query: elements.query.value,
        updatedAt: Date.now(),
      },
    });
    elements.saveState.textContent = "草稿已保存";
  }, 240);
}

function tokenize(value, weight, scores) {
  const text = cleanText(value);
  if (!text) return;

  const add = (token, score) => {
    const normalized = token.replace(/^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu, "");
    const size = graphemes(normalized).length;
    if (size < 2 || size > 12 || STOP_WORDS.has(normalized.toLowerCase())) return;
    scores.set(normalized, (scores.get(normalized) || 0) + score + Math.min(size, 5) * 0.1);
  };

  if (typeof Intl.Segmenter === "function") {
    const words = [...new Intl.Segmenter("zh-CN", { granularity: "word" }).segment(text)]
      .filter((part) => part.isWordLike)
      .map((part) => part.segment);
    words.forEach((word) => add(word, weight));
    for (let index = 0; index < words.length - 1; index += 1) {
      const phrase = `${words[index]}${/^[\x00-\x7F]/.test(words[index + 1]) ? " " : ""}${words[index + 1]}`;
      add(phrase, weight * 0.72);
    }
  } else {
    text.split(/[\s，。；：！？、,.!?;:()（）【】]+/).forEach((word) => add(word, weight));
  }

  for (const match of text.matchAll(/[A-Za-z][A-Za-z0-9.+#_-]{1,20}(?:\s+[A-Za-z0-9.+#_-]+)?/g)) {
    add(match[0], weight * 1.35);
  }
}

function suggestKeywords() {
  const scores = new Map();
  tokenize(elements.title.value, 7, scores);
  tokenize(elements.summary.value, 3, scores);
  tokenize(lastPageContext.selectedText || "", 5, scores);
  tokenize(lastPageContext.heading || "", 4, scores);

  const candidates = [...scores.entries()]
    .sort((left, right) => right[1] - left[1] || graphemes(left[0]).length - graphemes(right[0]).length)
    .map(([word]) => word);

  keywords = candidates.filter(
    (word, index, all) =>
      !all.slice(0, index).some((prior) => prior.includes(word) && prior !== word),
  ).slice(0, 9);

  if (!keywords.length) {
    keywords = ["新闻配图", "高清横图", "锁屏壁纸"];
  }

  selectedKeywords = new Set(keywords.slice(0, 3));
  renderKeywords();
  updateQueryFromKeywords();
}

function renderKeywords() {
  elements.chips.replaceChildren();
  for (const keyword of keywords) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "keyword-chip";
    button.textContent = keyword;
    button.classList.toggle("selected", selectedKeywords.has(keyword));
    button.addEventListener("click", () => {
      if (selectedKeywords.has(keyword)) selectedKeywords.delete(keyword);
      else selectedKeywords.add(keyword);
      button.classList.toggle("selected", selectedKeywords.has(keyword));
      updateQueryFromKeywords();
    });
    elements.chips.append(button);
  }
}

function updateQueryFromKeywords() {
  elements.query.value = keywords.filter((word) => selectedKeywords.has(word)).join(" ");
  scheduleSave();
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function sendToActiveTab(message) {
  const tab = await getActiveTab();
  if (!tab?.id || !/^https?:/i.test(tab.url || "")) {
    throw new Error("请在普通网页中使用此功能");
  }
  return chrome.tabs.sendMessage(tab.id, message);
}

async function readCurrentPage({ force = false } = {}) {
  try {
    const context = await sendToActiveTab({ type: "GET_PAGE_CONTEXT" });
    lastPageContext = context || {};
    elements.pageStatus.textContent = context.hostname || "当前页面";

    const pageTitle = context.boundTitle || context.selectedText || context.heading || context.title;
    const pageSummary = context.boundSummary || context.description || context.selectedText;
    if (force || !elements.title.value) {
      elements.title.value = clipText(cleanPageTitle(pageTitle), settings.titleLimit);
    }
    if (force || !elements.summary.value) {
      elements.summary.value = clipText(cleanText(pageSummary), settings.summaryLimit);
    }
    updateCounters();
    scheduleSave();
    suggestKeywords();
    showToast("已读取当前页面内容");
  } catch (error) {
    elements.pageStatus.textContent = "此页面不支持读取";
    if (force) showToast(error.message || "读取页面失败");
    suggestKeywords();
  }
}

async function initialize() {
  const [{ settings: savedSettings }, { draft }] = await Promise.all([
    chrome.storage.sync.get("settings"),
    chrome.storage.local.get("draft"),
  ]);
  settings = {
    ...DEFAULT_SETTINGS,
    ...(savedSettings || {}),
    siteRules: savedSettings?.siteRules || {},
  };

  if (draft) {
    elements.title.value = clipText(draft.title || "", settings.titleLimit);
    elements.summary.value = clipText(draft.summary || "", settings.summaryLimit);
    elements.query.value = draft.query || "";
  }
  updateCounters();
  await readCurrentPage();
}

elements.title.addEventListener("input", () => {
  enforceLimit(elements.title, settings.titleLimit, "标题");
  updateCounters();
  scheduleSave();
});

elements.summary.addEventListener("input", () => {
  enforceLimit(elements.summary, settings.summaryLimit, "简介");
  updateCounters();
  scheduleSave();
});

elements.query.addEventListener("input", scheduleSave);
elements.title.addEventListener("change", suggestKeywords);
elements.summary.addEventListener("change", suggestKeywords);

document.querySelector("#refreshKeywords").addEventListener("click", suggestKeywords);
document.querySelector("#readPage").addEventListener("click", () => readCurrentPage({ force: true }));

document.querySelector("#copyDraft").addEventListener("click", async () => {
  const output = [elements.title.value, elements.summary.value].filter(Boolean).join("\n");
  if (!output) return showToast("请先输入标题或简介");
  await navigator.clipboard.writeText(output);
  showToast("标题和简介已复制");
});

document.querySelector("#applyDraft").addEventListener("click", async () => {
  try {
    const result = await sendToActiveTab({
      type: "APPLY_DRAFT",
      title: elements.title.value,
      summary: elements.summary.value,
    });
    showToast(result?.message || (result?.ok ? "已填写到后台" : "请先绑定后台字段"));
  } catch (error) {
    showToast(error.message || "填写失败");
  }
});

document.querySelectorAll("[data-engine]").forEach((button) => {
  button.addEventListener("click", () => {
    const query = cleanText(elements.query.value);
    if (!query) return showToast("请先输入或选择搜索词");
    chrome.runtime.sendMessage({
      type: "OPEN_IMAGE_SEARCH",
      engine: button.dataset.engine,
      query,
    });
  });
});

document.querySelector("#replaceMode").addEventListener("click", async () => {
  try {
    await sendToActiveTab({ type: "TOGGLE_REPLACE_MODE" });
    window.close();
  } catch (error) {
    showToast(error.message || "当前页面无法换图");
  }
});

document.querySelector("#bindFields").addEventListener("click", async () => {
  try {
    await sendToActiveTab({ type: "START_BIND_MODE" });
    window.close();
  } catch (error) {
    showToast(error.message || "当前页面无法绑定");
  }
});

document.querySelector("#openOptions").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

initialize();
