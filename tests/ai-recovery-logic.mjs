import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8")).version;
const local = { localSecrets: { aiApiKey: "secret-test-key" } };
const sync = { settings: {} };
const noop = () => {};
const storage = (data) => ({
  get: async (keys) => keys === null ? structuredClone(data) : Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, structuredClone(data[key])])),
  set: async (patch) => Object.assign(data, structuredClone(patch)),
});
const progress = [];
const chrome = {
  runtime: { onInstalled: { addListener: noop }, onStartup: { addListener: noop }, onMessage: { addListener: noop }, openOptionsPage: noop },
  action: { onClicked: { addListener: noop } },
  contextMenus: { removeAll: (callback) => callback?.(), create: noop, onClicked: { addListener: noop } },
  storage: { local: storage(local), sync: storage(sync) },
  tabs: { sendMessage: async (_id, message) => { progress.push(structuredClone(message)); return { ok: true }; }, create: noop },
  downloads: { download: async () => 1, search: async () => [], onChanged: { addListener: noop } },
};
const context = vm.createContext({
  chrome, console, URL, URLSearchParams, TextEncoder, Uint8Array, ArrayBuffer, Blob, Response, Headers,
  AbortController, setTimeout, clearTimeout, crypto: webcrypto, btoa, atob, importScripts: noop,
  fetch: async () => { throw new Error("scenario not configured"); },
});
for (const file of ["workflow.js", "background-ai.js", "background-stock.js", "background-downloads.js", "background-locks.js", "background.js"]) vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), context, { filename: file });
const run = (code) => vm.runInContext(code, context);
context.retryWaits = [];
run("sleepForRetry = async (ms) => { retryWaits.push(ms); }");

const successPayload = {
  model: "returned-model",
  choices: [{ finish_reason: "stop", message: { content: JSON.stringify({
    title: "Care for cats", summary: "Keep cats comfortable at home",
    image_query_en: "comfortable cat resting quiet home", language: "en",
  }) } }],
};
const response = (body, status = 200, headers = {}) => new Response(typeof body === "string" ? body : JSON.stringify(body), {
  status, headers: { "content-type": "application/json", ...headers },
});
function scenario(responses, settings = {}) {
  sync.settings = {
    aiEndpoint: "https://api.test/chat/completions", aiModel: "primary-model", aiFallbackModel: "",
    rewriteMode: "ai", thinkingLevel: "off", titleLimit: 12, summaryLimit: 50, aiTimeoutMs: 30000,
    ...settings,
  };
  context.retryWaits.length = 0;
  progress.length = 0;
  const queue = [...responses];
  context.requestBodies = [];
  context.fetch = async (_url, options = {}) => {
    const requestBody = JSON.parse(options.body);
    context.requestBodies.push(requestBody);
    const next = queue.shift();
    if (next instanceof Error) throw next;
    if (!next) throw new Error("scripted response queue exhausted");
    return typeof next === "function" ? next(options) : next;
  };
}
const item = { id: "x", index: 1, originalTitle: "How to care for cats", originalSummary: "Keep cats comfortable at home",
  articleText: "Cats stay comfortable when they have a warm quiet room, fresh water and a clean place to rest." };
context.item = item;

scenario([response(successPayload)]);
const summaryFallback = await run("generateBatchItemWithAi({item:{originalTitle:'No body',originalSummary:'Use the original summary fallback'},maxRetries:0})");
assert.equal(summaryFallback.summarySource, "original_summary");
assert.equal(summaryFallback.titleSource, "generated_summary");

assert.equal(run("parseRetryAfter('120')"), 60000);
assert.equal(run("retryDelayMs(0)"), 5000);
assert.equal(run("retryDelayMs(1)"), 15000);
assert.equal(run("retryDelayMs(2)"), 30000);
assert.equal(run("classifyAiError({status:429})"), "RATE_LIMIT");
assert.equal(run("classifyAiError({status:503})"), "SERVER_ERROR");
assert.equal(run("classifyAiError({code:'TIMEOUT'})"), "TIMEOUT");
assert.equal(run("isOutputTruncated({choices:[{finish_reason:'length',message:{content:'partial'}}]})"), true);
assert.equal(run("isOutputTruncated({choices:[{finish_reason:'length',message:{content:'',reasoning_content:''}}]})"), true);

scenario([
  response({ choices: [{ finish_reason: "length", message: { content: "", reasoning_content: "thinking" } }] }),
  response({ choices: [{ finish_reason: "length", message: { content: "", reasoning_content: "" } }] }),
  response({ choices: [{ finish_reason: "length", message: { content: "partial" } }] }),
]);
await assert.rejects(run("generateBatchItemWithAi({item}, 7)"), (error) => error.errorType === "OUTPUT_LENGTH" && error.attempts === 3);
assert.deepEqual(context.requestBodies.map((body) => body.max_tokens), [4096, 8192, 16384]);
assert.deepEqual(context.retryWaits, [], "length 扩容不得等待");

scenario([response({ message: "busy" }, 503), response({ message: "busy" }, 503), response(successPayload)]);
const recovered = await run("generateBatchItemWithAi({item}, 7)");
assert.equal(recovered.title, "Care for cats");
assert.equal(recovered.summarySource, "article_body");
assert.equal(recovered.titleSource, "generated_summary");
assert.ok(context.requestBodies.at(-1).messages[0].content.includes("After writing the summary, derive one natural title using ONLY that newly written summary"));
assert.ok(context.requestBodies.at(-1).messages.at(-1).content.includes(item.articleText));
assert.ok(context.requestBodies.at(-1).messages.at(-1).content.includes(item.originalTitle));
assert.equal(context.requestBodies.length, 3, "正常恢复后每个尝试只发一条主 AI 请求，不再另发标题请求");
assert.deepEqual(context.retryWaits, [5000, 15000]);
assert.ok(progress.some((entry) => entry.status === "waiting" && entry.waitMs === 5000));

scenario([
  response({ message: "busy" }, 503), response({ message: "busy" }, 503), response({ message: "busy" }, 503),
  response(successPayload),
], { aiFallbackModel: "backup-model" });
const fallback = await run("generateBatchItemWithAi({item}, 7)");
assert.equal(fallback.model, "backup-model");
assert.equal(fallback.usedFallbackModel, true);
assert.deepEqual(context.requestBodies.map((body) => body.model), ["primary-model", "primary-model", "primary-model", "backup-model"]);
assert.deepEqual(context.retryWaits, [5000, 15000, 30000]);

scenario([response({ error: { message: "empty proxy" } }), response({ choices: [] }), response("")]);
await assert.rejects(run("generateBatchItemWithAi({item})"), (error) => {
  assert.equal(error.errorType, "EMPTY_RESPONSE");
  assert.equal(error.diagnostics.length, 3);
  assert.equal(Array.from(error.diagnostics, (entry) => entry.responseKind).join(","), "ERROR_JSON,EMPTY_CHOICES,EMPTY_BODY");
  return true;
});

scenario([response({ error: { message: `x${"z".repeat(4000)}` } }, 503)]);
await assert.rejects(run("generateBatchItemWithAi({item,maxRetries:0})"), (error) => {
  assert.equal(error.diagnostics[0].rawBody.length, 3000);
  assert.equal(error.diagnostics[0].rawBody.includes("secret-test-key"), false);
  assert.equal(error.diagnostics[0].contentType, "application/json");
  return true;
});

scenario([response({ error: { message: "use max_completion_tokens instead of unsupported max_tokens" } }, 400), response(successPayload)]);
const compatible = await run("generateBatchItemWithAi({item,maxRetries:0})");
assert.equal(compatible.title, "Care for cats");
assert.equal(context.requestBodies[0].max_tokens, 4096);
assert.equal(context.requestBodies[1].max_completion_tokens, 4096);
assert.equal("max_tokens" in context.requestBodies[1], false);

scenario([response({ error: { message: "unauthorized" } }, 401), response(successPayload)], { aiFallbackModel: "backup-model" });
await assert.rejects(run("generateBatchItemWithAi({item},7)"), (error) => error.errorType === "AUTH_ERROR" && error.attempts === 1);
assert.equal(context.requestBodies.length, 1, "认证错误不得重试或切备用模型");

console.log(`${version} AI 恢复测试通过：诊断分类、length 扩容、分级退避、token 字段兼容与备用模型`);
