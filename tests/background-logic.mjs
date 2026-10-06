import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.resolve(here, "..", "background.js"), "utf8");
const noop = () => {};
const chrome = {
  runtime: { onInstalled: { addListener: noop }, onMessage: { addListener: noop }, openOptionsPage: noop },
  action: { onClicked: { addListener: noop } },
  contextMenus: { removeAll: (callback) => callback?.(), create: noop, onClicked: { addListener: noop } },
  tabs: { create: noop, sendMessage: async () => ({}) },
  storage: {
    sync: { get: async () => ({ settings: {} }), set: async () => {} },
    local: { get: async () => ({ localSecrets: {} }), set: async () => {} },
  },
  downloads: { download: async () => 1 },
};
const context = vm.createContext({
  chrome,
  console,
  URL,
  URLSearchParams,
  TextEncoder,
  Uint8Array,
  ArrayBuffer,
  AbortController,
  setTimeout,
  clearTimeout,
  fetch: async () => { throw new Error("测试不应访问网络"); },
  btoa: (value) => Buffer.from(value, "binary").toString("base64"),
});
vm.runInContext(source, context, { filename: "background.js" });

function evaluate(expression) {
  return vm.runInContext(expression, context);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(evaluate("buildSafeStockQuery('peony garden morning light')") === "peony garden morning light",
  "非人物搜索词不应追加人物姿态");
assert(evaluate("buildSafeStockQuery('woman walking in city')").includes("side profile"),
  "人物搜索词应追加侧脸/背影约束");
assert(evaluate("supportsThinkingControl('dsv4flash', 'https://api.deepseek.com/chat/completions')") === true,
  "DeepSeek 官方端点未识别思考控制");
assert(evaluate("supportsThinkingControl('deepseek-v4-pro')") === true, "DeepSeek V4 Pro 未识别思考控制");
assert(evaluate("supportsThinkingControl('glm-5')") === true, "GLM 5 未识别思考控制");
assert(evaluate("enableMediumThinking({}, 'dsv4flash', 'https://api.deepseek.com/chat/completions').thinking.type") === "enabled",
  "DeepSeek 思考模式未开启");
assert(evaluate("enableMediumThinking({}, 'dsv4flash', 'https://api.deepseek.com/chat/completions').reasoning_effort") === "medium",
  "DeepSeek 推理档位不是 medium");
assert(evaluate("normalizeAiEndpoint('https://api.deepseek.com')") === "https://api.deepseek.com/chat/completions", "DeepSeek 根地址未补全");
assert(evaluate("describeEmptyAiResponse({choices:[{finish_reason:'length',message:{reasoning_content:'thinking'}}]})").includes("思考内容"),
  "DeepSeek 空响应诊断不明确");
assert(evaluate("describeEmptyAiResponse({model:'custom-model',choices:[]})").includes("model=custom-model"),
  "空响应诊断未包含实际返回模型");
assert(evaluate("shouldRetry({code:'TIMEOUT',retryable:true})") === false, "超时不应再连续自动重试");
assert(evaluate("getNearestAspect(1080, 1920, 'auto').aspectLabel") === "9:16", "9:16 比例识别失败");
assert(evaluate("getNearestAspect(1080, 2400, 'auto').aspectLabel") === "9:20", "9:20 比例识别失败");
assert(evaluate("inspectImageMetadataSafety({title:'shirtless model'}).safetyStatus") === "rejected",
  "高裸露风险词未拒绝");
assert(evaluate("inspectImageMetadataSafety({title:'woman walking'}).safetyStatus") === "review",
  "普通人物图片应要求复核");
assert(evaluate("inspectImageMetadataSafety({title:'woman silhouette from behind'}).safetyStatus") === "passed",
  "背影/剪影不应一律拒绝");
assert(evaluate("normalizePexelsImage({id:7,src:{original:'https://img/original.jpg',medium:'https://img/medium.jpg'},width:1080,height:1920}).imageUrl")
  === "https://img/original.jpg", "Pexels 未优先 original");

const filename = evaluate("buildFinalImageName({index:3,title:'A/B:C',summary:'D?E'}, {aspectLabel:'9:16',mime:'image/jpeg'})");
assert(filename.startsWith("03-A-B-C【D-E】_9x16"), "成品图命名或非法字符清理错误");
assert(!/[\\/:*?\"<>|]/.test(filename), "成品图文件名仍含 Windows 非法字符");

const valid = evaluate(`validateAiResult(
  {title:'Ideas clave',summary:'Resumen breve y fiel',image_query_en:'historic city street evening',language:'es'},
  {titleLimit:12,summaryLimit:50,originalTitle:'Ideas para la ciudad',expectedLanguage:'es'}
)`);
assert(valid.language === "es", "西班牙语结果校验失败");
let overLimitRejected = false;
try {
  evaluate(`validateAiResult(
    {title:'This title is far too long',summary:'Short summary',image_query_en:'green forest trail morning',language:'en'},
    {titleLimit:12,summaryLimit:50,originalTitle:'A useful title',expectedLanguage:'en'}
  )`);
} catch {
  overLimitRejected = true;
}
assert(overLimitRejected, "超长标题没有被拒绝");

const strictPrompt = evaluate(`buildAiMessages({
  originalTitle:'How to grow peonies at home', originalSummary:'A practical guide to planting and caring for peonies.',
  articleText:'', expectedLanguage:'en', titleLimit:12, summaryLimit:50
}, 'AI title was 27 characters, exceeding the 12 character limit')[0].content`);
assert(strictPrompt.includes("MANDATORY FINAL CHECK"), "提示词缺少强制字符复核");
assert(strictPrompt.includes("at most 12 Unicode characters"), "提示词缺少标题字符限制");
assert(strictPrompt.includes("at most 50 Unicode characters"), "提示词缺少简介字符限制");
assert(strictPrompt.includes("PREVIOUS ATTEMPT FAILED"), "重试提示词没有携带上次失败原因");
assert(strictPrompt.includes("image_query_en"), "提示词丢失英文搜图词要求");

console.log("后台逻辑测试通过");
