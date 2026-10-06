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
assert(/^\d+\.\d+\.\d+$/.test(manifest.version), "manifest 版本号格式无效");
assert(manifest.background?.service_worker === "background-entry.js" && manifest.background?.type === "module",
  "后台应使用模块化 service worker 入口");
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
  "aiFallbackModel",
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
  "usageThreshold",
  "usageWindowDays",
  "batchLimit",
  "batchConcurrency",
  "preferredRatio",
  "originalFolder",
  "imageFolder",
]) {
  assert(optionsHtml.includes(`id="${id}"`), `设置页缺少 #${id}`);
}

const backgroundFiles = ["background.js", "background-ai.js", "background-stock.js", "background-downloads.js", "background-locks.js"];
const background = backgroundFiles.map(read).join("\n");
const workflow = read("workflow.js");
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
  "GET_DUPLICATE_LIBRARY",
  "EXPORT_DUPLICATE_LIBRARY",
  "IMPORT_DUPLICATE_LIBRARY",
  "REBUILD_IMAGE_USAGE",
  "RECONCILE_IMAGE_DOWNLOADS",
  "DETECT_SOURCE_LANGUAGE",
  "GET_AI_TRANSLATION_STATUS",
  "TRANSLATE_TEXT",
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
assert(assistant.includes('q(".lsa-stock-query").value = item.originalTitle') && assistant.includes('sendRuntime("GENERATE_IMAGE_QUERY", { title: source'),
  "手动换图没有强制从原标题重新生成关键词");
assert(background.includes("EXCLUSIVELY from the ORIGINAL TITLE") && background.includes("buildImageQueryMessages(payload.title"),
  "自动或独立图片搜索未限定为原标题来源");
assert(assistant.includes("priorQuerySource !== cleanText(item.originalTitle)") && assistant.includes("reusedExistingCopy"),
  "自动处理仍可能复用旧版或其他来源的图片关键词");
assert(background.includes("version 0.13 fallback order")
  && background.includes("generateTitleFromSummary(result.summary")
  && background.includes("Condense ONLY the supplied summary")
  && background.includes('summarySource = explicitSummarySource || (articleText ? "article_body" : originalSummary ? "original_summary" : "original_title")')
  && background.includes('titleSource: "generated_summary"'),
  "AI 文案未强制执行正文→简介→标题来源链");
assert(assistant.includes('["article_body", "original_summary", "original_title"].includes(item.summarySource)')
  && assistant.includes("item.titleSource === \"generated_summary\"")
  && assistant.includes("const sourceText = articleText || item.originalSummary || item.originalTitle")
  && assistant.includes("refreshedBodyCount")
  && assistant.includes("copyrightOnly"),
  "旧文案来源标记或正文→原简介→原标题兜底链未实现");
assert(workflow.includes('const title = localShorten(summary') && workflow.includes('articleText ? "article_body" : originalSummary ? "original_summary" : "original_title"'),
  "本地模式未执行正文→简介→标题来源链");
assert(content.includes("page.originalTitle || page.boundTitle") && !content.includes("nearbyImageText"),
  "旧式手动替换面板仍可能使用图片说明或页面标题搜索");
assert(background.includes("reviewAiCandidate") && background.includes('reasoning_effort = "medium"'),
  "第二 AI 审核或中等推理未接入");
assert(background.includes("reviewWarning") && background.includes("disableThinking(requestBody"),
  "审核 AI 未实现快速模式或安全回退");
assert(background.includes("const budgets = [4096, 8192, 16384]") && background.includes("isReasoningTruncated"),
  "思考截断未实现输出预算扩容重试");
assert(background.includes("fetchAiJson") && background.includes("buildAiDiagnostic") && background.includes('headers.get("retry-after")'),
  "AI 错误诊断或分级退避未实现");
assert(background.includes("aiFallbackModel") && assistant.includes("lsa-retry-type"),
  "备用模型或按错误类型重试界面未实现");
assert(assistant.includes("请输入英文，或清空恢复按原标题搜索")
  && assistant.includes("liveInput === targetOriginal")
  && (assistant.match(/class=\"lsa-primary-button lsa-search-images\"/g) || []).length === 1,
  "单按钮自适应搜图或人工词不留痕未实现");
assert(assistant.includes("globalThis.Translator?.availability")
  && assistant.includes("离线翻译不可用")
  && assistant.includes("lsa-ai-translate-title")
  && background.includes("translateTextWithAi")
  && workflow.includes("titleZh"),
  "编辑页离线/手动 AI 标题翻译或缓存未实现");
assert(assistant.includes("lsa-bangladesh-toggle")
  && assistant.includes("孟加拉模式：宗教与内容禁忌风险高")
  && assistant.includes("isBangladeshEligible")
  && background.includes("BANGLADESH MODE")
  && background.includes("孟加拉模式：元数据含人物")
  && workflow.includes('["bn", /bengali'),
  "孟加拉模式双条件、提示词、初筛、警告或语言识别未完整实现");

for (const file of ["workflow.js", "page-bridge.js", "background-entry.js", ...backgroundFiles, "content.js", "assistant-engine.js", "assistant-ui.js", "assistant.js", "options.js"]) {
  execFileSync(process.execPath, ["--check", path.join(root, file)], { stdio: "inherit" });
}

console.log(`锁屏编辑助手 ${manifest.version} 静态验证通过`);
