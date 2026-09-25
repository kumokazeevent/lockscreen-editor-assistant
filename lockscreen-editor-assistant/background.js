const LSAWorkflow = globalThis.LSAWorkflow;
const { parseRetryAfter, retryDelayMs, classifyAiError } = globalThis.LSABackgroundAi;
const { PERSON_TERMS, containsWholeTerm, inspectImageMetadataSafety, buildSafeStockQuery } = globalThis.LSABackgroundStock;
const { extensionForMime, fileNameForMime } = globalThis.LSABackgroundDownloads;
const queueWorkLock = globalThis.LSABackgroundLocks.serialQueue();
const SEARCH_ENGINES = {
  baidu: (query) =>
    `https://image.baidu.com/search/index?tn=baiduimage&word=${encodeURIComponent(query)}`,
  bing: (query) =>
    `https://www.bing.com/images/search?q=${encodeURIComponent(query)}`,
  google: (query) =>
    `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(query)}`,
};

const DEFAULT_BATCH_SETTINGS = {
  titleLimit: 12,
  summaryLimit: 50,
  batchLimit: 30,
  batchConcurrency: 2,
  rewriteMode: "ai",
  thinkingLevel: "medium",
  aiFallbackModel: "",
  bangladeshMode: false,
  duplicateCheck: true,
  usageThreshold: 3,
  usageWindowDays: 90,
  aiTimeoutMs: 30000,
  preferredRatio: "auto",
  originalFolder: "锁屏批次/原始内容",
  imageFolder: "锁屏批次/成品图片",
};

const MANUAL_DUPLICATES_KEY = "lsaManualDuplicates";
const IMAGE_USAGE_KEY = "lsaImageUsage";
const USAGE_REBUILT_BATCHES_KEY = "lsaUsageRebuiltBatches";
const MANUAL_DUPLICATES_MIGRATED_KEY = "lsaManualDuplicatesMigratedV1";
const USAGE_EVENT_LIMIT = 40;
const USAGE_TTL_MS = 365 * 86400000;

const TARGET_RATIOS = {
  "9:16": 9 / 16,
  "9:20": 9 / 20,
};

const MAX_ARTICLE_HTML_CHARS = 500000;
const MAX_ARTICLE_TEXT_CHARS = 160000;
const MAX_AI_ARTICLE_CHARS = 6000;
const MAX_IMAGE_BYTES = 24 * 1024 * 1024;
const MAX_TEXT_DOWNLOAD_BYTES = 32 * 1024 * 1024;

let epochPromise;
function tabEpoch() {
  return epochPromise ||= chrome.storage.local.get("lsaTabEpoch").then(async (saved) => {
    if (saved.lsaTabEpoch) return saved.lsaTabEpoch;
    const epoch = crypto.randomUUID();
    await chrome.storage.local.set({ lsaTabEpoch: epoch });
    return epoch;
  });
}
chrome.runtime.onStartup?.addListener(() => {
  const epoch = crypto.randomUUID();
  epochPromise = chrome.storage.local.set({ lsaTabEpoch: epoch }).then(() => epoch);
  ensureDuplicateMigration().catch(() => {});
});
async function getTabContext(tabId) {
  if (!Number.isInteger(tabId) || tabId < 0) throw new Error("未识别到当前浏览器标签页，请刷新后台后重试");
  const prefix = `lsaTab:${await tabEpoch()}:${tabId}`;
  return { tabId, label: `标签页 ${tabId}`, folder: `标签页-${tabId}-${(await tabEpoch()).slice(0, 8)}`,
    keys: Object.fromEntries(["batchState", "assistantState", "settings", "imageHistory", "workLease"].map((name) => [name, `${prefix}:${name}`])) };
}
async function tabOverrides(tabId) {
  if (!Number.isInteger(tabId)) return {};
  const { keys } = await getTabContext(tabId);
  const saved = (await chrome.storage.local.get(keys.settings))[keys.settings] || {};
  return Object.fromEntries(["titleLimit", "summaryLimit", "rewriteMode", "thinkingLevel", "batchConcurrency", "batchLimit", "bangladeshMode"].filter((key) => saved[key] !== undefined).map((key) => [key, saved[key]]));
}
async function savedBatches() {
  const all = await chrome.storage.local.get(null);
  const entries = Object.entries(all).filter(([key, batch]) => (key === "batchState" || /^lsaTab:.*:batchState(?::folder:.*)?$/.test(key)) && batch?.items?.length);
  const active = new Set(entries.filter(([key]) => !key.includes(':folder:')).map(([key,batch]) => `${key}|${batch.batchId}`));
  return { batches: entries.filter(([key,batch]) => !key.includes(':folder:') || !active.has(`${key.split(':folder:')[0]}|${batch.batchId}`))
    .map(([key, batch]) => ({ key, batchId: batch.batchId, folderName: LSAWorkflow.folderName(batch), count: batch.items.length, updatedAt: batch.updatedAt || 0 }))
    .sort((a, b) => b.updatedAt - a.updatedAt) };
}

chrome.runtime.onInstalled.addListener(() => {
  ensureDuplicateMigration().catch(() => {});
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "lockscreen-search-selection",
      title: "用锁屏助手搜索图片：“%s”",
      contexts: ["selection"],
      documentUrlPatterns: ["https://lockscreen-admin.mofeeds.com/*"],
    });
    chrome.contextMenus.create({
      id: "lockscreen-search-image",
      title: "搜索这张图片的相似图片",
      contexts: ["image"],
      documentUrlPatterns: ["https://lockscreen-admin.mofeeds.com/*"],
    });
    chrome.contextMenus.create({
      id: "lockscreen-replace-image",
      title: "在锁屏助手中替换这张图片",
      contexts: ["image"],
      documentUrlPatterns: ["https://lockscreen-admin.mofeeds.com/*"],
    });
  });
});

chrome.action.onClicked.addListener((tab) => {
  if (!tab?.id || !/^https?:/i.test(tab.url || "")) return;
  chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_FLOATING_ASSISTANT" }).catch(() => {});
});

function openImageSearch(engine, query) {
  const buildUrl = SEARCH_ENGINES[engine] || SEARCH_ENGINES.baidu;
  chrome.tabs.create({ url: buildUrl(String(query || "").trim()) });
}

function openVisualSearch(imageUrl) {
  const url = `https://lens.google.com/uploadbyurl?url=${encodeURIComponent(imageUrl)}`;
  chrome.tabs.create({ url });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "lockscreen-search-selection" && info.selectionText) {
    const { settings = {} } = await chrome.storage.sync.get("settings");
    openImageSearch(settings.defaultEngine || "baidu", info.selectionText);
    return;
  }

  if (info.menuItemId === "lockscreen-search-image" && info.srcUrl) {
    openVisualSearch(info.srcUrl);
    return;
  }

  if (info.menuItemId === "lockscreen-replace-image" && info.srcUrl && tab?.id) {
    chrome.tabs.sendMessage(tab.id, {
      type: "SET_REPLACE_TARGET",
      srcUrl: info.srcUrl,
    });
  }
});

function cleanErrorMessage(error, fallback = "请求失败") {
  const message = String(error?.message || error || "").trim();
  if (!message || /signal is aborted without reason/i.test(message)) return fallback;
  return message;
}

class RequestError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "RequestError";
    Object.assign(this, details);
  }
}

class OutputTruncatedError extends RequestError {
  constructor(message, details = {}) {
    super(message, { ...details, code: "OUTPUT_LENGTH", errorType: "OUTPUT_LENGTH", retryable: true });
    this.name = "OutputTruncatedError";
  }
}

function clampNumber(value, fallback, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, numeric));
}

function validateHttpUrl(value, label = "地址") {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    throw new Error(`${label}无效`);
  }
  if (!/^https?:$/.test(url.protocol)) throw new Error(`${label}仅支持 http 或 https`);
  if (url.username || url.password) throw new Error(`${label}不能包含账号或密码`);
  return url;
}

async function fetchResponse(url, options = {}, timeout = 30000, timeoutLabel = "接口") {
  const requestUrl = validateHttpUrl(url, timeoutLabel === "文章" ? "文章地址" : "请求地址");
  const controller = new AbortController();
  const timeoutMs = clampNumber(timeout, 30000, 3000, 120000);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(requestUrl.href, {
      redirect: "follow",
      credentials: "omit",
      ...options,
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted || error?.name === "AbortError" || /aborted/i.test(error?.message || "")) {
      throw new RequestError(
        `${timeoutLabel}请求超过 ${Math.ceil(timeoutMs / 1000)} 秒，已停止；请检查网络或稍后重试`,
        { code: "TIMEOUT", retryable: true },
      );
    }
    throw new RequestError(`${timeoutLabel}网络请求失败：${cleanErrorMessage(error, "无法连接上游服务")}`, {
      code: "NETWORK_ERROR",
      retryable: true,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, options = {}, timeout = 30000, timeoutLabel = "接口") {
  const response = await fetchResponse(url, options, timeout, timeoutLabel);
  const bodyText = await response.text().catch(() => "");
  let payload = {};
  if (bodyText) {
    try {
      payload = JSON.parse(bodyText);
    } catch {
      if (response.ok) {
        throw new RequestError(`${timeoutLabel}返回的不是有效 JSON`, {
          code: "INVALID_JSON",
          status: response.status,
          retryable: true,
        });
      }
    }
  }
  if (!response.ok) {
    const responseUrl = (() => {
      try {
        const parsed = new URL(response.url || String(url));
        return `${parsed.origin}${parsed.pathname}`;
      } catch {
        return String(url || "");
      }
    })();
    const returnedHtml = /<!doctype html|<html\b/i.test(bodyText);
    const opencodeRouteHint = response.status === 404 && /(^|\.)opencode\.ai$/i.test((() => {
      try { return new URL(response.url || String(url)).hostname; } catch { return ""; }
    })())
      ? `OpenCode API 路由不存在：${responseUrl}。OpenCode Go 模型应使用 https://opencode.ai/zen/go/v1/chat/completions（末尾不要加 /）`
      : "";
    const providerMessage = opencodeRouteHint ||
      payload?.detail ||
      payload?.error?.message ||
      payload?.message ||
      (returnedHtml ? "服务器返回了网页而不是 API JSON，请检查完整接口地址" : bodyText.slice(0, 240)) ||
      `HTTP ${response.status}`;
    throw new RequestError(`${timeoutLabel}请求失败（${response.status}）：${providerMessage}`, {
      code: "HTTP_ERROR",
      status: response.status,
      requestUrl: responseUrl,
      retryable: response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500,
    });
  }
  return payload;
}

function buildAiDiagnostic({ status = 0, contentType = "", elapsedMs = 0, timeoutMs = 0, attempt = 1,
  model = "", bodyText = "", responseKind = "", requestUrl = "", retryAfterMs = 0 } = {}) {
  return {
    httpStatus: Number(status) || 0,
    contentType: String(contentType || "").slice(0, 200),
    elapsedMs: Math.max(0, Math.round(Number(elapsedMs) || 0)),
    durationMs: Math.max(0, Math.round(Number(elapsedMs) || 0)),
    timeoutMs: Math.max(0, Math.round(Number(timeoutMs) || 0)),
    attempt: Math.max(1, Math.round(Number(attempt) || 1)),
    model: String(model || "").slice(0, 200),
    rawBody: String(bodyText || "").slice(0, 3000),
    responseKind: String(responseKind || "").slice(0, 80),
    requestUrl: String(requestUrl || "").slice(0, 1000),
    retryAfterMs: Math.min(60000, Math.max(0, Math.round(Number(retryAfterMs) || 0))),
  };
}

function aiResponseKind(payload, bodyText) {
  if (!String(bodyText || "").trim()) return "EMPTY_BODY";
  if (payload?.error) return "ERROR_JSON";
  if (Array.isArray(payload?.choices) && payload.choices.length === 0) return "EMPTY_CHOICES";
  if (Array.isArray(payload?.choices) && payload.choices.length && !getAiResponseText(payload).trim()
    && payload.choices[0]?.finish_reason !== "length"
    && !normalizeAiContent(payload.choices[0]?.message?.reasoning_content).trim()) return "EMPTY_CONTENT";
  return "JSON";
}

async function fetchAiJson(url, options = {}, timeout = 30000, timeoutLabel = "AI", metadata = {}) {
  const startedAt = Date.now();
  let response;
  try {
    response = await fetchResponse(url, options, timeout, timeoutLabel);
  } catch (error) {
    const diagnostic = buildAiDiagnostic({
      elapsedMs: Date.now() - startedAt,
      timeoutMs: timeout,
      attempt: metadata.attempt,
      model: metadata.model,
      requestUrl: String(url || ""),
      responseKind: error?.code === "TIMEOUT" ? "TIMEOUT" : "NETWORK_ERROR",
    });
    error.errorType = classifyAiError({ code: error?.code });
    error.model = metadata.model || "";
    error.diagnostic = diagnostic;
    error.diagnostics = [diagnostic];
    throw error;
  }
  const bodyText = await response.text().catch(() => "");
  const contentType = response.headers.get("content-type") || "";
  const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
  let payload = {};
  let parsed = false;
  if (bodyText.trim()) {
    try { payload = JSON.parse(bodyText); parsed = true; } catch {}
  }
  const responseKind = !bodyText.trim() ? "EMPTY_BODY" : parsed ? aiResponseKind(payload, bodyText) : "INVALID_JSON";
  const diagnostic = buildAiDiagnostic({
    status: response.status,
    contentType,
    elapsedMs: Date.now() - startedAt,
    timeoutMs: timeout,
    attempt: metadata.attempt,
    model: metadata.model,
    bodyText,
    responseKind,
    requestUrl: response.url || String(url || ""),
    retryAfterMs,
  });
  if (!response.ok) {
    const providerMessage = payload?.detail || payload?.error?.message || payload?.message
      || (/<!doctype html|<html\b/i.test(bodyText) ? "服务器返回了网页而不是 API JSON，请检查完整接口地址" : bodyText.slice(0, 240))
      || `HTTP ${response.status}`;
    const errorType = classifyAiError({ status: response.status, responseKind });
    throw new RequestError(`${timeoutLabel}请求失败（${response.status}）：${providerMessage}`, {
      code: "HTTP_ERROR",
      status: response.status,
      requestUrl: diagnostic.requestUrl,
      retryable: response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500,
      retryAfterMs,
      errorType,
      model: metadata.model || "",
      diagnostic,
      diagnostics: [diagnostic],
    });
  }
  if (!parsed || ["EMPTY_BODY", "ERROR_JSON", "EMPTY_CHOICES", "EMPTY_CONTENT", "INVALID_JSON"].includes(responseKind)) {
    const message = responseKind === "EMPTY_BODY" ? `${timeoutLabel}返回 200，但响应正文为空`
      : responseKind === "ERROR_JSON" ? `${timeoutLabel}返回 200，但正文是 error JSON`
      : responseKind === "EMPTY_CHOICES" ? `${timeoutLabel}返回 200，但 choices 为空数组`
      : responseKind === "EMPTY_CONTENT" ? describeEmptyAiResponse(payload)
      : `${timeoutLabel}返回 200，但正文不是有效 JSON`;
    throw new RequestError(message, {
      code: "AI_EMPTY",
      status: response.status,
      requestUrl: diagnostic.requestUrl,
      retryable: true,
      errorType: "EMPTY_RESPONSE",
      model: metadata.model || "",
      diagnostic,
      diagnostics: [diagnostic],
    });
  }
  return { data: payload, diagnostic };
}

function applyCompletionBudget(body, budget, field = "max_tokens") {
  delete body.max_tokens;
  delete body.max_completion_tokens;
  body[field === "max_completion_tokens" ? "max_completion_tokens" : "max_tokens"] = budget;
  return body;
}

function requiresCompletionTokenFieldFallback(error) {
  if (![400, 422].includes(Number(error?.status))) return false;
  const raw = String(error?.diagnostic?.rawBody || error?.message || "");
  return /max_completion_tokens/i.test(raw) || /max_tokens[^\n]{0,100}(?:unsupported|not supported|unknown|invalid)/i.test(raw);
}

function sleepForRetry(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function notifyAiRetry(tabId, payload = {}) {
  if (!Number.isInteger(tabId) || typeof chrome.tabs?.sendMessage !== "function") return Promise.resolve();
  return chrome.tabs.sendMessage(tabId, { type: "AI_RETRY_PROGRESS", ...payload }).catch(() => {});
}

function normalizeOpenverseImage(item) {
  return {
    id: `openverse-${item.id}`,
    source: "openverse",
    previewUrl: item.thumbnail || item.url,
    imageUrl: item.url,
    originalUrl: item.url,
    uploadUrl: item.url,
    downloadUrl: item.url,
    pageUrl: item.foreign_landing_url || item.detail_url,
    title: item.title || "开放许可图片",
    creator: item.creator || "未知作者",
    creatorUrl: item.creator_url || "",
    license: [item.license?.toUpperCase(), item.license_version].filter(Boolean).join(" "),
    licenseUrl: item.license_url || "https://creativecommons.org/share-your-work/cclicenses/",
    attribution: item.attribution || "",
    width: Number(item.width) || 0,
    height: Number(item.height) || 0,
    fileName: `openverse-${item.id}.${item.filetype || "jpg"}`,
  };
}

function normalizePexelsImage(item) {
  const originalUrl = item.src?.original || item.src?.large2x || item.src?.large;
  return {
    id: `pexels-${item.id}`,
    source: "pexels",
    previewUrl: item.src?.medium || item.src?.small,
    imageUrl: originalUrl,
    originalUrl,
    uploadUrl: originalUrl,
    downloadUrl: originalUrl,
    pageUrl: item.url,
    title: item.alt || "Pexels 图片",
    creator: item.photographer || "Pexels 摄影师",
    creatorUrl: item.photographer_url || item.url,
    license: "Pexels License",
    licenseUrl: "https://www.pexels.com/license/",
    attribution: `Photo by ${item.photographer || "photographer"} on Pexels`,
    width: Number(item.width) || 0,
    height: Number(item.height) || 0,
    fileName: `pexels-${item.id}.jpg`,
  };
}

function normalizePixabayImage(item) {
  const originalUrl = item.fullHDURL || item.imageURL || item.largeImageURL || item.webformatURL;
  return {
    id: `pixabay-${item.id}`,
    source: "pixabay",
    previewUrl: item.webformatURL || item.previewURL,
    imageUrl: originalUrl,
    originalUrl,
    uploadUrl: originalUrl,
    downloadUrl: originalUrl,
    pageUrl: item.pageURL,
    title: item.tags || "Pixabay 图片",
    creator: item.user || "Pixabay 创作者",
    creatorUrl: item.user_id
      ? `https://pixabay.com/users/${encodeURIComponent(item.user || "user")}-${item.user_id}/`
      : item.pageURL,
    license: "Pixabay Content License",
    licenseUrl: "https://pixabay.com/service/license-summary/",
    attribution: `Image by ${item.user || "creator"} via Pixabay`,
    width: Number(item.imageWidth) || 0,
    height: Number(item.imageHeight) || 0,
    fileName: `pixabay-${item.id}.jpg`,
  };
}

function isPortraitImage(item) {
  return Number(item.height) > Number(item.width) && Number(item.width) > 0;
}

function pexelsCropUrl(url, width, height) {
  if (!url) return "";
  try {
    const cropped = new URL(url);
    ["w", "h", "dpr", "crop"].forEach((key) => cropped.searchParams.delete(key));
    cropped.searchParams.set("auto", "compress");
    cropped.searchParams.set("cs", "tinysrgb");
    cropped.searchParams.set("fit", "crop");
    cropped.searchParams.set("w", String(width));
    cropped.searchParams.set("h", String(height));
    return cropped.href;
  } catch {
    return url;
  }
}

function normalizePreferredRatio(value) {
  return Object.prototype.hasOwnProperty.call(TARGET_RATIOS, value) ? value : "auto";
}

function getNearestAspect(width, height, preferredRatio = "auto") {
  const ratio = Number(width) / Number(height);
  const preferred = normalizePreferredRatio(preferredRatio);
  const labels = preferred === "auto" ? Object.keys(TARGET_RATIOS) : [preferred];
  let bestLabel = labels[0];
  let bestDistance = Infinity;
  for (const label of labels) {
    const target = TARGET_RATIOS[label];
    const distance = Math.abs(ratio - target) / target;
    if (distance < bestDistance) {
      bestDistance = distance;
      bestLabel = label;
    }
  }
  return { ratio, aspectLabel: bestLabel, ratioDistance: bestDistance };
}

function enrichAndRankImages(items, preferredRatio = "auto", limit = 12, bangladeshMode = false) {
  return items
    .filter(isPortraitImage)
    .map((item) => {
      const aspect = getNearestAspect(item.width, item.height, preferredRatio);
      const safety = inspectImageMetadataSafety(item, bangladeshMode);
      const cropUrls = item.source === "pexels"
        ? {
            "9:16": pexelsCropUrl(item.originalUrl || item.imageUrl, 1080, 1920),
            "9:20": pexelsCropUrl(item.originalUrl || item.imageUrl, 1080, 2400),
          }
        : {};
      const safetyPenalty = safety.safetyStatus === "passed" ? 0 : safety.safetyStatus === "review" ? 0.18 : 10;
      return {
        ...item,
        ...aspect,
        ...safety,
        cropUrls,
        suggestedCropUrl: cropUrls[aspect.aspectLabel] || "",
        uploadUrl: item.originalUrl || item.imageUrl,
        downloadUrl: item.originalUrl || item.imageUrl,
        rankScore: Number((aspect.ratioDistance + safetyPenalty).toFixed(6)),
      };
    })
    .filter((item) => item.safetyStatus !== "rejected")
    .sort((left, right) => left.rankScore - right.rankScore || right.height - left.height)
    .slice(0, limit);
}

const PIXABAY_CACHE_TTL = 24 * 60 * 60 * 1000;
const PIXABAY_CACHE_LIMIT = 100;

async function getCachedPixabaySearch(cacheKey) {
  const { pixabaySearchCache = {} } = await chrome.storage.local.get("pixabaySearchCache");
  const cached = pixabaySearchCache[cacheKey];
  return cached?.expiresAt > Date.now() ? cached.result : null;
}

async function cachePixabaySearch(cacheKey, result) {
  const { pixabaySearchCache = {} } = await chrome.storage.local.get("pixabaySearchCache");
  const now = Date.now();
  const validEntries = Object.entries(pixabaySearchCache)
    .filter(([, value]) => value?.expiresAt > now)
    .sort((left, right) => left[1].expiresAt - right[1].expiresAt)
    .slice(-(PIXABAY_CACHE_LIMIT - 1));
  const nextCache = Object.fromEntries(validEntries);
  nextCache[cacheKey] = { expiresAt: now + PIXABAY_CACHE_TTL, result };
  await chrome.storage.local.set({ pixabaySearchCache: nextCache });
}

async function searchPexels(query, page = 1, options = {}) {
  const [{ settings = {} }, { localSecrets = {} }] = await Promise.all([
    chrome.storage.sync.get("settings"),
    chrome.storage.local.get("localSecrets"),
  ]);
  if (!localSecrets.pexelsApiKey) {
    throw new RequestError("请先在扩展设置中填写免费的 Pexels API Key", {
      code: "PEXELS_KEY_MISSING",
      retryable: false,
    });
  }
  const url = validateHttpUrl(settings.pexelsEndpoint || "https://api.pexels.com/v1/search", "Pexels 接口地址");
  url.searchParams.set("query", options.safeQuery ? buildSafeStockQuery(query, options.bangladeshMode) : String(query).trim());
  url.searchParams.set("orientation", "portrait");
  url.searchParams.set("locale", options.safeQuery ? "en-US" : /[\u3400-\u9fff]/.test(query) ? "zh-CN" : "en-US");
  url.searchParams.set("per_page", String(options.perPage || 12));
  url.searchParams.set("page", String(page));
  const data = await fetchJson(url.href, {
    headers: { Authorization: localSecrets.pexelsApiKey },
  }, options.timeout || 30000, "Pexels");
  return {
    source: "pexels",
    page: data.page || page,
    total: data.total_results || 0,
    hasNext: Boolean(data.next_page),
    searchQuery: url.searchParams.get("query"),
    items: (data.photos || []).map(normalizePexelsImage).filter(isPortraitImage),
  };
}

async function searchPixabay(query, page = 1, options = {}) {
  const [{ settings = {} }, { localSecrets = {} }] = await Promise.all([
    chrome.storage.sync.get("settings"),
    chrome.storage.local.get("localSecrets"),
  ]);
  if (!localSecrets.pixabayApiKey) {
    throw new RequestError("请先在扩展设置中填写免费的 Pixabay API Key", {
      code: "PIXABAY_KEY_MISSING",
      retryable: false,
    });
  }
  const safeQuery = options.safeQuery ? buildSafeStockQuery(query, options.bangladeshMode) : String(query).trim();
  const normalizedQuery = Array.from(safeQuery).slice(0, 100).join("");
  const perPage = options.perPage || 20;
  const configuredEndpoint = settings.pixabayEndpoint || "https://pixabay.com/api/";
  const cacheKey = `v4|${Boolean(options.bangladeshMode)}|${configuredEndpoint}|${normalizedQuery.toLowerCase()}|${page}|${perPage}`;
  const cachedResult = await getCachedPixabaySearch(cacheKey);
  if (cachedResult) return cachedResult;
  const url = validateHttpUrl(configuredEndpoint, "Pixabay 接口地址");
  url.searchParams.set("key", localSecrets.pixabayApiKey);
  url.searchParams.set("q", normalizedQuery);
  url.searchParams.set("lang", "en");
  url.searchParams.set("image_type", "photo");
  url.searchParams.set("orientation", "vertical");
  url.searchParams.set("safesearch", "true");
  url.searchParams.set("order", "popular");
  url.searchParams.set("per_page", String(perPage));
  url.searchParams.set("page", String(page));
  const data = await fetchJson(url.href, {}, options.timeout || 30000, "Pixabay");
  const result = {
    source: "pixabay",
    page,
    total: data.totalHits || data.total || 0,
    hasNext: page * perPage < (data.totalHits || 0),
    searchQuery: normalizedQuery,
    items: (data.hits || []).map(normalizePixabayImage).filter(isPortraitImage),
  };
  await cachePixabaySearch(cacheKey, result);
  return result;
}

async function searchStockImages(source, query, page = 1) {
  if (!String(query || "").trim()) throw new Error("请输入图片搜索词");

  if (source === "pexels") {
    const result = await searchPexels(query, page, { perPage: 12 });
    return { ...result, items: enrichAndRankImages(result.items, "auto", 12) };
  }

  if (source === "pixabay") {
    const result = await searchPixabay(query, page, { perPage: 20 });
    return { ...result, items: enrichAndRankImages(result.items, "auto", 12) };
  }

  const url = new URL("https://api.openverse.org/v1/images/");
  url.searchParams.set("q", String(query).trim());
  url.searchParams.set("license_type", "commercial");
  url.searchParams.set("aspect_ratio", "tall");
  url.searchParams.set("mature", "false");
  url.searchParams.set("page_size", "12");
  url.searchParams.set("page", String(page));
  const data = await fetchJson(url.href, {
    headers: { "Api-Version": "v1" },
  }, 30000, "Openverse");
  const items = (data.results || []).map(normalizeOpenverseImage).filter(isPortraitImage);
  return {
    source: "openverse",
    page: data.page || page,
    total: data.result_count || 0,
    hasNext: (data.page || page) < (data.page_count || 1),
    items: enrichAndRankImages(items, "auto", 12),
  };
}

async function searchBatchImages(query, preferredRatio = "auto", page = 1, source = "", bangladeshMode = false) {
  if (!String(query || "").trim()) throw new Error("AI 未生成可用的英文图片关键词");
  const ratio = normalizePreferredRatio(preferredRatio);
  if (["pexels", "pixabay"].includes(source)) {
    const result = await (source === "pexels" ? searchPexels : searchPixabay)(query, page, { safeQuery: true, perPage: 60, timeout: 30000, bangladeshMode });
    return { ...result, preferredRatio: ratio, bangladeshMode, items: enrichAndRankImages(result.items, ratio, 60, bangladeshMode) };
  }
  let pexelsError = null;
  try {
    const pexels = await searchPexels(query, page, { safeQuery: true, perPage: 60, timeout: 30000, bangladeshMode });
    const items = enrichAndRankImages(pexels.items, ratio, 60, bangladeshMode);
    if (items.length) return { ...pexels, preferredRatio: ratio, bangladeshMode, items, fallbackUsed: false };
    pexelsError = new Error("Pexels 没有返回符合竖屏和安全规则的图片");
  } catch (error) {
    pexelsError = error;
  }

  try {
    const pixabay = await searchPixabay(query, page, { safeQuery: true, perPage: 60, timeout: 30000, bangladeshMode });
    const items = enrichAndRankImages(pixabay.items, ratio, 60, bangladeshMode);
    if (!items.length) throw new Error("Pixabay 也没有返回符合竖屏和安全规则的图片");
    return {
      ...pixabay,
      preferredRatio: ratio,
      bangladeshMode,
      items,
      fallbackUsed: true,
      fallbackReason: cleanErrorMessage(pexelsError, "Pexels 无可用结果"),
    };
  } catch (pixabayError) {
    const pexelsMessage = cleanErrorMessage(pexelsError, "Pexels 不可用");
    const pixabayMessage = cleanErrorMessage(pixabayError, "Pixabay 不可用");
    throw new Error(`没有可用的竖屏图片。Pexels：${pexelsMessage}；Pixabay：${pixabayMessage}`);
  }
}

function extractJson(text) {
  const cleaned = String(text || "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start < 0 || end <= start) {
      throw new RequestError("AI 未返回可识别的 JSON 结果", { code: "AI_INVALID", retryable: true });
    }
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      throw new RequestError("AI 返回的 JSON 格式不完整", { code: "AI_INVALID", retryable: true });
    }
  }
}

function wordCount(value) {
  return LSAWorkflow.count(value);
}

function normalizeLanguageCode(value) {
  return LSAWorkflow.normalizeLanguageCode(value);
}

const SUPPORTED_LANGUAGE_CODES = new Set(["vi", "es", "en", "ru", "be", "ar", "it", "zh", "fa", "ne", "si", "my", "ky", "tg", "az", "bn", "id"]);

function isBangladeshCountry(value) {
  return /(?:bangladesh|孟加拉|বাংলাদেশ)/iu.test(String(value || "").trim());
}

function supportsThinkingControl(model, endpoint = "") {
  const value = String(model || "").trim();
  let hostname = "";
  try { hostname = new URL(endpoint).hostname; } catch {}
  return /(^|\.)api\.deepseek\.com$/i.test(hostname) ||
    /^glm[-_.\s]?5(?:\D|$)/i.test(value) || /^deepseek-v4(?:[-_.]|$)/i.test(value);
}

function enableMediumThinking(requestBody, model, endpoint = "") {
  if (!supportsThinkingControl(model, endpoint)) return requestBody;
  requestBody.thinking = { type: "enabled" };
  requestBody.reasoning_effort = "medium";
  return requestBody;
}

function disableThinking(requestBody, model, endpoint = "") {
  if (!supportsThinkingControl(model, endpoint)) return requestBody;
  requestBody.thinking = { type: "disabled" };
  delete requestBody.reasoning_effort;
  return requestBody;
}

function configureThinking(body, model, endpoint, level = "medium") {
  if (level === "provider") return body;
  if (level === "off") return disableThinking(body, model, endpoint);
  if (supportsThinkingControl(model, endpoint)) {
    body.thinking = { type: "enabled" };
    body.reasoning_effort = ["low", "medium", "high", "max"].includes(level) ? level : "medium";
  }
  return body;
}

function aiHeaders(apiKey) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${String(apiKey || "").trim()}`,
  };
}

function normalizeAiEndpoint(value) {
  const endpointUrl = validateHttpUrl(value, "AI 接口地址");
  endpointUrl.pathname = endpointUrl.pathname.replace(/\/+$/g, "");
  if (/^(?:www\.)?opencode\.ai$/i.test(endpointUrl.hostname)) {
    endpointUrl.hostname = "opencode.ai";
    if (endpointUrl.pathname.startsWith("/zen/go/") && endpointUrl.pathname !== "/zen/go/v1/chat/completions") {
      throw new RequestError(
        "OpenCode Go 接口地址不完整；请填写 https://opencode.ai/zen/go/v1/chat/completions",
        { code: "AI_ENDPOINT_INVALID", retryable: false },
      );
    }
  }
  if (/^(?:www\.)?api\.deepseek\.com$/i.test(endpointUrl.hostname)) {
    endpointUrl.hostname = "api.deepseek.com";
    if (!endpointUrl.pathname || endpointUrl.pathname === "/") endpointUrl.pathname = "/chat/completions";
    if (endpointUrl.pathname === "/v1") endpointUrl.pathname = "/v1/chat/completions";
  }
  return endpointUrl.href;
}

function detectSourceLanguage(text) {
  const value = String(text || "").trim();
  if (!value) return { code: "", confidence: 0 };
  if (/\p{Script=Bengali}/u.test(value)) return { code: "bn", confidence: 1 };
  if (/[پچژگکی]/u.test(value) && /(?:است|برای|های|یک|در|از|به|که)/u.test(value)) return { code: "fa", confidence: 0.92 };
  if (/\p{Script=Arabic}/u.test(value)) return { code: "ar", confidence: 1 };
  if (/[ўЎіІ]/u.test(value)) return { code: "be", confidence: 0.95 };
  if (/\p{Script=Cyrillic}/u.test(value)) return { code: "ru", confidence: 0.9 };
  if (/\p{Script=Han}/u.test(value)) return { code: "zh", confidence: 1 };
  if (/[ăâđêôơưĂÂĐÊÔƠƯ]|[ạảấầẩẫậắằẳẵặẹẻẽếềểễệịỉĩọỏốồổỗộớờởỡợụủũứừửữựỳỵỷỹ]/iu.test(value)) {
    return { code: "vi", confidence: 0.98 };
  }
  const words = value.toLowerCase().match(/[a-zà-ÿ]+/g) || [];
  const scores = {
    en: words.filter((word) => ["the", "a", "an", "and", "or", "to", "of", "in", "for", "with", "how", "why", "ways"].includes(word)).length,
    es: words.filter((word) => ["el", "la", "los", "las", "un", "una", "de", "del", "en", "para", "con", "cómo", "por", "que"].includes(word)).length,
    vi: words.filter((word) => ["và", "của", "cho", "trong", "với", "những", "cách", "làm", "tại", "sao"].includes(word)).length,
    it: words.filter((word) => ["il", "lo", "la", "gli", "le", "di", "del", "in", "per", "con", "come", "che"].includes(word)).length,
  };
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  if (ranked[0][1] > 0 && ranked[0][1] > ranked[1][1]) {
    return { code: ranked[0][0], confidence: Math.min(0.9, 0.55 + ranked[0][1] * 0.1) };
  }
  if (/^[\p{Script=Latin}\p{Number}\p{Punctuation}\p{Separator}]+$/u.test(value)) {
    return { code: "", confidence: 0.2 };
  }
  return { code: "", confidence: 0 };
}

function dominantScript(value) {
  const text = String(value || "");
  const scripts = [
    ["arabic", (text.match(/\p{Script=Arabic}/gu) || []).length],
    ["cyrillic", (text.match(/\p{Script=Cyrillic}/gu) || []).length],
    ["han", (text.match(/\p{Script=Han}/gu) || []).length],
    ["latin", (text.match(/\p{Script=Latin}/gu) || []).length],
  ].sort((a, b) => b[1] - a[1]);
  return scripts[0][1] ? scripts[0][0] : "other";
}

function normalizeAiContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => typeof part === "string" ? part : part?.text || part?.content || "").join("");
  }
  return content?.text || "";
}

function getAiResponseText(data) {
  const chatContent = data?.choices?.[0]?.message?.content;
  if (chatContent != null) return normalizeAiContent(chatContent);
  if (typeof data?.output_text === "string") return data.output_text;
  if (Array.isArray(data?.output)) {
    return data.output
      .flatMap((item) => item?.content || [])
      .map((part) => part?.text || part?.content || "")
      .join("");
  }
  return "";
}

function describeEmptyAiResponse(data) {
  const choice = data?.choices?.[0];
  const reasoning = normalizeAiContent(choice?.message?.reasoning_content).trim();
  let reason = "AI 返回内容为空";
  if (reasoning) reason = "模型只返回了思考内容，没有生成最终正文";
  else if (choice?.finish_reason === "length") reason = "模型输出达到 token 上限，没有生成最终正文";
  else if (choice?.finish_reason === "content_filter") reason = "模型输出被内容安全策略过滤";
  else if (choice?.finish_reason === "insufficient_system_resource") reason = "上游当前推理资源不足";
  const details = [
    `model=${String(data?.model || "未返回")}`,
    `choices=${Array.isArray(data?.choices) ? data.choices.length : "无"}`,
    `finish_reason=${String(choice?.finish_reason || "无")}`,
    `reasoning_chars=${Array.from(reasoning).length}`,
    `top_fields=${Object.keys(data || {}).slice(0, 8).join(",") || "无"}`,
  ];
  return `${reason}（${details.join("；")}）`;
}

function isReasoningTruncated(data) {
  return data?.choices?.[0]?.finish_reason === "length";
}


function isOutputTruncated(data) {
  return isReasoningTruncated(data);
}

function validateAiResult(raw, context) {
  const title = String(raw?.title || "").replace(/^['\"`]+|['\"`]+$/g, "").trim();
  const summary = String(raw?.summary || "").replace(/^['\"`]+|['\"`]+$/g, "").trim();
  const imageQueryEn = String(raw?.image_query_en || raw?.imageQueryEn || "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  const language = normalizeLanguageCode(raw?.language);

  if (!title || !summary || !imageQueryEn || !language) {
    throw new RequestError("AI 结果缺少 title、summary、image_query_en 或 language", {
      code: "AI_INVALID",
      retryable: true,
    });
  }
  if (wordCount(title) > context.titleLimit) {
    throw new RequestError(`AI 标题为 ${wordCount(title)} 词，超过 ${context.titleLimit} 词限制`, {
      code: "AI_INVALID",
      retryable: true,
    });
  }
  if (wordCount(summary) > context.summaryLimit) {
    throw new RequestError(`AI 简介为 ${wordCount(summary)} 词，超过 ${context.summaryLimit} 词限制`, {
      code: "AI_INVALID",
      retryable: true,
    });
  }
  if (/\p{Script=Han}|\p{Script=Cyrillic}|\p{Script=Arabic}/u.test(imageQueryEn)) {
    throw new RequestError("AI 图片关键词不是英文", { code: "AI_INVALID", retryable: true });
  }

  const sourceScript = dominantScript(context.originalTitle);
  const titleScript = dominantScript(title);
  const summaryScript = dominantScript(summary);
  if (["arabic", "cyrillic", "han"].includes(sourceScript) && (sourceScript !== titleScript || sourceScript !== summaryScript)) {
    throw new RequestError("AI 文案与原标题的文字语言不一致", { code: "AI_INVALID", retryable: true });
  }
  if (sourceScript === "latin" && [titleScript, summaryScript].some((script) => ["arabic", "cyrillic", "han"].includes(script))) {
    throw new RequestError("AI 文案与原标题的文字语言不一致", { code: "AI_INVALID", retryable: true });
  }

  const expectedLanguage = context.expectedLanguage;
  if (expectedLanguage && language !== expectedLanguage) {
    throw new RequestError(`AI 返回语言 ${language.toUpperCase()}，与原稿 ${expectedLanguage.toUpperCase()} 不一致`, {
      code: "AI_INVALID",
      retryable: true,
    });
  }
  const detectedOutput = detectSourceLanguage(`${title} ${summary}`);
  if (detectedOutput.confidence >= 0.65 && detectedOutput.code && detectedOutput.code !== language) {
    throw new RequestError(`AI 标注语言 ${language.toUpperCase()}，但文案疑似 ${detectedOutput.code.toUpperCase()}`, {
      code: "AI_INVALID",
      retryable: true,
    });
  }
  return { title, summary, image_query_en: imageQueryEn, language };
}

function validateAiSummaryResult(raw, context) {
  const summary = String(raw?.summary || "").replace(/^['\"`]+|['\"`]+$/g, "").trim();
  const imageQueryEn = String(raw?.image_query_en || raw?.imageQueryEn || "")
    .replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
  const language = normalizeLanguageCode(raw?.language);
  if (!summary || !imageQueryEn || !language) {
    throw new RequestError("AI 结果缺少 summary、image_query_en 或 language", { code: "AI_INVALID", retryable: true });
  }
  if (wordCount(summary) > context.summaryLimit) {
    throw new RequestError(`AI 简介为 ${wordCount(summary)} 词，超过 ${context.summaryLimit} 词限制`, {
      code: "AI_INVALID", retryable: true,
    });
  }
  if (/\p{Script=Han}|\p{Script=Cyrillic}|\p{Script=Arabic}/u.test(imageQueryEn)) {
    throw new RequestError("AI 图片关键词不是英文", { code: "AI_INVALID", retryable: true });
  }
  const sourceScript = dominantScript(context.originalTitle);
  const summaryScript = dominantScript(summary);
  if (["arabic", "cyrillic", "han"].includes(sourceScript) && sourceScript !== summaryScript) {
    throw new RequestError("AI 简介与原标题的文字语言不一致", { code: "AI_INVALID", retryable: true });
  }
  if (sourceScript === "latin" && ["arabic", "cyrillic", "han"].includes(summaryScript)) {
    throw new RequestError("AI 简介与原标题的文字语言不一致", { code: "AI_INVALID", retryable: true });
  }
  if (context.expectedLanguage && language !== context.expectedLanguage) {
    throw new RequestError(`AI 返回语言 ${language.toUpperCase()}，与原稿 ${context.expectedLanguage.toUpperCase()} 不一致`, {
      code: "AI_INVALID", retryable: true,
    });
  }
  const detectedOutput = detectSourceLanguage(summary);
  if (detectedOutput.confidence >= 0.65 && detectedOutput.code && detectedOutput.code !== language) {
    throw new RequestError(`AI 标注语言 ${language.toUpperCase()}，但简介疑似 ${detectedOutput.code.toUpperCase()}`, {
      code: "AI_INVALID", retryable: true,
    });
  }
  return { summary, image_query_en: imageQueryEn, language };
}

function buildAiMessages(context, correction = "") {
  const languageInstruction = context.expectedLanguage
    ? `The input language is ${context.expectedLanguage.toUpperCase()}. The title and summary MUST stay in that language.`
    : "Detect the title's original language first. The title and summary MUST stay in that language and MUST NOT default to Chinese or English.";
  const system = [
    "You are a professional lock-screen magazine title and description editor.",
    LSAWorkflow.wordPrompt(context.rewritePrompt)
      .replaceAll("{titleLimit}", String(context.titleLimit)).replaceAll("{summaryLimit}", String(context.summaryLimit)),
    "Use the version 0.13 fallback order for the summary: article body first, then original description, then original title.",
    `Create a faithful, natural summary of at most ${context.summaryLimit} words. If the article body does not provide usable article content, continue with the original description; if that is also unavailable, use the original title.`,
    `After writing the summary, derive one natural title using ONLY that newly written summary. The title must be at most ${context.titleLimit} words. Do not write a title from the original title, original description or article directly.`,
    "KEEP THE ORIGINAL LANGUAGE: use exactly the same language as the input title. Never translate the summary.",
    "Never change a stated number of methods, steps, tips or items into a smaller or different number.",
    `SUMMARY: at most ${context.summaryLimit} words. Preserve the available source's meaning and key information.`,
    "Remove repetition, background details and excessive modifiers. Do not invent any information.",
    languageInstruction,
    "Write the summary first, then condense only that summary into the title. The original title is also used to identify language and create image_query_en.",
    "IMAGE QUERY SOURCE IS STRICT: image_query_en must be 5 to 12 concrete English visual keywords derived EXCLUSIVELY from the ORIGINAL TITLE. Ignore the original description, article text and shortened title for this field.",
    "For people, prefer side profile, back view, silhouette, fully clothed subjects or wide shots. Avoid frontal close-ups, selfies, swimwear, nudity, exposed skin and sexualized poses. Prefer objects or scenery when people are unnecessary.",
    context.bangladeshMode ? "BANGLADESH MODE: avoid religiously sensitive framing, storytelling narration, negative or sad wording, and romantic-love themes. Food content must never mention pork, pig, bacon or ham. Prefer neutral, practical and positive wording." : "",
    "LANGUAGE CODE: language must be the ISO 639-1 two-letter code of the original title: vi, es, en, ru, be, ar, it, zh, fa, ne, si, my, ky, tg, az, bn or id.",
    "MANDATORY FINAL CHECK: count words in the summary before answering. For Vietnamese count space-separated written words/syllables; for Chinese and other unspaced writing use natural word segmentation.",
    "Keep internal reasoning concise and reserve enough output budget for the final JSON answer.",
    `If summary exceeds ${context.summaryLimit} words, rewrite it shorter and count again.`,
    "Never exceed the summary limit. Further shortening is always preferable to exceeding it.",
    "Return exactly one strict JSON object with keys in this exact order and no Markdown, labels, explanations, analysis or word counts:",
    '{"summary":"...","title":"...","image_query_en":"...","language":"..."}',
    correction ? `PREVIOUS ATTEMPT FAILED: ${correction}. Correct this failure before returning the new JSON.` : "",
  ].filter(Boolean).join("\n");
  const user = [
    `原始标题：${context.originalTitle}`,
    `原始简介：${context.originalSummary || "（无）"}`,
    `原始文章正文：${context.sourceText || "（未抓取到正文，请依次使用原始简介、原始标题兜底）"}`,
  ].join("\n\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

function buildTitleFromSummaryMessages(summary, context, correction = "") {
  const languageInstruction = context.expectedLanguage
    ? `Write the title in ${context.expectedLanguage.toUpperCase()}, the same language as the supplied summary.`
    : "Write the title in exactly the same language as the supplied summary. Never translate it.";
  return [
    {
      role: "system",
      content: [
        "You create a lock-screen magazine title only after the summary has been completed.",
        `Condense ONLY the supplied summary into one natural title of at most ${context.titleLimit} words.`,
        "Do not use any original title, original description or article text. They are intentionally not provided.",
        "Preserve the summary's core topic, important proper nouns and stated numbers. Do not invent information.",
        "Count written words, not letters or characters. Spaces and punctuation do not count; hyphenated compounds and contractions count as one word.",
        languageInstruction,
        `Before answering, recount and shorten again if the title exceeds ${context.titleLimit} words.`,
        "Return exactly one strict JSON object and nothing else: {\"title\":\"...\"}",
        correction ? `PREVIOUS ATTEMPT FAILED: ${correction}. Correct it now.` : "",
      ].filter(Boolean).join("\n"),
    },
    { role: "user", content: `已生成简介：\n${summary}` },
  ];
}

function validateTitleFromSummary(raw, summary, context) {
  const title = String(raw?.title || "").replace(/^['\"`]+|['\"`]+$/g, "").trim();
  if (!title) throw new RequestError("AI 未返回标题", { code: "AI_INVALID", retryable: true });
  if (wordCount(title) > context.titleLimit) {
    throw new RequestError(`AI 标题为 ${wordCount(title)} 词，超过 ${context.titleLimit} 词限制`, {
      code: "AI_INVALID", retryable: true,
    });
  }
  const summaryScript = dominantScript(summary);
  const titleScript = dominantScript(title);
  if (["arabic", "cyrillic", "han"].includes(summaryScript) && summaryScript !== titleScript) {
    throw new RequestError("AI 标题与生成简介的文字语言不一致", { code: "AI_INVALID", retryable: true });
  }
  if (summaryScript === "latin" && ["arabic", "cyrillic", "han"].includes(titleScript)) {
    throw new RequestError("AI 标题与生成简介的文字语言不一致", { code: "AI_INVALID", retryable: true });
  }
  return title;
}

function generateTitleFromSummary(summary, candidate, context) {
  return validateTitleFromSummary(candidate, summary, context);
}

async function reviewAiCandidate(candidate, context, settings, localSecrets, timeout) {
  const endpointValue = String(settings.reviewAiEndpoint || "").trim();
  const model = String(settings.reviewAiModel || "").trim();
  const apiKey = String(localSecrets.reviewAiApiKey || "").trim();
  if (!endpointValue || !model || !apiKey) {
    throw new RequestError("审核 AI 已启用，但接口地址、模型或 API Key 未配置完整", {
      code: "REVIEW_AI_NOT_CONFIGURED",
      retryable: false,
    });
  }
  const endpoint = normalizeAiEndpoint(endpointValue);
  const requestBody = {
    model,
    temperature: 0,
    max_tokens: 800,
    stream: false,
    messages: [
      {
        role: "system",
        content: [
          "You are the final quality reviewer for lock-screen magazine copy.",
          `Correct candidate.summary using the version 0.13 fallback order: original_article, then original_summary, then original_title. Keep it within ${context.summaryLimit} words.`,
          `After correcting the summary, derive the title using ONLY that final summary; it must be at most ${context.titleLimit} words.`,
          "The summary MUST use the original title's language. Count words, not letters. Spaces and punctuation do not count. Contractions and hyphenated words count as one.",
          "Preserve the available source's core meaning, important proper nouns and every stated number of methods, steps, tips or items. Do not invent facts.",
          context.bangladeshMode ? "BANGLADESH MODE: remove religiously sensitive framing, storytelling narration, negative/sad wording, romantic-love themes and any pork-related food wording while preserving the factual core." : "",
          "image_query_en must remain a concrete English stock-photo query based EXCLUSIVELY on original_title. Ignore original_summary and article text for this field.",
          "Count the words in summary before replying. Rewrite and recount until the summary limit is satisfied.",
          "Review quickly and directly. Do not provide analysis or explanations.",
          "Return exactly one strict JSON object and nothing else:",
          '{"summary":"...","title":"...","image_query_en":"...","language":"..."}',
        ].join("\n"),
      },
      {
        role: "user",
        content: JSON.stringify({
          original_title: context.originalTitle,
          original_summary: context.originalSummary,
          original_article: context.sourceText,
          candidate,
        }),
      },
    ],
  };
  disableThinking(requestBody, model, endpoint);
  const { data, diagnostic } = await fetchAiJson(endpoint, {
    method: "POST",
    headers: aiHeaders(apiKey),
    body: JSON.stringify(requestBody),
  }, timeout, "审核 AI", { attempt: 1, model });
  if (data?.choices?.[0]?.finish_reason === "length") {
    throw new OutputTruncatedError(describeEmptyAiResponse(data), { model, diagnostic, diagnostics: [diagnostic] });
  }
  const content = getAiResponseText(data);
  if (!content) {
    throw new RequestError(describeEmptyAiResponse(data), {
      code: "REVIEW_AI_INVALID",
      retryable: false,
      errorType: "EMPTY_RESPONSE",
      model,
      diagnostic,
      diagnostics: [diagnostic],
    });
  }
  try {
    const candidate = extractJson(content);
    const result = validateAiSummaryResult(candidate, context);
    return { ...result, title: generateTitleFromSummary(result.summary, candidate, context), diagnostic };
  } catch (error) {
    error.model ||= model;
    error.errorType ||= "AI_INVALID";
    error.diagnostic ||= diagnostic;
    error.diagnostics ||= [diagnostic];
    throw error;
  }
}

function shouldRetry(error) {
  if (error?.retryable === false) return false;
  // A second full timeout usually means another 30 seconds with the same result.
  // Let the user retry explicitly while preserving automatic retries for short
  // transient failures and invalid model output.
  if (error?.code === "TIMEOUT") return false;
  if ([400, 401, 403, 404, 422].includes(Number(error?.status))) return false;
  return true;
}

async function generateBatchItemWithAi(payload = {}, tabId) {
  const item = payload.item || payload;
  const [{ settings: savedSettings = {} }, { localSecrets = {}, rewritePrompt = "" }] = await Promise.all([
    chrome.storage.sync.get("settings"),
    chrome.storage.local.get(["localSecrets", "rewritePrompt"]),
  ]);
  const settings = { ...DEFAULT_BATCH_SETTINGS, ...savedSettings, ...await tabOverrides(tabId) };
  if (settings.rewriteMode === "local") {
    const result = LSAWorkflow.localRewrite(item, settings);
    return { configured: true, result, ...result, attempts: 1 };
  }
  let endpoint = String(settings.aiEndpoint || "").trim();
  const model = String(settings.aiModel || "").trim();
  const fallbackModel = String(settings.aiFallbackModel || "").trim();
  const apiKey = String(localSecrets.aiApiKey || "").trim();
  if (!endpoint || !model || !apiKey) {
    throw new RequestError("独立 AI 接口未配置完整，请在设置中填写接口地址、模型和 API Key", {
      code: "AI_NOT_CONFIGURED",
      retryable: false,
    });
  }
  endpoint = normalizeAiEndpoint(endpoint);

  const originalTitle = String(item.originalTitle || item.title || "").trim();
  if (!originalTitle) throw new Error("没有读取到原标题，无法改写");
  const originalSummary = String(item.originalSummary || item.summary || "").trim().slice(0, 2000);
  const articleText = String(item.articleText || "").replace(/\s+/g, " ").trim().slice(0, MAX_AI_ARTICLE_CHARS);
  const explicitSummarySource = ["article_body", "original_summary", "original_title"].includes(item.summarySource)
    ? item.summarySource : "";
  const summarySource = explicitSummarySource || (articleText ? "article_body" : originalSummary ? "original_summary" : "original_title");
  const sourceText = String(item.sourceText || articleText || originalSummary || originalTitle)
    .replace(/\s+/g, " ").trim().slice(0, MAX_AI_ARTICLE_CHARS);
  const detected = detectSourceLanguage(`${originalTitle} ${originalSummary}`);
  const normalizedHint = normalizeLanguageCode(item.languageHint || item.language || item.pageLanguage || payload.languageHint);
  const hintedLanguage = SUPPORTED_LANGUAGE_CODES.has(normalizedHint) ? normalizedHint : "";
  const expectedLanguage = hintedLanguage || (detected.confidence >= 0.55 ? detected.code : "");
  const bangladeshMode = Boolean(settings.bangladeshMode && expectedLanguage === "bn"
    && isBangladeshCountry(item.pageCountry || payload.pageCountry || payload.country));
  const context = {
    originalTitle,
    originalSummary,
    sourceText,
    summarySource,
    expectedLanguage,
    rewritePrompt,
    titleLimit: clampNumber(payload.titleLimit ?? settings.titleLimit, 12, 1, 100),
    summaryLimit: clampNumber(payload.summaryLimit ?? settings.summaryLimit, 50, 1, 500),
    bangladeshMode,
  };
  const timeout = clampNumber(payload.timeoutMs ?? settings.aiTimeoutMs, 30000, 5000, 120000);
  const maxAttempts = clampNumber((payload.maxRetries ?? 2) + 1, 3, 1, 3);
  const allDiagnostics = [];
  let totalAttempts = 0;

  const requestCycle = async (activeModel, usedFallbackModel = false) => {
    const errors = [];
    const budgets = [4096, 8192, 16384];
    let budgetIndex = 0;
    let completionField = "max_tokens";
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      totalAttempts += 1;
      await notifyAiRetry(tabId, {
        status: "requesting", itemId: String(item.id || ""), itemIndex: item.index,
        attempt, waitMs: 0, model: activeModel, errorType: "", usedFallbackModel,
      });
      const requestBody = {
        model: activeModel,
        temperature: 0.1,
        stream: false,
        messages: buildAiMessages(context, attempt > 1 ? cleanErrorMessage(lastError, "The previous output was invalid") : ""),
      };
      applyCompletionBudget(requestBody, budgets[budgetIndex], completionField);
      configureThinking(requestBody, activeModel, endpoint, settings.thinkingLevel);
      let response;
      try {
        while (true) {
          try {
            response = await fetchAiJson(endpoint, {
              method: "POST",
              headers: aiHeaders(apiKey),
              body: JSON.stringify(requestBody),
            }, timeout, "AI 改写", { attempt, model: activeModel });
            allDiagnostics.push(response.diagnostic);
            break;
          } catch (requestError) {
            if (requestError?.diagnostic) allDiagnostics.push(requestError.diagnostic);
            if (completionField === "max_tokens" && requiresCompletionTokenFieldFallback(requestError)) {
              completionField = "max_completion_tokens";
              applyCompletionBudget(requestBody, budgets[budgetIndex], completionField);
              continue;
            }
            throw requestError;
          }
        }
        const { data, diagnostic } = response;
        if (data?.choices?.[0]?.finish_reason === "length") {
          throw new OutputTruncatedError(describeEmptyAiResponse(data), {
            model: activeModel,
            status: diagnostic.httpStatus,
            requestUrl: diagnostic.requestUrl,
            diagnostic,
            diagnostics: [diagnostic],
          });
        }
        const content = getAiResponseText(data);
        if (!content) {
          throw new RequestError(describeEmptyAiResponse(data), {
            code: "AI_EMPTY", errorType: "EMPTY_RESPONSE", retryable: true,
            model: activeModel, status: diagnostic.httpStatus, requestUrl: diagnostic.requestUrl,
            diagnostic, diagnostics: [diagnostic],
          });
        }
        let candidate;
        try { candidate = extractJson(content); }
        catch (error) {
          error.model ||= activeModel;
          error.errorType ||= "AI_INVALID";
          error.diagnostic ||= diagnostic;
          error.diagnostics ||= [diagnostic];
          throw error;
        }
        let primaryResult;
        let primaryError;
        try {
          const summaryResult = validateAiSummaryResult(candidate, context);
          primaryResult = { ...summaryResult, title: generateTitleFromSummary(summaryResult.summary, candidate, context) };
        }
        catch (error) {
          primaryError = error;
          primaryError.model ||= activeModel;
          primaryError.errorType ||= "AI_INVALID";
          primaryError.diagnostic ||= diagnostic;
          primaryError.diagnostics ||= [diagnostic];
        }
        let result = primaryResult;
        let reviewed = false;
        let reviewWarning = "";
        if (settings.reviewAiEnabled) {
          try {
            result = await reviewAiCandidate(candidate, context, settings, localSecrets, timeout);
            if (result.diagnostic) allDiagnostics.push(result.diagnostic);
            reviewed = true;
          } catch (reviewError) {
            if (!primaryResult) {
              throw new RequestError(
                `审核 AI 未能修正不合格的主 AI 结果：${cleanErrorMessage(reviewError, "审核失败")}；主 AI：${cleanErrorMessage(primaryError, "结果未通过校验")}`,
                {
                  code: reviewError?.code || "REVIEW_AI_FAILED", status: reviewError?.status, retryable: false,
                  errorType: reviewError?.errorType || "AI_INVALID", model: activeModel,
                  diagnostic: reviewError?.diagnostic || diagnostic,
                  diagnostics: [...(primaryError?.diagnostics || [diagnostic]), ...(reviewError?.diagnostics || [])],
                },
              );
            }
            result = primaryResult;
            reviewWarning = `审核 AI 未完成，已使用通过本地校验的主 AI 结果：${cleanErrorMessage(reviewError, "审核失败")}`;
          }
        } else if (!primaryResult) {
          throw primaryError;
        }
        result = validateAiResult({ ...result, title: generateTitleFromSummary(result.summary, result, context) }, context);
        return {
          ok: true,
          value: {
            configured: true, result, title: result.title, summary: result.summary,
            image_query_en: result.image_query_en, imageQueryEn: result.image_query_en,
            language: result.language, reviewed, reviewWarning, attempts: totalAttempts,
            copySource: `${context.summarySource}_to_summary_to_title`,
            summarySource: context.summarySource,
            titleSource: "generated_summary",
            model: activeModel, usedFallbackModel, diagnostics: allDiagnostics,
          },
        };
      } catch (error) {
        error.model ||= activeModel;
        error.errorType ||= classifyAiError({ status: error?.status, code: error?.code });
        error.diagnostics = error.diagnostics?.length ? error.diagnostics : error.diagnostic ? [error.diagnostic] : [];
        lastError = error;
        errors.push(error);
        if (error.errorType === "OUTPUT_LENGTH") {
          if (budgetIndex < budgets.length - 1 && attempt < maxAttempts) {
            budgetIndex += 1;
            continue;
          }
          break;
        }
        if (attempt >= maxAttempts || !shouldRetry(error)) break;
        const waitMs = retryDelayMs(attempt - 1, error.retryAfterMs);
        await notifyAiRetry(tabId, {
          status: "waiting", itemId: String(item.id || ""), itemIndex: item.index,
          attempt: attempt + 1, waitMs, model: activeModel, errorType: error.errorType, usedFallbackModel,
        });
        await sleepForRetry(waitMs);
      }
    }
    return { ok: false, error: lastError, errors };
  };

  const primary = await requestCycle(model, false);
  if (primary.ok) {
    await notifyAiRetry(tabId, { status: "clear", itemId: String(item.id || ""), itemIndex: item.index });
    return primary.value;
  }
  const lengthExhausted = primary.errors.length === maxAttempts
    && primary.errors.every((error) => error.errorType === "OUTPUT_LENGTH");
  const transientExhausted = primary.errors.length === maxAttempts
    && primary.errors.every((error) => error.errorType === "EMPTY_RESPONSE"
      || (error.errorType === "SERVER_ERROR" && (!error.status || Number(error.status) >= 500)));
  let finalCycle = primary;
  let usedFallbackModel = false;
  if (fallbackModel && fallbackModel !== model && (lengthExhausted || transientExhausted)) {
    if (transientExhausted) {
      const waitMs = retryDelayMs(2, primary.error?.retryAfterMs);
      await notifyAiRetry(tabId, {
        status: "waiting", itemId: String(item.id || ""), itemIndex: item.index,
        attempt: 1, waitMs, model: fallbackModel, errorType: primary.error?.errorType || "", usedFallbackModel: true,
      });
      await sleepForRetry(waitMs);
    }
    finalCycle = await requestCycle(fallbackModel, true);
    usedFallbackModel = true;
    if (finalCycle.ok) {
      await notifyAiRetry(tabId, { status: "clear", itemId: String(item.id || ""), itemIndex: item.index });
      return finalCycle.value;
    }
  }
  await notifyAiRetry(tabId, { status: "clear", itemId: String(item.id || ""), itemIndex: item.index });
  const lastError = finalCycle.error || primary.error;
  const timeoutHint = lastError?.code === "TIMEOUT"
    ? `；本次请求已等待 ${Math.ceil(timeout / 1000)} 秒，超时不会自动重复请求，可稍后点击重试`
    : "";
  throw new RequestError(
    `AI 改写失败（已尝试 ${totalAttempts} 次）：${cleanErrorMessage(lastError, "上游接口不可用")}${timeoutHint}`,
    {
      code: lastError?.code || "AI_FAILED", status: lastError?.status,
      requestUrl: lastError?.requestUrl, retryable: false,
      errorType: lastError?.errorType || classifyAiError({ status: lastError?.status, code: lastError?.code }),
      model: lastError?.model || (usedFallbackModel ? fallbackModel : model), attempts: totalAttempts,
      diagnostics: allDiagnostics, usedFallbackModel,
    },
  );
}

function buildImageQueryMessages(title, bangladeshMode = false) {
  const originalTitle = String(title || "").replace(/\s+/g, " ").trim();
  if (!originalTitle) throw new Error("没有读取到原标题，无法生成图片搜索词");
  return [
    {
      role: "system",
      content: [
        "Create a precise stock-photo search query from the ORIGINAL TITLE only.",
        "Do not use or infer from any description, summary, article body, rewritten title, previously saved query or selected image.",
        "Return 5 to 10 concrete English visual keywords describing visible subject, named place, object, action, scene and atmosphere stated or directly implied by that title.",
        "Prefer side profile, back view, silhouette, fully clothed subjects or wide shots. Avoid frontal faces, selfies, swimwear, nudity and excessive exposed skin.",
        "Preserve visually relevant proper nouns. Do not use abstract words such as news, article, report or photography.",
        bangladeshMode ? "BANGLADESH MODE: prefer food without pork, landscapes, objects, butterflies, fish or anime/cartoon visuals. Exclude people, realistic animals other than butterflies/fish, romance, religious storytelling and pork-related terms." : "",
        "Return strict JSON only: {\"image_query_en\":\"...\"}",
      ].join("\n"),
    },
    { role: "user", content: `ORIGINAL TITLE ONLY:\n${originalTitle}` },
  ];
}

async function generateImageQueryWithAi(payload, tabId) {
  const [{ settings: savedSettings = {} }, { localSecrets = {} }] = await Promise.all([
    chrome.storage.sync.get("settings"),
    chrome.storage.local.get("localSecrets"),
  ]);
  const settings = { ...savedSettings, ...await tabOverrides(tabId) };
  const configuredEndpoint = settings.aiEndpoint?.trim();
  if (settings.rewriteMode === "local") return { configured: false, imageQueryEn: "", local: true };
  const model = String(settings.aiModel || "").trim();
  const apiKey = localSecrets.aiApiKey?.trim();
  if (!configuredEndpoint || !model || !apiKey) return { configured: false };
  const endpoint = normalizeAiEndpoint(configuredEndpoint);

  const requestBody = {
    model,
    temperature: 0.1,
    max_tokens: 2048,
    messages: buildImageQueryMessages(payload.title, Boolean(settings.bangladeshMode && payload.bangladeshMode)),
  };
  configureThinking(requestBody, model, endpoint, settings.thinkingLevel || "medium");
  const { data, diagnostic } = await fetchAiJson(endpoint, {
    method: "POST",
    headers: aiHeaders(apiKey),
    body: JSON.stringify(requestBody),
  }, clampNumber(settings.aiTimeoutMs, 30000, 5000, 120000), "英文图片关键词生成", { attempt: 1, model });
  if (data?.choices?.[0]?.finish_reason === "length") {
    throw new OutputTruncatedError(describeEmptyAiResponse(data), { model, diagnostic, diagnostics: [diagnostic] });
  }
  const generated = extractJson(getAiResponseText(data));
  return {
    configured: true,
    imageQueryEn: String(generated.image_query_en || "").trim(),
    diagnostics: [diagnostic],
  };
}

async function getAiTranslationStatus(tabId) {
  const [{ settings: savedSettings = {} }, { localSecrets = {} }] = await Promise.all([
    chrome.storage.sync.get("settings"),
    chrome.storage.local.get("localSecrets"),
  ]);
  const settings = { ...DEFAULT_BATCH_SETTINGS, ...savedSettings, ...await tabOverrides(tabId) };
  const configured = settings.rewriteMode !== "local"
    && Boolean(String(settings.aiEndpoint || "").trim())
    && Boolean(String(settings.aiModel || "").trim())
    && Boolean(String(localSecrets.aiApiKey || "").trim());
  return {
    configured,
    rewriteMode: settings.rewriteMode,
    model: String(settings.aiModel || "").trim(),
    reason: configured ? "" : settings.rewriteMode === "local"
      ? "当前标签页为本地模式，AI 翻译不会发起付费请求"
      : "请先在设置页配置主 AI 的端点、模型和 API Key",
  };
}

async function translateTextWithAi(payload = {}, tabId) {
  const text = String(payload.text || "").replace(/\s+/g, " ").trim().slice(0, 2000);
  if (!text) throw new RequestError("没有可翻译的原标题", { code: "AI_INVALID", retryable: false });
  const [{ settings: savedSettings = {} }, { localSecrets = {} }] = await Promise.all([
    chrome.storage.sync.get("settings"),
    chrome.storage.local.get("localSecrets"),
  ]);
  const settings = { ...DEFAULT_BATCH_SETTINGS, ...savedSettings, ...await tabOverrides(tabId) };
  if (settings.rewriteMode === "local") {
    throw new RequestError("当前标签页为本地模式；请切换为 AI 改写后再手动使用 AI 翻译", {
      code: "AI_NOT_CONFIGURED", retryable: false, errorType: "AUTH_ERROR",
    });
  }
  let endpoint = String(settings.aiEndpoint || "").trim();
  const model = String(settings.aiModel || "").trim();
  const apiKey = String(localSecrets.aiApiKey || "").trim();
  if (!endpoint || !model || !apiKey) {
    throw new RequestError("主 AI 接口未配置完整，无法手动翻译", {
      code: "AI_NOT_CONFIGURED", retryable: false, errorType: "AUTH_ERROR",
    });
  }
  endpoint = normalizeAiEndpoint(endpoint);
  const requestBody = {
    model,
    temperature: 0,
    max_tokens: 1024,
    stream: false,
    messages: [
      {
        role: "system",
        content: [
          "Translate the supplied article title into concise, natural Simplified Chinese.",
          "Preserve the exact meaning, numbers and proper nouns. Do not summarize, explain or add facts.",
          "Return exactly one strict JSON object and nothing else: {\"translation\":\"...\"}",
        ].join("\n"),
      },
      { role: "user", content: text },
    ],
  };
  configureThinking(requestBody, model, endpoint, settings.thinkingLevel);
  const timeout = clampNumber(settings.aiTimeoutMs, 30000, 5000, 120000);
  let response;
  try {
    response = await fetchAiJson(endpoint, {
      method: "POST",
      headers: aiHeaders(apiKey),
      body: JSON.stringify(requestBody),
    }, timeout, "标题 AI 翻译", { attempt: 1, model });
  } catch (error) {
    if (requiresCompletionTokenFieldFallback(error)) {
      applyCompletionBudget(requestBody, 1024, "max_completion_tokens");
      response = await fetchAiJson(endpoint, {
        method: "POST",
        headers: aiHeaders(apiKey),
        body: JSON.stringify(requestBody),
      }, timeout, "标题 AI 翻译", { attempt: 1, model });
    } else throw error;
  }
  const { data, diagnostic } = response;
  if (isOutputTruncated(data)) {
    throw new OutputTruncatedError(describeEmptyAiResponse(data), { model, diagnostic, diagnostics: [diagnostic] });
  }
  const content = getAiResponseText(data).trim();
  let titleZh = "";
  try { titleZh = String(extractJson(content).translation || "").trim(); }
  catch { titleZh = content.replace(/^```(?:json)?\s*|\s*```$/gi, "").replace(/^['\"`]+|['\"`]+$/g, "").trim(); }
  if (!titleZh || !/\p{Script=Han}/u.test(titleZh)) {
    throw new RequestError("AI 没有返回有效的中文标题翻译", {
      code: "AI_INVALID", retryable: false, errorType: "AI_INVALID", model,
      diagnostic, diagnostics: [diagnostic],
    });
  }
  return { titleZh, translation: titleZh, model, diagnostics: [diagnostic] };
}

function decodeHtmlEntities(value) {
  const named = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
    ndash: "–", mdash: "—", hellip: "…", laquo: "«", raquo: "»",
  };
  return String(value || "")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (match, name) => named[name.toLowerCase()] ?? match);
}

function htmlToReadableText(html) {
  return decodeHtmlEntities(String(html || "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg|canvas)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(br|\/p|\/div|\/li|\/article|\/section|\/h[1-6]|\/tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " "))
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function fetchArticle(payload = {}) {
  const url = payload.url || payload.sourceUrl;
  const articleUrl = validateHttpUrl(url, "文章地址");
  const credentials = articleUrl.hostname.toLowerCase() === "lockscreen-admin.mofeeds.com" ? "include" : "omit";
  const timeout = clampNumber(payload.timeoutMs, 25000, 5000, 60000);
  const response = await fetchResponse(articleUrl.href, {
    credentials,
    headers: {
      Accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.8,*/*;q=0.2",
      "Accept-Language": "en,zh-CN;q=0.9,*;q=0.8",
    },
  }, timeout, "文章");
  if (!response.ok) {
    throw new RequestError(`文章读取失败（${response.status}）`, {
      status: response.status,
      retryable: response.status === 408 || response.status === 429 || response.status >= 500,
    });
  }
  const contentType = response.headers.get("content-type") || "";
  const declaredLength = Number(response.headers.get("content-length")) || 0;
  if (declaredLength > 5 * 1024 * 1024) throw new Error("文章页面超过 5MB，已停止读取");
  if (/^(image|audio|video)\//i.test(contentType) || /application\/pdf/i.test(contentType)) {
    throw new Error(`文章链接返回了不支持的内容类型：${contentType.split(";")[0]}`);
  }
  const raw = await response.text();
  const html = raw.slice(0, MAX_ARTICLE_HTML_CHARS);
  const text = (/html|xhtml/i.test(contentType) || /<\s*(?:html|body|article|main)\b/i.test(raw))
    ? htmlToReadableText(raw).slice(0, MAX_ARTICLE_TEXT_CHARS)
    : raw.replace(/\s+/g, " ").trim().slice(0, MAX_ARTICLE_TEXT_CHARS);
  if (!text) throw new Error("文章页面已打开，但没有提取到可用正文");
  return {
    url: articleUrl.href,
    finalUrl: response.url || String(url),
    status: response.status,
    contentType,
    html,
    text,
    truncated: raw.length > MAX_ARTICLE_HTML_CHARS || text.length >= MAX_ARTICLE_TEXT_CHARS,
  };
}

function arrayBufferToBase64(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function inferImageMime(url, contentType) {
  const normalized = String(contentType || "").split(";")[0].trim().toLowerCase();
  if (/^image\//.test(normalized)) return normalized;
  const pathname = (() => {
    try { return new URL(url).pathname.toLowerCase(); } catch { return ""; }
  })();
  if (/\.png$/.test(pathname)) return "image/png";
  if (/\.webp$/.test(pathname)) return "image/webp";
  if (/\.gif$/.test(pathname)) return "image/gif";
  if (/\.avif$/.test(pathname)) return "image/avif";
  return "image/jpeg";
}

async function normalizeDownloadedImage(buffer, sourceMime) {
  const mime = String(sourceMime || "").toLowerCase();
  if (["image/jpeg", "image/jpg", "image/png"].includes(mime)) {
    return { buffer, mime: mime === "image/jpg" ? "image/jpeg" : mime, converted: false };
  }
  if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas !== "function") {
    throw new Error(`素材返回 ${mime || "未知格式"}，当前浏览器无法转换为 JPEG；请更新 Chrome / Edge 后重试`);
  }
  let bitmap;
  try {
    bitmap = await createImageBitmap(new Blob([buffer], { type: mime }));
    if (!bitmap.width || !bitmap.height) throw new Error("图片尺寸无效");
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("无法创建图片转换画布");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, bitmap.width, bitmap.height);
    context.drawImage(bitmap, 0, 0);
    const jpeg = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.94 });
    if (!jpeg.size || jpeg.type !== "image/jpeg") throw new Error("JPEG 编码结果为空");
    return { buffer: await jpeg.arrayBuffer(), mime: "image/jpeg", converted: true };
  } catch (error) {
    throw new Error(`素材为 ${mime || "未知格式"}，转换 JPEG 失败：${error.message}`);
  } finally {
    bitmap?.close?.();
  }
}

async function fetchImageFile(payload = {}) {
  const url = payload.url || payload.imageUrl || payload.image?.uploadUrl || payload.image?.originalUrl || payload.image?.imageUrl;
  const response = await fetchResponse(url, {
    headers: { Accept: "image/jpeg,image/png;q=0.9,image/*;q=0.5,*/*;q=0.1" },
  }, clampNumber(payload.timeoutMs, 45000, 5000, 120000), "图片");
  if (!response.ok) throw new Error(`图片读取失败（${response.status}）`);
  const declaredLength = Number(response.headers.get("content-length")) || 0;
  if (declaredLength > MAX_IMAGE_BYTES) throw new Error("图片超过 24MB，无法写入上传控件");
  const sourceBuffer = await response.arrayBuffer();
  if (!sourceBuffer.byteLength) throw new Error("下载到的图片为空");
  if (sourceBuffer.byteLength > MAX_IMAGE_BYTES) throw new Error("图片超过 24MB，无法写入上传控件");
  const sourceMime = inferImageMime(url, response.headers.get("content-type"));
  if (!/^image\//.test(sourceMime)) throw new Error("下载地址返回的不是图片");
  const normalized = await normalizeDownloadedImage(sourceBuffer, sourceMime);
  const { buffer, mime } = normalized;
  if (buffer.byteLength > MAX_IMAGE_BYTES) throw new Error("转换后的图片超过 24MB，无法下载");
  const fallbackName = `lockscreen-image.${extensionForMime(mime)}`;
  const generatedImageMeta = { ...(payload.item?.image || {}), ...(payload.image || {}), mime };
  const generatedName = payload.item
    ? buildFinalImageName(payload.item, generatedImageMeta)
    : fallbackName;
  const fileName = fileNameForMime(payload.fileName || generatedName, mime, fallbackName);
  return {
    dataUrl: `data:${mime};base64,${arrayBufferToBase64(buffer)}`,
    mime,
    mimeType: mime,
    size: buffer.byteLength,
    fileName,
    sourceUrl: String(url),
    sourceMime,
    converted: normalized.converted,
    lastModified: Date.now(),
  };
}

function sanitizePathSegment(value, fallback = "未命名") {
  const cleaned = String(value || "")
    .replace(/[<>:\"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/[. ]+$/g, "")
    .replace(/^\.+/g, "")
    .replace(/-{2,}/g, "-")
    .trim();
  return cleaned || fallback;
}

function sanitizeFileName(value, fallback = "file.txt") {
  const raw = String(value || fallback).replace(/\\/g, "/").split("/").pop();
  return sanitizePathSegment(raw, fallback).slice(0, 190);
}

function sanitizeRelativeFolder(value, fallback) {
  const raw = String(value || fallback || "").trim().replace(/\\/g, "/");
  if (!raw) return "";
  if (raw.startsWith("/") || /^[a-z]:/i.test(raw) || raw.split("/").some((part) => part === "..")) {
    throw new Error("下载目录必须是浏览器“下载”文件夹内的相对子目录，不能使用盘符、绝对路径或 ..");
  }
  return raw
    .split("/")
    .filter((part) => part && part !== ".")
    .map((part) => sanitizePathSegment(part, "未命名目录"))
    .join("/");
}

function joinDownloadPath(folder, fileName) {
  return [folder, fileName].filter(Boolean).join("/");
}

function utf8ToBase64(text) {
  return arrayBufferToBase64(new TextEncoder().encode(text).buffer);
}

async function getBatchSettings() {
  const { settings = {} } = await chrome.storage.sync.get("settings");
  return { ...DEFAULT_BATCH_SETTINGS, ...settings };
}

async function saveTextFile(payload = {}) {
  const settings = await getBatchSettings();
  const folder = sanitizeRelativeFolder(payload.folder, settings.originalFolder);
  const rawValue = payload.text ?? payload.contents ?? payload.data ?? payload.json ?? "";
  const text = typeof rawValue === "string" ? rawValue : JSON.stringify(rawValue, null, 2);
  const size = new TextEncoder().encode(text).byteLength;
  if (size > MAX_TEXT_DOWNLOAD_BYTES) throw new Error("保存内容超过 32MB，请按页面分别导出");
  const mimeType = String(payload.mimeType || "application/json;charset=utf-8");
  const defaultExtension = /json/i.test(mimeType) ? "json" : "txt";
  const defaultName = `锁屏批次-${new Date().toISOString().replace(/[:.]/g, "-")}.${defaultExtension}`;
  const fileName = sanitizeFileName(payload.fileName || defaultName, defaultName);
  const path = joinDownloadPath(folder, fileName);
  const downloadId = await chrome.downloads.download({
    url: `data:${mimeType};base64,${utf8ToBase64(text)}`,
    filename: path,
    conflictAction: "uniquify",
    saveAs: false,
  });
  return { downloadId, path, fileName, size };
}

function chooseDownloadUrl(image = {}, item = {}) {
  const aspectLabel = image.aspectLabel || item.aspectLabel || "9:16";
  return image.selectedUrl || image.uploadUrl || image.downloadUrl || image.originalUrl || image.imageUrl ||
    image.cropUrls?.[aspectLabel] || item.imageUrl || "";
}

function buildFinalImageName(item = {}, image = {}) {
  const numericIndex = clampNumber(item.index ?? item.order ?? item.number, 1, 1, 999);
  const index = String(Math.trunc(numericIndex)).padStart(2, "0");
  const title = sanitizePathSegment(item.title || item.generatedTitle || item.originalTitle || "未命名", "未命名").slice(0, 45);
  const summary = sanitizePathSegment(item.summary || item.generatedSummary || "无简介", "无简介").slice(0, 75);
  const aspectLabel = String(image.aspectLabel || item.aspectLabel || "9:16").replace(":", "x");
  const mime = image.mime || image.mimeType || "image/jpeg";
  const extension = extensionForMime(mime);
  return sanitizeFileName(`${index}-${title}【${summary}】_${aspectLabel}.${extension}`, `${index}-lockscreen_${aspectLabel}.${extension}`);
}

let finalImageFolderReservation = Promise.resolve();

function reserveFinalImageFolder(baseFolder, batchLimit = 30) {
  const size = LSAWorkflow.batchSize(batchLimit);
  const reservation = finalImageFolderReservation.then(async () => {
    const storageKey = "finalImageFolderCounters";
    const stored = await chrome.storage.local.get(storageKey);
    const counters = stored?.[storageKey] && typeof stored[storageKey] === "object"
      ? { ...stored[storageKey] }
      : {};
    const counterKey = size === 30 ? baseFolder : `${baseFolder}|40`;
    const nextNumber = Math.max(0, Number(counters[counterKey]) || 0) + 1;
    counters[counterKey] = nextNumber;
    await chrome.storage.local.set({ [storageKey]: counters });

    const group = Math.ceil(nextNumber / size);
    const first = (group - 1) * size + 1;
    const last = group * size;
    const groupFolder = `第${String(group).padStart(3, "0")}组_${String(first).padStart(3, "0")}-${String(last).padStart(3, "0")}`;
    return {
      folder: joinDownloadPath(baseFolder, groupFolder),
      groupFolder,
      sequenceNumber: nextNumber,
    };
  });
  finalImageFolderReservation = reservation.catch(() => {});
  return reservation;
}

let imageHistoryChain = Promise.resolve();
function withImageHistory(task) {
  const run = imageHistoryChain.then(task);
  imageHistoryChain = run.catch(() => {});
  return run;
}
async function imageHistory(storageKey = "imageHistory") {
  return (await chrome.storage.local.get(storageKey))[storageKey] || {};
}

let duplicateMigrationPromise;
function duplicateEntry(key, image = {}, previous = {}) {
  const known = String(key || "").match(/^(pexels|pixabay):(.+)$/i);
  return {
    markedAt: Number(previous.markedAt || previous.updatedAt) || Date.now(),
    source: String(image.source || image.provider || previous.source || known?.[1] || "unknown").toLowerCase(),
    id: String(image.id || previous.id || known?.[2] || ""),
    url: String(image.originalUrl || image.imageUrl || image.downloadUrl || previous.url || "").slice(0, 4000),
  };
}

async function migrateLegacyDuplicateMarks() {
  const marker = (await chrome.storage.local.get(MANUAL_DUPLICATES_MIGRATED_KEY))[MANUAL_DUPLICATES_MIGRATED_KEY];
  if (marker) return { migrated: false };
  const all = await chrome.storage.local.get(null);
  const manual = all[MANUAL_DUPLICATES_KEY] && typeof all[MANUAL_DUPLICATES_KEY] === "object"
    ? { ...all[MANUAL_DUPLICATES_KEY] }
    : {};
  let migrated = 0;
  for (const [storageKey, history] of Object.entries(all)) {
    if (!/^lsaTab:.*:imageHistory$/.test(storageKey) || !history || typeof history !== "object") continue;
    for (const [key, entry] of Object.entries(history)) {
      if (!entry?.manual || manual[key]) continue;
      manual[key] = duplicateEntry(key, {}, entry);
      migrated += 1;
    }
  }
  await chrome.storage.local.set({
    [MANUAL_DUPLICATES_KEY]: manual,
    [MANUAL_DUPLICATES_MIGRATED_KEY]: { completedAt: Date.now(), migrated },
  });
  return { migrated: true, count: migrated };
}

function ensureDuplicateMigration() {
  duplicateMigrationPromise ||= migrateLegacyDuplicateMarks().catch((error) => {
    duplicateMigrationPromise = null;
    throw error;
  });
  return duplicateMigrationPromise;
}

function validUsageEvents(entry, now = Date.now()) {
  const cutoff = now - USAGE_TTL_MS;
  return (Array.isArray(entry?.events) ? entry.events : [])
    .map(Number)
    .filter((stamp) => Number.isFinite(stamp) && stamp >= cutoff && stamp <= now)
    .sort((left, right) => left - right)
    .slice(-USAGE_EVENT_LIMIT);
}

async function globalImageState(storageKey = "") {
  await ensureDuplicateMigration();
  const keys = [MANUAL_DUPLICATES_KEY, IMAGE_USAGE_KEY];
  if (storageKey) keys.push(storageKey);
  const saved = await chrome.storage.local.get(keys);
  return {
    manual: saved[MANUAL_DUPLICATES_KEY] || {},
    usage: saved[IMAGE_USAGE_KEY] || {},
    local: storageKey ? saved[storageKey] || {} : {},
  };
}

async function getDuplicateLibrary() {
  const { manual, usage } = await globalImageState();
  const bySource = {};
  for (const entry of Object.values(manual)) {
    const source = String(entry?.source || "unknown").toLowerCase();
    bySource[source] = (bySource[source] || 0) + 1;
  }
  return { count: Object.keys(manual).length, bySource, entries: manual, usage };
}

async function exportDuplicateLibrary() {
  const library = await getDuplicateLibrary();
  return {
    format: "lockscreen-manual-duplicates",
    version: 1,
    exportedAt: new Date().toISOString(),
    entries: library.entries,
  };
}

async function importDuplicateLibrary(payload = {}) {
  const data = payload.library || payload.data || payload;
  if (!data || data.format !== "lockscreen-manual-duplicates" || !data.entries || typeof data.entries !== "object") {
    throw new Error("重复标记库格式无效");
  }
  return withImageHistory(async () => {
    await ensureDuplicateMigration();
    const current = (await chrome.storage.local.get(MANUAL_DUPLICATES_KEY))[MANUAL_DUPLICATES_KEY] || {};
    const next = payload.replace ? {} : { ...current };
    for (const [key, raw] of Object.entries(data.entries)) {
      if (!key || key.length > 4000 || key === "__proto__" || !raw || typeof raw !== "object") continue;
      next[key] = duplicateEntry(key, raw, raw);
    }
    await chrome.storage.local.set({ [MANUAL_DUPLICATES_KEY]: next });
    return { count: Object.keys(next).length };
  });
}

async function removeDuplicatesBySource(source) {
  const target = String(source || "").trim().toLowerCase();
  if (!target) throw new Error("请指定素材来源");
  return withImageHistory(async () => {
    await ensureDuplicateMigration();
    const current = (await chrome.storage.local.get(MANUAL_DUPLICATES_KEY))[MANUAL_DUPLICATES_KEY] || {};
    const next = Object.fromEntries(Object.entries(current).filter(([, entry]) => String(entry?.source || "unknown").toLowerCase() !== target));
    await chrome.storage.local.set({ [MANUAL_DUPLICATES_KEY]: next });
    return { removed: Object.keys(current).length - Object.keys(next).length, count: Object.keys(next).length };
  });
}

async function recordImageUsageUnlocked(key, timestamp = Date.now()) {
  if (!key) return { count: 0 };
  const now = Date.now();
  const stamp = Math.min(now, Number.isFinite(Number(timestamp)) ? Number(timestamp) : now);
  const saved = await chrome.storage.local.get(IMAGE_USAGE_KEY);
  const usage = saved[IMAGE_USAGE_KEY] && typeof saved[IMAGE_USAGE_KEY] === "object" ? { ...saved[IMAGE_USAGE_KEY] } : {};
  const events = [...validUsageEvents(usage[key], now), stamp].sort((a, b) => a - b).slice(-USAGE_EVENT_LIMIT);
  usage[key] = { events, lastUsedAt: events.at(-1) || stamp };
  await chrome.storage.local.set({ [IMAGE_USAGE_KEY]: usage });
  return { count: events.length, entry: usage[key] };
}

async function attachGlobalDedupInfo(result = {}, tabId, candidateLimit = 12) {
  const storageKey = Number.isInteger(tabId) ? (await getTabContext(tabId)).keys.imageHistory : "";
  const [{ usageThreshold, usageWindowDays }, global] = await Promise.all([getBatchSettings(), globalImageState(storageKey)]);
  const annotate = (image) => {
    const key = LSAWorkflow.imageKey(image);
    const usageCount = LSAWorkflow.usageEventsInWindow(global.usage[key], usageWindowDays).length;
    return {
      ...image,
      imageKey: key,
      globalManualDuplicate: Boolean(global.manual[key]),
      usageCount,
      usageLimited: usageCount >= Number(usageThreshold || 3),
      localDownloadStatus: global.local[key]?.status || "",
    };
  };
  const items = (result.items || result.images || result.results || []).map(annotate).sort((left, right) => {
    const leftBlocked = Number(left.globalManualDuplicate) * 2 + Number(left.usageLimited);
    const rightBlocked = Number(right.globalManualDuplicate) * 2 + Number(right.usageLimited);
    return leftBlocked - rightBlocked;
  }).slice(0, clampNumber(candidateLimit, 12, 1, 60));
  return { ...result, items };
}

async function rebuildImageUsage(payload = {}) {
  const batch = payload.batch || payload.data || payload;
  if (!batch?.batchId || !Array.isArray(batch.items)) throw new Error("批次结果缺少 batchId 或 items");
  return withImageHistory(async () => {
    const saved = await chrome.storage.local.get([IMAGE_USAGE_KEY, USAGE_REBUILT_BATCHES_KEY]);
    const rebuilt = Array.isArray(saved[USAGE_REBUILT_BATCHES_KEY]) ? [...saved[USAGE_REBUILT_BATCHES_KEY]] : [];
    if (rebuilt.includes(batch.batchId)) return { rebuilt: false, reason: "already_rebuilt" };
    const usage = saved[IMAGE_USAGE_KEY] && typeof saved[IMAGE_USAGE_KEY] === "object" ? { ...saved[IMAGE_USAGE_KEY] } : {};
    const timestamp = Math.min(Date.now(), Number.isFinite(new Date(batch.createdAt).getTime()) ? new Date(batch.createdAt).getTime() : Date.now());
    const additions = new Map();
    for (const item of batch.items) {
      const key = LSAWorkflow.imageKey(item?.image || {});
      if (key && validUsageEvents(usage[key]).length === 0) additions.set(key, (additions.get(key) || 0) + 1);
    }
    let rebuiltImages = 0;
    if (timestamp >= Date.now() - USAGE_TTL_MS) {
      for (const [key, count] of additions) {
        const events = Array(Math.min(USAGE_EVENT_LIMIT, count)).fill(timestamp);
        usage[key] = { events, lastUsedAt: timestamp };
        rebuiltImages += 1;
      }
    }
    const nextRebuilt = [...rebuilt.filter((id) => id !== batch.batchId), batch.batchId].slice(-200);
    await chrome.storage.local.set({ [IMAGE_USAGE_KEY]: usage, [USAGE_REBUILT_BATCHES_KEY]: nextRebuilt });
    return { rebuilt: true, rebuiltImages, rebuiltEvents: [...additions.values()].reduce((sum, count) => sum + count, 0) };
  });
}

async function markDuplicate(payload, tabId) {
  const storageKey = Number.isInteger(tabId) ? (await getTabContext(tabId)).keys.imageHistory : "imageHistory";
  return withImageHistory(async () => {
    await ensureDuplicateMigration();
    const key = LSAWorkflow.imageKey(payload.image);
    if (!key) throw new Error("没有可识别的图片地址");
    const saved = await chrome.storage.local.get([storageKey, MANUAL_DUPLICATES_KEY]);
    const history = saved[storageKey] || {};
    const manual = saved[MANUAL_DUPLICATES_KEY] || {};
    if (payload.marked) {
      manual[key] = duplicateEntry(key, payload.image, manual[key]);
      history[key] = { ...history[key], manual: true, updatedAt: Date.now() };
    } else {
      delete manual[key];
      if (history[key]) history[key] = { ...history[key], manual: false, updatedAt: Date.now() };
    }
    await chrome.storage.local.set({ [storageKey]: history, [MANUAL_DUPLICATES_KEY]: manual });
    return { key, entry: history[key] || {}, globalEntry: manual[key] || null, marked: Boolean(payload.marked) };
  });
}

async function downloadFinalImage(payload = {}, tabId) {
  const tab = Number.isInteger(tabId) ? await getTabContext(tabId) : null;
  const storageKey = tab?.keys.imageHistory || "imageHistory";
  const settings = await getBatchSettings();
  const item = payload.item || {};
  const image = payload.image || {};
  const url = chooseDownloadUrl(image, item);
  if (!/^(https?:\/\/|data:image\/)/i.test(url)) throw new Error("成品图片下载地址无效");
  const key = LSAWorkflow.imageKey(image) || url;
  const global = await globalImageState(storageKey);
  const isLocalDuplicate = (entry) => ["queued", "completed"].includes(entry?.status);
  if (settings.duplicateCheck !== false && !payload.force && global.manual[key]) {
    return { skipped: true, duplicate: true, path: global.local[key]?.path || "", reason: "你已在全局标记为重复" };
  }
  if (settings.duplicateCheck !== false && !payload.force && isLocalDuplicate(global.local[key])) {
    return { skipped: true, duplicate: true, path: global.local[key].path || "", reason: "此图已在当前标签页下载或正在下载" };
  }
  const file = await fetchImageFile({ url, item, image });
  const bytes = Uint8Array.from(atob(file.dataUrl.split(",")[1]), (character) => character.charCodeAt(0));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return withImageHistory(async () => {
  const saved = await chrome.storage.local.get([storageKey, MANUAL_DUPLICATES_KEY]);
  const fresh = saved[storageKey] || {};
  const manual = saved[MANUAL_DUPLICATES_KEY] || {};
  const duplicate = Object.values(fresh).find((entry) => entry.hash === hash && isLocalDuplicate(entry));
  if (settings.duplicateCheck !== false && !payload.force && manual[key]) {
    return { skipped: true, duplicate: true, path: fresh[key]?.path || "", reason: "你已在全局标记为重复" };
  }
  if (settings.duplicateCheck !== false && !payload.force && (isLocalDuplicate(fresh[key]) || duplicate)) {
    return { skipped: true, duplicate: true, path: (duplicate || fresh[key])?.path || "", reason: "图片已存在（素材、地址或文件内容相同）" };
  }
  const baseFolder = joinDownloadPath(sanitizeRelativeFolder(payload.folder, settings.imageFolder), payload.batchFolder ? sanitizePathSegment(payload.batchFolder, "未命名批次") : tab?.folder || "");
  const allocation = await reserveFinalImageFolder(baseFolder, payload.batchLimit);
  const folder = allocation.folder;
  const fileName = sanitizeFileName(payload.fileName || file.fileName, "lockscreen-image.jpg");
  const path = joinDownloadPath(folder, fileName);
  const downloadId = await chrome.downloads.download({
    url: file.dataUrl,
    filename: path,
    conflictAction: "uniquify",
    saveAs: false,
  });
  fresh[key] = { ...fresh[key], manual: Boolean(fresh[key]?.manual), hash, path, downloadId, status: "queued", usageRecordedAt: 0, updatedAt: Date.now() };
  await chrome.storage.local.set({ [storageKey]: fresh, [`lsaDownload:${downloadId}`]: { storageKey, key } });
  return { downloadId, path, fileName, url, ...allocation };
  });
}

chrome.downloads.onChanged?.addListener((delta) => {
  if (!delta.state || !["complete", "interrupted"].includes(delta.state.current)) return;
  withImageHistory(async () => {
    const record = (await chrome.storage.local.get(`lsaDownload:${delta.id}`))[`lsaDownload:${delta.id}`];
    if (!record) return;
    const history = await imageHistory(record.storageKey);
    for (const [key, entry] of Object.entries(history)) {
      if (entry.downloadId !== delta.id) continue;
      entry.status = delta.state.current === "complete" ? "completed" : "interrupted";
      entry.updatedAt = Date.now();
      if (delta.state.current === "complete" && !entry.usageRecordedAt) {
        await recordImageUsageUnlocked(record.key || key, Date.now());
        entry.usageRecordedAt = Date.now();
      }
    }
    await chrome.storage.local.set({ [record.storageKey]: history });
  }).catch(() => {});
});

async function reconcileImageDownloads(tabId) {
  if (!Number.isInteger(tabId)) throw new Error("未识别到当前标签页");
  const storageKey = (await getTabContext(tabId)).keys.imageHistory;
  return withImageHistory(async () => {
    const history = await imageHistory(storageKey);
    let completed = 0;
    let interrupted = 0;
    for (const [key, entry] of Object.entries(history)) {
      if (entry?.status !== "queued") continue;
      let matches = [];
      if (Number.isInteger(entry.downloadId) && typeof chrome.downloads.search === "function") {
        try { matches = await chrome.downloads.search({ id: entry.downloadId }); } catch { matches = []; }
      }
      const download = matches[0];
      if (!download) {
        entry.status = "interrupted";
        entry.updatedAt = Date.now();
        interrupted += 1;
      } else if (download.state === "complete") {
        entry.status = "completed";
        entry.updatedAt = Date.now();
        if (!entry.usageRecordedAt) {
          await recordImageUsageUnlocked(key, Number(download.endTime ? new Date(download.endTime).getTime() : Date.now()));
          entry.usageRecordedAt = Date.now();
        }
        completed += 1;
      } else if (download.state === "interrupted") {
        entry.status = "interrupted";
        entry.updatedAt = Date.now();
        interrupted += 1;
      }
    }
    await chrome.storage.local.set({ [storageKey]: history });
    return { completed, interrupted, history };
  });
}

function workLock(action, token, tabId) {
  return queueWorkLock(async () => {
    const storageKey = (await getTabContext(tabId)).keys.workLease;
    const workLease = (await chrome.storage.local.get(storageKey))[storageKey];
    const active = workLease && workLease.expiresAt > Date.now();
    const owns = active && workLease.token === token && workLease.tabId === tabId;
    if (action === "status") return { active: Boolean(active), owns: Boolean(owns) };
    if (action === "release") {
      if (owns) await chrome.storage.local.set({ [storageKey]: null });
      return { active: false };
    }
    if ((action === "renew" && !owns) || (active && !owns)) throw new Error("当前标签页仍有任务正在处理，请稍后重试；其他标签页可以独立运行");
    await chrome.storage.local.set({ [storageKey]: { token, tabId, expiresAt: Date.now() + 30000 } });
    return { active: true, owns: true };
  });
}

async function downloadImage(url, fileName) {
  if (!/^https?:\/\//i.test(url || "")) throw new Error("图片下载地址无效");
  const safeName = sanitizeFileName(fileName || "stock-image.jpg", "stock-image.jpg");
  const downloadId = await chrome.downloads.download({
    url,
    filename: `锁屏素材/${safeName}`,
    conflictAction: "uniquify",
    saveAs: false,
  });
  return { downloadId };
}

function respondAsync(sendResponse, promise, fallbackMessage) {
  Promise.resolve(promise)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({
      ok: false,
      error: cleanErrorMessage(error, fallbackMessage),
      code: error?.code || "",
      status: Number(error?.status) || 0,
      requestUrl: error?.requestUrl || "",
      errorType: error?.errorType || classifyAiError({ status: error?.status, code: error?.code }),
      model: error?.model || "",
      attempts: Number(error?.attempts) || 0,
      diagnostics: Array.isArray(error?.diagnostics) ? error.diagnostics : error?.diagnostic ? [error.diagnostic] : [],
      usedFallbackModel: Boolean(error?.usedFallbackModel),
    }));
  return true;
}

chrome.runtime.onMessage.addListener((message = {}, _sender, sendResponse) => {
  const action = message.action || message.type;
  if (action === "GET_TAB_CONTEXT") return respondAsync(sendResponse, getTabContext(_sender.tab?.id), "标签页识别失败");
  if (action === "LIST_SAVED_BATCHES") return respondAsync(sendResponse, savedBatches(), "读取已存批次失败");
  if (action === "WORK_LOCK") return respondAsync(sendResponse, workLock(message.operation, message.token, _sender.tab?.id), "批次正在使用");
  if (action === "MARK_IMAGE_DUPLICATE") return respondAsync(sendResponse, markDuplicate(message, _sender.tab?.id), "重复标记失败");
  if (action === "GET_DUPLICATE_LIBRARY") return respondAsync(sendResponse, getDuplicateLibrary(), "读取全局重复标记库失败");
  if (action === "IMPORT_DUPLICATE_LIBRARY") return respondAsync(sendResponse, importDuplicateLibrary(message), "导入全局重复标记库失败");
  if (action === "REMOVE_DUPLICATES_BY_SOURCE") return respondAsync(sendResponse, removeDuplicatesBySource(message.source), "解除来源标记失败");
  if (action === "REBUILD_IMAGE_USAGE") return respondAsync(sendResponse, rebuildImageUsage(message), "重建图片使用记录失败");
  if (action === "RECONCILE_IMAGE_DOWNLOADS") return respondAsync(sendResponse, reconcileImageDownloads(_sender.tab?.id), "下载状态对账失败");
  if (action === "EXPORT_DUPLICATE_LIBRARY") {
    const run = async () => {
      const library = await exportDuplicateLibrary();
      if (!message.download) return { library };
      const settings = await getBatchSettings();
      const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
      const saved = await saveTextFile({ folder: settings.originalFolder, fileName: `全局重复标记库_${stamp}.json`, text: JSON.stringify(library, null, 2) });
      return { library, ...saved };
    };
    return respondAsync(sendResponse, run(), "导出全局重复标记库失败");
  }

  if (action === "OPEN_IMAGE_SEARCH") {
    openImageSearch(message.engine, message.query);
    sendResponse({ ok: true });
    return false;
  }

  if (action === "OPEN_VISUAL_SEARCH") {
    openVisualSearch(message.imageUrl);
    sendResponse({ ok: true });
    return false;
  }

  if (action === "OPEN_OPTIONS") {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return false;
  }

  if (action === "SEARCH_STOCK_IMAGES") {
    return respondAsync(sendResponse, searchStockImages(message.source, message.query, message.page)
      .then((result) => attachGlobalDedupInfo(result, _sender.tab?.id, message.candidateLimit)), "素材搜索失败");
  }

  if (action === "SEARCH_PEXELS_BATCH" || action === "SEARCH_BATCH_IMAGES") {
    return respondAsync(
      sendResponse,
      searchBatchImages(message.query, message.preferredRatio, message.page || 1, message.source, Boolean(message.bangladeshMode))
        .then((result) => attachGlobalDedupInfo(result, _sender.tab?.id, message.candidateLimit)),
      "批量竖屏图片搜索失败",
    );
  }

  if (action === "DOWNLOAD_IMAGE") {
    return respondAsync(sendResponse, downloadImage(message.url, message.fileName), "图片下载失败");
  }

  if (action === "GENERATE_IMAGE_QUERY") {
    return respondAsync(sendResponse, generateImageQueryWithAi(message, _sender.tab?.id), "英文图片关键词生成失败");
  }

  if (action === "DETECT_SOURCE_LANGUAGE") {
    const normalizedHint = normalizeLanguageCode(message.hint);
    const hinted = SUPPORTED_LANGUAGE_CODES.has(normalizedHint) ? normalizedHint : "";
    const detected = detectSourceLanguage(message.text);
    sendResponse({ ok: true, ...detected, code: hinted || detected.code, hinted: Boolean(hinted) });
    return false;
  }

  if (action === "GET_AI_TRANSLATION_STATUS") {
    return respondAsync(sendResponse, getAiTranslationStatus(_sender.tab?.id), "读取 AI 翻译状态失败");
  }

  if (action === "TRANSLATE_TEXT") {
    return respondAsync(sendResponse, translateTextWithAi(message, _sender.tab?.id), "标题 AI 翻译失败");
  }

  if (action === "AI_PROCESS_ITEM") {
    return respondAsync(sendResponse, generateBatchItemWithAi(message, _sender.tab?.id), "AI 改写失败");
  }

  if (action === "FETCH_ARTICLE") {
    return respondAsync(sendResponse, fetchArticle(message), "文章读取失败");
  }

  if (action === "FETCH_IMAGE_FILE") {
    return respondAsync(sendResponse, fetchImageFile(message), "图片读取失败");
  }

  if (action === "SAVE_TEXT_FILE") {
    const save = async () => {
      const tab = await getTabContext(_sender.tab?.id);
      const settings = await getBatchSettings();
      return saveTextFile({ ...message, folder: joinDownloadPath(sanitizeRelativeFolder(message.folder, settings.originalFolder), message.batchFolder ? sanitizePathSegment(message.batchFolder, "未命名批次") : tab.folder) });
    };
    return respondAsync(sendResponse, save(), "内容文件保存失败");
  }

  if (action === "DOWNLOAD_FINAL_IMAGE") {
    return respondAsync(sendResponse, downloadFinalImage(message, _sender.tab?.id), "成品图片下载失败");
  }

  return false;
});
