(() => {
  "use strict";

  if (globalThis.__lockscreenFloatingAssistantLoaded) return;
  globalThis.__lockscreenFloatingAssistantLoaded = true;

  const TARGET_HOST = "lockscreen-admin.mofeeds.com";
  const DEFAULT_SETTINGS = {
    titleLimit: 12,
    summaryLimit: 50,
    batchLimit: 30,
    batchConcurrency: 2,
    preferredRatio: "auto",
    originalFolder: "锁屏批次/原始内容",
    imageFolder: "锁屏批次/成品图片",
  };
  const RATIO_TARGETS = { "9:16": 9 / 16, "9:20": 9 / 20 };
  const STATUS_LABELS = {
    pending: "待处理", fetching: "读取文章", rewriting: "AI 改写", searching: "搜索配图",
    completed: "已完成", needs_review: "图片需复核", error: "处理失败",
  };
  const PROCESS_STAGES = [
    { key: "article", label: "读取文章" },
    { key: "ai", label: "AI 改写" },
    { key: "image", label: "搜索图片" },
  ];

  const state = {
    root: null,
    route: { kind: "none", key: "none" },
    settings: { ...DEFAULT_SETTINGS },
    batch: null,
    runToken: 0,
    pauseRequested: false,
    storageChain: Promise.resolve(),
    selectedRecordIndex: -1,
    pageContext: {},
    manualResults: [],
    dragging: null,
    resizeObserver: null,
    resizeTimer: null,
    lastLocation: location.href,
  };

  function create(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function q(selector) {
    return state.root?.querySelector(selector) || null;
  }

  function qa(selector) {
    return [...(state.root?.querySelectorAll(selector) || [])];
  }

  function cleanText(value = "") {
    return String(value).replace(/<[^>]*>/g, " ").replace(/[\u200b-\u200d\ufeff]/g, "")
      .replace(/\s+/g, " ").trim();
  }

  function graphemes(value = "") {
    if (typeof Intl.Segmenter === "function") {
      return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(String(value))]
        .map((part) => part.segment);
    }
    return Array.from(String(value));
  }

  function textLength(value) {
    return graphemes(value).length;
  }

  function formatOriginal(title = "", summary = "") {
    return title || summary ? `${cleanText(title)}////${cleanText(summary)}` : "";
  }

  function parseOriginal(value = "") {
    const at = String(value).indexOf("////");
    if (at < 0) return { title: cleanText(value), summary: "" };
    return { title: cleanText(String(value).slice(0, at)), summary: cleanText(String(value).slice(at + 4)) };
  }

  function parseDraft(value = "") {
    const lines = String(value).replace(/\r\n?/g, "\n").split("\n");
    while (lines.length && !lines[0].trim()) lines.shift();
    return { title: cleanText(lines.shift() || ""), summary: cleanText(lines.join(" ")) };
  }

  function routeFromLocation() {
    if (location.hostname !== TARGET_HOST) return { kind: "none", key: "none" };
    const raw = location.hash.replace(/^#/, "");
    const question = raw.indexOf("?");
    const path = question >= 0 ? raw.slice(0, question) : raw;
    const params = new URLSearchParams(question >= 0 ? raw.slice(question + 1) : "");
    if (/^\/nav\/overseasContent\/?$/i.test(path) && params.get("index") === "5") {
      return { kind: "list", key: `list:${params.get("index") || ""}`, params };
    }
    if (/^\/nav\/overseasDeliver\/?$/i.test(path)
      && params.get("index") === "5" && params.get("type") === "editEMPTY") {
      const id = params.get("id") || "";
      return { kind: "edit", id, key: `edit:${id}`, params };
    }
    return { kind: "none", key: "none", params };
  }

  async function sendRuntime(type, payload = {}) {
    const response = await chrome.runtime.sendMessage({ type, action: type, ...payload });
    if (!response) throw new Error(`${type} 未返回结果，请重新加载插件`);
    if (response.ok === false) {
      const error = new Error(response.error || response.message || `${type} 执行失败`);
      error.code = response.code || "";
      error.status = Number(response.status) || 0;
      error.requestUrl = response.requestUrl || "";
      throw error;
    }
    return response;
  }

  async function pageTool(name, ...args) {
    const methodMap = {
      GET_SITE_ROUTE: "getSiteRoute", SCAN_LIST_ITEMS: "scanListItems", GET_PAGE_CONTEXT: "getPageContext",
      APPLY_BATCH_RECORD: "applyBatchRecord", APPLY_DRAFT: "applyDraft", START_BINDING: "startBindingMode",
    };
    const method = globalThis.__lsaPageTools?.[methodMap[name]];
    if (typeof method !== "function") {
      throw new Error(`页面适配器缺少 ${name}，请在扩展管理页点击“重新加载”后再试`);
    }
    return method(...args);
  }

  function setPanelStatus(selector, message, isError = false) {
    const node = q(selector);
    if (!node) return;
    node.textContent = message;
    node.classList.toggle("is-error", isError);
  }

  function switchTab(name) {
    qa(".lsa-tab-button").forEach((button) => button.classList.toggle("is-active", button.dataset.tab === name));
    qa(".lsa-tab-panel").forEach((panel) => { panel.hidden = panel.dataset.panel !== name; });
  }

  function getBatchItems() {
    const items = Array.isArray(state.batch?.items) ? state.batch.items : [];
    items.forEach(ensureItemStages);
    return items;
  }

  function ensureItemStages(item) {
    if (!item || typeof item !== "object") return item;
    item.stages = { article: "pending", ai: "pending", image: "pending", ...(item.stages || {}) };
    if (item.articleText && item.stages.article === "pending") item.stages.article = "done";
    if (item.title && item.summary && item.imageQueryEn && item.stages.ai === "pending") item.stages.ai = "done";
    if (item.image && item.stages.image === "pending") item.stages.image = "done";
    if (item.status === "fetching") item.stages.article = "working";
    if (item.status === "rewriting") item.stages.ai = "working";
    if (item.status === "searching") item.stages.image = "working";
    if (["completed", "needs_review"].includes(item.status)) {
      PROCESS_STAGES.forEach(({ key }) => { item.stages[key] = "done"; });
    }
    if (item.status === "error" && !PROCESS_STAGES.some(({ key }) => item.stages[key] === "error")) {
      const failedKey = item.stages.ai === "done" ? "image" : item.stages.article === "done" ? "ai" : "article";
      item.stages[failedKey] = "error";
      item.currentStage ||= failedKey;
    }
    return item;
  }

  function itemProgressPercent(item) {
    ensureItemStages(item);
    if (["completed", "needs_review", "error"].includes(item.status)) return 100;
    const units = PROCESS_STAGES.reduce((sum, { key }) => {
      const stage = item.stages[key];
      return sum + (stage === "done" ? 1 : stage === "working" ? 0.5 : 0);
    }, 0);
    return Math.round(units / PROCESS_STAGES.length * 100);
  }

  function progressMetrics() {
    const items = getBatchItems();
    const stages = Object.fromEntries(PROCESS_STAGES.map(({ key }) => [key, { done: 0, working: 0, error: 0 }]));
    let totalPercent = 0;
    let settled = 0;
    for (const item of items) {
      totalPercent += itemProgressPercent(item);
      if (["completed", "needs_review", "error"].includes(item.status)) settled += 1;
      for (const { key } of PROCESS_STAGES) {
        const status = item.stages[key];
        if (status === "done") stages[key].done += 1;
        else if (status === "working") stages[key].working += 1;
        else if (status === "error") stages[key].error += 1;
      }
    }
    return {
      total: items.length,
      settled,
      percent: items.length ? Math.round(totalPercent / items.length) : 0,
      stages,
    };
  }

  function batchCounts() {
    const counts = { total: 0, done: 0, review: 0, failed: 0, pending: 0, working: 0 };
    for (const item of getBatchItems()) {
      counts.total += 1;
      if (item.status === "completed") counts.done += 1;
      else if (item.status === "needs_review") counts.review += 1;
      else if (item.status === "error") counts.failed += 1;
      else if (["fetching", "rewriting", "searching"].includes(item.status)) counts.working += 1;
      else counts.pending += 1;
    }
    return counts;
  }

  function cloneBatch() {
    return state.batch ? JSON.parse(JSON.stringify(state.batch)) : null;
  }

  function persistBatch({ render = true } = {}) {
    if (!state.batch) return Promise.resolve();
    state.batch.updatedAt = Date.now();
    const snapshot = cloneBatch();
    state.storageChain = state.storageChain.catch(() => {})
      .then(() => chrome.storage.local.set({ batchState: snapshot }));
    if (render) renderBatch();
    return state.storageChain;
  }

  function makeBatchId() {
    const now = new Date();
    const pad = (value) => String(value).padStart(2, "0");
    return [now.getFullYear(), pad(now.getMonth() + 1), pad(now.getDate()), "-",
      pad(now.getHours()), pad(now.getMinutes()), pad(now.getSeconds())].join("");
  }

  function normalizeScannedItem(raw, index) {
    const id = raw.id ?? raw.contentId ?? raw.articleId ?? "";
    return {
      index: index + 1,
      id: String(id || ""),
      originalTitle: cleanText(raw.originalTitle || raw.title || raw.name || ""),
      originalSummary: cleanText(raw.originalSummary || raw.summary || raw.description || ""),
      sourceUrl: raw.sourceUrl || raw.articleUrl || raw.viewUrl || raw.url || "",
      editUrl: raw.editUrl || raw.editorUrl || "",
      pageOrder: raw.pageOrder ?? index,
      status: "pending",
      attempts: 0,
      error: "",
      diagnostics: raw.diagnostics || [],
      currentStage: "",
      stages: { article: "pending", ai: "pending", image: "pending" },
    };
  }

  function serializeOriginalSnapshot() {
    return JSON.stringify({
      batchId: state.batch.batchId,
      sourcePage: state.batch.sourcePage,
      createdAt: new Date(state.batch.createdAt).toISOString(),
      items: getBatchItems().map((item) => ({
        index: item.index, id: item.id, title: item.originalTitle, summary: item.originalSummary,
        sourceUrl: item.sourceUrl, editUrl: item.editUrl, articleText: item.articleText || "",
      })),
    }, null, 2);
  }

  function serializableBatch() {
    return JSON.stringify(cloneBatch(), null, 2);
  }

  async function saveTextSnapshot(kind, quiet = false) {
    if (!state.batch) throw new Error("当前没有批次");
    const isOriginal = kind === "original" || kind === "original-list";
    const label = kind === "original-list" ? "原始列表" : isOriginal ? "原始内容" : "批次结果";
    const fileName = `${state.batch.batchId}-${label}.json`;
    try {
      const response = await sendRuntime("SAVE_TEXT_FILE", {
        folder: state.settings.originalFolder,
        fileName,
        text: isOriginal ? serializeOriginalSnapshot() : serializableBatch(),
        mimeType: "application/json;charset=utf-8",
      });
      if (!quiet) setPanelStatus(".lsa-batch-status", `已保存 ${response.fileName || fileName}`);
      return response;
    } catch (error) {
      if (!quiet) setPanelStatus(".lsa-batch-status", `保存 JSON 失败：${error.message}`, true);
      throw error;
    }
  }

  async function scanListItems() {
    const button = q(".lsa-scan-batch");
    if (button) button.disabled = true;
    setPanelStatus(".lsa-batch-status", "正在按页面左上到右下顺序扫描…");
    try {
      const limit = Math.max(1, Math.min(30, Number(state.settings.batchLimit) || 30));
      const response = await pageTool("SCAN_LIST_ITEMS", limit);
      const rawItems = Array.isArray(response) ? response : response?.items;
      if (!Array.isArray(rawItems) || !rawItems.length) {
        throw new Error(response?.message || "没有识别到内容卡片；请确认位于海外内容列表页，或在诊断信息中检查选择器");
      }
      const items = rawItems.slice(0, limit).map(normalizeScannedItem);
      state.batch = {
        version: 2,
        batchId: makeBatchId(),
        sourcePage: location.href,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        status: "ready",
        originalFolder: state.settings.originalFolder,
        imageFolder: state.settings.imageFolder,
        preferredRatio: state.settings.preferredRatio,
        diagnostics: response?.diagnostics || [],
        items,
      };
      state.selectedRecordIndex = -1;
      await persistBatch();
      setPanelStatus(".lsa-batch-status", `已扫描 ${items.length} 条；编号顺序为页面左上到右下。`);
      saveTextSnapshot("original-list", true).catch((error) => {
        setPanelStatus(".lsa-batch-status", `已扫描 ${items.length} 条，但原始 JSON 保存失败：${error.message}`, true);
      });
    } catch (error) {
      setPanelStatus(".lsa-batch-status", error.message || "扫描失败", true);
    } finally {
      if (button) button.disabled = false;
      renderBatch();
    }
  }

  function articleTextFromResponse(response) {
    const direct = response.articleText || response.text || response.content || response.article?.text || response.data?.text;
    if (direct) return cleanText(direct).slice(0, 12000);
    const html = response.html || response.article?.html || response.data?.html;
    if (!html) return "";
    const doc = new DOMParser().parseFromString(String(html), "text/html");
    doc.querySelectorAll("script,style,noscript,svg,nav,footer,form").forEach((node) => node.remove());
    return cleanText(doc.body?.textContent || "").slice(0, 12000);
  }

  function normalizeAiResult(response) {
    const data = response.result || response.data || response.output || response;
    return {
      title: cleanText(data.title || data.optimizedTitle || data.shortTitle || ""),
      summary: cleanText(data.summary || data.description || data.shortSummary || ""),
      imageQueryEn: cleanText(data.imageQueryEn || data.image_query_en || data.imageQuery || data.query || ""),
      language: cleanText(data.language || data.languageCode || ""),
      reviewWarning: cleanText(response.reviewWarning || data.reviewWarning || ""),
    };
  }

  function safetyCode(image) {
    const value = String(image.safetyStatus || image.safety || image.safety_state || "").toLowerCase();
    if (["passed", "pass", "safe", "ok", "approved"].includes(value)) return "passed";
    if (["rejected", "reject", "unsafe", "blocked"].includes(value)) return "rejected";
    return "review";
  }

  function ratioDistance(image, preferred = state.settings.preferredRatio) {
    const width = Number(image.width);
    const height = Number(image.height);
    if (!width || !height) return Number.POSITIVE_INFINITY;
    const ratio = width / height;
    if (RATIO_TARGETS[preferred]) return Math.abs(ratio - RATIO_TARGETS[preferred]);
    return Math.min(...Object.values(RATIO_TARGETS).map((target) => Math.abs(ratio - target)));
  }

  function closestRatioLabel(image) {
    if (image.aspectLabel || image.targetRatio) return image.aspectLabel || image.targetRatio;
    const width = Number(image.width);
    const height = Number(image.height);
    if (!width || !height) return "比例未知";
    return Math.abs(width / height - RATIO_TARGETS["9:16"]) <= Math.abs(width / height - RATIO_TARGETS["9:20"])
      ? "接近 9:16" : "接近 9:20";
  }

  function normalizeImage(raw) {
    const image = {
      id: raw.id || raw.photoId || "",
      source: raw.source || raw.provider || "Pexels",
      previewUrl: raw.previewUrl || raw.preview || raw.src?.medium || raw.src?.small || raw.imageUrl || raw.url || "",
      imageUrl: raw.imageUrl || raw.originalUrl || raw.uploadUrl || raw.downloadUrl || raw.src?.original || raw.url || "",
      originalUrl: raw.originalUrl || raw.imageUrl || raw.src?.original || "",
      uploadUrl: raw.uploadUrl || raw.originalUrl || raw.imageUrl || "",
      downloadUrl: raw.downloadUrl || raw.originalUrl || raw.imageUrl || "",
      pageUrl: raw.pageUrl || raw.pexelsUrl || raw.sourceUrl || "",
      creator: raw.creator || raw.photographer || raw.user || "",
      width: Number(raw.width || raw.srcWidth || 0),
      height: Number(raw.height || raw.srcHeight || 0),
      safetyStatus: safetyCode(raw),
      safetyReason: cleanText(raw.safetyReason || raw.safety_reason || raw.reviewReason || raw.reason || ""),
      aspectLabel: raw.aspectLabel || raw.targetRatio || "",
      fileName: raw.fileName || "",
      cropUrls: raw.cropUrls || null,
      suggestedCropUrl: raw.suggestedCropUrl || "",
    };
    image.aspectLabel = closestRatioLabel(image);
    if (image.safetyStatus === "review" && !image.safetyReason) {
      image.safetyReason = "自动检测无法可靠确认正脸或裸露程度";
    }
    return image;
  }

  function selectBestImage(response) {
    const raw = response.items || response.images || response.results || response.data?.items || [];
    const vertical = raw.map(normalizeImage)
      .filter((image) => image.width > 0 && image.height > image.width && image.imageUrl);
    if (!vertical.length) throw new Error("没有找到尺寸可验证的竖屏图片（宽度必须小于高度）");
    const candidates = vertical.filter((image) => image.safetyStatus !== "rejected");
    if (!candidates.length) throw new Error("搜索结果均未通过图片安全初筛，请更换关键词后重试");
    candidates.sort((left, right) => {
      const safety = Number(right.safetyStatus === "passed") - Number(left.safetyStatus === "passed");
      return safety || ratioDistance(left) - ratioDistance(right);
    });
    return candidates[0];
  }

  function validateAiResult(result) {
    if (!result.title || !result.summary) throw new Error("AI 未返回完整标题和简介");
    if (!result.imageQueryEn) throw new Error("AI 未返回英文图片搜索词");
    if (textLength(result.title) > Number(state.settings.titleLimit || 12)) {
      throw new Error(`AI 标题为 ${textLength(result.title)} 字，超过 ${state.settings.titleLimit} 字；未自动截断，请重试`);
    }
    if (textLength(result.summary) > Number(state.settings.summaryLimit || 50)) {
      throw new Error(`AI 简介为 ${textLength(result.summary)} 字，超过 ${state.settings.summaryLimit} 字；未自动截断，请重试`);
    }
  }

  function resetItemProgress(item) {
    item.currentStage = "";
    item.stages = { article: "pending", ai: "pending", image: "pending" };
  }

  function setItemStage(item, key, status) {
    ensureItemStages(item);
    item.currentStage = key;
    item.stages[key] = status;
  }

  async function processItem(item, token) {
    if (token !== state.runToken || state.pauseRequested) return;
    item.attempts = Number(item.attempts || 0) + 1;
    item.error = "";
    item.reviewWarning = "";
    resetItemProgress(item);
    try {
      setItemStage(item, "article", "working");
      if (!item.sourceUrl) throw new Error("未读取到“查看链接”的文章地址");
      item.status = "fetching";
      await persistBatch();
      const articleResponse = await sendRuntime("FETCH_ARTICLE", { url: item.sourceUrl, sourceUrl: item.sourceUrl });
      const articleText = articleTextFromResponse(articleResponse);
      if (!articleText) throw new Error("文章链接已打开，但没有提取到正文");
      item.articleText = articleText;
      item.articleTitle = cleanText(articleResponse.title || articleResponse.article?.title || "");
      setItemStage(item, "article", "done");

      if (token !== state.runToken) return;
      setItemStage(item, "ai", "working");
      item.status = "rewriting";
      await persistBatch();
      const aiResponse = await sendRuntime("AI_PROCESS_ITEM", {
        item: {
          index: item.index, id: item.id, originalTitle: item.originalTitle,
          originalSummary: item.originalSummary, articleTitle: item.articleTitle,
          articleText, sourceUrl: item.sourceUrl,
        },
        titleLimit: Number(state.settings.titleLimit || 12),
        summaryLimit: Number(state.settings.summaryLimit || 50),
      });
      const ai = normalizeAiResult(aiResponse);
      validateAiResult(ai);
      Object.assign(item, ai);
      setItemStage(item, "ai", "done");

      if (token !== state.runToken) return;
      setItemStage(item, "image", "working");
      item.status = "searching";
      await persistBatch();
      const imageResponse = await sendRuntime("SEARCH_PEXELS_BATCH", {
        query: ai.imageQueryEn, imageQueryEn: ai.imageQueryEn,
        preferredRatio: state.settings.preferredRatio, orientation: "portrait",
      });
      item.image = selectBestImage(imageResponse);
      setItemStage(item, "image", "done");
      item.currentStage = "";
      item.status = item.image.safetyStatus === "passed" ? "completed" : "needs_review";
      item.error = "";
    } catch (error) {
      setItemStage(item, item.currentStage || "article", "error");
      item.status = "error";
      item.error = error.message || "处理失败";
      const fatalAiError = ["AI_NOT_CONFIGURED", "AI_ENDPOINT_INVALID"].includes(error.code)
        || (error.code === "HTTP_ERROR" && [400, 401, 403, 404, 422].includes(Number(error.status)));
      if (fatalAiError) {
        state.pauseRequested = true;
        state.batch.fatalError = item.error;
      }
    }
    await persistBatch();
  }

  async function runBatch() {
    if (!state.batch || !getBatchItems().length) {
      setPanelStatus(".lsa-batch-status", "请先扫描当前列表", true);
      return;
    }
    if (state.batch.status === "running") return;
    state.pauseRequested = false;
    state.runToken += 1;
    const token = state.runToken;
    state.batch.status = "running";
    state.batch.fatalError = "";
    getBatchItems().forEach((item) => {
      if (["fetching", "rewriting", "searching"].includes(item.status)) {
        item.status = "pending";
        PROCESS_STAGES.forEach(({ key }) => {
          if (item.stages[key] === "working") item.stages[key] = "pending";
        });
        item.currentStage = "";
      }
    });
    await persistBatch();
    setPanelStatus(".lsa-batch-status", "批处理已开始；并发数最多为 2。切换页面不会丢失已完成记录。");

    const concurrency = Math.max(1, Math.min(2, Number(state.settings.batchConcurrency) || 2));
    const claimNext = () => {
      if (state.pauseRequested || token !== state.runToken) return null;
      return getBatchItems().find((item) => item.status === "pending") || null;
    };
    const workers = Array.from({ length: concurrency }, async () => {
      while (!state.pauseRequested && token === state.runToken) {
        const item = claimNext();
        if (!item) break;
        item.status = "fetching";
        await processItem(item, token);
      }
    });
    await Promise.all(workers);
    if (token !== state.runToken) return;
    const counts = batchCounts();
    if (state.pauseRequested) {
      state.batch.status = "paused";
      setPanelStatus(
        ".lsa-batch-status",
        state.batch.fatalError
          ? `已停止整批，未继续请求剩余条目：${state.batch.fatalError}`
          : "已暂停；正在执行的请求已完成并保存，可稍后继续。",
        Boolean(state.batch.fatalError),
      );
    } else if (counts.failed) {
      state.batch.status = "partial";
      setPanelStatus(".lsa-batch-status", `本轮完成，${counts.failed} 条失败。请查看原因后点击“重试失败项”。`, true);
    } else {
      state.batch.status = "completed";
      setPanelStatus(".lsa-batch-status", `处理完成：${counts.done} 条通过自动初筛，${counts.review} 条图片需人工复核。`);
    }
    await persistBatch();
    Promise.allSettled([
      saveTextSnapshot("original", true),
      saveTextSnapshot("batch", true),
    ]).catch(() => {});
  }

  function pauseBatch() {
    if (!state.batch || state.batch.status !== "running") return;
    state.pauseRequested = true;
    state.batch.status = "pausing";
    persistBatch();
    setPanelStatus(".lsa-batch-status", "正在暂停；不会强行中断当前两条网络请求…");
  }

  function retryFailed(index = null) {
    if (!state.batch) return;
    const targets = index === null
      ? getBatchItems().filter((item) => item.status === "error")
      : getBatchItems().filter((item) => item.index === index);
    if (!targets.length) {
      setPanelStatus(".lsa-batch-status", "没有需要重试的失败项");
      return;
    }
    targets.forEach((item) => {
      item.status = "pending";
      item.error = "";
      resetItemProgress(item);
    });
    state.batch.status = "ready";
    persistBatch();
    runBatch();
  }

  function safetyText(image) {
    if (!image) return "无图片";
    if (image.safetyStatus === "passed") return "自动初筛通过";
    if (image.safetyStatus === "rejected") return "已拒绝";
    return `需复核：${image.safetyReason || "无法可靠判断正脸或裸露程度"}`;
  }

  function imageMeta(image) {
    if (!image) return "尚未选择图片";
    const size = image.width && image.height ? `${image.width}×${image.height}` : "尺寸未知";
    return `${image.source || "素材源未知"} · ${size} · ${image.aspectLabel || closestRatioLabel(image)} · ${safetyText(image)}`;
  }

  async function downloadFinalImage(item, button) {
    if (!item?.image) throw new Error("该条还没有可下载图片");
    if (button) { button.disabled = true; button.textContent = "下载中…"; }
    try {
      const response = await sendRuntime("DOWNLOAD_FINAL_IMAGE", {
        item, record: item, image: item.image, index: item.index,
        folder: state.settings.imageFolder, preferredRatio: state.settings.preferredRatio,
      });
      item.downloadStatus = "completed";
      item.downloadFileName = response.fileName || response.filename || "";
      item.downloadError = "";
      if (state.batch?.items?.includes(item)) await persistBatch();
      return response;
    } catch (error) {
      item.downloadStatus = "error";
      item.downloadError = error.message;
      if (state.batch?.items?.includes(item)) await persistBatch();
      throw error;
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = item.downloadStatus === "completed" ? "重新下载" : "下载成品图";
      }
    }
  }

  async function downloadAllImages() {
    const candidates = getBatchItems().filter((item) => item.image && item.status === "completed"
      && item.image.safetyStatus === "passed");
    if (!candidates.length) return setPanelStatus(".lsa-batch-status", "没有可下载的成品图", true);
    const button = q(".lsa-download-all");
    if (button) button.disabled = true;
    let cursor = 0;
    let failed = 0;
    setPanelStatus(".lsa-batch-status", `正在下载 ${candidates.length} 张成品图到 ${state.settings.imageFolder}…`);
    const worker = async () => {
      while (cursor < candidates.length) {
        const item = candidates[cursor++];
        try { await downloadFinalImage(item); } catch { failed += 1; }
      }
    };
    await Promise.all([worker(), worker()]);
    if (button) button.disabled = false;
    setPanelStatus(".lsa-batch-status", failed
      ? `下载结束：${candidates.length - failed} 张成功，${failed} 张失败。`
      : `已加入下载列表：${candidates.length} 张。`, Boolean(failed));
  }

  function stageStatusText(status) {
    return ({ pending: "等待", working: "进行中", done: "完成", error: "失败" })[status] || "等待";
  }

  function createItemProgress(item) {
    const percent = itemProgressPercent(item);
    const wrap = create("div", `lsa-item-progress${item.status === "error" ? " is-error" : ""}`);
    const headline = create("div", "lsa-item-progress-head");
    headline.append(create("span", "", "本条进度"), create("strong", "", `${percent}%`));
    const track = create("div", "lsa-progress-track");
    const fill = create("span", "lsa-progress-fill");
    fill.style.width = `${percent}%`;
    track.append(fill);
    const stages = create("div", "lsa-item-stage-list");
    PROCESS_STAGES.forEach(({ key, label }) => {
      const status = item.stages[key] || "pending";
      const stage = create("span", `lsa-item-stage is-${status}`, `${label} · ${stageStatusText(status)}`);
      stages.append(stage);
    });
    wrap.append(headline, track, stages);
    return wrap;
  }

  function renderTotalProgress() {
    const metrics = progressMetrics();
    const value = q(".lsa-total-progress-value");
    const fill = q(".lsa-total-progress-fill");
    const detail = q(".lsa-total-progress-detail");
    const stagesWrap = q(".lsa-stage-progress-list");
    if (value) value.textContent = `${metrics.percent}%`;
    if (fill) fill.style.width = `${metrics.percent}%`;
    if (detail) detail.textContent = metrics.total
      ? `已结束 ${metrics.settled} / ${metrics.total} 条；总进度会计入正在执行的步骤`
      : "扫描列表后显示总进度";
    if (!stagesWrap) return;
    stagesWrap.replaceChildren();
    PROCESS_STAGES.forEach(({ key, label }) => {
      const stageMetrics = metrics.stages[key];
      const resolved = stageMetrics.done + stageMetrics.error;
      const stagePercent = metrics.total
        ? Math.round((resolved + stageMetrics.working * 0.5) / metrics.total * 100)
        : 0;
      const row = create("div", `lsa-stage-progress-row${stageMetrics.error ? " has-error" : ""}`);
      const copy = create("div", "lsa-stage-progress-copy");
      const parts = [`完成 ${stageMetrics.done}/${metrics.total}`];
      if (stageMetrics.working) parts.push(`进行中 ${stageMetrics.working}`);
      if (stageMetrics.error) parts.push(`失败 ${stageMetrics.error}`);
      copy.append(create("span", "", label), create("small", "", parts.join(" · ")));
      const track = create("div", "lsa-progress-track");
      const bar = create("span", "lsa-progress-fill");
      bar.style.width = `${stagePercent}%`;
      track.append(bar);
      row.append(copy, track);
      stagesWrap.append(row);
    });
  }

  function renderBatchItems() {
    const wrap = q(".lsa-batch-items");
    if (!wrap) return;
    wrap.replaceChildren();
    const items = getBatchItems();
    if (!items.length) {
      wrap.append(create("div", "lsa-empty-result", "点击“扫描当前页”，最多读取 30 条内容"));
      return;
    }
    for (const item of items) {
      const card = create("article", `lsa-batch-card is-${item.status || "pending"}`);
      const header = create("div", "lsa-batch-card-header");
      header.append(create("span", "lsa-item-number", String(item.index).padStart(2, "0")));
      const title = create("strong", "lsa-original-title", item.originalTitle || "（未读取到原标题）");
      title.title = item.originalTitle || "";
      header.append(title, create("span", "lsa-item-status", STATUS_LABELS[item.status] || item.status || "待处理"));
      card.append(header, createItemProgress(item));
      if (item.title || item.summary) {
        const output = create("div", "lsa-item-output");
        output.append(create("b", "", item.title || "—"), create("p", "", item.summary || "—"));
        card.append(output);
      }
      if (item.image) {
        const media = create("div", "lsa-item-media");
        const image = create("img", "lsa-item-thumb");
        image.src = item.image.previewUrl || item.image.imageUrl;
        image.alt = item.imageQueryEn || item.originalTitle;
        image.loading = "lazy";
        image.referrerPolicy = "no-referrer";
        const meta = create("div", "lsa-item-image-copy");
        meta.append(create("p", "", item.imageQueryEn || ""),
          create("small", item.image.safetyStatus === "passed" ? "" : "is-warning", imageMeta(item.image)));
        media.append(image, meta);
        card.append(media);
      }
      if (item.error) card.append(create("p", "lsa-item-error", item.error));
      if (item.reviewWarning) card.append(create("p", "lsa-item-review-warning", item.reviewWarning));
      if (item.downloadStatus === "completed") {
        card.append(create("p", "lsa-item-download", `已下载：${item.downloadFileName || "浏览器下载目录"}`));
      } else if (item.downloadError) {
        card.append(create("p", "lsa-item-error", `下载失败：${item.downloadError}`));
      }
      const actions = create("div", "lsa-item-actions");
      if (item.status === "error") {
        const retry = create("button", "lsa-secondary-button", "重试此项");
        retry.type = "button";
        retry.addEventListener("click", () => retryFailed(item.index));
        actions.append(retry);
      }
      if (item.image) {
        const download = create("button", "lsa-secondary-button",
          item.downloadStatus === "completed" ? "重新下载" : "下载成品图");
        download.type = "button";
        download.addEventListener("click", () => downloadFinalImage(item, download).catch((error) => {
          setPanelStatus(".lsa-batch-status", `第 ${item.index} 条下载失败：${error.message}`, true);
        }));
        actions.append(download);
      }
      if (item.editUrl) {
        const edit = create("a", "lsa-link-button", "打开编辑页");
        edit.href = item.editUrl;
        actions.append(edit);
      }
      if (actions.childNodes.length) card.append(actions);
      wrap.append(card);
    }
  }

  function renderBatch() {
    if (!state.root) return;
    const counts = batchCounts();
    const summary = q(".lsa-batch-summary");
    if (summary) {
      summary.textContent = state.batch
        ? `${state.batch.batchId} · 共 ${counts.total} · 完成 ${counts.done} · 需复核 ${counts.review} · 失败 ${counts.failed} · 待处理 ${counts.pending + counts.working}`
        : "尚未建立批次";
    }
    renderTotalProgress();
    const start = q(".lsa-start-batch");
    const pause = q(".lsa-pause-batch");
    const retry = q(".lsa-retry-failed");
    if (start) {
      start.disabled = !counts.total || state.batch?.status === "running" || state.batch?.status === "pausing"
        || (!counts.pending && !counts.working);
      start.textContent = state.batch?.status === "paused" ? "继续处理" : "开始处理";
    }
    if (pause) pause.disabled = state.batch?.status !== "running";
    if (retry) retry.disabled = !counts.failed || state.batch?.status === "running";
    const save = q(".lsa-save-batch-json");
    const downloadAll = q(".lsa-download-all");
    if (save) save.disabled = !counts.total;
    if (downloadAll) downloadAll.disabled = !counts.done;
    renderBatchItems();
    renderEditRecordSelector();
  }

  function recordMatchesRoute(item) {
    if (!item || state.route.kind !== "edit") return false;
    if (state.route.id && String(item.id) === String(state.route.id)) return true;
    if (state.route.id && item.editUrl) {
      try {
        const hash = new URL(item.editUrl, location.href).hash;
        const params = new URLSearchParams(hash.split("?")[1] || "");
        return String(params.get("id") || "") === String(state.route.id);
      } catch { return item.editUrl.includes(`id=${encodeURIComponent(state.route.id)}`); }
    }
    return false;
  }

  function selectedRecord() {
    const items = getBatchItems();
    if (state.selectedRecordIndex >= 0 && items[state.selectedRecordIndex]) return items[state.selectedRecordIndex];
    return items.find(recordMatchesRoute) || null;
  }

  function renderEditRecordSelector() {
    const list = q(".lsa-record-list");
    if (!list) return;
    const items = getBatchItems();
    const automatic = items.findIndex(recordMatchesRoute);
    if (state.selectedRecordIndex < 0 && automatic >= 0) state.selectedRecordIndex = automatic;
    list.replaceChildren();
    if (!items.length) {
      list.append(create("div", "lsa-empty-result", "没有批次记录，请先到列表页处理"));
      renderSelectedRecord();
      return;
    }
    items.forEach((item, index) => {
      const option = create("button", `lsa-record-option${index === state.selectedRecordIndex ? " is-selected" : ""}`);
      option.type = "button";
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", index === state.selectedRecordIndex ? "true" : "false");
      const status = STATUS_LABELS[item.status] || item.status || "未知状态";
      option.append(
        create("strong", `lsa-record-option-status${item.status === "error" ? " is-error" : ""}`,
          `${String(item.index).padStart(2, "0")}-${status}`),
        create("span", "lsa-record-option-title", item.originalTitle || "无标题"),
      );
      option.addEventListener("click", () => selectAndNavigateRecord(index));
      list.append(option);
    });
    renderSelectedRecord();
  }

  function selectAndNavigateRecord(index) {
    const items = getBatchItems();
    const item = items[index];
    if (!item) return;
    state.selectedRecordIndex = index;
    renderEditRecordSelector();
    if (!item.editUrl) {
      setPanelStatus(".lsa-edit-status", `第 ${item.index} 条没有识别到编辑页地址，无法跳转`, true);
      return;
    }
    const target = new URL(item.editUrl, location.href).href;
    if (target === location.href) {
      setPanelStatus(".lsa-edit-status", `已选择第 ${item.index} 条，当前已在对应编辑页。`);
      return;
    }
    setPanelStatus(".lsa-edit-status", `正在跳转到第 ${item.index} 条编辑页…`);
    location.assign(target);
  }

  function renderSelectedRecord() {
    const wrap = q(".lsa-selected-record");
    const button = q(".lsa-apply-record");
    if (!wrap) return;
    wrap.replaceChildren();
    const item = selectedRecord();
    if (!item) {
      wrap.append(create("div", "lsa-empty-result", "未匹配到当前 URL 的 id；可在上方手动选择记录"));
      if (button) button.disabled = true;
      return;
    }
    wrap.append(create("h3", "", `${String(item.index).padStart(2, "0")} · ${item.originalTitle}`));
    wrap.append(create("p", "lsa-record-title", item.title || "尚未生成标题"),
      create("p", "lsa-record-summary", item.summary || "尚未生成简介"));
    if (item.image) {
      const image = create("img", "lsa-record-image");
      image.src = item.image.previewUrl || item.image.imageUrl;
      image.alt = item.imageQueryEn || item.originalTitle;
      image.referrerPolicy = "no-referrer";
      wrap.append(image, create("small", item.image.safetyStatus === "passed" ? "" : "is-warning", imageMeta(item.image)));
    }
    if (item.error) wrap.append(create("p", "lsa-item-error", item.error));
    if (button) button.disabled = !item.title || !item.summary || !item.image?.imageUrl;
  }

  async function applySelectedRecord() {
    const item = selectedRecord();
    if (!item) return setPanelStatus(".lsa-edit-status", "请先选择批次记录", true);
    if (!item.title || !item.summary || !item.image?.imageUrl) {
      return setPanelStatus(".lsa-edit-status", "该记录的文案或图片尚未准备好", true);
    }
    const button = q(".lsa-apply-record");
    if (button) button.disabled = true;
    setPanelStatus(".lsa-edit-status", "正在读取原图并写入后台上传控件…");
    try {
      const imagePayload = await sendRuntime("FETCH_IMAGE_FILE", {
        url: item.image.imageUrl, imageUrl: item.image.imageUrl,
        item, image: item.image, preferredRatio: state.settings.preferredRatio,
      });
      const result = await pageTool("APPLY_BATCH_RECORD", item, imagePayload);
      if (!result?.ok) throw new Error(result?.message || "页面字段或上传控件写入失败");
      const details = [result.title?.message, result.summary?.message, result.upload?.message]
        .filter(Boolean).join("；");
      setPanelStatus(".lsa-edit-status",
        `${result.message || "标题、简介和图片已写入后台"}${details ? `：${details}` : ""}。请核对预览后手动点击后台保存。`);
    } catch (error) {
      setPanelStatus(".lsa-edit-status", `填入失败：${error.message}`, true);
    } finally {
      if (button) button.disabled = false;
    }
  }

  function updateManualCounts() {
    const draft = parseDraft(q(".lsa-draft-copy")?.value || "");
    const title = q(".lsa-title-count");
    const summary = q(".lsa-summary-count");
    if (title) {
      title.textContent = `标题 ${textLength(draft.title)} / ${state.settings.titleLimit}`;
      title.classList.toggle("is-over", textLength(draft.title) > state.settings.titleLimit);
    }
    if (summary) {
      summary.textContent = `简介 ${textLength(draft.summary)} / ${state.settings.summaryLimit}`;
      summary.classList.toggle("is-over", textLength(draft.summary) > state.settings.summaryLimit);
    }
  }

  async function readPage() {
    try {
      const context = await pageTool("GET_PAGE_CONTEXT");
      state.pageContext = context || {};
      const title = cleanText(context.boundTitle || context.heading || context.title || context.selectedText || "");
      const summary = cleanText(context.boundSummary || context.description || "");
      const original = q(".lsa-original-copy");
      const draft = q(".lsa-draft-copy");
      if (original) original.value = formatOriginal(title, summary);
      if (draft && !draft.value) draft.value = `${title}\n${summary}`.trim();
      const queryInput = q(".lsa-stock-query");
      if (queryInput && !queryInput.value) queryInput.value = title;
      updateManualCounts();
      setPanelStatus(".lsa-manual-status", "已读取当前页面；手动填写不会点击后台保存。");
    } catch (error) {
      setPanelStatus(".lsa-manual-status", `读取失败：${error.message}`, true);
    }
  }

  async function applyManualDraft() {
    const draft = parseDraft(q(".lsa-draft-copy")?.value || "");
    if (!draft.title || !draft.summary) return setPanelStatus(".lsa-manual-status", "第一行填标题，第二行起填简介", true);
    if (textLength(draft.title) > state.settings.titleLimit || textLength(draft.summary) > state.settings.summaryLimit) {
      return setPanelStatus(".lsa-manual-status", "标题或简介超过限制，未写入后台", true);
    }
    try {
      const result = await pageTool("APPLY_DRAFT", draft.title, draft.summary);
      setPanelStatus(".lsa-manual-status", result?.message || "已写入标题和简介，请人工保存", !result?.ok);
    } catch (error) {
      setPanelStatus(".lsa-manual-status", error.message, true);
    }
  }

  async function makeManualEnglishQuery(source) {
    try {
      const response = await sendRuntime("GENERATE_IMAGE_QUERY", { title: source, summary: "" });
      const value = cleanText(response.imageQueryEn || response.query || response.result?.imageQueryEn || "");
      if (value) return value;
    } catch { /* Continue with the independent batch API. */ }
    const response = await sendRuntime("AI_PROCESS_ITEM", {
      item: { originalTitle: source, originalSummary: "", articleText: source, sourceUrl: location.href },
      mode: "image_query_only",
    });
    const value = normalizeAiResult(response).imageQueryEn;
    if (!value) throw new Error("AI 未返回英文图片搜索词");
    return value;
  }

  async function searchManualImages() {
    const input = q(".lsa-stock-query");
    let value = cleanText(input?.value || parseOriginal(q(".lsa-original-copy")?.value || "").title);
    if (!value) return setPanelStatus(".lsa-image-status", "请先输入原标题或英文关键词", true);
    const button = q(".lsa-search-images");
    if (button) button.disabled = true;
    setPanelStatus(".lsa-image-status", "正在生成英文提示词并搜索竖屏图片…");
    try {
      value = await makeManualEnglishQuery(value);
      input.value = value;
      const response = await sendRuntime("SEARCH_PEXELS_BATCH", {
        query: value, imageQueryEn: value, preferredRatio: state.settings.preferredRatio, orientation: "portrait",
      });
      const raw = response.items || response.images || response.results || [];
      state.manualResults = raw.map(normalizeImage)
        .filter((image) => image.width > 0 && image.height > image.width && image.safetyStatus !== "rejected")
        .sort((left, right) => {
          const safety = Number(right.safetyStatus === "passed") - Number(left.safetyStatus === "passed");
          return safety || ratioDistance(left) - ratioDistance(right);
        });
      renderManualImages();
      const sources = [...new Set(state.manualResults.map((image) => image.source).filter(Boolean))].join(" / ");
      setPanelStatus(".lsa-image-status", state.manualResults.length
        ? `找到 ${state.manualResults.length} 张经尺寸验证的竖图；来源：${sources || "Pexels/Pixabay"}。安全标记仅为自动初筛。`
        : "没有找到尺寸可验证的竖图，请更换关键词。", !state.manualResults.length);
    } catch (error) {
      state.manualResults = [];
      renderManualImages();
      setPanelStatus(".lsa-image-status", error.message, true);
    } finally {
      if (button) button.disabled = false;
    }
  }

  function renderManualImages() {
    const wrap = q(".lsa-stock-results");
    if (!wrap) return;
    wrap.replaceChildren();
    if (!state.manualResults.length) {
      wrap.append(create("div", "lsa-empty-result", "这里只展示已验证宽度小于高度的图片"));
      return;
    }
    state.manualResults.forEach((image, index) => {
      const card = create("article", "lsa-stock-card");
      const preview = create("img", "lsa-stock-image");
      preview.src = image.previewUrl || image.imageUrl;
      preview.alt = image.source || "竖屏素材";
      preview.loading = "lazy";
      preview.referrerPolicy = "no-referrer";
      const copy = create("div", "lsa-stock-copy");
      copy.append(create("p", "lsa-stock-title", `${image.source || "素材"} · ${image.creator || "作者信息见来源页"}`));
      copy.append(create("p", image.safetyStatus === "passed" ? "lsa-stock-meta" : "lsa-stock-meta is-warning", imageMeta(image)));
      const download = create("button", "lsa-image-action", "下载此图");
      download.type = "button";
      download.addEventListener("click", async () => {
        const original = parseOriginal(q(".lsa-original-copy")?.value || "");
        const synthetic = {
          index: index + 1, originalTitle: original.title, title: original.title || "锁屏配图",
          summary: original.summary || "", image,
        };
        try {
          await downloadFinalImage(synthetic, download);
          setPanelStatus(".lsa-image-status", "图片已加入浏览器下载列表");
        } catch (error) {
          setPanelStatus(".lsa-image-status", error.message, true);
        }
      });
      copy.append(download);
      card.append(preview, copy);
      wrap.append(card);
    });
  }

  function diagnosticsText() {
    const lines = [
      `站点：${location.hostname}`,
      `路由：${state.route.kind} (${location.hash || "无 hash"})`,
      `批次：${state.batch?.batchId || "无"}`,
      `记录：${getBatchItems().length}`,
      `原始内容目录：${state.settings.originalFolder}`,
      `成品图目录：${state.settings.imageFolder}`,
    ];
    if (state.batch?.diagnostics) {
      const diagnostics = state.batch.diagnostics;
      if (Array.isArray(diagnostics) && diagnostics.length) lines.push(`扫描诊断：${diagnostics.join("；")}`);
      else if (!Array.isArray(diagnostics) && Object.keys(diagnostics).length) {
        const warnings = Array.isArray(diagnostics.warnings) ? diagnostics.warnings.join("；") : "";
        lines.push(`扫描诊断：${warnings || JSON.stringify(diagnostics)}`);
      }
    }
    getBatchItems().filter((item) => item.error).slice(0, 5)
      .forEach((item) => lines.push(`${String(item.index).padStart(2, "0")}：${item.error}`));
    return lines.join("\n");
  }

  function updateDiagnostics() {
    const node = q(".lsa-diagnostics-text");
    if (node) node.textContent = diagnosticsText();
  }

  function buildAssistant(route) {
    const root = create("aside", "lsa-assistant");
    root.setAttribute("aria-label", "锁屏编辑助手悬浮窗");
    const isList = route.kind === "list";
    root.innerHTML = `
      <header class="lsa-assistant-header">
        <div class="lsa-assistant-logo">锁</div>
        <div class="lsa-assistant-name"><strong>锁屏编辑助手</strong><small>${isList ? "列表批处理" : `编辑页 ${route.id ? `· ID ${route.id}` : ""}`}</small></div>
        <div class="lsa-window-actions"><button class="lsa-window-button lsa-minimize" type="button" title="最小化">—</button><button class="lsa-window-button lsa-close" type="button" title="关闭">×</button></div>
      </header>
      <nav class="lsa-assistant-nav" data-tabs="${isList ? "2" : "3"}">
        ${isList ? '<button class="lsa-tab-button is-active" data-tab="batch" type="button">批处理</button>' : '<button class="lsa-tab-button is-active" data-tab="record" type="button">批次填入</button><button class="lsa-tab-button" data-tab="manual" type="button">手动填写</button>'}
        <button class="lsa-tab-button" data-tab="images" type="button">单条配图</button>
      </nav>
      <div class="lsa-assistant-body">
        ${isList ? `
        <section class="lsa-tab-panel" data-panel="batch">
          <div class="lsa-section-card">
            <div class="lsa-section-row"><h2 class="lsa-section-title">列表批处理（最多 30 条）</h2><button class="lsa-text-action lsa-scan-batch" type="button">扫描当前页</button></div>
            <p class="lsa-section-hint">卡片按页面左上到右下编号；读取“查看链接”的正文后，独立 API 一次生成同语言标题、简介和英文配图词。</p>
            <div class="lsa-total-progress" aria-label="批次总进度">
              <div class="lsa-total-progress-head"><span>总进度</span><strong class="lsa-total-progress-value">0%</strong></div>
              <div class="lsa-progress-track lsa-total-progress-track"><span class="lsa-progress-fill lsa-total-progress-fill"></span></div>
              <p class="lsa-total-progress-detail">扫描列表后显示总进度</p>
              <div class="lsa-stage-progress-list"></div>
            </div>
            <p class="lsa-batch-summary">尚未建立批次</p>
            <div class="lsa-button-row"><button class="lsa-primary-button lsa-start-batch" type="button" disabled>开始处理</button><button class="lsa-secondary-button lsa-pause-batch" type="button" disabled>暂停</button><button class="lsa-secondary-button lsa-retry-failed" type="button" disabled>重试失败项</button></div>
            <div class="lsa-button-row"><button class="lsa-secondary-button lsa-save-batch-json" type="button" disabled>保存批次 JSON</button><button class="lsa-secondary-button lsa-download-all" type="button" disabled>下载自动通过图</button></div>
            <p class="lsa-status-text lsa-batch-status">扫描后可开始；并发固定不超过 2，状态实时保存。</p>
          </div>
          <div class="lsa-batch-items"></div>
        </section>` : `
        <section class="lsa-tab-panel" data-panel="record">
          <div class="lsa-section-card">
            <div class="lsa-section-row"><h2 class="lsa-section-title">从批次填入当前编辑页</h2><button class="lsa-text-action lsa-refresh-record" type="button">重新匹配 ID</button></div>
            <p class="lsa-section-hint">优先按当前 URL 的 id 自动匹配；点击下面任一记录会立即跳转到对应编辑页。只填入标题、简介和上传图片，绝不点击后台最终保存。</p>
            <div class="lsa-record-list" role="listbox" aria-label="选择并跳转到批次记录"></div>
            <div class="lsa-selected-record"></div>
            <button class="lsa-primary-button lsa-apply-record" type="button" disabled>填入文案并上传图片</button>
            <p class="lsa-status-text lsa-edit-status">请先核对匹配记录；图片使用原图数据写入后台上传控件。</p>
          </div>
        </section>
        <section class="lsa-tab-panel" data-panel="manual" hidden>
          <div class="lsa-section-card">
            <div class="lsa-section-row"><h2 class="lsa-section-title">单条手动填写</h2><button class="lsa-text-action lsa-read-page" type="button">读取页面</button></div>
            <label class="lsa-field-label"><span>页面原稿</span><span>标题////简介</span></label><textarea class="lsa-assistant-textarea lsa-original-copy" placeholder="标题////简介"></textarea>
            <label class="lsa-field-label"><span>待填写文案</span><span><span class="lsa-counter lsa-title-count">标题 0 / 12</span> <span class="lsa-counter lsa-summary-count">简介 0 / 50</span></span></label><textarea class="lsa-assistant-textarea lsa-draft-copy" placeholder="第一行标题&#10;第二行起简介"></textarea>
            <div class="lsa-button-row"><button class="lsa-primary-button lsa-apply-draft" type="button">填写标题和简介</button><button class="lsa-secondary-button lsa-bind-fields" type="button">重新绑定字段</button></div><p class="lsa-status-text lsa-manual-status">不会自动点击后台保存。</p>
          </div>
        </section>`}
        <section class="lsa-tab-panel" data-panel="images" hidden>
          <div class="lsa-section-card">
            <div class="lsa-section-row"><h2 class="lsa-section-title">单条竖屏配图</h2><button class="lsa-text-action lsa-read-for-images" type="button">读取原标题</button></div>
            <p class="lsa-section-hint">自动把原标题总结为英文视觉词；优先 Pexels，必要时回退 Pixabay。只展示可验证为竖向的图片。</p>
            <div class="lsa-search-row"><input class="lsa-assistant-input lsa-stock-query" type="search" placeholder="原标题或 English keywords"><button class="lsa-primary-button lsa-search-images" type="button">搜索</button></div>
            <p class="lsa-status-text lsa-image-status">正脸与裸露检测存在局限，无法确定的图片会明确标为“需复核”。</p>
          </div>
          <div class="lsa-stock-results"><div class="lsa-empty-result">这里只展示已验证宽度小于高度的图片</div></div>
        </section>
        <details class="lsa-diagnostics"><summary>诊断信息</summary><pre class="lsa-diagnostics-text"></pre></details>
      </div>
      <footer class="lsa-assistant-footer"><span class="lsa-global-status">草稿与批次状态自动保存</span><button class="lsa-text-action lsa-open-settings" type="button">设置</button></footer>`;
    return root;
  }

  async function saveAssistantState(patch) {
    const { assistantState = {} } = await chrome.storage.local.get("assistantState");
    return chrome.storage.local.set({ assistantState: { ...assistantState, ...patch } });
  }

  function clampPosition(left, top) {
    const width = state.root?.offsetWidth || 410;
    const height = state.root?.offsetHeight || 58;
    return {
      left: Math.max(6, Math.min(window.innerWidth - width - 6, Number(left) || 6)),
      top: Math.max(6, Math.min(window.innerHeight - height - 6, Number(top) || 6)),
    };
  }

  function applyPosition(position) {
    if (!state.root || !position) return;
    const next = clampPosition(position.left, position.top);
    state.root.style.left = `${next.left}px`;
    state.root.style.top = `${next.top}px`;
    state.root.style.right = "auto";
  }

  function applySize(size) {
    if (!state.root || !size) return;
    const width = Math.max(320, Math.min(window.innerWidth - 12, Number(size.width) || 410));
    const height = Math.max(300, Math.min(window.innerHeight - 12, Number(size.height) || 760));
    state.root.style.width = `${width}px`;
    state.root.style.height = `${height}px`;
  }

  function startDrag(event) {
    if (event.button !== 0 || event.target.closest("button")) return;
    const rect = state.root.getBoundingClientRect();
    state.dragging = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    document.addEventListener("pointermove", moveDrag, true);
    document.addEventListener("pointerup", stopDrag, true);
  }

  function moveDrag(event) {
    if (!state.dragging) return;
    applyPosition({ left: event.clientX - state.dragging.x, top: event.clientY - state.dragging.y });
  }

  function stopDrag() {
    if (!state.dragging) return;
    state.dragging = null;
    document.removeEventListener("pointermove", moveDrag, true);
    document.removeEventListener("pointerup", stopDrag, true);
    const rect = state.root.getBoundingClientRect();
    saveAssistantState({ position: { left: Math.round(rect.left), top: Math.round(rect.top) } });
  }

  function setMinimized(minimized) {
    state.root?.classList.toggle("is-minimized", minimized);
    const close = q(".lsa-close");
    if (close) {
      close.textContent = minimized ? "□" : "×";
      close.title = minimized ? "恢复" : "关闭";
    }
    saveAssistantState({ minimized });
  }

  function unmount({ disable = false } = {}) {
    clearTimeout(state.resizeTimer);
    state.resizeObserver?.disconnect();
    state.resizeObserver = null;
    state.root?.remove();
    state.root = null;
    if (disable) saveAssistantState({ enabled: false });
  }

  function bindAssistantEvents() {
    q(".lsa-assistant-header")?.addEventListener("pointerdown", startDrag);
    q(".lsa-minimize")?.addEventListener("click", () => setMinimized(true));
    q(".lsa-close")?.addEventListener("click", () => {
      if (state.root?.classList.contains("is-minimized")) setMinimized(false);
      else unmount({ disable: true });
    });
    qa(".lsa-tab-button").forEach((button) => button.addEventListener("click", () => switchTab(button.dataset.tab)));
    q(".lsa-open-settings")?.addEventListener("click", () => chrome.runtime.sendMessage({ type: "OPEN_OPTIONS", action: "OPEN_OPTIONS" }));
    q(".lsa-scan-batch")?.addEventListener("click", scanListItems);
    q(".lsa-start-batch")?.addEventListener("click", runBatch);
    q(".lsa-pause-batch")?.addEventListener("click", pauseBatch);
    q(".lsa-retry-failed")?.addEventListener("click", () => retryFailed());
    q(".lsa-save-batch-json")?.addEventListener("click", () => saveTextSnapshot("batch").catch(() => {}));
    q(".lsa-download-all")?.addEventListener("click", downloadAllImages);
    q(".lsa-refresh-record")?.addEventListener("click", () => {
      state.selectedRecordIndex = -1;
      renderEditRecordSelector();
      setPanelStatus(".lsa-edit-status", selectedRecord() ? "已按当前 URL 的 id 重新匹配。" : "仍未匹配，可手动选择。", !selectedRecord());
    });
    q(".lsa-apply-record")?.addEventListener("click", applySelectedRecord);
    q(".lsa-read-page")?.addEventListener("click", readPage);
    q(".lsa-read-for-images")?.addEventListener("click", async () => {
      await readPage();
      const title = parseOriginal(q(".lsa-original-copy")?.value || "").title || state.pageContext.title || "";
      if (q(".lsa-stock-query")) q(".lsa-stock-query").value = title;
    });
    q(".lsa-apply-draft")?.addEventListener("click", applyManualDraft);
    q(".lsa-bind-fields")?.addEventListener("click", () => pageTool("START_BINDING")
      .catch((error) => setPanelStatus(".lsa-manual-status", error.message, true)));
    q(".lsa-draft-copy")?.addEventListener("input", updateManualCounts);
    q(".lsa-search-images")?.addEventListener("click", searchManualImages);
    q(".lsa-stock-query")?.addEventListener("keydown", (event) => { if (event.key === "Enter") searchManualImages(); });
    q(".lsa-diagnostics")?.addEventListener("toggle", updateDiagnostics);
  }

  async function mount(route, { force = false } = {}) {
    if (route.kind === "none" || location.hostname !== TARGET_HOST) return;
    if (state.root && state.route.key === route.key) return;
    unmount();
    const [{ settings = {} }, local] = await Promise.all([
      chrome.storage.sync.get("settings"), chrome.storage.local.get(["batchState", "assistantState"]),
    ]);
    if (!force && local.assistantState?.enabled === false) return;
    state.settings = { ...DEFAULT_SETTINGS, ...settings };
    state.batch = local.batchState || state.batch;
    if (state.batch?.status === "running" || state.batch?.status === "pausing") {
      state.batch.status = "paused";
      getBatchItems().forEach((item) => {
        if (["fetching", "rewriting", "searching"].includes(item.status)) item.status = "pending";
      });
      persistBatch({ render: false });
    }
    state.route = route;
    state.selectedRecordIndex = -1;
    state.root = buildAssistant(route);
    document.documentElement.append(state.root);
    applySize(local.assistantState?.size);
    applyPosition(local.assistantState?.position);
    if (local.assistantState?.minimized) {
      state.root.classList.add("is-minimized");
      const close = q(".lsa-close");
      if (close) { close.textContent = "□"; close.title = "恢复"; }
    }
    bindAssistantEvents();
    if (typeof ResizeObserver === "function") {
      state.resizeObserver = new ResizeObserver(() => {
        if (!state.root || state.root.classList.contains("is-minimized")) return;
        clearTimeout(state.resizeTimer);
        state.resizeTimer = setTimeout(() => {
          const rect = state.root?.getBoundingClientRect();
          if (!rect) return;
          saveAssistantState({ size: { width: Math.round(rect.width), height: Math.round(rect.height) },
            position: clampPosition(rect.left, rect.top) });
        }, 200);
      });
      state.resizeObserver.observe(state.root);
    }
    renderBatch();
    updateDiagnostics();
    if (route.kind === "edit") readPage();
    saveAssistantState({ enabled: true });
  }

  async function handleRouteChange({ force = false } = {}) {
    const route = routeFromLocation();
    if (route.kind === "none") {
      state.route = route;
      unmount();
      return;
    }
    if (state.root && state.route.key === route.key) return;
    await mount(route, { force });
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const type = message?.type || message?.action;
    if (type !== "TOGGLE_FLOATING_ASSISTANT") return undefined;
    if (state.root) unmount({ disable: true });
    else handleRouteChange({ force: true }).catch(() => {});
    sendResponse({ ok: true });
    return undefined;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes.settings?.newValue) {
      state.settings = { ...state.settings, ...changes.settings.newValue };
      updateManualCounts();
      renderBatch();
    }
    if (area === "local" && changes.batchState?.newValue) {
      const incoming = changes.batchState.newValue;
      if (!state.batch || Number(incoming.updatedAt || 0) > Number(state.batch.updatedAt || 0)) {
        state.batch = incoming;
        renderBatch();
      }
    }
  });

  window.addEventListener("hashchange", () => handleRouteChange().catch(() => {}));
  window.addEventListener("popstate", () => handleRouteChange().catch(() => {}));
  window.addEventListener("resize", () => {
    if (!state.root || state.root.classList.contains("is-minimized")) return;
    const rect = state.root.getBoundingClientRect();
    applySize({ width: rect.width, height: rect.height });
    applyPosition({ left: rect.left, top: rect.top });
  });
  setInterval(() => {
    if (state.lastLocation === location.href) return;
    state.lastLocation = location.href;
    handleRouteChange().catch(() => {});
  }, 800);

  handleRouteChange().catch(() => {});
})();
