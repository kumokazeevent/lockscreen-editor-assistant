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
    imageUrl: item.src?.original || item.src?.large2x || item.src?.large,
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
    if (!match) throw new Error("AI 未返回可识别的图片关键词结果");
    return JSON.parse(match[0]);
  }
}

async function generateImageQueryWithAi(payload) {
  const [{ settings = {} }, { localSecrets = {} }] = await Promise.all([
    chrome.storage.sync.get("settings"),
    chrome.storage.local.get("localSecrets"),
  ]);
  const endpoint = settings.aiEndpoint?.trim();
  const model = settings.aiModel?.trim();
  const apiKey = localSecrets.aiApiKey?.trim();
  if (!endpoint || !model || !apiKey) return { configured: false };

  const requestBody = {
    model,
    temperature: 0.1,
    max_tokens: 80,
    messages: [
      {
        role: "system",
        content: [
          "Convert the ORIGINAL article title into a precise stock-photo search query.",
          "Return 5 to 8 concrete English visual keywords describing visible people, named place, object, action, scene and atmosphere.",
          "Preserve important proper nouns when they are visually relevant. Do not use abstract editorial words such as news, article, report or photography.",
          "Use only the original title, not a rewritten title or summary.",
          "Return strict JSON only: {\"image_query_en\":\"...\"}",
        ].join("\n"),
      },
      { role: "user", content: String(payload.title || "") },
    ],
  };
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
  }, 30000);
  const content = data.choices?.[0]?.message?.content || data.output_text || "";
  const generated = extractJson(content);
  return {
    configured: true,
    imageQueryEn: String(generated.image_query_en || "").trim(),
  };
}

async function downloadImage(url, fileName) {
  if (!/^https?:\/\//i.test(url || "")) throw new Error("图片下载地址无效");
  const safeName = String(fileName || "stock-image.jpg")
    .replace(/[<>:\"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/^\.+|\.+$/g, "")
    .slice(0, 160) || "stock-image.jpg";
  const downloadId = await chrome.downloads.download({
    url,
    filename: `锁屏素材/${safeName}`,
    saveAs: false,
  });
  return { downloadId };
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

  if (message.type === "DOWNLOAD_IMAGE") {
    downloadImage(message.url, message.fileName)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "图片下载失败" }));
    return true;
  }

  if (message.type === "GENERATE_IMAGE_QUERY") {
    generateImageQueryWithAi(message)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "英文图片关键词生成失败" }));
    return true;
  }
});
