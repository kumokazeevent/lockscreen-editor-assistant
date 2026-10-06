(function initAssistantEngine(global) {
  function shouldPatchProgress(batch, item, progressOnly) {
    return Boolean(progressOnly && item && batch?.status === "running");
  }

  function batchSummary(batch, counts) {
    if (!batch) return "";
    return `${batch.batchId} · 共 ${counts.total} · 完成 ${counts.done} · 需复核 ${counts.review} · 失败 ${counts.failed} · 待处理 ${counts.pending + counts.working}`;
  }

  global.LSAAssistantEngine = Object.freeze({ shouldPatchProgress, batchSummary });
})(globalThis);
