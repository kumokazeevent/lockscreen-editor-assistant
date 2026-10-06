(function initAssistantEngine(global) {
  function shouldPatchProgress(batch, item, progressOnly) {
    return Boolean(progressOnly && item && batch?.status === "running");
  }

  function batchSummary(batch, counts) {
    if (!batch) return "";
    return `${batch.batchId} · 共 ${counts.total} · 完成 ${counts.done} · 需复核 ${counts.review} · 失败 ${counts.failed} · 待处理 ${counts.pending + counts.working}`;
  }

  function manualImageSearchPlan({ page = 1, typedValue = "", originalTitle = "", currentQuery = "" } = {}) {
    const pageNumber = Math.max(1, Number(page) || 1);
    const typed = String(typedValue || "").trim();
    const original = String(originalTitle || "").trim();
    if (pageNumber > 1) {
      if (!currentQuery) return { error: "当前没有可翻页的搜索结果，请先搜索" };
      return { mode: "continuation", query: String(currentQuery), usesOriginalTitle: false };
    }
    const usesOriginalTitle = !typed || typed === original;
    if (usesOriginalTitle && !original) return { error: "没有读取到原标题，无法搜索图片" };
    if (!usesOriginalTitle && /[^\x00-\x7f]/.test(typed)) {
      return { error: "自定义关键词请使用英文；也可点击“恢复原标题”重新按原标题搜索" };
    }
    return { mode: usesOriginalTitle ? "original" : "custom", query: usesOriginalTitle ? original : typed, usesOriginalTitle };
  }

  function shouldStoreGeneratedQuery(liveInput, originalTitle) {
    const input = String(liveInput || "").trim();
    const original = String(originalTitle || "").trim();
    return !input || input === original;
  }

  global.LSAAssistantEngine = Object.freeze({
    shouldPatchProgress, batchSummary, manualImageSearchPlan, shouldStoreGeneratedQuery,
  });
})(globalThis);
