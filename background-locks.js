(function initBackgroundLocks(global) {
  function serialQueue() {
    let chain = Promise.resolve();
    return (task) => {
      const run = chain.then(task);
      chain = run.catch(() => {});
      return run;
    };
  }

  global.LSABackgroundLocks = Object.freeze({ serialQueue });
})(globalThis);
