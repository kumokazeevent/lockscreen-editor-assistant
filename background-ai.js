(function initBackgroundAi(global) {
  function parseRetryAfter(value, now = Date.now()) {
    const raw = String(value || "").trim();
    if (!raw) return 0;
    const seconds = Number(raw);
    const duration = Number.isFinite(seconds) ? seconds * 1000 : new Date(raw).getTime() - now;
    return Number.isFinite(duration) && duration > 0 ? Math.min(60000, Math.ceil(duration)) : 0;
  }

  function retryDelayMs(retryIndex, retryAfterMs = 0) {
    if (Number(retryAfterMs) > 0) return Math.min(60000, Math.max(0, Math.ceil(Number(retryAfterMs))));
    return [5000, 15000, 30000][Math.max(0, Math.min(2, Number(retryIndex) || 0))];
  }

  function classifyAiError({ status = 0, code = "", responseKind = "" } = {}) {
    if (code === "OUTPUT_LENGTH") return "OUTPUT_LENGTH";
    if (code === "TIMEOUT") return "TIMEOUT";
    if (Number(status) === 429) return "RATE_LIMIT";
    if ([400, 401, 403, 404, 422].includes(Number(status)) || ["AI_NOT_CONFIGURED", "AI_ENDPOINT_INVALID"].includes(code)) return "AUTH_ERROR";
    if (Number(status) >= 500 || ["NETWORK_ERROR", "SERVER_ERROR"].includes(code)) return "SERVER_ERROR";
    if (/EMPTY|ERROR_JSON|EMPTY_CHOICES|EMPTY_CONTENT/.test(responseKind) || ["AI_EMPTY", "EMPTY_RESPONSE"].includes(code)) return "EMPTY_RESPONSE";
    return code === "AI_INVALID" ? "AI_INVALID" : "SERVER_ERROR";
  }

  global.LSABackgroundAi = Object.freeze({ parseRetryAfter, retryDelayMs, classifyAiError });
})(globalThis);
