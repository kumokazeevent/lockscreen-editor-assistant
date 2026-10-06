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
  const DEFAULT_PROMPT = "Preserve the original language and core meaning. Rewrite naturally within {titleLimit} words for the title and {summaryLimit} words for the description. Count written words, not letters or characters. Spaces and punctuation are not words. Hyphenated words and contractions count as one word. Preserve an already suitable text if it fits. Keep important proper nouns. Never change a stated number of methods or steps to a different number. Remove repetition and excessive modifiers. Do not invent facts. Check both word counts before answering.";
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
  function folderName(batch = {}) {
    const meta = batchMeta(batch.metadata, { capturedAt: batch.createdAt });
    const safe = (value) => value.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[. ]+$/g, "") || "未知";
    const date = new Date(meta.capturedAt), pad = (value, width = 2) => String(value).padStart(width, "0");
    const stamp = `${date.getFullYear()}${pad(date.getMonth()+1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}${pad(date.getMilliseconds(),3)}`;
    // A stable suffix prevents simultaneous tabs/pages with identical timestamps colliding.
    let hash = 0;
    for (const ch of String(batch.batchId || "")) hash = (hash * 31 + ch.codePointAt(0)) | 0;
    return `${safe(meta.language)}_${safe(meta.country)}_${stamp}-${(hash >>> 0).toString(36)}`;
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
        articleText: clean(raw.articleText), title: clean(raw.title, 12000), summary: clean(raw.summary, 32000),
        imageQueryEn: clean(raw.imageQueryEn || raw.image_query_en, 500), language: clean(raw.language, 20),
        image: safeImage(raw.image), rewriteMode: raw.rewriteMode === "local" ? "local" : "ai",
        reviewWarning: clean(raw.reviewWarning, 1000), error: clean(raw.error, 2000), attempts: 0,
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
    const summary = item.originalSummary || item.articleText || item.originalTitle;
    return { title: localShorten(item.originalTitle, settings.titleLimit || 12),
      summary: localShorten(summary, settings.summaryLimit || 50), imageQueryEn: item.imageQueryEn || "",
      rewriteMode: "local", reviewWarning: "本地词语候选：未做语义理解或翻译，请人工核对原意与专有名词。" };
  }
  globalThis.LSAWorkflow = { words, count, clean, number, DEFAULT_PROMPT, wordPrompt, httpUrl, editUrl, imageKey, recordKey, batchSize, batchMeta, folderName, splitBatchFolders, safeImage, importBatch, localShorten, localRewrite };
})();
