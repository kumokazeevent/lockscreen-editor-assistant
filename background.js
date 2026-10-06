importScripts("workflow.js");
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
  duplicateCheck: true,
  aiTimeoutMs: 30000,
  preferredRatio: "auto",
  originalFolder: "锁屏批次/原始内容",
  imageFolder: "锁屏批次/成品图片",
};

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
  return Object.fromEntries(["titleLimit", "summaryLimit", "rewriteMode", "thinkingLevel", "batchConcurrency", "batchLimit"].filter((key) => saved[key] !== undefined).map((key) => [key, saved[key]]));
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

const EXPOSED_SKIN_TERMS = [
  "nude", "nudity", "naked", "topless", "shirtless", "lingerie", "underwear", "bikini",
  "swimsuit", "swimwear", "cleavage", "erotic", "boudoir", "seductive", "sexy",
];
const FRONTAL_FACE_TERMS = [
  "headshot", "selfie", "looking at camera", "facing camera", "front portrait", "close-up face",
  "close up face", "facial portrait",
];
const SAFE_PERSON_POSE_TERMS = [
  "side profile", "profile view", "back view", "from behind", "silhouette", "shadow", "rear view",
];
const PERSON_TERMS = [
  "person", "people", "woman", "women", "man", "men", "girl", "boy", "child", "adult", "model",
  "lady", "gentleman", "couple", "family", "worker", "traveler", "traveller",
];

function inspectImageMetadataSafety(item) {
  const text = `${item.title || ""} ${item.attribution || ""}`.toLowerCase();
  const exposure = EXPOSED_SKIN_TERMS.find((term) => text.includes(term));
  if (exposure) {
    return { safetyStatus: "rejected", safetyReason: `元数据含高裸露风险词：${exposure}` };
  }
  const frontal = FRONTAL_FACE_TERMS.find((term) => text.includes(term));
  if (frontal) {
    return { safetyStatus: "rejected", safetyReason: `元数据显示可能为正脸特写：${frontal}` };
  }
  const safePose = SAFE_PERSON_POSE_TERMS.find((term) => text.includes(term));
  if (safePose) {
    return { safetyStatus: "passed", safetyReason: `元数据显示为可用人物姿态：${safePose}` };
  }
  if (PERSON_TERMS.some((term) => new RegExp(`\\b${term}\\b`, "i").test(text))) {
    return {
      safetyStatus: "review",
      safetyReason: "图片包含人物，元数据无法确认是否正脸或裸露，请在上传前看缩略图复核",
    };
  }
  return { safetyStatus: "passed", safetyReason: "元数据未发现正脸或高裸露风险词" };
}

function enrichAndRankImages(items, preferredRatio = "auto", limit = 12) {
  return items
    .filter(isPortraitImage)
    .map((item) => {
      const aspect = getNearestAspect(item.width, item.height, preferredRatio);
      const safety = inspectImageMetadataSafety(item);
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

function buildSafeStockQuery(query) {
  const base = String(query || "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!base) throw new Error("请输入图片搜索词");
  const lower = base.toLowerCase();
  const humanQueryTerms = [
    ...PERSON_TERMS,
    "president", "politician", "leader", "doctor", "teacher", "farmer", "athlete", "singer",
    "actor", "actress", "tourist", "mother", "father", "crowd", "pedestrian", "human",
  ];
  if (!humanQueryTerms.some((term) => new RegExp(`\\b${term}\\b`, "i").test(lower))) return base;
  const additions = ["side profile", "back view", "silhouette", "fully clothed", "wide shot"]
    .filter((term) => !lower.includes(term));
  return `${base} ${additions.join(" ")}`.trim();
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
  url.searchParams.set("query", options.safeQuery ? buildSafeStockQuery(query) : String(query).trim());
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
  const safeQuery = options.safeQuery ? buildSafeStockQuery(query) : String(query).trim();
  const normalizedQuery = Array.from(safeQuery).slice(0, 100).join("");
  const perPage = options.perPage || 20;
  const configuredEndpoint = settings.pixabayEndpoint || "https://pixabay.com/api/";
  const cacheKey = `v3|${configuredEndpoint}|${normalizedQuery.toLowerCase()}|${page}|${perPage}`;
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

async function searchBatchImages(query, preferredRatio = "auto", page = 1, source = "") {
  if (!String(query || "").trim()) throw new Error("AI 未生成可用的英文图片关键词");
  const ratio = normalizePreferredRatio(preferredRatio);
  if (["pexels", "pixabay"].includes(source)) {
    const result = await (source === "pexels" ? searchPexels : searchPixabay)(query, page, { safeQuery: true, perPage: 60, timeout: 30000 });
    return { ...result, preferredRatio: ratio, items: enrichAndRankImages(result.items, ratio, 12) };
  }
  let pexelsError = null;
  try {
    const pexels = await searchPexels(query, page, { safeQuery: true, perPage: 60, timeout: 30000 });
    const items = enrichAndRankImages(pexels.items, ratio, 12);
    if (items.length) return { ...pexels, preferredRatio: ratio, items, fallbackUsed: false };
    pexelsError = new Error("Pexels 没有返回符合竖屏和安全规则的图片");
  } catch (error) {
    pexelsError = error;
  }

  try {
    const pixabay = await searchPixabay(query, page, { safeQuery: true, perPage: 60, timeout: 30000 });
    const items = enrichAndRankImages(pixabay.items, ratio, 12);
    if (!items.length) throw new Error("Pixabay 也没有返回符合竖屏和安全规则的图片");
    return {
      ...pixabay,
      preferredRatio: ratio,
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
  const text = String(value || "").trim().toLowerCase();
  if (!text) return "";
  const containsRules = [
    ["vi", /vietnamese|越南语|越南|\bvie?\b/i],
    ["es", /spanish|español|西班牙语|西班牙|\bes\b|\bspa\b/i],
    ["en", /english|英语|英文|\ben\b|\beng\b/i],
    ["ru", /russian|русский|俄语|俄文|\bru\b|\brus\b/i],
    ["be", /belarusian|беларуская|白俄罗斯语|\bbe\b|\bbel\b/i],
    ["ar", /arabic|العربية|阿拉伯语|阿拉伯文|\bar\b|\bara\b/i],
    ["it", /italian|italiano|意大利语|\bit\b|\bita\b/i],
    ["zh", /chinese|中文|汉语|華語|\bzh\b|\bzho\b/i],
  ];
  for (const [code, pattern] of containsRules) {
    if (pattern.test(text)) return code;
  }
  return text.slice(0, 12);
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
  const choice = data?.choices?.[0];
  return choice?.finish_reason === "length" &&
    !normalizeAiContent(choice?.message?.content).trim() &&
    Boolean(normalizeAiContent(choice?.message?.reasoning_content).trim());
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

function buildAiMessages(context, correction = "") {
  const languageInstruction = context.expectedLanguage
    ? `The input language is ${context.expectedLanguage.toUpperCase()}. The title and summary MUST stay in that language.`
    : "Detect the title's original language first. The title and summary MUST stay in that language and MUST NOT default to Chinese or English.";
  const system = [
    "You are a professional lock-screen magazine title and description editor.",
    LSAWorkflow.wordPrompt(context.rewritePrompt)
      .replaceAll("{titleLimit}", String(context.titleLimit)).replaceAll("{summaryLimit}", String(context.summaryLimit)),
    "Shorten the supplied title and description by rewriting them naturally. Do not merely cut off the text.",
    "KEEP THE ORIGINAL LANGUAGE: use exactly the same language as the input title. Never translate the title or summary.",
    `TITLE: at most ${context.titleLimit} words. Count written words, NOT letters or characters. Spaces and punctuation do not count. Hyphenated compounds and contractions are one word; numbers are words.`,
    "Preserve the core topic, meaning and most important keywords. Keep important names, places and technical terms when possible.",
    "If the original title is already within the limit and reads naturally, preserve it unchanged.",
    "Never change a stated number of methods, steps, tips or items into a smaller or different number.",
    `SUMMARY: at most ${context.summaryLimit} words. Preserve the original meaning and key information.`,
    "Remove repetition, background details and excessive modifiers. Do not invent any information.",
    languageInstruction,
    "IMAGE QUERY: image_query_en must be 5 to 12 concrete English visual keywords derived directly from the ORIGINAL title, description and article text, never guessed from the shortened title.",
    "For people, prefer side profile, back view, silhouette, fully clothed subjects or wide shots. Avoid frontal close-ups, selfies, swimwear, nudity, exposed skin and sexualized poses. Prefer objects or scenery when people are unnecessary.",
    "LANGUAGE CODE: language must be the ISO 639-1 two-letter code of the original title, such as en, vi, es, ru, be, ar or it.",
    "MANDATORY FINAL CHECK: count words in the title and summary before answering. For Vietnamese count space-separated written words/syllables; for Chinese and other unspaced writing use natural word segmentation.",
    "Keep internal reasoning concise and reserve enough output budget for the final JSON answer.",
    `If title exceeds ${context.titleLimit} words, rewrite it shorter and count again. If summary exceeds ${context.summaryLimit} words, rewrite it shorter and count again.`,
    "Never exceed either limit. Further shortening is always preferable to exceeding a limit.",
    "Return exactly one strict JSON object with no Markdown, labels, explanations, analysis or word counts:",
    '{"title":"...","summary":"...","image_query_en":"...","language":"..."}',
    correction ? `PREVIOUS ATTEMPT FAILED: ${correction}. Correct this failure before returning the new JSON.` : "",
  ].filter(Boolean).join("\n");
  const user = [
    `原始标题：${context.originalTitle}`,
    `原始简介：${context.originalSummary || "（无）"}`,
    `原始文章正文：${context.articleText || "（未抓取到正文，请仅依据原始标题和原始简介）"}`,
  ].join("\n\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
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
          "Compare the candidate with the original title and description. Correct the candidate whenever needed.",
          `The final title MUST use the original language and contain at most ${context.titleLimit} words. Count words, not letters. Spaces and punctuation do not count. Contractions and hyphenated words count as one.`,
          `The final summary MUST use the original language and contain at most ${context.summaryLimit} words.`,
          "Preserve the core meaning, important proper nouns and every stated number of methods, steps, tips or items. Do not invent facts.",
          "image_query_en must remain a concrete English stock-photo query based on the original material.",
          "Count the words in title and summary before replying. Rewrite and recount until both word limits are satisfied.",
          "Review quickly and directly. Do not provide analysis or explanations.",
          "Return exactly one strict JSON object and nothing else:",
          '{"title":"...","summary":"...","image_query_en":"...","language":"..."}',
        ].join("\n"),
      },
      {
        role: "user",
        content: JSON.stringify({
          original_title: context.originalTitle,
          original_summary: context.originalSummary,
          original_article: context.articleText,
          candidate,
        }),
      },
    ],
  };
  disableThinking(requestBody, model, endpoint);
  const data = await fetchJson(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(requestBody),
  }, timeout, "审核 AI");
  const content = getAiResponseText(data);
  if (!content) {
    throw new RequestError(describeEmptyAiResponse(data), {
      code: "REVIEW_AI_INVALID",
      retryable: false,
    });
  }
  return validateAiResult(extractJson(content), context);
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
  const detected = detectSourceLanguage(`${originalTitle} ${originalSummary}`);
  const hintedLanguage = normalizeLanguageCode(item.languageHint || item.language || payload.languageHint);
  const expectedLanguage = hintedLanguage || (detected.confidence >= 0.55 ? detected.code : "");
  const context = {
    originalTitle,
    originalSummary,
    articleText: String(item.articleText || "").replace(/\s+/g, " ").trim().slice(0, MAX_AI_ARTICLE_CHARS),
    expectedLanguage,
    rewritePrompt,
    titleLimit: clampNumber(payload.titleLimit ?? settings.titleLimit, 12, 1, 100),
    summaryLimit: clampNumber(payload.summaryLimit ?? settings.summaryLimit, 50, 1, 500),
  };
  const timeout = clampNumber(payload.timeoutMs ?? settings.aiTimeoutMs, 30000, 5000, 120000);
  const maxRetries = clampNumber(payload.maxRetries, 2, 0, 2);
  let lastError;
  let attemptsMade = 0;
  let outputTokenBudget = 4096;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    attemptsMade = attempt + 1;
    const requestBody = {
      model,
      temperature: 0.1,
      max_tokens: outputTokenBudget,
      stream: false,
      messages: buildAiMessages(context, attempt > 0 ? cleanErrorMessage(lastError, "The previous output was invalid") : ""),
    };
    configureThinking(requestBody, model, endpoint, settings.thinkingLevel);
    try {
      const data = await fetchJson(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(requestBody),
      }, timeout, "AI 改写");
      const content = getAiResponseText(data);
      if (!content) {
        const truncated = isReasoningTruncated(data);
        throw new RequestError(describeEmptyAiResponse(data), {
          code: truncated ? "REASONING_TRUNCATED" : "AI_INVALID",
          retryable: truncated,
        });
      }
      const candidate = extractJson(content);
      let primaryResult;
      let primaryError;
      try {
        primaryResult = validateAiResult(candidate, context);
      } catch (error) {
        primaryError = error;
      }
      let result = primaryResult;
      let reviewed = false;
      let reviewWarning = "";
      if (settings.reviewAiEnabled) {
        try {
          result = await reviewAiCandidate(candidate, context, settings, localSecrets, timeout);
          reviewed = true;
        } catch (reviewError) {
          if (!primaryResult) {
            throw new RequestError(
              `审核 AI 未能修正不合格的主 AI 结果：${cleanErrorMessage(reviewError, "审核失败")}；主 AI：${cleanErrorMessage(primaryError, "结果未通过校验")}`,
              { code: reviewError?.code || "REVIEW_AI_FAILED", status: reviewError?.status, retryable: false },
            );
          }
          result = primaryResult;
          reviewWarning = `审核 AI 未完成，已使用通过本地校验的主 AI 结果：${cleanErrorMessage(reviewError, "审核失败")}`;
        }
      } else if (!primaryResult) {
        throw primaryError;
      }
      return {
        configured: true,
        result,
        title: result.title,
        summary: result.summary,
        image_query_en: result.image_query_en,
        imageQueryEn: result.image_query_en,
        language: result.language,
        reviewed,
        reviewWarning,
        attempts: attemptsMade,
      };
    } catch (error) {
      lastError = error;
      if (error?.code === "REASONING_TRUNCATED") outputTokenBudget = 8192;
      if (attempt >= maxRetries || !shouldRetry(error)) break;
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
  const timeoutHint = lastError?.code === "TIMEOUT"
    ? "；为避免连续等待约 90 秒，超时不会自动重复请求，可稍后点击重试"
    : "";
  throw new RequestError(
    `AI 改写失败（已尝试 ${attemptsMade} 次）：${cleanErrorMessage(lastError, "上游接口不可用")}${timeoutHint}`,
    {
      code: lastError?.code || "AI_FAILED",
      status: lastError?.status,
      requestUrl: lastError?.requestUrl,
      retryable: false,
    },
  );
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
    messages: [
      {
        role: "system",
        content: [
          "Convert the ORIGINAL article title and summary into a precise stock-photo search query.",
          "Return 5 to 10 concrete English visual keywords describing visible subject, named place, object, action, scene and atmosphere.",
          "Prefer side profile, back view, silhouette, fully clothed subjects or wide shots. Avoid frontal faces, selfies, swimwear, nudity and excessive exposed skin.",
          "Preserve visually relevant proper nouns. Do not use abstract words such as news, article, report or photography.",
          "Return strict JSON only: {\"image_query_en\":\"...\"}",
        ].join("\n"),
      },
      { role: "user", content: `${String(payload.title || "")}\n${String(payload.summary || "")}`.trim() },
    ],
  };
  configureThinking(requestBody, model, endpoint, settings.thinkingLevel || "medium");
  const data = await fetchJson(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(requestBody),
  }, clampNumber(settings.aiTimeoutMs, 30000, 5000, 120000), "英文图片关键词生成");
  const generated = extractJson(getAiResponseText(data));
  return {
    configured: true,
    imageQueryEn: String(generated.image_query_en || "").trim(),
  };
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

function extensionForMime(mime) {
  return ({
    "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png", "image/webp": "webp",
    "image/gif": "gif", "image/avif": "avif",
  })[String(mime || "").toLowerCase()] || "jpg";
}

async function fetchImageFile(payload = {}) {
  const url = payload.url || payload.imageUrl || payload.image?.uploadUrl || payload.image?.originalUrl || payload.image?.imageUrl;
  const response = await fetchResponse(url, {
    headers: { Accept: "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8" },
  }, clampNumber(payload.timeoutMs, 45000, 5000, 120000), "图片");
  if (!response.ok) throw new Error(`图片读取失败（${response.status}）`);
  const declaredLength = Number(response.headers.get("content-length")) || 0;
  if (declaredLength > MAX_IMAGE_BYTES) throw new Error("图片超过 24MB，无法写入上传控件");
  const buffer = await response.arrayBuffer();
  if (!buffer.byteLength) throw new Error("下载到的图片为空");
  if (buffer.byteLength > MAX_IMAGE_BYTES) throw new Error("图片超过 24MB，无法写入上传控件");
  const mime = inferImageMime(url, response.headers.get("content-type"));
  if (!/^image\//.test(mime)) throw new Error("下载地址返回的不是图片");
  const fallbackName = `lockscreen-image.${extensionForMime(mime)}`;
  const generatedImageMeta = { ...(payload.item?.image || {}), ...(payload.image || {}), mime };
  const generatedName = payload.item
    ? buildFinalImageName(payload.item, generatedImageMeta)
    : fallbackName;
  const fileName = sanitizeFileName(payload.fileName || generatedName, fallbackName);
  return {
    dataUrl: `data:${mime};base64,${arrayBufferToBase64(buffer)}`,
    mime,
    mimeType: mime,
    size: buffer.byteLength,
    fileName,
    sourceUrl: String(url),
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
async function markDuplicate(payload, tabId) {
  const storageKey = Number.isInteger(tabId) ? (await getTabContext(tabId)).keys.imageHistory : "imageHistory";
  return withImageHistory(async () => {
    const key = LSAWorkflow.imageKey(payload.image);
    if (!key) throw new Error("没有可识别的图片地址");
    const history = await imageHistory(storageKey);
    history[key] = { ...history[key], manual: Boolean(payload.marked), updatedAt: Date.now() };
    await chrome.storage.local.set({ [storageKey]: history });
    return { key, entry: history[key] };
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
  const history = await imageHistory(storageKey);
  const isDuplicate = (entry) => entry?.manual || ["queued", "completed"].includes(entry?.status);
  if (settings.duplicateCheck !== false && !payload.force && isDuplicate(history[key])) {
    return { skipped: true, duplicate: true, path: history[key].path || "", reason: history[key].manual ? "你已标记为重复" : "此图已下载或正在下载" };
  }
  const file = await fetchImageFile({ url, item, image });
  const bytes = Uint8Array.from(atob(file.dataUrl.split(",")[1]), (character) => character.charCodeAt(0));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return withImageHistory(async () => {
  const fresh = await imageHistory(storageKey);
  const duplicate = Object.values(fresh).find((entry) => entry.hash === hash && isDuplicate(entry));
  if (settings.duplicateCheck !== false && !payload.force && (isDuplicate(fresh[key]) || duplicate)) {
    return { skipped: true, duplicate: true, path: (duplicate || fresh[key])?.path || "", reason: "图片已存在（素材或文件内容相同）" };
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
  fresh[key] = { ...fresh[key], hash, path, downloadId, status: "queued", updatedAt: Date.now() };
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
    for (const entry of Object.values(history)) {
      if (entry.downloadId === delta.id) entry.status = delta.state.current === "complete" ? "completed" : "interrupted";
    }
    await chrome.storage.local.set({ [record.storageKey]: history });
  }).catch(() => {});
});

let workLockChain = Promise.resolve();
function workLock(action, token, tabId) {
  const run = workLockChain.then(async () => {
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
  workLockChain = run.catch(() => {});
  return run;
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
    }));
  return true;
}

chrome.runtime.onMessage.addListener((message = {}, _sender, sendResponse) => {
  const action = message.action || message.type;
  if (action === "GET_TAB_CONTEXT") return respondAsync(sendResponse, getTabContext(_sender.tab?.id), "标签页识别失败");
  if (action === "LIST_SAVED_BATCHES") return respondAsync(sendResponse, savedBatches(), "读取已存批次失败");
  if (action === "WORK_LOCK") return respondAsync(sendResponse, workLock(message.operation, message.token, _sender.tab?.id), "批次正在使用");
  if (action === "MARK_IMAGE_DUPLICATE") return respondAsync(sendResponse, markDuplicate(message, _sender.tab?.id), "重复标记失败");

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
    return respondAsync(sendResponse, searchStockImages(message.source, message.query, message.page), "素材搜索失败");
  }

  if (action === "SEARCH_PEXELS_BATCH" || action === "SEARCH_BATCH_IMAGES") {
    return respondAsync(
      sendResponse,
      searchBatchImages(message.query, message.preferredRatio, message.page || 1, message.source),
      "批量竖屏图片搜索失败",
    );
  }

  if (action === "DOWNLOAD_IMAGE") {
    return respondAsync(sendResponse, downloadImage(message.url, message.fileName), "图片下载失败");
  }

  if (action === "GENERATE_IMAGE_QUERY") {
    return respondAsync(sendResponse, generateImageQueryWithAi(message, _sender.tab?.id), "英文图片关键词生成失败");
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
