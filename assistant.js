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
    rewriteMode: "ai", thinkingLevel: "medium", autoSearch: true, duplicateCheck: true,
    bangladeshMode: false,
    usageThreshold: 3, usageWindowDays: 90,
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
    { key: "ai", label: "文案改写" },
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
    mountRevision: 0,
    tabContext: null, tabSettings: {}, globalSettings: {},
    workToken: `${Date.now()}-${Math.random()}`, workOwned: false, leaseTimer: null, scanning: false,
    imageHistory: {}, globalManual: {}, globalUsage: {}, imagePage: 1, imageHasNext: false, imageBusy: false, searchRevision: 0,
    imageQuery: "", imageTargetIndex: null, pageFilter: "all", autoReadRevision: 0,
    downloadBusy: false, downloadProgress: null,
    titleTranslationStatus: new Map(), titleTranslationInFlight: new Set(),
    aiTranslation: { loaded: false, configured: false, reason: "正在检查主 AI 配置…" },
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
    return LSAWorkflow.count(value);
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
      error.errorType = response.errorType || "";
      error.model = response.model || "";
      error.attempts = Number(response.attempts) || 0;
      error.diagnostics = Array.isArray(response.diagnostics) ? response.diagnostics : [];
      error.usedFallbackModel = Boolean(response.usedFallbackModel);
      throw error;
    }
    return response;
  }

  async function pageTool(name, ...args) {
    const methodMap = {
      GET_SITE_ROUTE: "getSiteRoute", SCAN_LIST_ITEMS: "scanListItems", GET_PAGE_CONTEXT: "getPageContext",
      SCAN_PAGE_SNAPSHOT: "scanPageSnapshot",
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

  function isBangladeshEligible() {
    const item = getBatchItems().find(recordMatchesRoute) || selectedRecord?.() || getBatchItems()[0];
    const language = state.batch?.metadata?.language || item?.pageLanguage || item?.language || "";
    const country = state.batch?.metadata?.country || item?.pageCountry || "";
    return LSAWorkflow.normalizeLanguageCode(language) === "bn"
      && /(?:bangladesh|孟加拉|বাংলাদেশ)/iu.test(String(country));
  }

  function isBangladeshModeActive() {
    return isBangladeshEligible() && Boolean(state.settings.bangladeshMode);
  }

  function renderBangladeshMode() {
    const eligible = isBangladeshEligible();
    const active = eligible && Boolean(state.settings.bangladeshMode);
    const warning = q(".lsa-bangladesh-warning");
    if (warning) warning.hidden = !active;
    const bar = q(".lsa-bangladesh-mode-bar");
    if (bar) bar.classList.toggle("is-active", active);
    const badge = q(".lsa-bangladesh-badge");
    if (badge) badge.textContent = active ? "已开启" : eligible ? "建议开启" : "条件未匹配";
    const toggle = q(".lsa-bangladesh-toggle");
    if (toggle) { toggle.checked = Boolean(state.settings.bangladeshMode); toggle.disabled = !eligible || state.workOwned; }
    const hint = q(".lsa-bangladesh-mode-hint");
    if (hint) hint.textContent = active
      ? "人物与非蝴蝶/鱼类动物会被严格初筛；自动结果仍必须逐条人工审核。"
      : eligible ? "检测到孟加拉语 + 孟加拉，请人工确认后开启。工具不会自动改数据。"
        : "仅当语言为孟加拉语且国家为孟加拉时可开启。";
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
    if (!state.batch) return null;
    const copy = JSON.parse(JSON.stringify(state.batch));
    copy.version = 4; copy.countUnit = "words";
    copy.items.forEach((item) => { item.manualDuplicate = Boolean(state.globalManual[LSAWorkflow.imageKey(item.image || {})]); });
    return copy;
  }

  function persistBatch({ render = true, item = null, progressOnly = false } = {}) {
    if (!state.batch) return Promise.resolve();
    state.batch.updatedAt = Date.now();
    const snapshot = cloneBatch();
    state.storageChain = state.storageChain.catch(() => {})
      .then(() => chrome.storage.local.set({ [state.tabContext.keys.batchState]: snapshot }));
    if (render) {
      if (LSAAssistantEngine.shouldPatchProgress(state.batch, item, progressOnly)) renderItemRuntimeState(item);
      else renderBatch();
    }
    return state.storageChain;
  }

  async function acquireWork() {
    await sendRuntime("WORK_LOCK", { operation: "acquire", token: state.workToken });
    state.workOwned = true;
    const batchState = (await chrome.storage.local.get(state.tabContext.keys.batchState))[state.tabContext.keys.batchState];
    if (batchState && (!state.batch || batchState.updatedAt > state.batch.updatedAt)) state.batch = batchState;
    clearInterval(state.leaseTimer);
    state.leaseTimer = setInterval(() => {
      sendRuntime("WORK_LOCK", { operation: "renew", token: state.workToken }).catch(() => {
        state.pauseRequested = true;
        state.workOwned = false;
        clearInterval(state.leaseTimer);
      });
    }, 8000);
  }

  async function releaseWork() {
    clearInterval(state.leaseTimer);
    state.workOwned = false;
    await sendRuntime("WORK_LOCK", { operation: "release", token: state.workToken }).catch(() => {});
    renderBatch();
  }

  async function recoverInterruptedBatch() {
    if (state.workOwned || !["running", "pausing"].includes(state.batch?.status)) return;
    const lease = await sendRuntime("WORK_LOCK", { operation: "status", token: state.workToken });
    if (lease.active) return;
    try {
      await acquireWork();
      state.batch.status = "paused";
      getBatchItems().forEach((item) => {
        if (["fetching", "rewriting", "searching"].includes(item.status)) item.status = "pending";
        for (const stage of Object.keys(item.stages || {})) if (item.stages[stage] === "working") item.stages[stage] = "pending";
      });
      await persistBatch();
    } finally { if (state.workOwned) await releaseWork(); }
  }

  function pagesInBatch() {
    const pages = new Map();
    for (const item of getBatchItems()) {
      const key = item.pageKey || "legacy";
      if (!pages.has(key)) pages.set(key, { key, label: item.pageLabel || "原有批次", items: [] });
      pages.get(key).items.push(item);
    }
    return [...pages.values()];
  }

  function currentBatchLimit() { return LSAWorkflow.batchSize(state.batch?.batchLimit || state.settings.batchLimit); }
  function currentFolder() { return state.batch ? LSAWorkflow.folderName(state.batch) : ""; }
  async function archiveBatch(batch = cloneBatch()) {
    if (!batch?.items?.length) return;
    const key = `${state.tabContext.keys.batchState}:folder:${encodeURIComponent(batch.batchId)}`;
    await chrome.storage.local.set({ [key]: batch });
  }
  async function selectFolder(batch) {
    await archiveBatch();
    state.batch = batch;
    state.selectedRecordIndex = -1; state.pageFilter = "all";
    state.tabSettings = { ...state.tabSettings, batchLimit: LSAWorkflow.batchSize(batch.batchLimit) };
    state.settings.batchLimit = state.tabSettings.batchLimit;
    await chrome.storage.local.set({ [state.tabContext.keys.settings]: state.tabSettings });
    await persistBatch();
    const reconciliation = await sendRuntime("RECONCILE_IMAGE_DOWNLOADS").catch(() => null);
    if (reconciliation?.history) state.imageHistory = reconciliation.history;
  }

  async function exportResults(pageKey = null) {
    if (!state.batch) return;
    const pages = pagesInBatch().filter((page) => pageKey ? page.key === pageKey
      : page.items.every((item) => ["completed", "needs_review"].includes(item.status)));
    const items = pages.flatMap((page) => page.items);
    if (!items.length) return setPanelStatus(".lsa-transfer-status", "尚无已完成页面；可保存完整批次 JSON 保留当前进度", true);
    const allPages = pagesInBatch();
    const pageNumber = pageKey ? Math.max(1, allPages.findIndex((page) => page.key === pageKey) + 1) : 0;
    const fileType = pageKey ? `结果_第${pageNumber}页` : "批次结果";
    await sendRuntime("SAVE_TEXT_FILE", { folder: state.settings.originalFolder, batchFolder: currentFolder(),
      fileName: LSAWorkflow.batchFileName(state.batch, fileType, items.length),
      text: JSON.stringify({ ...cloneBatch(), version: 4, countUnit: "words", format: "lockscreen-results", items: items.map((item) => ({ ...item, manualDuplicate: Boolean(state.globalManual[LSAWorkflow.imageKey(item.image || {})]) })) }, null, 2) });
    setPanelStatus(".lsa-transfer-status", `已导出 ${pages.length} 页、${items.length} 条结果`);
  }

  async function importResults(file) {
    if (!file) return;
    if (state.workOwned) return setPanelStatus(".lsa-transfer-status", "请先暂停当前读取或处理", true);
    setPanelStatus(".lsa-transfer-status", "正在读取 JSON 并整理文件夹…");
    try {
      if (file.size > 32 * 1024 * 1024) throw new Error("JSON 超过 32MB，请按页面导入");
      const batch = LSAWorkflow.importBatch(JSON.parse(await file.text()), state.settings);
      await acquireWork();
      const folders = LSAWorkflow.splitBatchFolders(batch);
      let usageWarning = "";
      try { await sendRuntime("REBUILD_IMAGE_USAGE", { batch }); }
      catch (error) { usageWarning = `；图片使用记录未能重建：${error.message}`; }
      // Preserve the old batch before switching; never append unrelated imported records.
      await archiveBatch();
      for (const folder of folders) await archiveBatch(folder);
      const selected = folders.find((folder) => folder.items.some(recordMatchesRoute)) || folders[0];
      state.batch = null;
      await selectFolder(selected);
      await sendRuntime("RECONCILE_IMAGE_DOWNLOADS").catch(() => {});
      setPanelStatus(".lsa-transfer-status", `已导入 ${batch.items.length} 条，分为 ${folders.length} 个文件夹；当前显示 ${selected.items.length} 条，旧批次已归档，不再追加。可在文件夹列表切换${usageWarning}。`);
    } catch (error) { setPanelStatus(".lsa-transfer-status", `导入失败：${error.message}`, true); }
    finally { if (state.workOwned) await releaseWork(); }
  }

  function makeBatchId() {
    const now = new Date();
    const pad = (value) => String(value).padStart(2, "0");
    return [now.getFullYear(), pad(now.getMonth() + 1), pad(now.getDate()), "-",
      pad(now.getHours()), pad(now.getMinutes()), pad(now.getSeconds()), "-", state.tabContext.tabId].join("");
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
      metadata: state.batch.metadata, batchLimit: currentBatchLimit(),
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
    const fileType = kind === "original-list" ? "批次原稿_读取时" : isOriginal ? "批次原稿_含正文" : "批次结果";
    const fileName = LSAWorkflow.batchFileName(state.batch, fileType);
    try {
      const response = await sendRuntime("SAVE_TEXT_FILE", {
        folder: state.settings.originalFolder,
        batchFolder: currentFolder(),
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
    if (state.workOwned || state.scanning) return;
    const button = q(".lsa-scan-batch");
    if (button) button.disabled = true;
    setPanelStatus(".lsa-batch-status", "正在按页面左上到右下顺序扫描…");
    try {
      await acquireWork();
      state.scanning = true;
      state.pauseRequested = false;
      const limit = LSAWorkflow.batchSize(state.settings.batchLimit);
      const response = await pageTool("SCAN_PAGE_SNAPSHOT", limit);
      if (!response?.items?.length) throw new Error(response?.message || "页面未识别到内容");
      const metadata = LSAWorkflow.batchMeta(response.metadata);
      const rawItems = response.items.slice(0, limit);
      const samePage = state.batch && state.batch.metadata?.language === metadata.language
        && state.batch.metadata?.country === metadata.country
        && state.batch.items.length === rawItems.length
        && rawItems.every((raw) => getBatchItems().some((item) => LSAWorkflow.recordKey(item) === LSAWorkflow.recordKey(normalizeScannedItem(raw, 0))));
      if (!samePage) {
        await archiveBatch();
        const batchId = makeBatchId() + "-" + String(Date.now()).slice(-3);
        state.batch = {
          version: 4, countUnit: "words", format: "lockscreen-results", batchId, metadata, batchLimit: limit,
          sourcePage: location.href, createdAt: Date.now(), updatedAt: Date.now(), status: "ready",
          originalFolder: state.settings.originalFolder, imageFolder: state.settings.imageFolder,
          preferredRatio: state.settings.preferredRatio, diagnostics: response.diagnostics?.warnings || [],
          items: rawItems.map((raw, index) => ({ ...normalizeScannedItem(raw, index),
            pageKey: batchId, pageLabel: response.pageLabel || "当前页",
            pageLanguage: metadata.language, pageCountry: metadata.country, sourcePage: response.sourcePage || location.href })),
        };
      } else state.batch.batchLimit = limit;
      state.selectedRecordIndex = -1; state.pageFilter = "all";
      await persistBatch();
      setPanelStatus(".lsa-batch-status", `当前文件夹已读取 ${getBatchItems().length} / ${limit} 条；${samePage ? "相同页面保留已有处理结果。" : "旧批次已归档，不与本页合并。"}${rawItems.length < limit ? "页面不足目标数量，请在网站选择每页显示足够条数后重新读取；工具不会自动翻页。" : ""}`);
      setPanelStatus(".lsa-transfer-status", `当前只显示 ${getBatchItems().length} 条；其他结果可在“切换文件夹”中打开，不会叠加在下方。`);
      saveTextSnapshot("original-list", true).catch((error) => {
        setPanelStatus(".lsa-batch-status", `原始 JSON 保存失败：${error.message}`, true);
      });
    } catch (error) {
      setPanelStatus(".lsa-batch-status", error.message || "扫描失败", true);
    } finally {
      state.scanning = false;
      if (state.workOwned) await releaseWork();
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
      copySource: cleanText(response.copySource || data.copySource || ""),
      summarySource: cleanText(response.summarySource || data.summarySource || ""),
      titleSource: cleanText(response.titleSource || data.titleSource || ""),
      rewriteMode: data.rewriteMode || response.rewriteMode || "ai",
      aiModel: cleanText(response.model || data.model || ""),
      aiAttempts: Number(response.attempts || data.attempts || 0),
      aiDiagnostics: Array.isArray(response.diagnostics) ? response.diagnostics : [],
      usedFallbackModel: Boolean(response.usedFallbackModel),
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
      imageKey: raw.imageKey || "",
      globalManualDuplicate: Boolean(raw.globalManualDuplicate),
      usageCount: Number(raw.usageCount || 0),
      usageLimited: Boolean(raw.usageLimited),
      localDownloadStatus: raw.localDownloadStatus || "",
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
    if (!result.imageQueryEn && result.rewriteMode !== "local") throw new Error("AI 未返回英文图片搜索词");
    if (textLength(result.title) > Number(state.settings.titleLimit || 12)) {
      throw new Error(`标题为 ${textLength(result.title)} 词，超过 ${state.settings.titleLimit} 词；请重试改写`);
    }
    if (textLength(result.summary) > Number(state.settings.summaryLimit || 50)) {
      throw new Error(`简介为 ${textLength(result.summary)} 词，超过 ${state.settings.summaryLimit} 词；请重试改写`);
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
    const bangladeshMode = isBangladeshModeActive();
    item.attempts = Number(item.attempts || 0) + 1;
    item.error = "";
    item.errorType = "";
    item.error_type = "";
    item.aiErrorModel = "";
    item.model = "";
    item.aiDiagnostics = [];
    item.retryStatus = "";
    item.reviewWarning = "";
    resetItemProgress(item);
    try {
      setItemStage(item, "article", "working");
      item.status = "fetching";
      await persistBatch({ item, progressOnly: true });
      const priorSummarySource = cleanText(item.summarySource || "");
      const hadStoredArticleText = Boolean(item.articleText);
      const articleResponse = !item.articleText && item.sourceUrl
        ? await sendRuntime("FETCH_ARTICLE", { url: item.sourceUrl, sourceUrl: item.sourceUrl }) : {};
      const fetchedArticleText = articleTextFromResponse(articleResponse);
      const articleText = item.articleText || fetchedArticleText || item.originalSummary || item.originalTitle;
      const summarySource = hadStoredArticleText || fetchedArticleText ? "article_body"
        : item.originalSummary ? "original_summary" : "original_title";
      if (!articleText) throw new Error("没有可用于生成简介的正文、原简介或原标题");
      const sourceText = articleText;
      item.articleText = articleText;
      item.summarySource = summarySource;
      item.articleTitle = cleanText(articleResponse.title || articleResponse.article?.title || "");
      setItemStage(item, "article", "done");

      if (token !== state.runToken || !state.workOwned) return;
      setItemStage(item, "ai", "working");
      item.status = "rewriting";
      await persistBatch({ item, progressOnly: true });
      const reusedExistingCopy = !item.forceRewrite && item.title && item.summary
        && priorSummarySource === summarySource
        && ["article_body", "original_summary", "original_title"].includes(item.summarySource)
        && item.titleSource === "generated_summary"
        && textLength(item.title) <= state.settings.titleLimit && textLength(item.summary) <= state.settings.summaryLimit;
      const priorQuerySource = cleanText(item.imageQuerySourceTitle || "");
      const aiResponse = reusedExistingCopy ? { result: item } : await sendRuntime("AI_PROCESS_ITEM", {
        item: {
          index: item.index, id: item.id, originalTitle: item.originalTitle,
          originalSummary: item.originalSummary, articleTitle: item.articleTitle,
          articleText: sourceText, sourceText, summarySource,
          sourceUrl: item.sourceUrl, pageLanguage: item.pageLanguage, pageCountry: item.pageCountry,
        },
        titleLimit: Number(state.settings.titleLimit || 12),
        summaryLimit: Number(state.settings.summaryLimit || 50),
      });
      const ai = normalizeAiResult(aiResponse);
      if (ai.rewriteMode === "local") {
        ai.imageQueryEn = item.originalTitle;
      } else if (reusedExistingCopy && (priorQuerySource !== cleanText(item.originalTitle) || !ai.imageQueryEn)) {
        ai.imageQueryEn = await makeManualEnglishQuery(item.originalTitle);
      }
      validateAiResult(ai);
      Object.assign(item, ai);
      item.forceRewrite = false;
      item.imageQueryEn ||= item.originalTitle;
      item.imageQuerySourceTitle = item.originalTitle;
      setItemStage(item, "ai", "done");

      if (token !== state.runToken || !state.workOwned) return;
      setItemStage(item, "image", "working");
      item.status = "searching";
      await persistBatch({ item, progressOnly: true });
      const imageResponse = await sendRuntime("SEARCH_PEXELS_BATCH", {
        query: item.imageQueryEn, imageQueryEn: item.imageQueryEn,
        preferredRatio: state.settings.preferredRatio, orientation: "portrait", candidateLimit: 60,
        bangladeshMode,
      });
      const candidates = (imageResponse.items || []).map(normalizeImage);
      const available = candidates.filter((image) => !imageRestriction(image, item).blocked);
      const usedFallback = !available.length && candidates.some((image) => image.width > 0 && image.height > image.width
        && image.imageUrl && image.safetyStatus !== "rejected");
      if (token !== state.runToken || !state.workOwned) return;
      item.image = selectBestImage({ ...imageResponse, items: available.length ? available : candidates });
      if (usedFallback) {
        const warning = "候选全部重复/占用，已自动选用，请人工确认";
        item.reviewWarning = [item.reviewWarning, warning].filter(Boolean).join("；");
      }
      setItemStage(item, "image", "done");
      item.currentStage = "";
      item.status = !usedFallback && item.image.safetyStatus === "passed" && item.rewriteMode !== "local" ? "completed" : "needs_review";
      if (bangladeshMode) {
        item.status = "needs_review";
        item.reviewWarning = [item.reviewWarning, "孟加拉模式：自动初筛不保证合规，投递前必须人工审核图片与文案"].filter(Boolean).join("；");
      }
      item.error = "";
    } catch (error) {
      setItemStage(item, item.currentStage || "article", "error");
      item.status = "error";
      item.error = error.message || "处理失败";
      item.errorType = error.errorType || error.code || "UNKNOWN_ERROR";
      item.error_type = item.errorType;
      item.aiErrorModel = error.model || "";
      item.model = item.aiErrorModel;
      item.aiAttempts = Number(error.attempts) || item.aiAttempts || 0;
      item.aiDiagnostics = Array.isArray(error.diagnostics) ? error.diagnostics : [];
      item.usedFallbackModel = Boolean(error.usedFallbackModel);
      item.retryStatus = "";
      const fatalAiError = ["AI_NOT_CONFIGURED", "AI_ENDPOINT_INVALID"].includes(error.code)
        || (error.code === "HTTP_ERROR" && [400, 401, 403, 404, 422].includes(Number(error.status)));
      if (fatalAiError) {
        state.pauseRequested = true;
        state.batch.fatalError = item.error;
      }
    }
    if (state.workOwned) await persistBatch();
  }

  async function runBatch() {
    if (state.workOwned || state.scanning) return;
    if (!state.batch || !getBatchItems().length) {
      setPanelStatus(".lsa-batch-status", "请先扫描当前列表", true);
      return;
    }
    try { await acquireWork(); } catch (error) { return setPanelStatus(".lsa-batch-status", error.message, true); }
    try {
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
    const scheduledPages = pagesInBatch().filter((page) => (state.pageFilter === "all" || page.key === state.pageFilter)
      && page.items.some((item) => item.status === "pending"));
    const scheduledItems = new Set(scheduledPages.flatMap((page) => page.items));
    setPanelStatus(".lsa-batch-status", `当前标签页开始处理 ${scheduledItems.size} 条；其他标签页可独立同时运行。`);

    const concurrency = Math.max(1, Math.min(2, Number(state.settings.batchConcurrency) || 2));
    const claimNext = () => {
      if (state.pauseRequested || token !== state.runToken) return null;
      return getBatchItems().find((item) => item.status === "pending" && scheduledItems.has(item)) || null;
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
    } else if (counts.pending) {
      state.batch.status = "paused";
      setPanelStatus(".lsa-batch-status", `本轮 ${scheduledPages.length} 页已处理；另有 ${counts.pending} 条等待下一轮，失败 ${counts.failed} 条。`);
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
    } catch (error) {
      state.batch.status = "paused";
      setPanelStatus(".lsa-batch-status", error.message, true);
    } finally { await releaseWork(); renderBatch(); }
  }

  function pauseBatch() {
    if (state.scanning) { state.pauseRequested = true; return; }
    if (!state.workOwned) return;
    if (!state.batch || state.batch.status !== "running") return;
    state.pauseRequested = true;
    state.batch.status = "pausing";
    persistBatch();
    setPanelStatus(".lsa-batch-status", "正在暂停；不会强行中断当前两条网络请求…");
  }

  async function retryFailed(index = null, errorType = "") {
    if (state.workOwned) return;
    if (!state.batch) return;
    try { await acquireWork(); } catch (error) { return setPanelStatus(".lsa-batch-status", error.message, true); }
    try {
    const targets = index === null
      ? LSAWorkflow.failedItemsByType(getBatchItems(), errorType)
      : getBatchItems().filter((item) => item.index === index);
    if (!targets.length) {
      setPanelStatus(".lsa-batch-status", "没有需要重试的失败项");
      return;
    }
    targets.forEach((item) => {
      item.status = "pending";
      item.error = "";
      item.errorType = "";
      item.error_type = "";
      item.aiErrorModel = "";
      item.model = "";
      item.aiDiagnostics = [];
      item.retryStatus = "";
      resetItemProgress(item);
    });
    state.batch.status = "ready";
    await persistBatch();
    } finally { await releaseWork(); }
    await runBatch();
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

  function occupiedImageOwner(image, targetItem = null) {
    const key = LSAWorkflow.imageKey(image);
    if (!key) return null;
    return getBatchItems().find((item) => item !== targetItem && item.image && LSAWorkflow.imageKey(item.image) === key) || null;
  }

  function imageRestriction(image, targetItem = null) {
    const key = LSAWorkflow.imageKey(image);
    const local = state.imageHistory[key] || {};
    const usageCount = LSAWorkflow.usageEventsInWindow(state.globalUsage[key], state.settings.usageWindowDays).length;
    const globalManual = Boolean(state.globalManual[key]);
    const usageLimited = usageCount >= Number(state.settings.usageThreshold || 3);
    const localStatus = Object.prototype.hasOwnProperty.call(state.imageHistory, key) ? local.status : image.localDownloadStatus;
    const localUsed = ["queued", "completed"].includes(localStatus);
    const owner = occupiedImageOwner(image, targetItem);
    const reasons = [];
    if (globalManual) reasons.push("已在全局手动标记重复");
    if (usageLimited) reasons.push(`近 ${state.settings.usageWindowDays} 天已使用 ${usageCount} 次`);
    else if (usageCount > 0) reasons.push(`近 ${state.settings.usageWindowDays} 天使用 ${usageCount} 次`);
    if (localUsed) reasons.push(localStatus === "queued" ? "当前标签页下载中" : "当前标签页已下载");
    if (owner) reasons.push(`本批次已由第 ${owner.index} 条占用`);
    return { key, globalManual, usageCount, usageLimited, localUsed, owner, blocked: globalManual || usageLimited || localUsed || Boolean(owner), reasons };
  }

  function duplicateInfo(image, targetItem = null) {
    return imageRestriction(image, targetItem).reasons.join("；");
  }

  function duplicateButton(image) {
    const key = LSAWorkflow.imageKey(image);
    const marked = Boolean(state.globalManual[key]);
    const button = create("button", "lsa-secondary-button", marked ? "取消重复标记" : "标记重复");
    button.type = "button";
    button.addEventListener("click", async () => {
      try {
        const response = await sendRuntime("MARK_IMAGE_DUPLICATE", { image, marked: !marked });
        state.imageHistory[response.key] = response.entry;
        if (response.globalEntry) state.globalManual[response.key] = response.globalEntry;
        else delete state.globalManual[response.key];
        renderBatch(); renderManualImages();
      } catch (error) { setPanelStatus(".lsa-image-status", error.message, true); }
    });
    return button;
  }

  function downloadDestination() {
    return { folder: state.settings.imageFolder, batchFolder: currentFolder(), batchLimit: currentBatchLimit() };
  }
  function autoDownloadCandidates() {
    return getBatchItems().filter((item) => item.image?.safetyStatus === "passed");
  }
  async function downloadFinalImage(item, button, force = false, destination = downloadDestination()) {
    if (!item?.image) throw new Error("该条还没有可下载图片");
    if (button) { button.disabled = true; button.textContent = "下载中…"; }
    try {
      const response = await sendRuntime("DOWNLOAD_FINAL_IMAGE", {
        item, record: item, image: item.image, index: item.index,
        ...destination, preferredRatio: state.settings.preferredRatio,
        force,
      });
      if (response.skipped) {
        item.downloadStatus = "duplicate";
        item.downloadError = `已跳过重复：${response.reason}${response.path ? `（${response.path}）` : ""}`;
        if (button) {
          const retry = create("button", "lsa-secondary-button", "仍然下载这张图");
          retry.type = "button";
          retry.addEventListener("click", () => { retry.remove(); downloadFinalImage(item, button, true, destination).catch(() => {}); });
          button.after(retry);
        }
        return response;
      }
      item.downloadStatus = "completed";
      item.downloadFileName = response.fileName || response.filename || "";
      item.downloadPath = response.path || item.downloadFileName;
      item.downloadGroupFolder = response.groupFolder || "";
      item.downloadError = "";
      if (!state.workOwned && state.batch?.status !== "running" && state.batch?.items?.includes(item)) await persistBatch();
      return response;
    } catch (error) {
      item.downloadStatus = "error";
      item.downloadError = error.message;
      if (!state.workOwned && !["running", "pausing"].includes(state.batch?.status) && state.batch?.items?.includes(item)) await persistBatch();
      throw error;
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = item.downloadStatus === "completed" ? "重新下载" : "下载成品图";
      }
    }
  }

  async function downloadAllImages() {
    if (state.downloadBusy) return;
    const destination = downloadDestination();
    const candidates = autoDownloadCandidates();
    if (!candidates.length) {
      const selected = getBatchItems().filter((item) => item.image).length;
      const review = getBatchItems().filter((item) => item.image?.safetyStatus === "review").length;
      return setPanelStatus(".lsa-batch-status", `当前没有自动通过的图片；已选图 ${selected} 张，其中需人工复核 ${review} 张。`, true);
    }
    const button = q(".lsa-download-all");
    state.downloadBusy = true;
    state.downloadProgress = { finished: 0, total: candidates.length };
    if (button) { button.disabled = true; button.textContent = `下载中 0/${candidates.length}`; }
    let cursor = 0;
    let failed = 0;
    let skipped = 0;
    const errors = [];
    setPanelStatus(".lsa-batch-status", `正在下载 ${candidates.length} 张成品图；每累计 ${destination.batchLimit} 张自动新建一个分组目录…`);
    const worker = async () => {
      while (cursor < candidates.length) {
        const item = candidates[cursor++];
        try {
          const result = await downloadFinalImage(item, null, false, destination);
          if (result.skipped) skipped += 1;
        } catch (error) {
          failed += 1;
          errors.push(`${String(item.index).padStart(2, "0")}：${error.message}`);
        } finally {
          state.downloadProgress.finished += 1;
          const liveButton = q(".lsa-download-all");
          if (liveButton) liveButton.textContent = `下载中 ${state.downloadProgress.finished}/${state.downloadProgress.total}`;
          setPanelStatus(".lsa-batch-status", `正在下载：${state.downloadProgress.finished}/${state.downloadProgress.total}；成功 ${state.downloadProgress.finished - failed - skipped}，跳过 ${skipped}，失败 ${failed}`,
            Boolean(failed));
        }
      }
    };
    const workerCount = Math.min(4, candidates.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    state.downloadBusy = false;
    state.downloadProgress = null;
    renderBatch();
    if (currentFolder() === destination.batchFolder) setPanelStatus(".lsa-batch-status", `下载结束：${candidates.length - failed - skipped} 张加入下载，跳过重复 ${skipped} 张，失败 ${failed} 张；每 ${destination.batchLimit} 张分组。${errors[0] ? ` 首个错误：${errors[0]}` : ""}`, Boolean(failed));
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

  function renderItemRuntimeState(item) {
    if (!state.root || !item) return;
    renderTotalProgress();
    const counts = batchCounts();
    const summary = q(".lsa-batch-summary");
    if (summary && state.batch) summary.textContent = LSAAssistantEngine.batchSummary(state.batch, counts);
    const key = LSAWorkflow.recordKey(item);
    const nextProgress = createItemProgress(item);
    LSAAssistantUi.patchBatchCard({
      root: state.root,
      itemKey: key,
      status: item.status,
      statusLabel: STATUS_LABELS[item.status] || item.status || "待处理",
      progressNode: nextProgress,
      retryStatus: item.retryStatus,
      createRetryNode: (text) => create("p", "lsa-item-retry-status", text),
    });
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
    const items = getBatchItems().filter((item) => state.pageFilter === "all" || (item.pageKey || "legacy") === state.pageFilter);
    if (!items.length) {
      wrap.append(create("div", "lsa-empty-result", `点击“读取当前页”，最多读取 ${LSAWorkflow.batchSize(state.settings.batchLimit)} 条；每个标签页拥有独立批次`));
      return;
    }
    const visibleItems = state.pageFilter === "all" ? items.slice(0, 60) : items;
    if (visibleItems.length < items.length) wrap.append(create("p", "lsa-section-hint", "当前展示前 60 条；请用页面筛选查看其余页面，总进度包含所有记录。"));
    for (const item of visibleItems) {
      const card = create("article", `lsa-batch-card is-${item.status || "pending"}`);
      card.dataset.itemKey = LSAWorkflow.recordKey(item);
      const header = create("div", "lsa-batch-card-header");
      header.append(create("span", "lsa-item-number", String(item.index).padStart(2, "0")));
      const title = create("strong", "lsa-original-title", item.originalTitle || "（未读取到原标题）");
      title.title = item.originalTitle || "";
      if (isBangladeshModeActive()) header.append(create("span", "lsa-bangladesh-card-badge", "孟加拉"));
      header.append(title, create("span", "lsa-item-status", STATUS_LABELS[item.status] || item.status || "待处理"));
      card.append(header, createItemProgress(item));
      if (isBangladeshModeActive()) card.append(create("p", "lsa-bangladesh-card-warning", "⚠ 孟加拉模式：本条图片与文案必须人工审核"));
      if (item.retryStatus) card.append(create("p", "lsa-item-retry-status", item.retryStatus));
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
        card.append(create("p", "lsa-item-download", `已下载：${item.downloadPath || item.downloadFileName || "浏览器下载目录"}`));
      } else if (item.downloadError) {
        card.append(create("p", "lsa-item-error", `下载失败：${item.downloadError}`));
      }
      const actions = create("div", "lsa-item-actions");
      if (item.title && item.summary && !state.workOwned && !["running", "pausing"].includes(state.batch?.status)) {
        const rewrite = create("button", "lsa-secondary-button", "按新设置重写");
        rewrite.type = "button";
        rewrite.addEventListener("click", async () => {
          item.forceRewrite = true;
          await retryFailed(item.index);
        });
        actions.append(rewrite);
      }
      if (item.imageQueryEn || item.originalTitle) {
        const search = create("button", "lsa-secondary-button", "换图 / 翻页");
        search.type = "button";
        search.disabled = state.imageBusy;
        search.addEventListener("click", () => {
          state.imageTargetIndex = item.index;
          state.originalForSearch = {
            title: item.originalTitle,
            summary: item.originalSummary,
            articleText: item.articleText || "",
            sourceUrl: item.sourceUrl || "",
          };
          q(".lsa-stock-query").value = item.originalTitle;
          switchTab("images");
          searchManualImages(1);
        });
        actions.append(search);
      }
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
        actions.append(duplicateButton(item.image));
        if (duplicateInfo(item.image, item)) card.append(create("p", "lsa-item-error", duplicateInfo(item.image, item)));
      }
      if (item.editUrl) {
        const edit = create("a", "lsa-link-button", "打开编辑页");
        edit.href = LSAWorkflow.editUrl(item.editUrl, item.id);
        actions.append(edit);
      }
      if (actions.childNodes.length) card.append(actions);
      wrap.append(card);
    }
  }

  function renderBatch() {
    if (!state.root) return;
    renderBangladeshMode();
    const folder = q(".lsa-current-folder");
    if (folder) folder.textContent = state.batch ? currentFolder() : "尚未选择文件夹；读取或导入后建立";
    for (const key of ["language", "country"]) {
      const input = q(`[data-meta="${key}"]`);
      if (input && input !== document.activeElement) input.value = state.batch?.metadata?.[key] || "";
      if (input) input.disabled = !state.batch || state.workOwned;
    }
    const size = q('[data-setting="batchLimit"]');
    if (size) { size.value = currentBatchLimit(); size.disabled = state.workOwned; }
    const counts = batchCounts();
    const summary = q(".lsa-batch-summary");
    if (summary) {
      summary.textContent = state.batch
        ? `${state.batch.batchId} · 共 ${counts.total} · 完成 ${counts.done} · 需复核 ${counts.review} · 失败 ${counts.failed} · 待处理 ${counts.pending + counts.working}`
        : "尚未建立批次";
    }
    renderTotalProgress();
    renderPages();
    const start = q(".lsa-start-batch");
    const pause = q(".lsa-pause-batch");
    const retry = q(".lsa-retry-failed");
    const retryType = q(".lsa-retry-type");
    if (start) {
      start.disabled = state.scanning || !counts.total || state.batch?.status === "running" || state.batch?.status === "pausing"
        || (!counts.pending && !counts.working);
      start.textContent = state.batch?.status === "paused" ? "继续处理" : "开始处理";
    }
    if (pause) pause.disabled = !state.scanning && (!state.workOwned || state.batch?.status !== "running");
    if (retry) retry.disabled = !counts.failed || state.batch?.status === "running";
    if (retryType) {
      const selected = retryType.value;
      const failureCounts = LSAWorkflow.failureTypeCounts(getBatchItems());
      retryType.replaceChildren(new Option(`全部失败（${counts.failed}）`, ""),
        ...Object.entries(failureCounts).sort().map(([type, count]) => new Option(`${type}（${count}）`, type)));
      retryType.value = Object.prototype.hasOwnProperty.call(failureCounts, selected) ? selected : "";
      retryType.disabled = !counts.failed || state.batch?.status === "running";
    }
    const save = q(".lsa-save-batch-json");
    const downloadAll = q(".lsa-download-all");
    if (save) save.disabled = !counts.total;
    if (downloadAll) {
      const candidates = autoDownloadCandidates();
      downloadAll.disabled = state.downloadBusy || !counts.total;
      downloadAll.textContent = state.downloadBusy && state.downloadProgress
        ? `下载中 ${state.downloadProgress.finished}/${state.downloadProgress.total}`
        : `下载自动通过图${candidates.length ? `（${candidates.length}）` : ""}`;
      downloadAll.title = candidates.length ? `下载 ${candidates.length} 张图片；最多 4 张同时处理` : "当前没有自动通过图片；点击可查看原因";
    }
    const scan = q(".lsa-scan-batch");
    if (scan) scan.disabled = state.workOwned || ["running", "pausing"].includes(state.batch?.status);
    renderBatchItems();
    renderEditRecordSelector();
  }

  function renderPages() {
    const wrap = q(".lsa-page-results");
    const filter = q(".lsa-page-filter");
    const pages = pagesInBatch();
    if (filter) {
      filter.parentElement.hidden = pages.length <= 1;
      filter.replaceChildren(create("option", "", "全部页面")); filter.firstChild.value = "all";
      pages.forEach((page) => { const option = create("option", "", page.label); option.value = page.key; filter.append(option); });
      filter.value = state.pageFilter;
    }
    if (!wrap) return;
    wrap.replaceChildren();
    for (const page of pages) {
      const done = page.items.filter((item) => ["completed", "needs_review"].includes(item.status)).length;
      const failed = page.items.filter((item) => item.status === "error").length;
      const row = create("div", "lsa-page-result");
      row.append(create("span", "", `${page.label} · 完成 ${done}/${page.items.length}${failed ? ` · 失败 ${failed}` : ""}`));
      const progress = create("progress", ""); progress.max = page.items.length; progress.value = done;
      row.append(progress);
      const exportButton = create("button", "lsa-text-action", "导出本页 JSON");
      exportButton.type = "button"; exportButton.disabled = done !== page.items.length;
      exportButton.addEventListener("click", () => exportResults(page.key).catch((error) => setPanelStatus(".lsa-transfer-status", error.message, true)));
      row.append(exportButton); wrap.append(row);
    }
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
    const label = q(".lsa-record-fold-label");
    if (label) label.textContent = items.length ? `批次记录（${items.length} 条）` : "批次记录（暂无）";
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
    const target = LSAWorkflow.editUrl(item.editUrl, item.id);
    if (!target) return setPanelStatus(".lsa-edit-status", "编辑页地址无效", true);
    if (target === location.href) {
      setPanelStatus(".lsa-edit-status", `已选择第 ${item.index} 条，当前已在对应编辑页。`);
      return;
    }
    setPanelStatus(".lsa-edit-status", `正在跳转到第 ${item.index} 条编辑页…`);
    location.assign(target);
  }

  function titleTranslationKey(item) {
    return `${String(item?.id || item?.index || "unknown")}::${cleanText(item?.originalTitle || "")}`;
  }

  async function createOfflineTitleTranslator(sourceLanguage) {
    const options = { sourceLanguage, targetLanguage: "zh" };
    if (globalThis.Translator?.availability && globalThis.Translator?.create) {
      const availability = await globalThis.Translator.availability(options);
      if (["unavailable", "no"].includes(String(availability))) throw new Error(`不支持 ${sourceLanguage} → zh`);
      return globalThis.Translator.create(options);
    }
    if (globalThis.translation?.canTranslate && globalThis.translation?.createTranslator) {
      const availability = await globalThis.translation.canTranslate(options);
      if (["unavailable", "no"].includes(String(availability))) throw new Error(`不支持 ${sourceLanguage} → zh`);
      return globalThis.translation.createTranslator(options);
    }
    throw new Error("当前 Chrome 未提供 Translator API");
  }

  async function requestOfflineTitleTranslation(item) {
    if (!item || item.titleZh || !recordMatchesRoute(item)) return;
    const key = titleTranslationKey(item);
    if (state.titleTranslationInFlight.has(key) || state.titleTranslationStatus.has(key)) return;
    state.titleTranslationInFlight.add(key);
    state.titleTranslationStatus.set(key, "正在尝试 Chrome 离线翻译…");
    renderSelectedRecord();
    try {
      const detected = await sendRuntime("DETECT_SOURCE_LANGUAGE", {
        text: item.originalTitle,
        hint: item.language || item.pageLanguage || "",
      });
      const sourceLanguage = cleanText(detected.code || "").toLowerCase();
      if (!sourceLanguage) throw new Error("无法确定原标题语言");
      let titleZh;
      if (sourceLanguage === "zh") titleZh = item.originalTitle;
      else {
        const translator = await createOfflineTitleTranslator(sourceLanguage);
        try { titleZh = cleanText(await translator.translate(item.originalTitle)); }
        finally { translator.destroy?.(); }
      }
      if (!titleZh) throw new Error("返回内容为空");
      item.titleZh = titleZh;
      state.titleTranslationStatus.set(key, "Chrome 离线翻译已完成");
      await persistBatch();
    } catch (error) {
      state.titleTranslationStatus.set(key, `离线翻译不可用：${cleanText(error.message || "当前语言不受支持")}`);
      renderSelectedRecord();
    } finally {
      state.titleTranslationInFlight.delete(key);
    }
  }

  async function refreshAiTranslationStatus() {
    try {
      const result = await sendRuntime("GET_AI_TRANSLATION_STATUS");
      state.aiTranslation = { loaded: true, configured: Boolean(result.configured), reason: result.reason || "" };
    } catch (error) {
      state.aiTranslation = { loaded: true, configured: false, reason: error.message };
    }
    renderSelectedRecord();
  }

  async function translateSelectedTitleWithAi() {
    const item = selectedRecord();
    if (!item || !recordMatchesRoute(item)) return setPanelStatus(".lsa-edit-status", "请先打开该记录对应的编辑页", true);
    if (!state.aiTranslation.configured) return setPanelStatus(".lsa-edit-status", state.aiTranslation.reason || "主 AI 未配置", true);
    const key = titleTranslationKey(item);
    state.titleTranslationStatus.set(key, "正在请求主 AI 翻译标题…");
    renderSelectedRecord();
    try {
      const response = await sendRuntime("TRANSLATE_TEXT", { text: item.originalTitle });
      const titleZh = cleanText(response.titleZh || response.translation || "");
      if (!titleZh) throw new Error("AI 没有返回中文标题");
      item.titleZh = titleZh;
      state.titleTranslationStatus.set(key, `AI 翻译已更新${response.model ? ` · ${response.model}` : ""}`);
      await persistBatch();
      setPanelStatus(".lsa-edit-status", "标题中文对照已更新；它只用于查看，不会写入后台或参与搜图。");
    } catch (error) {
      state.titleTranslationStatus.set(key, `AI 翻译失败：${error.message}`);
      renderSelectedRecord();
      setPanelStatus(".lsa-edit-status", error.message, true);
    }
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
    const originalHeading = create("h3", "lsa-record-original", `${String(item.index).padStart(2, "0")} · ${item.originalTitle}`);
    if (isBangladeshModeActive()) originalHeading.append(create("span", "lsa-bangladesh-card-badge", "孟加拉"));
    wrap.append(originalHeading);
    if (isBangladeshModeActive()) wrap.append(create("p", "lsa-bangladesh-card-warning", "⚠ 孟加拉模式：填入前必须人工审核图片与文案"));
    const translationKey = titleTranslationKey(item);
    if (item.titleZh) wrap.append(create("p", "lsa-title-zh", `中文：${item.titleZh}`));
    const translationStatus = state.titleTranslationStatus.get(translationKey);
    if (!item.titleZh || translationStatus) {
      wrap.append(create("small", `lsa-translation-status${translationStatus?.startsWith("离线翻译不可用") || translationStatus?.startsWith("AI 翻译失败") ? " is-warning" : ""}`,
        translationStatus || "正在准备离线翻译…"));
    }
    const translationActions = create("div", "lsa-translation-actions");
    const translateButton = create("button", "lsa-secondary-button lsa-ai-translate-title", "AI 翻译标题");
    translateButton.type = "button";
    translateButton.disabled = !recordMatchesRoute(item) || !state.aiTranslation.configured;
    translateButton.title = translateButton.disabled ? (state.aiTranslation.reason || "正在检查主 AI 配置") : "主动调用已配置的主 AI，仅翻译原标题";
    translateButton.addEventListener("click", translateSelectedTitleWithAi);
    translationActions.append(translateButton);
    if (!state.aiTranslation.configured) translationActions.append(create("small", "lsa-ai-translation-note", state.aiTranslation.reason || "正在检查主 AI 配置…"));
    wrap.append(translationActions);
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
    if (button) button.disabled = !item.title || !item.summary;
    if (recordMatchesRoute(item) && !item.titleZh) Promise.resolve().then(() => requestOfflineTitleTranslation(item));
  }

  async function applySelectedRecord() {
    const item = selectedRecord();
    if (!item) return setPanelStatus(".lsa-edit-status", "请先选择批次记录", true);
    if (!item.title || !item.summary) {
      return setPanelStatus(".lsa-edit-status", "该记录的标题或简介尚未准备好", true);
    }
    const button = q(".lsa-apply-record");
    if (button) button.disabled = true;
    setPanelStatus(".lsa-edit-status", "正在填写标题和简介…");
    try {
      const result = await pageTool("APPLY_BATCH_RECORD", item);
      if (!result?.ok) throw new Error(result?.message || "页面标题或简介写入失败");
      const details = [result.title?.message, result.summary?.message]
        .filter(Boolean).join("；");
      setPanelStatus(".lsa-edit-status",
        `${result.message || "标题和简介已写入后台"}${details ? `：${details}` : ""}。图片请手动上传，核对后再点击后台保存。`);
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
      title.textContent = `标题 ${textLength(draft.title)} / ${state.settings.titleLimit} 词`;
      title.classList.toggle("is-over", textLength(draft.title) > state.settings.titleLimit);
    }
    if (summary) {
      summary.textContent = `简介 ${textLength(draft.summary)} / ${state.settings.summaryLimit} 词`;
      summary.classList.toggle("is-over", textLength(draft.summary) > state.settings.summaryLimit);
    }
  }

  async function readPage() {
    try {
      const context = await pageTool("GET_PAGE_CONTEXT");
      if (state.route.kind === "edit" && !context.boundTitle) return false;
      state.pageContext = context || {};
      const matched = getBatchItems().find(recordMatchesRoute);
      const title = cleanText(matched?.originalTitle || context.originalTitle || context.boundTitle || context.heading || context.title || context.selectedText || "");
      const summary = cleanText(matched?.originalSummary || context.boundSummary || context.description || "");
      state.originalForSearch = {
        title,
        summary,
        articleText: cleanText(matched?.articleText || ""),
        sourceUrl: matched?.sourceUrl || "",
      };
      const original = q(".lsa-original-copy");
      const draft = q(".lsa-draft-copy");
      if (original) original.value = formatOriginal(title, summary);
      if (draft && !draft.value) draft.value = `${matched?.title || title}\n${matched?.summary || summary}`.trim();
      const queryInput = q(".lsa-stock-query");
      if (queryInput && !queryInput.value) queryInput.value = title;
      updateManualCounts();
      setPanelStatus(".lsa-manual-status", "已读取当前页面；手动填写不会点击后台保存。");
      return true;
    } catch (error) {
      setPanelStatus(".lsa-manual-status", `读取失败：${error.message}`, true);
    }
  }

  async function autoReadAndSearch() {
    const revision = ++state.autoReadRevision;
    const root = state.root;
    for (let attempt = 0; attempt < 24; attempt += 1) {
      if (state.root !== root || revision !== state.autoReadRevision) return;
      const context = await pageTool("GET_PAGE_CONTEXT");
      if (context.boundTitle) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        if (state.root !== root || revision !== state.autoReadRevision) return;
        await readPage();
        if (state.settings.autoSearch !== false) await searchManualImages(1);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    setPanelStatus(".lsa-manual-status", "页面字段尚未加载，完成加载后可点击读取页面", true);
  }

  async function rewriteManual() {
    const source = parseOriginal(q(".lsa-original-copy")?.value || "");
    const matched = getBatchItems().find(recordMatchesRoute);
    const root = state.root;
    const button = q(".lsa-rewrite-manual");
    if (button) button.disabled = true;
    try {
      let articleText = cleanText(matched?.articleText || state.originalForSearch?.articleText || "");
      const sourceUrl = matched?.sourceUrl || state.originalForSearch?.sourceUrl || "";
      if (!articleText && sourceUrl) {
        setPanelStatus(".lsa-manual-status", "正在读取文章正文…");
        const articleResponse = await sendRuntime("FETCH_ARTICLE", { url: sourceUrl, sourceUrl });
        articleText = articleTextFromResponse(articleResponse);
        if (matched && articleText) {
          matched.articleText = articleText;
          ensureItemStages(matched);
          matched.stages.article = "done";
          await persistBatch({ item: matched, progressOnly: true });
        }
      }
      const summarySource = articleText ? "article_body" : source.summary ? "original_summary" : "original_title";
      const sourceText = articleText || source.summary || source.title;
      if (!sourceText) throw new Error("没有可用于生成简介的正文、原简介或原标题");
      const sourceLabel = summarySource === "article_body" ? "正文" : summarySource === "original_summary" ? "原简介兜底" : "原标题兜底";
      setPanelStatus(".lsa-manual-status", state.settings.rewriteMode === "local" ? `正在根据${sourceLabel}生成本地候选…` : `正在根据${sourceLabel}生成简介与标题…`);
      const response = await sendRuntime("AI_PROCESS_ITEM", { item: {
        originalTitle: source.title,
        originalSummary: source.summary,
        articleText: sourceText,
        sourceText,
        summarySource,
        sourceUrl,
        pageLanguage: matched?.pageLanguage,
        pageCountry: matched?.pageCountry,
      } });
      if (state.root !== root) return;
      const result = normalizeAiResult(response);
      validateAiResult(result);
      q(".lsa-draft-copy").value = `${result.title}\n${result.summary}`;
      updateManualCounts();
      setPanelStatus(".lsa-manual-status", result.reviewWarning || "改写完成，请核对后填写");
    } catch (error) { if (state.root === root) setPanelStatus(".lsa-manual-status", error.message, true); }
    finally { if (button) button.disabled = false; }
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
    if (state.settings.rewriteMode === "local") return source;
    {
      const response = await sendRuntime("GENERATE_IMAGE_QUERY", { title: source, bangladeshMode: isBangladeshModeActive() });
      const value = cleanText(response.imageQueryEn || response.query || response.result?.imageQueryEn || "");
      if (value) return value;
    }
    throw new Error("AI 未配置或未返回英文关键词；也可直接输入英文关键词搜索");
  }

  function manualSearchOriginalTitle() {
    const matched = getBatchItems().find((item) => item.index === state.imageTargetIndex)
      || getBatchItems().find(recordMatchesRoute);
    return cleanText(matched?.originalTitle || state.originalForSearch?.title || "");
  }

  async function searchManualImages(page = 1) {
    if (state.imageBusy) return;
    page = LSAWorkflow.number(page, 1, 1000, 1);
    const input = q(".lsa-stock-query");
    const originalTitle = manualSearchOriginalTitle();
    const typedValue = cleanText(input?.value || "");
    const usesOriginalTitle = page > 1 ? null : !typedValue || typedValue === originalTitle;
    let value = page > 1 ? state.imageQuery : typedValue;
    if (page > 1 && !value) return setPanelStatus(".lsa-image-status", "当前没有可翻页的搜索结果，请先搜索", true);
    if (page === 1 && usesOriginalTitle && !originalTitle) {
      return setPanelStatus(".lsa-image-status", "没有读取到原标题，无法搜索图片", true);
    }
    if (page === 1 && !usesOriginalTitle && /[^\x00-\x7f]/.test(typedValue)) {
      return setPanelStatus(".lsa-image-status", "请输入英文，或清空恢复按原标题搜索", true);
    }
    const button = q(".lsa-search-images");
    state.imageBusy = true;
    const revision = ++state.searchRevision;
    if (button) button.disabled = true;
    setPanelStatus(".lsa-image-status", page > 1
      ? `正在沿用当前英文关键词加载第 ${page} 页…`
      : usesOriginalTitle ? "正在根据原标题生成英文关键词并搜索竖屏图片…" : "正在按输入的英文关键词搜索竖屏图片…");
    try {
      if (page === 1 && usesOriginalTitle) value = await makeManualEnglishQuery(originalTitle);
      if (revision !== state.searchRevision) return;
      const response = await sendRuntime("SEARCH_PEXELS_BATCH", {
        query: value, imageQueryEn: value, preferredRatio: state.settings.preferredRatio, orientation: "portrait",
        page, source: page > 1 ? state.imageProvider : "", bangladeshMode: isBangladeshModeActive(),
      });
      if (revision !== state.searchRevision) return;
      state.imageQuery = value;
      state.imageProvider = response.source;
      state.imagePage = page;
      state.imageHasNext = Boolean(response.hasNext);
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
        ? `第 ${page} 页 · ${state.manualResults.length} 张竖图 · ${sources || "Pexels/Pixabay"} · 搜索词：${value}${state.settings.rewriteMode === "local" ? " · 本地模式不调用 AI" : ""}`
        : "本页没有通过竖图规则的结果，可继续翻页或更换关键词。", !state.manualResults.length);
    } catch (error) {
      if (revision !== state.searchRevision) return;
      state.manualResults = [];
      renderManualImages();
      setPanelStatus(".lsa-image-status", error.message, true);
    } finally {
      if (revision === state.searchRevision) { state.imageBusy = false; renderImagePager(); if (button) button.disabled = false; }
    }
  }

  function renderImagePager() {
    const previous = q(".lsa-images-prev"), next = q(".lsa-images-next"), label = q(".lsa-images-page");
    if (previous) previous.disabled = state.imageBusy || state.imagePage <= 1;
    if (next) next.disabled = state.imageBusy || !state.imageHasNext;
    if (label) label.textContent = `第 ${state.imagePage} 页`;
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
      if (isBangladeshModeActive()) card.append(create("p", "lsa-bangladesh-card-warning", "⚠ 孟加拉模式：自动初筛不保证合规，必须看图复核"));
      const preview = create("img", "lsa-stock-image");
      preview.src = image.previewUrl || image.imageUrl;
      preview.alt = image.source || "竖屏素材";
      preview.loading = "lazy";
      preview.referrerPolicy = "no-referrer";
      const copy = create("div", "lsa-stock-copy");
      if (isBangladeshModeActive()) copy.append(create("span", "lsa-bangladesh-card-badge", "孟加拉模式"));
      copy.append(create("p", "lsa-stock-title", `${image.source || "素材"} · ${image.creator || "作者信息见来源页"}`));
      copy.append(create("p", image.safetyStatus === "passed" ? "lsa-stock-meta" : "lsa-stock-meta is-warning", imageMeta(image)));
      const target = getBatchItems().find((item) => item.index === state.imageTargetIndex) || selectedRecord();
      if (duplicateInfo(image, target)) copy.append(create("p", "lsa-item-error", duplicateInfo(image, target)));
      const download = create("button", "lsa-image-action", "下载此图");
      download.type = "button";
      download.addEventListener("click", async () => {
        const original = parseOriginal(q(".lsa-original-copy")?.value || "");
        const synthetic = {
          index: index + 1, originalTitle: original.title, title: original.title || "锁屏配图",
          summary: original.summary || "", image,
        };
        try {
          const result = await downloadFinalImage(synthetic, download);
          setPanelStatus(".lsa-image-status", result.skipped ? `跳过重复：${result.reason}` : `图片已加入下载：${result.path}`);
        } catch (error) {
          setPanelStatus(".lsa-image-status", error.message, true);
        }
      });
      copy.append(download);
      copy.append(duplicateButton(image));
      if (target) {
        const choose = create("button", "lsa-secondary-button", `选为第 ${target.index} 条配图`);
        choose.type = "button";
        choose.disabled = state.workOwned || ["running", "pausing"].includes(state.batch?.status);
        choose.addEventListener("click", async () => {
          try {
            const occupied = occupiedImageOwner(image, target);
            if (occupied && !window.confirm(`这张图已由本批次第 ${occupied.index} 条占用。仍要重复选用吗？`)) {
              return setPanelStatus(".lsa-image-status", `未替换：请改选未被第 ${occupied.index} 条占用的图片`, true);
            }
            await acquireWork();
            target.image = image;
            const liveInput = cleanText(q(".lsa-stock-query")?.value || "");
            const targetOriginal = cleanText(target.originalTitle || state.originalForSearch?.title || "");
            if (!liveInput || liveInput === targetOriginal) {
              target.imageQueryEn = state.imageQuery;
              target.imageQuerySourceTitle = target.originalTitle;
            }
            target.downloadStatus = ""; target.downloadError = "";
            target.stages.image = "done";
            if (occupied) target.reviewWarning = [target.reviewWarning, `与第 ${occupied.index} 条使用同一图片，请人工确认`].filter(Boolean).join("；");
            target.status = target.title && target.summary ? (!occupied && image.safetyStatus === "passed" && target.rewriteMode !== "local" && !isBangladeshModeActive() ? "completed" : "needs_review") : "pending";
            if (isBangladeshModeActive()) target.reviewWarning = [target.reviewWarning, "孟加拉模式：投递前必须人工审核图片与文案"].filter(Boolean).join("；");
            await persistBatch();
            setPanelStatus(".lsa-image-status", `已替换第 ${target.index} 条配图`);
          } catch (error) { setPanelStatus(".lsa-image-status", error.message, true); }
          finally { if (state.workOwned) await releaseWork(); }
        });
        copy.append(choose);
      }
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
    const failureCounts = LSAWorkflow.failureTypeCounts(getBatchItems());
    if (Object.keys(failureCounts).length) {
      lines.push(`错误分类：${Object.entries(failureCounts).map(([type, count]) => `${type} ${count}`).join("；")}`);
    }
    getBatchItems().filter((item) => item.error).slice(0, 30).forEach((item) => {
      lines.push(`${String(item.index).padStart(2, "0")} [${item.errorType || "UNKNOWN_ERROR"}] model=${item.aiErrorModel || item.aiModel || "未记录"} attempts=${item.aiAttempts || 0}${item.usedFallbackModel ? " fallback=是" : ""}`);
      lines.push(item.error);
      for (const diagnostic of (Array.isArray(item.aiDiagnostics) ? item.aiDiagnostics : []).slice(0, 8)) {
        lines.push(`  attempt=${diagnostic.attempt || 0} status=${diagnostic.httpStatus || 0} type=${diagnostic.contentType || "无"} elapsed=${diagnostic.elapsedMs || 0}ms kind=${diagnostic.responseKind || "无"}`);
        if (diagnostic.rawBody) lines.push(`  raw=${String(diagnostic.rawBody).slice(0, 3000)}`);
      }
    });
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
    const quickSettings = `
      <details class="lsa-quick-settings lsa-section-card lsa-fold-card">
        <summary>当前标签页设置 · 词数 / 模式 / 思考强度</summary>
        <div class="lsa-fold-content">
          <div class="lsa-quick-grid">
            <label>标题词数上限<input data-setting="titleLimit" type="number" min="1" max="100"></label>
            <label>简介词数上限<input data-setting="summaryLimit" type="number" min="1" max="500"></label>
            <label>改写方式<select data-setting="rewriteMode"><option value="ai">AI 改写</option><option value="local">本地候选</option></select></label>
            <label>思考强度<select data-setting="thinkingLevel"><option value="off">关闭</option><option value="low">低</option><option value="medium">中等</option><option value="high">高</option><option value="max">最高</option><option value="provider">提供商默认</option></select></label>
          </div><p class="lsa-status-text lsa-quick-status">只修改当前标签页。空格和标点不计词数，连字符词与缩写计 1 词。底部“设置”管理通用默认值与 API。</p>
        </div>
      </details>`;
    const transferPanel = `
      <details class="lsa-section-card lsa-transfer lsa-fold-card">
        <summary class="lsa-folder-summary"><span>当前文件夹</span><small class="lsa-current-folder">尚未选择文件夹</small></summary>
        <div class="lsa-fold-content">
          <div class="lsa-quick-grid">
            <label>语言<input data-meta="language" placeholder="例如：俄语"></label>
            <label>国家<input data-meta="country" placeholder="例如：白俄罗斯"></label>
            <label>每批读取 / 图片分组<select data-setting="batchLimit"><option value="30">30 条 / 组</option><option value="40">40 条 / 组</option></select></label>
            <button class="lsa-secondary-button lsa-save-meta" type="button">保存语言国家</button>
          </div>
          <div class="lsa-button-row"><button class="lsa-secondary-button lsa-import-json" type="button">导入结果 JSON</button><button class="lsa-secondary-button lsa-export-completed" type="button">导出已完成页面</button><button class="lsa-text-action lsa-new-batch" type="button">导出并新建批次</button></div>
          <input class="lsa-import-file" type="file" accept=".json,application/json" hidden>
          <details class="lsa-restore"><summary>切换文件夹 / 恢复旧版批次</summary><button class="lsa-text-action lsa-list-saved" type="button">刷新文件夹列表</button><select class="lsa-saved-batches" aria-label="选择要恢复的批次"></select><button class="lsa-secondary-button lsa-restore-saved" type="button">打开选中文件夹</button></details>
          <p class="lsa-status-text lsa-transfer-status">只显示当前文件夹。导入或读取不同页面时先归档旧批次，不再追加；未知语言国家请手动补全。</p>
        </div>
      </details>`;
    root.innerHTML = `
      <header class="lsa-assistant-header">
        <div class="lsa-assistant-logo">锁</div>
        <div class="lsa-assistant-name"><strong>锁屏编辑助手</strong><small>${isList ? "列表批处理" : "编辑页"}</small></div>
        <div class="lsa-window-actions"><button class="lsa-window-button lsa-minimize" type="button" title="最小化">—</button><button class="lsa-window-button lsa-close" type="button" title="关闭">×</button></div>
      </header>
      <nav class="lsa-assistant-nav" data-tabs="${isList ? "2" : "3"}">
        ${isList ? '<button class="lsa-tab-button is-active" data-tab="batch" type="button">批处理</button>' : '<button class="lsa-tab-button is-active" data-tab="record" type="button">批次填入</button><button class="lsa-tab-button" data-tab="manual" type="button">手动填写</button>'}
        <button class="lsa-tab-button" data-tab="images" type="button">单条配图</button>
      </nav>
      <div class="lsa-assistant-body">
        <div class="lsa-bangladesh-warning" hidden>⚠ 孟加拉模式：宗教与内容禁忌风险高，所有条目投递前必须逐条人工审核图片与文案；自动初筛不保证合规。</div>
        <div class="lsa-bangladesh-mode-bar">
          <div><strong>孟加拉模式 <span class="lsa-bangladesh-badge">条件未匹配</span></strong><small class="lsa-bangladesh-mode-hint">仅当语言为孟加拉语且国家为孟加拉时可开启。</small></div>
          <label class="lsa-switch"><input class="lsa-bangladesh-toggle" type="checkbox"><span>开启</span></label>
        </div>
        ${isList ? `
        <section class="lsa-tab-panel" data-panel="batch">
          <div class="lsa-section-card">
            <div class="lsa-section-row"><h2 class="lsa-section-title">当前标签页独立处理</h2><button class="lsa-text-action lsa-scan-batch" type="button">读取当前页</button></div>
            <p class="lsa-section-hint">在多个浏览器标签页分别点击读取、开始处理，即可多线并行。每个标签页的记录、进度、暂停、导入与改写设置独立。</p>
            <div class="lsa-total-progress" aria-label="批次总进度">
              <div class="lsa-total-progress-head"><span>总进度</span><strong class="lsa-total-progress-value">0%</strong></div>
              <div class="lsa-progress-track lsa-total-progress-track"><span class="lsa-progress-fill lsa-total-progress-fill"></span></div>
              <p class="lsa-total-progress-detail">扫描列表后显示总进度</p>
              <div class="lsa-stage-progress-list"></div>
            </div>
            <p class="lsa-batch-summary">尚未建立批次</p>
            <div class="lsa-page-results"></div>
            <label class="lsa-field-label">显示页面<select class="lsa-page-filter"><option value="all">全部页面</option></select></label>
            <div class="lsa-button-row"><button class="lsa-primary-button lsa-start-batch" type="button" disabled>开始处理</button><button class="lsa-secondary-button lsa-pause-batch" type="button" disabled>暂停</button><select class="lsa-retry-type" aria-label="失败类型"><option value="">全部失败</option></select><button class="lsa-secondary-button lsa-retry-failed" type="button" disabled>重试失败项</button></div>
            <div class="lsa-button-row"><button class="lsa-secondary-button lsa-save-batch-json" type="button" disabled>保存批次 JSON</button><button class="lsa-secondary-button lsa-download-all" type="button" disabled>下载自动通过图</button></div>
            <p class="lsa-status-text lsa-batch-status">扫描后可开始；并发固定不超过 2，状态实时保存。</p>
          </div>
          ${transferPanel}
          ${quickSettings}
          <div class="lsa-batch-items"></div>
        </section>` : `
        <section class="lsa-tab-panel" data-panel="record">
          <div class="lsa-section-card">
            <div class="lsa-section-row"><h2 class="lsa-section-title">从批次填入当前编辑页</h2><button class="lsa-text-action lsa-refresh-record" type="button">重新匹配 ID</button></div>
            <p class="lsa-section-hint">优先按当前 URL 的 id 自动匹配；点击下面任一记录会立即跳转到对应编辑页。工具只填入标题和简介，图片由你手动上传，也不会点击后台最终保存。</p>
            <details class="lsa-record-fold lsa-inner-fold"${getBatchItems().length ? " open" : ""}>
              <summary class="lsa-record-fold-label">批次记录</summary>
              <div class="lsa-record-list" role="listbox" aria-label="选择并跳转到批次记录"></div>
            </details>
            <div class="lsa-selected-record"></div>
            <button class="lsa-primary-button lsa-apply-record" type="button" disabled>填入标题和简介</button>
            <p class="lsa-status-text lsa-edit-status">请先核对匹配记录；图片请在后台手动上传。</p>
          </div>
          ${transferPanel}
          ${quickSettings}
        </section>
        <section class="lsa-tab-panel" data-panel="manual" hidden>
          <div class="lsa-section-card">
            <div class="lsa-section-row"><h2 class="lsa-section-title">单条手动填写</h2><button class="lsa-text-action lsa-read-page" type="button">读取页面</button></div>
            <label class="lsa-field-label"><span>页面原稿</span><span>标题////简介</span></label><textarea class="lsa-assistant-textarea lsa-original-copy" placeholder="标题////简介"></textarea>
            <label class="lsa-field-label"><span>待填写文案</span><span><span class="lsa-counter lsa-title-count">标题 0 / 12</span> <span class="lsa-counter lsa-summary-count">简介 0 / 50</span></span></label><textarea class="lsa-assistant-textarea lsa-draft-copy" placeholder="第一行标题&#10;第二行起简介"></textarea>
            <div class="lsa-button-row"><button class="lsa-primary-button lsa-apply-draft" type="button">填写标题和简介</button><button class="lsa-secondary-button lsa-bind-fields" type="button">重新绑定字段</button></div><p class="lsa-status-text lsa-manual-status">不会自动点击后台保存。</p>
            <button class="lsa-secondary-button lsa-rewrite-manual" type="button">按当前模式改写</button>
          </div>
        </section>`}
        <section class="lsa-tab-panel" data-panel="images" hidden>
          <div class="lsa-section-card">
            <div class="lsa-section-row"><h2 class="lsa-section-title">单条竖屏配图</h2><button class="lsa-text-action lsa-read-for-images" type="button">读取原标题</button></div>
            <p class="lsa-section-hint">输入框为空或等于原标题时，自动按原标题生成英文视觉词；改成英文词则直接搜索、不调用 AI。简介、正文和改写标题不参与搜图。优先 Pexels，必要时回退 Pixabay。</p>
            <div class="lsa-search-row"><input class="lsa-assistant-input lsa-stock-query" type="search" placeholder="原标题；也可输入英文关键词"><button class="lsa-primary-button lsa-search-images" type="button">搜索图片</button></div>
            <p class="lsa-status-text lsa-image-status">正脸与裸露检测存在局限，无法确定的图片会明确标为“需复核”。</p>
            <div class="lsa-image-pager"><button class="lsa-secondary-button lsa-images-prev" type="button" disabled>上一页</button><span class="lsa-images-page">第 1 页</span><button class="lsa-secondary-button lsa-images-next" type="button" disabled>下一页</button></div>
          </div>
          <div class="lsa-stock-results"><div class="lsa-empty-result">这里只展示已验证宽度小于高度的图片</div></div>
        </section>
        <details class="lsa-diagnostics"><summary>诊断信息</summary><pre class="lsa-diagnostics-text"></pre></details>
      </div>
      <footer class="lsa-assistant-footer"><span class="lsa-global-status">草稿与批次状态自动保存</span><button class="lsa-text-action lsa-open-settings" type="button">设置</button></footer>`;
    root.querySelector(".lsa-assistant-name small").textContent = `${state.tabContext.label} · ${isList ? "独立批次" : `编辑页 ID ${route.id}`}`;
    return root;
  }

  async function saveAssistantState(patch) {
    if (!state.tabContext) return;
    const key = state.tabContext.keys.assistantState;
    const assistantState = (await chrome.storage.local.get(key))[key] || {};
    return chrome.storage.local.set({ [key]: { ...assistantState, ...patch } });
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
    const width = Math.min(window.innerWidth - 12, Math.max(320, Number(size.width) || 640));
    const height = Math.min(window.innerHeight - 12, Math.max(300, Number(size.height) || window.innerHeight * 0.92));
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

  function removeAllAssistantNodes() {
    document.querySelectorAll(".lsa-assistant").forEach((node) => node.remove());
  }

  function unmount({ disable = false, invalidate = true } = {}) {
    if (invalidate) state.mountRevision += 1;
    clearTimeout(state.resizeTimer);
    state.resizeObserver?.disconnect();
    state.resizeObserver = null;
    removeAllAssistantNodes();
    state.root = null;
    state.searchRevision += 1; state.autoReadRevision += 1; state.imageBusy = false;
    state.manualResults = []; state.imageQuery = ""; state.imageProvider = ""; state.imagePage = 1; state.imageHasNext = false;
    state.pageContext = {}; state.originalForSearch = null; state.imageTargetIndex = null;
    if (disable) saveAssistantState({ enabled: false });
  }

  function bindAssistantEvents() {
    q(".lsa-bangladesh-toggle")?.addEventListener("change", async (event) => {
      const enabled = Boolean(event.target.checked);
      if (enabled && !isBangladeshEligible()) {
        event.target.checked = false;
        setPanelStatus(state.route.kind === "list" ? ".lsa-batch-status" : ".lsa-edit-status", "只有语言为孟加拉语且国家为孟加拉时才能开启孟加拉模式", true);
        return;
      }
      state.tabSettings = { ...state.tabSettings, bangladeshMode: enabled };
      state.settings = { ...state.settings, bangladeshMode: enabled };
      await chrome.storage.local.set({ [state.tabContext.keys.settings]: state.tabSettings });
      renderBatch();
      setPanelStatus(state.route.kind === "list" ? ".lsa-batch-status" : ".lsa-edit-status",
        enabled ? "孟加拉模式已开启：自动初筛已收紧，投递前仍须逐条人工审核。" : "孟加拉模式已关闭。请确认当前国家规则是否允许。");
    });
    q(".lsa-save-meta")?.addEventListener("click", async () => {
      if (!state.batch || state.workOwned) return setPanelStatus(".lsa-transfer-status", "请先读取 / 导入批次，并暂停处理后修改", true);
      try {
        await acquireWork();
        state.batch.metadata = LSAWorkflow.batchMeta({ ...state.batch.metadata,
          language: q('[data-meta="language"]').value, country: q('[data-meta="country"]').value });
        for (const item of getBatchItems()) { item.pageLanguage = state.batch.metadata.language; item.pageCountry = state.batch.metadata.country; }
        await persistBatch();
        setPanelStatus(".lsa-transfer-status", "文件夹名称已更新；之后的下载使用新目录，已下载文件不会移动。");
      } catch (error) { setPanelStatus(".lsa-transfer-status", error.message, true); }
      finally { if (state.workOwned) await releaseWork(); }
    });
    q(".lsa-list-saved")?.addEventListener("click", async () => {
      try {
        const response = await sendRuntime("LIST_SAVED_BATCHES");
        state.savedBatchKeys = new Set(response.batches.map((batch) => batch.key));
        const select = q(".lsa-saved-batches"); select.replaceChildren();
        for (const batch of response.batches) {
          const option = create("option", "", `${batch.folderName || batch.batchId || "旧版批次"} · ${batch.count} 条${batch.key === state.tabContext.keys.batchState ? "（当前）" : ""}`);
          option.value = batch.key; select.append(option);
        }
        if (!response.batches.length) setPanelStatus(".lsa-transfer-status", "本机没有已存批次");
      } catch (error) { setPanelStatus(".lsa-transfer-status", error.message, true); }
    });
    q(".lsa-restore-saved")?.addEventListener("click", async () => {
      const key = q(".lsa-saved-batches")?.value;
      if (!state.savedBatchKeys?.has(key)) return setPanelStatus(".lsa-transfer-status", "请先查看并选择已存批次", true);
      const saved = (await chrome.storage.local.get(key))[key];
      const text = JSON.stringify(saved);
      await importResults({ size: new Blob([text]).size, text: async () => text });
    });
    qa("[data-setting]").forEach((input) => {
      input.value = state.settings[input.dataset.setting];
      input.addEventListener("change", async () => {
        const key = input.dataset.setting;
        if (key === "batchLimit" && state.workOwned) { input.value = currentBatchLimit(); return; }
        const value = key === "batchLimit" ? LSAWorkflow.batchSize(input.value) : input.type === "number" ? LSAWorkflow.number(input.value, 1, key === "titleLimit" ? 100 : 500, state.settings[key]) : input.value;
        state.tabSettings = { ...state.tabSettings, [key]: value };
        await chrome.storage.local.set({ [state.tabContext.keys.settings]: state.tabSettings });
        if (key === "batchLimit" && state.batch) { state.batch.batchLimit = value; await persistBatch(); }
        input.value = value; setPanelStatus(".lsa-quick-status", "已保存到当前标签页；其他标签页不受影响");
      });
    });
    q(".lsa-page-filter")?.addEventListener("change", (event) => { state.pageFilter = event.target.value; renderBatchItems(); });
    q(".lsa-import-json")?.addEventListener("click", () => q(".lsa-import-file").click());
    q(".lsa-import-file")?.addEventListener("change", (event) => { importResults(event.target.files[0]); event.target.value = ""; });
    q(".lsa-export-completed")?.addEventListener("click", () => exportResults().catch((error) => setPanelStatus(".lsa-transfer-status", error.message, true)));
    q(".lsa-new-batch")?.addEventListener("click", async () => {
      if (state.workOwned) return setPanelStatus(".lsa-transfer-status", "请先暂停处理", true);
      try {
        await acquireWork();
        if (getBatchItems().length) await saveTextSnapshot("batch");
        await archiveBatch();
        state.batch = null;
        await chrome.storage.local.set({ [state.tabContext.keys.batchState]: null });
        state.pageFilter = "all"; state.selectedRecordIndex = -1; renderBatch();
        setPanelStatus(".lsa-transfer-status", "旧批次已导出；可以读取新页面");
      } catch (error) { setPanelStatus(".lsa-transfer-status", error.message, true); }
      finally { if (state.workOwned) await releaseWork(); }
    });
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
    q(".lsa-retry-failed")?.addEventListener("click", () => retryFailed(null, q(".lsa-retry-type")?.value || ""));
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
    q(".lsa-rewrite-manual")?.addEventListener("click", rewriteManual);
    q(".lsa-bind-fields")?.addEventListener("click", () => pageTool("START_BINDING")
      .catch((error) => setPanelStatus(".lsa-manual-status", error.message, true)));
    q(".lsa-draft-copy")?.addEventListener("input", updateManualCounts);
    q(".lsa-search-images")?.addEventListener("click", () => searchManualImages(1));
    q(".lsa-images-prev")?.addEventListener("click", () => searchManualImages(state.imagePage - 1));
    q(".lsa-images-next")?.addEventListener("click", () => searchManualImages(state.imagePage + 1));
    q(".lsa-stock-query")?.addEventListener("input", () => {
      state.manualResults = [];
      state.imagePage = 1;
      state.imageHasNext = false;
      renderManualImages();
      renderImagePager();
    });
    q(".lsa-stock-query")?.addEventListener("keydown", (event) => { if (event.key === "Enter") searchManualImages(1); });
    q(".lsa-diagnostics")?.addEventListener("toggle", updateDiagnostics);
  }

  async function mount(route, { force = false } = {}) {
    if (route.kind === "none" || location.hostname !== TARGET_HOST) return;
    if (state.root && state.route.key === route.key) return;
    const revision = state.mountRevision + 1;
    state.mountRevision = revision;
    unmount({ invalidate: false });
    state.tabContext ||= await sendRuntime("GET_TAB_CONTEXT");
    const keys = state.tabContext.keys;
    const [{ settings = {} }, local, duplicateLibrary] = await Promise.all([
      chrome.storage.sync.get("settings"), chrome.storage.local.get(Object.values(keys)), sendRuntime("GET_DUPLICATE_LIBRARY"),
    ]);
    if (revision !== state.mountRevision) return;
    const assistantState = local[keys.assistantState] || {};
    if (!force && assistantState.enabled === false) return;
    state.globalSettings = settings;
    state.tabSettings = { batchLimit: LSAWorkflow.batchSize(settings.batchLimit), ...(local[keys.settings] || Object.fromEntries(["titleLimit", "summaryLimit", "rewriteMode", "thinkingLevel", "batchConcurrency"].map((key) => [key, settings[key] ?? DEFAULT_SETTINGS[key]]))) };
    if (!local[keys.settings]) await chrome.storage.local.set({ [keys.settings]: state.tabSettings });
    state.settings = { ...DEFAULT_SETTINGS, ...settings, ...state.tabSettings };
    if (!state.workOwned) state.batch = local[keys.batchState] || null;
    if (!state.workOwned && state.batch?.items?.length) {
      const folders = LSAWorkflow.splitBatchFolders(state.batch);
      if (folders.length > 1 || !state.batch.metadata) {
        // Migrate stacked legacy pages once, retaining the original for recovery.
        await archiveBatch(state.batch);
        for (const folder of folders) await archiveBatch(folder);
        state.batch = folders.find((folder) => folder.items.some((item) => String(item.id) === route.id)) || folders[0];
        await persistBatch({ render: false });
      }
    }
    state.imageHistory = local[keys.imageHistory] || {};
    state.globalManual = duplicateLibrary.entries || {};
    state.globalUsage = duplicateLibrary.usage || {};
    const reconciliation = await sendRuntime("RECONCILE_IMAGE_DOWNLOADS").catch(() => null);
    if (reconciliation?.history) state.imageHistory = reconciliation.history;
    const lease = await sendRuntime("WORK_LOCK", { operation: "status", token: state.workToken });
    if (revision !== state.mountRevision) return;
    if (!lease.active) await recoverInterruptedBatch();
    if (revision !== state.mountRevision) return;
    state.route = route;
    state.selectedRecordIndex = -1;
    removeAllAssistantNodes();
    state.root = buildAssistant(route);
    document.documentElement.append(state.root);
    applySize(assistantState.layoutVersion === 9 ? assistantState.size : { width: Math.min(680, window.innerWidth * 0.48), height: window.innerHeight * 0.92 });
    applyPosition(assistantState.position);
    if (assistantState.minimized) {
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
          state.viewportSize = { widthRatio: rect.width / window.innerWidth, heightRatio: rect.height / window.innerHeight };
          saveAssistantState({ layoutVersion: 9, size: { width: Math.round(rect.width), height: Math.round(rect.height) },
            position: clampPosition(rect.left, rect.top) });
        }, 200);
      });
      state.resizeObserver.observe(state.root);
    }
    renderBatch();
    updateDiagnostics();
    if (route.kind === "edit") {
      refreshAiTranslationStatus();
      autoReadAndSearch().catch((error) => setPanelStatus(".lsa-image-status", error.message, true));
    }
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
    if (type === "AI_RETRY_PROGRESS") {
      const item = getBatchItems().find((record) => (message.itemId && String(record.id) === String(message.itemId))
        || Number(record.index) === Number(message.itemIndex));
      if (item) {
        if (message.status === "waiting") {
          item.retryStatus = `第 ${message.attempt} 次重试，等待 ${Math.ceil(Number(message.waitMs || 0) / 1000)} 秒 · ${message.model || "当前模型"}`;
        } else if (message.status === "requesting" && Number(message.attempt) > 1) {
          item.retryStatus = `正在进行第 ${message.attempt} 次请求 · ${message.model || "当前模型"}`;
        } else {
          item.retryStatus = "";
        }
        renderItemRuntimeState(item);
      }
      sendResponse?.({ ok: true });
      return undefined;
    }
    if (type !== "TOGGLE_FLOATING_ASSISTANT") return undefined;
    if (state.root) unmount({ disable: true });
    else handleRouteChange({ force: true }).catch(() => {});
    sendResponse({ ok: true });
    return undefined;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes.settings?.newValue) {
      state.globalSettings = changes.settings.newValue;
      state.settings = { ...DEFAULT_SETTINGS, ...state.globalSettings, ...state.tabSettings };
      updateManualCounts();
      qa("[data-setting]").forEach((input) => { if (input !== document.activeElement) input.value = state.settings[input.dataset.setting]; });
      renderBatch();
      if (state.route.kind === "edit") refreshAiTranslationStatus();
    }
    const keys = state.tabContext?.keys;
    if (area === "local" && keys && changes[keys.settings]) {
      state.tabSettings = changes[keys.settings].newValue || {};
      state.settings = { ...DEFAULT_SETTINGS, ...state.globalSettings, ...state.tabSettings };
      updateManualCounts(); renderBatch();
      if (state.route.kind === "edit") refreshAiTranslationStatus();
    }
    if (area === "local" && changes.localSecrets && state.route.kind === "edit") {
      refreshAiTranslationStatus();
    }
    if (area === "local" && keys && changes[keys.imageHistory]) {
      state.imageHistory = changes[keys.imageHistory].newValue || {};
      renderBatch(); renderManualImages();
    }
    if (area === "local" && changes.lsaManualDuplicates) {
      state.globalManual = changes.lsaManualDuplicates.newValue || {};
      renderBatch(); renderManualImages();
    }
    if (area === "local" && changes.lsaImageUsage) {
      state.globalUsage = changes.lsaImageUsage.newValue || {};
      renderBatch(); renderManualImages();
    }
    if (area === "local" && keys && changes[keys.batchState] && !state.workOwned) {
      const incoming = changes[keys.batchState].newValue;
      if (!incoming || !state.batch || Number(incoming.updatedAt || 0) > Number(state.batch.updatedAt || 0)) {
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
    applySize(state.viewportSize ? { width: state.viewportSize.widthRatio * window.innerWidth, height: state.viewportSize.heightRatio * window.innerHeight } : { width: rect.width, height: rect.height });
    applyPosition({ left: rect.left, top: rect.top });
  });
  setInterval(() => {
    if (state.lastLocation === location.href) return;
    state.lastLocation = location.href;
    handleRouteChange().catch(() => {});
  }, 800);
  setInterval(() => recoverInterruptedBatch().catch(() => {}), 10000);

  handleRouteChange().catch(() => {});
})();
