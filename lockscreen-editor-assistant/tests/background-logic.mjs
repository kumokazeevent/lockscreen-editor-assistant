import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.resolve(here, "..", "background.js"), "utf8");
const backgroundModules = ["background-ai.js", "background-stock.js", "background-downloads.js", "background-locks.js"];
const noop = () => {};
class FakeOffscreenCanvas {
  constructor(width, height) { this.width = width; this.height = height; }
  getContext() { return { fillStyle: "", fillRect: noop, drawImage: noop }; }
  async convertToBlob(options) { return new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: options.type }); }
}
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
  importScripts: () => {},
  chrome,
  console,
  URL,
  URLSearchParams,
  TextEncoder,
  Uint8Array,
  ArrayBuffer,
  Blob,
  Response,
  AbortController,
  setTimeout,
  clearTimeout,
  fetch: async () => { throw new Error("测试不应访问网络"); },
  btoa: (value) => Buffer.from(value, "binary").toString("base64"),
  createImageBitmap: async () => ({ width: 900, height: 1600, close: noop }),
  OffscreenCanvas: FakeOffscreenCanvas,
});
vm.runInContext(fs.readFileSync(path.resolve(here, "..", "workflow.js"), "utf8"), context);
for (const file of backgroundModules) vm.runInContext(fs.readFileSync(path.resolve(here, "..", file), "utf8"), context, { filename: file });
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
assert(evaluate("disableThinking({reasoning_effort:'medium'}, 'deepseek-v4-flash', 'https://opencode.ai/zen/go/v1/chat/completions').thinking.type") === "disabled",
  "审核 AI 未关闭思考模式");
assert(evaluate("'reasoning_effort' in disableThinking({reasoning_effort:'medium'}, 'deepseek-v4-flash')") === false,
  "审核 AI 仍携带推理档位");
assert(evaluate("normalizeAiEndpoint('https://api.deepseek.com')") === "https://api.deepseek.com/chat/completions", "DeepSeek 根地址未补全");
assert(evaluate("describeEmptyAiResponse({choices:[{finish_reason:'length',message:{reasoning_content:'thinking'}}]})").includes("思考内容"),
  "DeepSeek 空响应诊断不明确");
assert(evaluate("describeEmptyAiResponse({model:'custom-model',choices:[]})").includes("model=custom-model"),
  "空响应诊断未包含实际返回模型");
assert(evaluate("isReasoningTruncated({choices:[{finish_reason:'length',message:{content:'',reasoning_content:'long reasoning'}}]})") === true,
  "未识别思考内容耗尽输出预算");
assert(evaluate("isOutputTruncated({choices:[{finish_reason:'length',message:{content:'partial result'}}]})") === true,
  "有部分正文的 length 响应也必须识别为截断");
assert(evaluate("isOutputTruncated({choices:[{finish_reason:'length',message:{content:''}}]})") === true,
  "无 reasoning_content 的 length 响应也必须识别为截断");
assert(evaluate("isReasoningTruncated({choices:[{finish_reason:'stop',message:{content:'',reasoning_content:'reasoning'}}]})") === false,
  "非 length 空响应不应触发扩容重试");
assert(evaluate("retryDelayMs(0)") === 5000 && evaluate("retryDelayMs(1)") === 15000 && evaluate("retryDelayMs(2)") === 30000,
  "自动重试没有使用 5/15/30 秒分级退避");
assert(evaluate("retryDelayMs(0,90000)") === 60000, "Retry-After 没有限制到 60 秒");
assert(evaluate("classifyAiError({status:429})") === "RATE_LIMIT", "429 未分类为限流");
assert(evaluate("classifyAiError({status:503})") === "SERVER_ERROR", "5xx 未分类为服务端错误");
assert(evaluate("classifyAiError({responseKind:'EMPTY_CHOICES'})") === "EMPTY_RESPONSE", "空 choices 未分类为空响应");
assert(evaluate("shouldRetry({code:'TIMEOUT',retryable:true})") === false, "超时不应再连续自动重试");
assert(evaluate("getNearestAspect(1080, 1920, 'auto').aspectLabel") === "9:16", "9:16 比例识别失败");
assert(evaluate("getNearestAspect(1080, 2400, 'auto').aspectLabel") === "9:20", "9:20 比例识别失败");
assert(evaluate("inspectImageMetadataSafety({title:'shirtless model'}).safetyStatus") === "rejected",
  "高裸露风险词未拒绝");
assert(evaluate("inspectImageMetadataSafety({title:'woman walking'}).safetyStatus") === "review",
  "普通人物图片应要求复核");
assert(evaluate("inspectImageMetadataSafety({title:'woman silhouette from behind'}).safetyStatus") === "passed",
  "背影/剪影不应一律拒绝");
assert(evaluate("inspectImageMetadataSafety({title:'woman silhouette from behind',width:900,height:1600},true).safetyStatus") === "rejected",
  "孟加拉模式不应因背影词放行人物");
assert(evaluate("inspectImageMetadataSafety({title:'realistic pet cat',width:900,height:1600},true).safetyStatus") === "rejected",
  "孟加拉模式未拒绝非白名单动物");
assert(evaluate("inspectImageMetadataSafety({title:'cartoon cat illustration',width:900,height:1600},true).safetyStatus") === "review",
  "孟加拉模式的动画动物应进入人工复核而非自动通过");
assert(evaluate("inspectImageMetadataSafety({title:'butterfly in garden',width:900,height:1600},true).safetyStatus") === "passed",
  "孟加拉模式应允许蝴蝶候选");
assert(evaluate("inspectImageMetadataSafety({title:'fish in aquarium',width:900,height:1600},true).safetyStatus") === "passed",
  "孟加拉模式应允许鱼类候选");
const bangladeshQuery = evaluate("buildSafeStockQuery('woman cooking dinner',true)");
assert(bangladeshQuery.includes("no people") && !bangladeshQuery.includes("side profile"),
  "孟加拉模式人物词没有转向无人对象/场景搜索");
assert(evaluate("normalizeLanguageCode('孟加拉语')") === "bn", "孟加拉语代码未识别");
assert(evaluate("detectSourceLanguage('কীভাবে বাগানে ফুল ফলাবেন').code") === "bn", "孟加拉文字未识别");
assert(evaluate("detectSourceLanguage('این یک راه خوب برای زندگی است').code") === "fa", "波斯语文本未识别");
assert(evaluate("normalizePexelsImage({id:7,src:{original:'https://img/original.jpg',medium:'https://img/medium.jpg'},width:1080,height:1920}).imageUrl")
  === "https://img/original.jpg", "Pexels 未优先 original");

const filename = evaluate("buildFinalImageName({index:3,title:'A/B:C',summary:'D?E'}, {aspectLabel:'9:16',mime:'image/jpeg'})");
assert(filename.startsWith("03-A-B-C【D-E】_9x16"), "成品图命名或非法字符清理错误");
assert(!/[\\/:*?\"<>|]/.test(filename), "成品图文件名仍含 Windows 非法字符");
context.avifBuffer = new Uint8Array([1, 2, 3, 4]).buffer;
const converted = await evaluate("normalizeDownloadedImage(avifBuffer, 'image/avif')");
assert(converted.mime === "image/jpeg" && converted.converted === true, "AVIF 未实际转成 JPEG");
assert(new Uint8Array(converted.buffer)[0] === 0xff, "JPEG 转换结果内容无效");
const preservedPng = await evaluate("normalizeDownloadedImage(avifBuffer, 'image/png')");
assert(preservedPng.mime === "image/png" && preservedPng.converted === false, "PNG 不应重新压缩");
assert(evaluate("fileNameForMime('photo.avif', 'image/jpeg')") === "photo.jpg", "转换后文件扩展名未同步为 JPG");
assert(evaluate("fileNameForMime('photo.webp', 'image/jpeg')") === "photo.jpg", "WebP 转换后扩展名未同步为 JPG");
context.fetch = async () => new Response(new Uint8Array([1, 2, 3, 4]), { headers: { "content-type": "image/avif" } });
const fetchedAvif = await evaluate("fetchImageFile({url:'https://image.test/photo.avif',item:{index:1,title:'Cat',summary:'Rest'}})");
assert(fetchedAvif.mime === "image/jpeg" && fetchedAvif.sourceMime === "image/avif", "完整下载流程未将 AVIF 转换为 JPEG");
assert(fetchedAvif.fileName.endsWith(".jpg") && fetchedAvif.dataUrl.startsWith("data:image/jpeg;base64,"), "下载文件名或数据类型仍为 AVIF");

const valid = evaluate(`validateAiResult(
  {title:'Ideas clave',summary:'Resumen breve y fiel',image_query_en:'historic city street evening',language:'es'},
  {titleLimit:12,summaryLimit:50,originalTitle:'Ideas para la ciudad',expectedLanguage:'es'}
)`);
assert(valid.language === "es", "西班牙语结果校验失败");
let overLimitRejected = false;
try {
  evaluate(`validateAiResult(
    {title:'This title contains far more than twelve written words and must be rejected now',summary:'Short summary',image_query_en:'green forest trail morning',language:'en'},
    {titleLimit:12,summaryLimit:50,originalTitle:'A useful title',expectedLanguage:'en'}
  )`);
} catch {
  overLimitRejected = true;
}
assert(overLimitRejected, "超长标题没有被拒绝");

const strictPrompt = evaluate(`buildAiMessages({
  originalTitle:'How to grow peonies at home', originalSummary:'A practical guide to planting and caring for peonies.',
  sourceText:'Peonies need a sunny bed, rich soil and careful watering during early growth.', summarySource:'article_body', expectedLanguage:'en', titleLimit:12, summaryLimit:50
}, 'AI title was 27 characters, exceeding the 12 character limit')[0].content`);
assert(strictPrompt.includes("MANDATORY FINAL CHECK"), "提示词缺少强制字符复核");
assert(strictPrompt.includes("version 0.13 fallback order") && strictPrompt.includes("article body first, then original description, then original title"),
  "简介请求没有恢复 0.13 兜底顺序");
assert(strictPrompt.includes("After writing the summary, derive one natural title using ONLY that newly written summary"), "标题没有限定为根据刚生成的简介浓缩");
assert(strictPrompt.includes('{"summary":"...","title":"...","image_query_en"'),
  "单次主 AI 响应必须按简介、标题顺序返回文案");
assert(!strictPrompt.includes("preserve it unchanged"), "提示词仍可能直接保留原标题");
assert(strictPrompt.includes("at most 50 words"), "提示词缺少简介词数限制");
assert(strictPrompt.includes("PREVIOUS ATTEMPT FAILED"), "重试提示词没有携带上次失败原因");
assert(strictPrompt.includes("image_query_en"), "提示词丢失英文搜图词要求");
assert(strictPrompt.includes("EXCLUSIVELY from the ORIGINAL TITLE") && strictPrompt.includes("Ignore the original description"),
  "批量自动搜图提示词没有严格限定原标题来源");
const strictUser = evaluate(`buildAiMessages({
  originalTitle:'Original title',originalSummary:'Original summary',sourceText:'Article body',summarySource:'article_body',
  expectedLanguage:'en',titleLimit:12,summaryLimit:50
})[1].content`);
assert(strictUser.includes('原始标题：Original title') && strictUser.includes('原始简介：Original summary') && strictUser.includes('原始文章正文：Article body'),
  "简介请求没有按 0.13 方法同时携带原标题、原简介和正文");
const titleOnlyMessages = evaluate(`buildTitleFromSummaryMessages('Keep cats comfortable at home',{
  expectedLanguage:'en',titleLimit:12
})`);
assert(titleOnlyMessages[1].content.includes('Keep cats comfortable at home'), "标题请求未收到已生成简介");
assert(!JSON.stringify(titleOnlyMessages).includes('How to grow peonies'), "标题请求混入原标题");
assert(titleOnlyMessages[0].content.includes('Condense ONLY the supplied summary'), "标题请求未严格限定简介来源");
assert(titleOnlyMessages[0].content.includes('at most 12 words'), "标题请求缺少标题词数限制");
const imageQueryMessages = evaluate("buildImageQueryMessages('Почему кошки любят коробки?')");
assert(imageQueryMessages[1].content.includes("Почему кошки любят коробки?"), "独立搜图请求未传入原标题");
assert(!imageQueryMessages[1].content.includes("summary") && !imageQueryMessages[1].content.includes("description"),
  "独立搜图请求混入简介或其他内容");
assert(imageQueryMessages[0].content.includes("previously saved query"), "手动换图未明确排除旧关键词");
assert(evaluate("buildImageQueryMessages('বাড়ির সাজসজ্জা',true)[0].content").includes("BANGLADESH MODE"),
  "孟加拉搜图提示词未加入专用约束");
assert(evaluate("buildAiMessages({originalTitle:'খাবারের ধারণা',originalSummary:'',titleLimit:12,summaryLimit:50,expectedLanguage:'bn',bangladeshMode:true})[0].content").includes("BANGLADESH MODE"),
  "孟加拉文案提示词未加入专用约束");

chrome.storage.sync.get = async () => ({settings:{aiEndpoint:"https://api.test/chat/completions",aiModel:"translation-model",rewriteMode:"ai",thinkingLevel:"medium",aiTimeoutMs:30000}});
chrome.storage.local.get = async () => ({localSecrets:{aiApiKey:"translation-key"}});
let translationRequest;
context.fetch = async (_url, options) => {
  translationRequest = JSON.parse(options.body);
  return new Response(JSON.stringify({model:"translation-model",choices:[{finish_reason:"stop",message:{content:'{"translation":"宠物牙齿护理"}'}}]}), {headers:{"content-type":"application/json"}});
};
const translationStatus = await evaluate("getAiTranslationStatus()");
assert(translationStatus.configured === true, "完整主 AI 配置未启用手动标题翻译");
const translated = await evaluate("translateTextWithAi({text:'Pet dental care'})");
assert(translated.titleZh === "宠物牙齿护理", "标题 AI 翻译结果解析失败");
assert(translationRequest.messages.at(-1).content === "Pet dental care", "标题翻译请求没有原样传入标题");
assert(!JSON.stringify(translationRequest).includes("summary"), "标题翻译请求不应携带简介");

console.log("后台逻辑测试通过");
