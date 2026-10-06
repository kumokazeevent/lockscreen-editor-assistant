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

console.log("后台逻辑测试通过");
