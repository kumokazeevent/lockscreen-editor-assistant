(function initAssistantUi(global) {
  function findBatchCard(root, itemKey) {
    return [...(root?.querySelectorAll?.(".lsa-batch-card") || [])]
      .find((node) => node.dataset.itemKey === itemKey) || null;
  }

  function patchBatchCard({ root, itemKey, status, statusLabel, progressNode, retryStatus, createRetryNode }) {
    const card = findBatchCard(root, itemKey);
    if (!card) return false;
    card.className = `lsa-batch-card is-${status || "pending"}`;
    const statusNode = card.querySelector(".lsa-item-status");
    if (statusNode) statusNode.textContent = statusLabel;
    const oldProgress = card.querySelector(".lsa-item-progress");
    if (oldProgress) oldProgress.replaceWith(progressNode);
    const oldRetry = card.querySelector(".lsa-item-retry-status");
    if (retryStatus) {
      if (oldRetry) oldRetry.textContent = retryStatus;
      else progressNode.after(createRetryNode(retryStatus));
    } else oldRetry?.remove();
    return true;
  }

  global.LSAAssistantUi = Object.freeze({ findBatchCard, patchBatchCard });
})(globalThis);
