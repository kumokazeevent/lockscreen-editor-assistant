(() => {
  "use strict";
  function words(value) {
    const source = String(value || "").normalize("NFC");
    const tokens = source.match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}]*(?:['’\-‐‑][\p{L}\p{M}\p{N}]+)*/gu) || [];
    return tokens.flatMap((token) => {
      if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u.test(token) && typeof Intl.Segmenter === "function") {
        return [...new Intl.Segmenter(undefined, { granularity: "word" }).segment(token)].filter((part) => part.isWordLike).map((part) => part.segment);
      }
      return [token];
    });
  }
  const count = (value) => words(value).length;
  const clean = (value, max = 12000) => String(value ?? "").normalize("NFC").replace(/\s+/g, " ").trim().slice(0, max);
  const number = (value, min, max, fallback) => Number.isFinite(Number(value))
    ? Math.max(min, Math.min(max, Math.round(Number(value)))) : fallback;
  function normalizeLanguageCode(value) {
    const text = String(value || "").trim().toLowerCase();
    if (!text) return "";
    const rules = [
      ["vi", /vietnamese|越南语|越南|\bvie?\b/i], ["es", /spanish|español|西班牙语|西班牙|\bes\b|\bspa\b/i],
      ["en", /english|英语|英文|\ben\b|\beng\b/i], ["ru", /russian|русский|俄语|俄文|\bru\b|\brus\b/i],
      ["be", /belarusian|беларуская|白俄罗斯语|\bbe\b|\bbel\b/i], ["ar", /arabic|العربية|阿拉伯语|阿拉伯文|\bar\b|\bara\b/i],
      ["it", /italian|italiano|意大利语|\bit\b|\bita\b/i], ["zh", /chinese|中文|汉语|華語|\bzh\b|\bzho\b/i],
      ["fa", /persian|farsi|فارسی|波斯语|\bfa\b|\bfas\b|\bper\b/i], ["ne", /nepali|नेपाली|尼泊尔语|\bne\b|\bnep\b/i],
      ["si", /sinhala|sinhalese|සිංහල|僧伽罗语|\bsi\b|\bsin\b/i], ["my", /burmese|myanmar|မြန်မာ|缅甸语|\bmy\b|\bmya\b|\bbur\b/i],
      ["ky", /kyrgyz|кыргыз|吉尔吉斯语|\bky\b|\bkir\b/i], ["tg", /tajik|тоҷикӣ|塔吉克语|\btg\b|\btgk\b/i],
      ["az", /azerbaijani|azərbaycan|阿塞拜疆语|\baz\b|\baze\b/i], ["bn", /bengali|bangla|বাংলা|孟加拉语|\bbn\b|\bben\b/i],
      ["id", /indonesian|bahasa indonesia|印度尼西亚语|印尼语|\bid\b|\bind\b/i],
    ];
    for (const [code, pattern] of rules) if (pattern.test(text)) return code;
    return text.slice(0, 12);
  }
  const DEFAULT_PROMPT = "Read the article body first and generate both the title and description from its facts and central topic. Preserve the original language. Write naturally within {titleLimit} words for the title and {summaryLimit} words for the description. Count written words, not letters or characters. Spaces and punctuation are not words. Hyphenated words and contractions count as one word. Keep important proper nouns and numbers supported by the article. Remove repetition and excessive modifiers. Do not invent facts. Check both word counts before answering.";
  function wordPrompt(value) {
    return String(value || DEFAULT_PROMPT)
      .replace(/counting spaces and punctuation/gi, "counting words, excluding standalone punctuation")
      .replace(/Unicode characters|characters|character counts|character limits/gi, (match) => /counts/i.test(match) ? "word counts" : /limits/i.test(match) ? "word limits" : "words")
      .replace(/字符/g, "词");
  }
  function httpUrl(value) {
    try { const url = new URL(String(value)); return /https?:/.test(url.protocol) ? url.href : ""; } catch { return ""; }
  }
  function editUrl(value, id = "") {
    const fallback = id ? `https://lockscreen-admin.mofeeds.com/#/nav/overseasDeliver?index=5&type=editEMPTY&id=${encodeURIComponent(id)}` : "";
    try {
      const url = new URL(value || fallback);
      const [path, query] = url.hash.slice(1).split("?");
      const params = new URLSearchParams(query);
      return url.origin === "https://lockscreen-admin.mofeeds.com" && path === "/nav/overseasDeliver"
        && params.get("index") === "5" && params.get("type") === "editEMPTY" ? url.href : fallback;
    } catch { return fallback; }
  }
  function imageKey(image = {}) {
    const source = clean(image.source || image.provider).toLowerCase();
    if (image.id && ["pexels", "pixabay"].includes(source)) return `${source}:${image.id}`;
    try {
      const url = new URL(image.originalUrl || image.imageUrl || image.downloadUrl || "");
      if (/images\.pexels\.com$/.test(url.hostname)) {
        const id = url.pathname.match(/\/photos\/(\d+)\//)?.[1];
        if (id) return `pexels:${id}`;
      }
      // Ignore only known resizing parameters, preserving resource-identifying query values.
      for (const key of ["w", "h", "width", "height", "fit", "crop", "auto", "q", "cs", "dpr", "fm"]) url.searchParams.delete(key);
      url.hash = "";
      url.searchParams.sort();
      return url.href;
    } catch { return ""; }
  }
  function recordKey(item) { return item.id ? `id:${item.id}` : `${item.sourceUrl || item.editUrl}|${item.originalTitle}`; }
  const batchSize = (value) => Number(value) === 40 ? 40 : 30;
  function batchMeta(raw = {}, fallback = {}) {
    const stamp = raw.capturedAt || fallback.capturedAt || Date.now();
    return { language: clean(raw.language || fallback.language || "未知语言", 40),
      country: clean(raw.country || fallback.country || "未知国家", 40),
      capturedAt: Number.isFinite(new Date(stamp).getTime()) ? new Date(stamp).getTime() : Date.now() };
  }
  function safePathPart(value, fallback = "未知") {
    return clean(value, 120).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[. ]+$/g, "") || fallback;
  }
  function batchStampSuffix(batch = {}) {
    let hash = 0;
    for (const ch of String(batch.batchId || "")) hash = (hash * 31 + ch.codePointAt(0)) | 0;
    return (hash >>> 0).toString(36);
  }
  function folderName(batch = {}) {
    const meta = batchMeta(batch.metadata, { capturedAt: batch.createdAt });
    const date = new Date(meta.capturedAt), pad = (value, width = 2) => String(value).padStart(width, "0");
    const stamp = `${date.getFullYear()}${pad(date.getMonth()+1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}${pad(date.getMilliseconds(),3)}`;
    return `${safePathPart(meta.language)}_${safePathPart(meta.country)}_${stamp}-${batchStampSuffix(batch)}`;
  }
  function batchFileName(batch = {}, type = "批次结果", count = null) {
    const allowed = /^(?:批次原稿_读取时|批次原稿_含正文|批次结果|结果_第\d+页)$/u;
    if (!allowed.test(String(type))) throw new Error("批次 JSON 类型无效");
    const meta = batchMeta(batch.metadata, { capturedAt: batch.createdAt });
    const date = new Date(meta.capturedAt), pad = (value) => String(value).padStart(2, "0");
    const stamp = `${date.getFullYear()}${pad(date.getMonth()+1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
    const total = count !== null && count !== undefined && Number.isFinite(Number(count))
      ? Math.max(0, Math.round(Number(count)))
      : (Array.isArray(batch.items) ? batch.items.length : 0);
    return `${safePathPart(meta.language)}_${safePathPart(meta.country)}_${total}条_${stamp}_${type}_${batchStampSuffix(batch)}.json`;
  }
  function usageEventsInWindow(entry = {}, windowDays = 90, now = Date.now()) {
    const current = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    const days = number(windowDays, 1, 365, 90);
    const cutoff = current - days * 86400000;
    const ttl = current - 365 * 86400000;
    return (Array.isArray(entry?.events) ? entry.events : [])
      .map(Number)
      .filter((stamp) => Number.isFinite(stamp) && stamp >= cutoff && stamp >= ttl && stamp <= current)
      .sort((left, right) => left - right);
  }
  function splitBatchFolders(batch) {
    const groups = new Map();
    for (const item of batch.items) {
      const key = JSON.stringify([item.pageKey || "imported", item.pageLanguage || batch.metadata?.language || item.language || "未知语言", item.pageCountry || batch.metadata?.country || "未知国家"]);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    return [...groups.values()].map((items, index) => {
      const first = items[0];
      const metadata = batchMeta({ language: first.pageLanguage || batch.metadata?.language || first.language,
        country: first.pageCountry || batch.metadata?.country, capturedAt: batch.metadata?.capturedAt || batch.createdAt });
      return { ...batch, metadata, batchId: groups.size === 1 ? batch.batchId : `${batch.batchId}-p${index+1}`,
        items: items.map((item, i) => ({ ...item, index: i+1 })) };
    });
  }
  function safeImage(raw) {
    if (!raw || typeof raw !== "object") return null;
    const width = Number(raw.width), height = Number(raw.height);
    const imageUrl = httpUrl(raw.originalUrl || raw.imageUrl || raw.downloadUrl);
    if (!imageUrl || !width || height <= width) return null;
    return {
      id: clean(raw.id, 100), source: clean(raw.source || raw.provider, 40), imageUrl, originalUrl: imageUrl,
      previewUrl: httpUrl(raw.previewUrl) || imageUrl, pageUrl: httpUrl(raw.pageUrl), width, height,
      creator: clean(raw.creator, 200), aspectLabel: clean(raw.aspectLabel, 20),
      safetyStatus: ["passed", "rejected", "review"].includes(raw.safetyStatus) ? raw.safetyStatus : "review",
      safetyReason: clean(raw.safetyReason, 400),
    };
  }
  function importBatch(data, settings = {}) {
    if (!data || !Array.isArray(data.items) || !data.items.length || data.items.length > 600) throw new Error("JSON 必须含 1–600 条 items 记录");
    if (!data.version && data.format !== "lockscreen-results") throw new Error("这是原稿或未知 JSON，请导入插件导出的批次结果文件");
    const seen = new Set();
    const items = data.items.map((raw, index) => {
      if (!raw || typeof raw !== "object") throw new Error(`第 ${index + 1} 条记录格式错误`);
      const id = clean(raw.id, 100);
      const item = {
        index: index + 1, id, originalTitle: clean(raw.originalTitle, 2000), originalSummary: clean(raw.originalSummary, 4000),
        sourceUrl: httpUrl(raw.sourceUrl), editUrl: editUrl(raw.editUrl, id),
        pageKey: clean(raw.pageKey || "imported", 160), pageLabel: clean(raw.pageLabel || "导入页面", 160),
        pageLanguage: clean(raw.pageLanguage, 40), pageCountry: clean(raw.pageCountry, 40),
        sourcePage: httpUrl(raw.sourcePage || data.sourcePage), pageOrder: number(raw.pageOrder, 0, 600, index),
        articleText: clean(raw.articleText), title: clean(raw.title, 12000), titleZh: clean(raw.titleZh, 4000), summary: clean(raw.summary, 32000),
        copySource: raw.copySource === "article_body" ? "article_body" : "",
        imageQueryEn: clean(raw.imageQueryEn || raw.image_query_en, 500), imageQuerySourceTitle: clean(raw.imageQuerySourceTitle, 2000), language: clean(raw.language, 20),
        image: safeImage(raw.image), rewriteMode: raw.rewriteMode === "local" ? "local" : "ai",
        reviewWarning: clean(raw.reviewWarning, 1000), error: clean(raw.error, 2000), attempts: 0,
        errorType: clean(raw.errorType || raw.error_type, 80), error_type: clean(raw.error_type || raw.errorType, 80),
        model: clean(raw.model || raw.aiErrorModel || raw.aiModel, 200), aiModel: clean(raw.aiModel || raw.model, 200),
        aiErrorModel: clean(raw.aiErrorModel || raw.model, 200), aiAttempts: number(raw.aiAttempts, 0, 20, 0),
        aiDiagnostics: Array.isArray(raw.aiDiagnostics || raw.diagnostics) ? (raw.aiDiagnostics || raw.diagnostics).slice(0, 20) : [],
        usedFallbackModel: Boolean(raw.usedFallbackModel),
        downloadStatus: "", downloadPath: "", manualDuplicate: Boolean(raw.manualDuplicate),
        stages: { article: "pending", ai: "pending", image: "pending" }, status: "pending",
      };
      if (!item.originalTitle) throw new Error(`第 ${index + 1} 条缺少原始标题`);
      if (item.articleText) item.stages.article = "done";
      const validCopy = item.title && item.summary && count(item.title) <= (settings.titleLimit || 12)
        && count(item.summary) <= (settings.summaryLimit || 50);
      if (validCopy) item.stages.ai = "done";
      if (item.image && item.image.safetyStatus !== "rejected") item.stages.image = "done";
      if (validCopy && item.stages.image === "done") {
        item.status = item.image.safetyStatus === "passed" && item.rewriteMode !== "local" ? "completed" : "needs_review";
      } else if (raw.status === "error" || (item.title && !validCopy)) {
        item.status = "error";
        item.error ||= "导入结果未通过当前词数限制，请重新改写";
      }
      return item;
    }).filter((item) => { const key = recordKey(item); if (seen.has(key)) return false; seen.add(key); return true; });
    return { version: 4, countUnit: "words", format: "lockscreen-results", batchId: clean(data.batchId, 100) || `import-${Date.now()}`,
      sourcePage: httpUrl(data.sourcePage), metadata: data.metadata ? batchMeta(data.metadata) : null,
      batchLimit: batchSize(data.batchLimit || settings.batchLimit),
      createdAt: Number.isFinite(new Date(data.createdAt).getTime()) ? new Date(data.createdAt).getTime() : Date.now(), updatedAt: Date.now(), status: "ready", items };
  }
  function localShorten(text, limit) {
    const source = clean(text);
    if (count(source) <= limit) return source;
    const segments = words(source);
    const stop = /^(?:the|a|an|and|of|to|for|how|can|you|your|this|that|el|la|los|las|de|del|un|una|y|para|как|и|в|на|для|это|ваш|вашего|của|và|là|các|những|một|cách|في|من|على|و)$/iu;
    const candidates = segments.filter((word) => !stop.test(word));
    let best = "";
    for (let start = 0; start < candidates.length; start += 1) {
      let candidate = "";
      for (let end = start; end < candidates.length; end += 1) {
        const joined = candidate ? `${candidate}${/[\u3400-\u9fff]$/.test(candidate) && /^[\u3400-\u9fff]/.test(candidates[end]) ? "" : " "}${candidates[end]}` : candidates[end];
        if (count(joined) > limit) break;
        candidate = joined;
      }
      if (count(candidate) > count(best)) best = candidate;
    }
    if (!best) throw new Error(`原稿没有可用的词语，请检查原稿或使用 AI 改写`);
    return best;
  }
  function localRewrite(item, settings) {
    const article = clean(item.articleText);
    if (!article) throw new Error("未读取到文章正文，不能生成本地候选");
    const firstSentence = article.split(/(?<=[.!?。！？])\s+/u).find(Boolean) || article;
    return { title: localShorten(firstSentence, settings.titleLimit || 12),
      summary: localShorten(article, settings.summaryLimit || 50), imageQueryEn: item.originalTitle,
      imageQuerySourceTitle: item.originalTitle,
      rewriteMode: "local", copySource: "article_body",
      reviewWarning: "本地正文候选：仅从正文截取词语，未做语义理解或翻译，请人工核对原意与专有名词。" };
  }
  function failureTypeCounts(items = []) {
    return (Array.isArray(items) ? items : []).reduce((counts, item) => {
      if (item?.status !== "error") return counts;
      const type = clean(item.errorType || item.error_type || "UNKNOWN_ERROR", 80) || "UNKNOWN_ERROR";
      counts[type] = (counts[type] || 0) + 1;
      return counts;
    }, {});
  }
  function failedItemsByType(items = [], type = "") {
    const target = clean(type, 80);
    return (Array.isArray(items) ? items : []).filter((item) => item?.status === "error"
      && (!target || clean(item.errorType || item.error_type || "UNKNOWN_ERROR", 80) === target));
  }
  globalThis.LSAWorkflow = { words, count, clean, number, normalizeLanguageCode, DEFAULT_PROMPT, wordPrompt, httpUrl, editUrl, imageKey, recordKey, batchSize, batchMeta, batchStampSuffix, batchFileName, usageEventsInWindow, folderName, splitBatchFolders, safeImage, importBatch, localShorten, localRewrite, failureTypeCounts, failedItemsByType };
})();
