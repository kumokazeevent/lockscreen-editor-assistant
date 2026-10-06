(function initBackgroundLocks(global) {
  function serialQueue() {
    let chain = Promise.resolve();
    return (task) => {
      const run = chain.then(task);
      chain = run.catch(() => {});
      return run;
    };
  }

  function createWorkLock({ storage, getStorageKey, leaseMs = 30000, now = () => Date.now() }) {
    const queue = serialQueue();
    return (action, token, tabId) => queue(async () => {
      const storageKey = await getStorageKey(tabId);
      const workLease = (await storage.get(storageKey))[storageKey];
      const active = workLease && workLease.expiresAt > now();
      const owns = active && workLease.token === token && workLease.tabId === tabId;
      if (action === "status") return { active: Boolean(active), owns: Boolean(owns) };
      if (action === "release") {
        if (owns) await storage.set({ [storageKey]: null });
        return { active: false };
      }
      if ((action === "renew" && !owns) || (active && !owns)) {
        throw new Error("当前标签页仍有任务正在处理，请稍后重试；其他标签页可以独立运行");
      }
      await storage.set({ [storageKey]: { token, tabId, expiresAt: now() + leaseMs } });
      return { active: true, owns: true };
    });
  }

  global.LSABackgroundLocks = Object.freeze({ serialQueue, createWorkLock });
})(globalThis);
