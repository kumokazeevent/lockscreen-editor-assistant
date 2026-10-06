const SEARCH_ENGINES = {
  baidu: (query) =>
    `https://image.baidu.com/search/index?tn=baiduimage&word=${encodeURIComponent(query)}`,
  bing: (query) =>
    `https://www.bing.com/images/search?q=${encodeURIComponent(query)}`,
  google: (query) =>
    `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(query)}`,
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "lockscreen-search-selection",
      title: "用锁屏助手搜索图片：“%s”",
      contexts: ["selection"],
    });
    chrome.contextMenus.create({
      id: "lockscreen-search-image",
      title: "搜索这张图片的相似图片",
      contexts: ["image"],
    });
    chrome.contextMenus.create({
      id: "lockscreen-replace-image",
      title: "在锁屏助手中替换这张图片",
      contexts: ["image"],
    });
  });
});

chrome.action.onClicked.addListener((tab) => {
  if (!tab?.id || !/^https?:/i.test(tab.url || "")) return;
  chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_FLOATING_ASSISTANT" }).catch(() => {});
});

function openImageSearch(engine, query) {
  const buildUrl = SEARCH_ENGINES[engine] || SEARCH_ENGINES.baidu;
  chrome.tabs.create({ url: buildUrl(query.trim()) });
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

async function fetchJson(url, options = {}, timeout = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.detail || payload.error?.message || `请求失败（${response.status}）`);
    }
    return payload;
  } catch (error) {
    if (controller.signal.aborted || error?.name === "AbortError") {
      throw new Error(`接口请求超过 ${Math.ceil(timeout / 1000)} 秒，请稍后重试；这通常是上游服务繁忙或网络较慢`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeOpenverseImage(item) {
  return {
    id: `openverse-${item.id}`,
    source: "openverse",
    previewUrl: item.thumbnail || item.url,
    imageUrl: item.url,
    pageUrl: item.foreign_landing_url || item.detail_url,
    title: item.title || "开放许可图片",
    creator: item.creator || "未知作者",
    creatorUrl: item.creator_url || "",
    license: [item.license?.toUpperCase(), item.license_version].filter(Boolean).join(" "),
    licenseUrl: item.license_url || "https://creativecommons.org/share-your-work/cclicenses/",
    attribution: item.attribution || "",
    width: item.width || 0,
    height: item.height || 0,
    fileName: `openverse-${item.id}.${item.filetype || "jpg"}`,
  };
}

function normalizePexelsImage(item) {
  return {
    id: `pexels-${item.id}`,
    source: "pexels",
    previewUrl: item.src?.medium || item.src?.small,
    imageUrl: item.src?.large2x || item.src?.large || item.src?.original,
    pageUrl: item.url,
    title: item.alt || "Pexels 图片",
    creator: item.photographer || "Pexels 摄影师",
    creatorUrl: item.photographer_url || item.url,
    license: "Pexels License",
    licenseUrl: "https://www.pexels.com/license/",
    attribution: `Photo by ${item.photographer || "photographer"} on Pexels`,
    width: item.width || 0,
    height: item.height || 0,
    fileName: `pexels-${item.id}.jpg`,
  };
}

function normalizePixabayImage(item) {
  return {
    id: `pixabay-${item.id}`,
    source: "pixabay",
    previewUrl: item.webformatURL || item.previewURL,
    imageUrl: item.largeImageURL || item.webformatURL,
    pageUrl: item.pageURL,
    title: item.tags || "Pixabay 图片",
    creator: item.user || "Pixabay 创作者",
    creatorUrl: item.user_id
      ? `https://pixabay.com/users/${encodeURIComponent(item.user || "user")}-${item.user_id}/`
      : item.pageURL,
    license: "Pixabay Content License",
    licenseUrl: "https://pixabay.com/service/license-summary/",
    attribution: `Image by ${item.user || "creator"} via Pixabay`,
    width: item.imageWidth || 0,
    height: item.imageHeight || 0,
    fileName: `pixabay-${item.id}.jpg`,
  };
}

function isPortraitImage(item) {
  return Number(item.height) > Number(item.width);
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

async function searchStockImages(source, query, page = 1) {
  if (!query?.trim()) throw new Error("请输入图片搜索词");

  if (source === "pexels") {
    const { localSecrets = {} } = await chrome.storage.local.get("localSecrets");
    if (!localSecrets.pexelsApiKey) {
      throw new Error("请先在扩展设置中填写免费的 Pexels API Key");
    }
    const url = new URL("https://api.pexels.com/v1/search");
    url.searchParams.set("query", query.trim());
    url.searchParams.set("orientation", "portrait");
    url.searchParams.set("locale", /[\u3400-\u9fff]/.test(query) ? "zh-CN" : "en-US");
    url.searchParams.set("per_page", "12");
    url.searchParams.set("page", String(page));
    const data = await fetchJson(url.href, {
      headers: { Authorization: localSecrets.pexelsApiKey },
    });
    return {
      source,
      page: data.page || page,
      total: data.total_results || 0,
      hasNext: Boolean(data.next_page),
      items: (data.photos || [])
        .map(normalizePexelsImage)
        .filter(isPortraitImage),
    };
  }

  if (source === "pixabay") {
    const { localSecrets = {} } = await chrome.storage.local.get("localSecrets");
    if (!localSecrets.pixabayApiKey) {
      throw new Error("请先在扩展设置中填写免费的 Pixabay API Key");
    }
    const normalizedQuery = Array.from(query.trim()).slice(0, 100).join("");
    const cacheKey = `v1|${normalizedQuery.toLowerCase()}|${page}`;
    const cachedResult = await getCachedPixabaySearch(cacheKey);
    if (cachedResult) return cachedResult;
    const perPage = 20;
    const url = new URL("https://pixabay.com/api/");
    url.searchParams.set("key", localSecrets.pixabayApiKey);
    url.searchParams.set("q", normalizedQuery);
    url.searchParams.set("lang", "en");
    url.searchParams.set("image_type", "photo");
    url.searchParams.set("orientation", "vertical");
    url.searchParams.set("safesearch", "true");
    url.searchParams.set("order", "popular");
    url.searchParams.set("per_page", String(perPage));
    url.searchParams.set("page", String(page));
    const data = await fetchJson(url.href);
    const result = {
      source,
      page,
      total: data.totalHits || data.total || 0,
      hasNext: page * perPage < (data.totalHits || 0),
      items: (data.hits || [])
        .map(normalizePixabayImage)
        .filter(isPortraitImage)
        .slice(0, 12),
    };
    await cachePixabaySearch(cacheKey, result);
    return result;
  }

  const url = new URL("https://api.openverse.org/v1/images/");
  url.searchParams.set("q", query.trim());
  url.searchParams.set("license_type", "commercial");
  url.searchParams.set("aspect_ratio", "tall");
  url.searchParams.set("mature", "false");
  url.searchParams.set("page_size", "12");
  url.searchParams.set("page", String(page));
  const data = await fetchJson(url.href, {
    headers: { "Api-Version": "v1" },
  });
  return {
    source: "openverse",
    page: data.page || page,
    total: data.result_count || 0,
    hasNext: (data.page || page) < (data.page_count || 1),
    items: (data.results || [])
      .map(normalizeOpenverseImage)
      .filter(isPortraitImage),
  };
}

function extractJson(text) {
  const cleaned = String(text || "").replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("AI 未返回可识别的改写结果");
    return JSON.parse(match[0]);
  }
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function safeFileName(value, contentType) {
  const fallbackExtension = contentType.includes("png") ? "png" :
    contentType.includes("webp") ? "webp" :
    contentType.includes("gif") ? "gif" : "jpg";
  const cleaned = String(value || "")
    .split(/[?#]/)[0]
    .split("/")
    .pop()
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 100);
  if (!cleaned || !/\.[a-zA-Z0-9]{2,5}$/.test(cleaned)) return `lockscreen-image.${fallbackExtension}`;
  return cleaned;
}

async function fetchImageFile(imageUrl, suggestedName) {
  if (!/^https?:\/\//i.test(imageUrl || "")) throw new Error("图片地址无效");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  try {
    const response = await fetch(imageUrl, { signal: controller.signal, redirect: "follow" });
    if (!response.ok) throw new Error(`图片下载失败（${response.status}）`);
    const contentType = (response.headers.get("content-type") || "image/jpeg").split(";")[0];
    if (!contentType.startsWith("image/")) throw new Error("素材地址返回的不是图片文件");
    const buffer = await response.arrayBuffer();
    if (!buffer.byteLength) throw new Error("下载到的图片文件为空");
    if (buffer.byteLength > 18 * 1024 * 1024) throw new Error("图片超过 18MB，请选择较小素材");
    return {
      dataUrl: `data:${contentType};base64,${arrayBufferToBase64(buffer)}`,
      contentType,
      fileName: safeFileName(suggestedName || imageUrl, contentType),
      size: buffer.byteLength,
    };
  } catch (error) {
    if (controller.signal.aborted || error?.name === "AbortError") {
      throw new Error("图片下载超过 45 秒，请检查网络或选择另一张素材");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function rewriteWithAi(payload) {
  const [{ settings = {} }, { localSecrets = {} }] = await Promise.all([
    chrome.storage.sync.get("settings"),
    chrome.storage.local.get("localSecrets"),
  ]);
  const endpoint = settings.aiEndpoint?.trim();
  const model = settings.aiModel?.trim();
  const apiKey = localSecrets.aiApiKey?.trim();
  if (!endpoint || !model || !apiKey) {
    return { configured: false };
  }

  const summaryLimit = Number(payload.summaryLimit) || 50;
  const sourceLanguage = payload.sourceLanguage || "und";
  const sourceLanguageLabel = payload.sourceLanguageLabel || "the dominant language of the source";
  const systemPrompt = [
    "You are a fast, accurate sentence translator, word aligner, and multilingual lock-screen summary editor.",
    `The original language is ${sourceLanguageLabel} (${sourceLanguage}). Rewrite ONLY the summary in that same language and script, within ${summaryLimit} Unicode characters. Preserve the central subject, action, outcome, names, places and numbers; remove secondary detail; never invent facts or truncate mid-word.`,
    "DO NOT rewrite, shorten, paraphrase, or translate the title as a replacement title.",
    "First understand and translate the COMPLETE original title into natural Simplified Chinese. Do not translate isolated words independently.",
    "Split the original title into source_tokens in exact original order. Each token must be copied verbatim from the original title and should normally be one word (or one meaningful unit for languages without spaces). Exclude standalone punctuation and whitespace, but cover every meaningful original word.",
    "Split the natural Chinese translation into meaningful Chinese word/short-phrase buttons. For each Chinese token, provide source_indices: the zero-based indices of all original source_tokens it aligns to in the context of the complete sentence. One Chinese token may align to multiple original tokens. Every source token must be referenced by at least one Chinese token.",
    "Create image_query_en from the ORIGINAL source as 5 to 8 concrete English visual keywords (people, place, object, scene, atmosphere).",
    "Return strict JSON only: {\"summary\":\"...\",\"title_translation_zh\":\"natural full Chinese translation\",\"source_tokens\":[\"exact\",\"original\",\"tokens\"],\"zh_tokens\":[{\"text\":\"中文词\",\"source_indices\":[0]}],\"image_query_en\":\"...\",\"language\":\"...\"}",
  ].join("\n");
  const userPrompt = `ORIGINAL_TITLE: ${payload.title || "(empty)"}\nORIGINAL_SUMMARY: ${payload.summary || "(empty)"}`;
  const requestBody = {
    model,
    temperature: 0.1,
    max_tokens: 512,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  };

  // GLM 5.x enables thinking by default. Short editorial rewrites are faster and
  // more consistent when thinking is explicitly disabled.
  if (/^glm[-_.\s]?5(?:\D|$)/i.test(model)) {
    requestBody.thinking = { type: "disabled" };
  }
  const data = await fetchJson(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(requestBody),
  }, 45000);
  const content = data.choices?.[0]?.message?.content || data.output_text || "";
  const rewritten = extractJson(content);
  return {
    configured: true,
    summary: String(rewritten.summary || "").trim(),
    titleTranslationZh: String(rewritten.title_translation_zh || "").trim(),
    sourceTokens: Array.isArray(rewritten.source_tokens) ? rewritten.source_tokens : [],
    zhTokens: Array.isArray(rewritten.zh_tokens) ? rewritten.zh_tokens : [],
    imageQueryEn: String(rewritten.image_query_en || "").trim(),
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "OPEN_IMAGE_SEARCH") {
    openImageSearch(message.engine, message.query);
    sendResponse({ ok: true });
  }

  if (message.type === "OPEN_VISUAL_SEARCH") {
    openVisualSearch(message.imageUrl);
    sendResponse({ ok: true });
  }

  if (message.type === "OPEN_OPTIONS") {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
  }

  if (message.type === "SEARCH_STOCK_IMAGES") {
    searchStockImages(message.source, message.query, message.page)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "素材搜索失败" }));
    return true;
  }

  if (message.type === "REWRITE_COPY") {
    rewriteWithAi(message)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "AI 改写失败" }));
    return true;
  }

  if (message.type === "FETCH_IMAGE_FILE") {
    fetchImageFile(message.imageUrl, message.fileName)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "图片下载失败" }));
    return true;
  }
});
