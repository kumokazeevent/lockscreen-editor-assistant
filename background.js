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

async function searchStockImages(source, query, page = 1) {
  if (!query?.trim()) throw new Error("请输入图片搜索词");

  if (source === "pexels") {
    const { localSecrets = {} } = await chrome.storage.local.get("localSecrets");
    if (!localSecrets.pexelsApiKey) {
      throw new Error("请先在扩展设置中填写免费的 Pexels API Key");
    }
    const url = new URL("https://api.pexels.com/v1/search");
    url.searchParams.set("query", query.trim());
    url.searchParams.set("orientation", "landscape");
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
      items: (data.photos || []).map(normalizePexelsImage),
    };
  }

  const url = new URL("https://api.openverse.org/v1/images/");
  url.searchParams.set("q", query.trim());
  url.searchParams.set("license_type", "commercial");
  url.searchParams.set("aspect_ratio", "wide");
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
    items: (data.results || []).map(normalizeOpenverseImage),
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

  const titleLimit = Number(payload.titleLimit) || 12;
  const summaryLimit = Number(payload.summaryLimit) || 50;
  const systemPrompt = [
    "你是中文杂志锁屏内容编辑。将原文改写成自然、准确、完整且有吸引力的标题和简介。",
    `标题最多${titleLimit}个Unicode字符，简介最多${summaryLimit}个Unicode字符。`,
    "不要机械截断，不要添加省略号，不要编造原文没有的事实。优先保留人物、事件、地点、数字等关键信息。",
    "同时根据原文生成适合英文图片素材库的搜索词：5到10个英文视觉关键词，优先人物、地点、物体、场景和氛围，不要抽象新闻套话。",
    "只输出严格JSON，格式为：{\"title\":\"...\",\"summary\":\"...\",\"image_query_en\":\"...\"}",
  ].join("\n");
  const userPrompt = `原标题：${payload.title || "（空）"}\n原简介：${payload.summary || "（空）"}\n页面补充：${payload.context || "（无）"}`;
  const data = await fetchJson(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.25,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  }, 45000);
  const content = data.choices?.[0]?.message?.content || data.output_text || "";
  const rewritten = extractJson(content);
  return {
    configured: true,
    title: String(rewritten.title || "").trim(),
    summary: String(rewritten.summary || "").trim(),
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
