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
assert(manifest.version === "0.7.1", "构建版本应为 0.7.1");
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
  "pexelsApiKey",
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
assert(content.includes("DataTransfer"), "真实上传流程缺少 DataTransfer");
assert(content.includes("input[type=\"file\"]") || content.includes("input[type='file']"), "未查找真实文件上传控件");

const assistant = read("assistant.js");
assert(assistant.includes("batchState"), "批任务未持久化");
assert(assistant.includes("APPLY_BATCH_RECORD"), "编辑页未接入批次填充/上传");

for (const file of ["page-bridge.js", "background.js", "content.js", "assistant.js", "options.js"]) {
  execFileSync(process.execPath, ["--check", path.join(root, file)], { stdio: "inherit" });
}

console.log("锁屏编辑助手 0.7.1 静态验证通过");
