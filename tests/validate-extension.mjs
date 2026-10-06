import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");
const manifest = JSON.parse(read("manifest.json"));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(manifest.manifest_version === 3, "必须使用 Manifest V3");
assert(manifest.version === "0.12.1", "构建版本应为 0.12.1");
assert(manifest.permissions.includes("downloads"), "缺少下载权限");
assert(manifest.permissions.includes("storage"), "缺少存储权限");
assert(
  manifest.content_scripts?.every((script) =>
    script.matches?.every((match) => match === "https://lockscreen-admin.mofeeds.com/*"),
  ),
  "内容脚本只能注入目标后台域名",
);

const optionsHtml = read("options.html");
for (const id of [
  "aiEndpoint",
  "aiModel",
  "aiApiKey",
  "reviewAiEnabled",
  "reviewAiEndpoint",
  "reviewAiModel",
  "reviewAiApiKey",
  "pexelsEndpoint",
  "pexelsApiKey",
  "pixabayEndpoint",
  "pixabayApiKey",
  "titleLimit",
  "summaryLimit",
  "batchLimit",
  "batchConcurrency",
  "preferredRatio",
  "originalFolder",
  "imageFolder",
]) {
  assert(optionsHtml.includes(`id="${id}"`), `设置页缺少 #${id}`);
}

const background = read("background.js");
assert(background.includes('Accept: "image/jpeg,image/png') && background.includes("normalizeDownloadedImage"),
  "图片下载未优先 JPEG 或缺少 AVIF/WebP 转换");
assert(background.includes('canvas.convertToBlob({ type: "image/jpeg", quality: 0.94 })') && background.includes("fileNameForMime"),
  "图片未实际转码为 JPEG 或扩展名未同步");
for (const message of [
  "AI_PROCESS_ITEM",
  "FETCH_ARTICLE",
  "SEARCH_PEXELS_BATCH",
  "FETCH_IMAGE_FILE",
  "SAVE_TEXT_FILE",
  "DOWNLOAD_FINAL_IMAGE",
]) {
  assert(background.includes(message), `后台缺少消息 ${message}`);
}
assert(/orientation[^\n]+portrait/i.test(background), "Pexels 未固定 portrait");
assert(/orientation[^\n]+vertical/i.test(background), "Pixabay 未固定 vertical");

const content = read("content.js");
for (const message of ["GET_SITE_ROUTE", "SCAN_LIST_ITEMS", "APPLY_BATCH_RECORD"]) {
  assert(content.includes(message), `页面适配器缺少消息 ${message}`);
}
const bindSteps = content.match(/const BIND_STEPS = \[([\s\S]*?)\n  \];/)?.[1] || "";
assert(bindSteps && !bindSteps.includes("imageUploadSelector"), "字段绑定不应再要求图片上传控件");
assert(content.includes('"未投递"') && content.includes("isCardMetaText"), "标题扫描未排除卡片投递状态");

const assistant = read("assistant.js");
assert(assistant.includes("batchState"), "批任务未持久化");
assert(assistant.includes("APPLY_BATCH_RECORD"), "编辑页未接入批次文案填充");
assert(assistant.includes("填入标题和简介") && !assistant.includes("填入文案并上传图片"),
  "编辑页按钮应只填写标题和简介");
assert(background.includes("finalImageFolderCounters") && background.includes("Math.ceil(nextNumber / size)") && background.includes("LSAWorkflow.batchSize(batchLimit)"),
  "成品图未实现 30 / 40 张切换分组目录");
assert(assistant.includes("lsa-record-option-status") && assistant.includes("selectAndNavigateRecord"),
  "记录列表未实现编号-状态显示或点击跳转");
assert(assistant.includes("mountRevision") && assistant.includes("removeAllAssistantNodes"),
  "路由切换未实现挂载竞态保护或残留窗口清理");
assert(assistant.includes('lsa-record-fold lsa-inner-fold') && assistant.includes('lsa-folder-summary'),
  "批次记录或当前文件夹未改成折叠区域");
assert(assistant.includes("Math.min(4, candidates.length)"), "批量图片下载未提升到最多 4 路并发");
assert(assistant.includes('item.image?.safetyStatus === "passed"') && assistant.includes("当前没有自动通过的图片"),
  "自动通过图按钮仍错误依赖整条记录状态，或缺少可见反馈");
assert(background.includes("reviewAiCandidate") && background.includes('reasoning_effort = "medium"'),
  "第二 AI 审核或中等推理未接入");
assert(background.includes("reviewWarning") && background.includes("disableThinking(requestBody"),
  "审核 AI 未实现快速模式或安全回退");
assert(background.includes("outputTokenBudget = 8192") && background.includes("isReasoningTruncated"),
  "思考截断未实现输出预算扩容重试");

for (const file of ["workflow.js", "page-bridge.js", "background.js", "content.js", "assistant.js", "options.js"]) {
  execFileSync(process.execPath, ["--check", path.join(root, file)], { stdio: "inherit" });
}

console.log("锁屏编辑助手 0.12.1 静态验证通过");
