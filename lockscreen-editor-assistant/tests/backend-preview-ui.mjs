import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(path.join(process.env.LSA_NODE_MODULES || "C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules", "package.json"));
const { chromium } = require("playwright");
const browser = await chromium.launch({ channel: "chrome", headless: true });
const downloads = [], requests = [], messages = [], reports = [];
let failOnce = true;
let gateResolve;
const gate = new Promise((resolve) => { gateResolve = resolve; });

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.exposeBinding("previewTestMessage", async ({ page }, message) => {
    messages.push(message);
    const tabId = Number(new URL(page.url()).searchParams.get("tab"));
    if (message.action === "GET_TAB_CONTEXT") return { ok: true, tabId, keys: { batchState: `batch:${tabId}`, settings: `settings:${tabId}`, imageHistory: `images:${tabId}`, assistantState: `window:${tabId}`, workLease: `work:${tabId}` } };
    if (message.action === "GET_DUPLICATE_LIBRARY") return { ok: true, entries: {}, usage: {} };
    if (message.action === "RECONCILE_IMAGE_DOWNLOADS") return { ok: true, history: {} };
    if (message.action === "WORK_LOCK") return { ok: true, active: false };
    if (message.action === "DOWNLOAD_BACKEND_PREVIEW") {
      if (message.record.id === "ls_retry" && failOnce) { failOnce = false; return { ok: false, error: "测试图片暂时无法下载" }; }
      downloads.push({ tabId, ...message });
      return { ok: true, status: "completed", path: `${message.folder}/${message.batchFolder}/后台预览图/第01组/${message.record.index}-${message.record.id}.jpg`, fileName: `${message.record.id}.jpg`, mime: "image/jpeg", size: 100 };
    }
    if (message.action === "SAVE_TEXT_FILE") { reports.push(JSON.parse(message.text)); return { ok: true }; }
    throw new Error(`测试中出现非预期请求：${message.action}`);
  });

  async function createPage(tab, ids, gated = false) {
    const page = await context.newPage();
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/OverseasLockScreen/get") {
        const id = url.searchParams.get("id");
        requests.push({ tab, id, method: route.request().method() });
        if (gated) await gate;
        const detail = { id, title: `Live title ${id}`, originImage: { url: "https://img.test/left.jpg" },
          content: '<p>Article body</p><img src="https://img.test/body.jpg">',
          originImageWebp: { url: "https://images.pexels.com/photos/42/pexels-photo-42.jpeg?w=2400&auto=compress" } };
        if (id === "ls_missing") detail.originImageWebp = null;
        if (id === "ls_mismatch") detail.id = "ls_other";
        await route.fulfill({ contentType: "application/json", body: JSON.stringify({ code: 0, data: detail }) });
        return;
      }
      const cards = ids.map((id) => `<div class="screen-item"><h3>Original ${id}</h3><div>请添加图片</div><a href="https://article.test/?id=${id}">查看链接</a><a href="#/nav/overseasDeliver?index=5&type=editEMPTY&id=${id}">编辑</a></div>`).join("");
      await route.fulfill({ contentType: "text/html", body: `<!doctype html><meta charset="utf-8"><style>.screen-item{display:inline-block;width:220px;height:200px;vertical-align:top}</style><label>语言：<input value="英语"></label><label>国家：<input value="美国"></label>${cards}` });
    });
    await page.goto(`https://lockscreen-admin.mofeeds.com/?tab=${tab}#/nav/overseasContent?index=5`);
    await page.evaluate(() => {
      const values = {};
      const storage = { get: async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, values[key]])), set: async (patch) => Object.assign(values, patch) };
      window.chrome = { runtime: { onMessage: { addListener: () => {} }, sendMessage: (message) => window.previewTestMessage(message) },
        storage: { local: storage, sync: { get: async () => ({ settings: { autoSearch: false, batchLimit: 40 } }) }, onChanged: { addListener: () => {} } } };
    });
    await page.addStyleTag({ path: path.join(root, "assistant.css") });
    for (const name of ["workflow.js", "backend-preview.js", "content.js", "assistant-engine.js", "assistant-ui.js", "assistant.js"]) await page.addScriptTag({ path: path.join(root, name) });
    await page.locator(".lsa-read-backend-previews").waitFor();
    return page;
  }

  const a = await createPage(1, ["ls_a", "ls_missing", "ls_b", "ls_mismatch", "ls_retry"]);
  const b = await createPage(2, ["ls_second_tab"]);
  await a.locator(".lsa-read-backend-previews").click();
  await a.waitForFunction(() => document.querySelector(".lsa-backend-preview-status").textContent.includes("读取完成"));
  assert.equal(downloads.length, 0, "读取步骤不得直接下载图片");
  assert.equal(await a.locator(".lsa-download-backend-previews").textContent(), "下载已读取图（3）");
  await a.locator(".lsa-backend-preview-label").click();
  assert.ok((await a.locator(".lsa-backend-preview-list").textContent()).includes("右侧无图"));
  assert.ok((await a.locator(".lsa-backend-preview-list").textContent()).includes("详情 ID"));
  assert.equal(await a.locator(".lsa-backend-preview-row a").count(), 3);
  assert.equal(await b.locator(".lsa-backend-preview-row").count(), 0, "其他标签页不应出现本页图片结果");
  assert.ok((await a.locator(".lsa-backend-preview-folder").textContent()).includes("英语_美国_"));
  await a.locator(".lsa-download-backend-previews").click();
  await a.waitForFunction(() => document.querySelector(".lsa-backend-preview-status").textContent.includes("下载结束"));
  assert.equal(downloads.length, 2, "同一图片应为两个条目分别保存");
  assert.deepEqual(downloads.map((row) => row.record.id).sort(), ["ls_a", "ls_b"]);
  assert.equal(downloads[0].image.sourceField, "originImageWebp");
  assert.equal(downloads[0].batchLimit, 40);
  assert.ok(downloads.every((row) => row.record.title.startsWith("Live title")), "文件名应采用最新详情中的标题");
  await a.locator(".lsa-download-backend-previews").click();
  await a.waitForFunction(() => document.querySelector(".lsa-backend-preview-status").textContent.includes("已保存 1"));
  assert.equal(downloads.length, 3, "重试只下载上次失败的条目");
  assert.equal(reports.at(-1).items.filter((row) => row.status === "completed").length, 3);
  assert.ok(requests.every((request) => request.method === "GET"));
  assert.ok(!messages.some((message) => /AI_PROCESS|SEARCH|GENERATE/.test(message.action)), "右侧图下载不应调用 AI 或图库搜索");
  fs.mkdirSync(path.join(root, "tests/artifacts"), { recursive: true });
  await a.locator(".lsa-backend-preview-section").screenshot({ path: path.join(root, "tests/artifacts/backend-preview-0.14.3.png") });

  const c = await createPage(3, Array.from({ length: 8 }, (_, i) => `ls_pause_${i}`), true);
  await c.locator(".lsa-read-backend-previews").click();
  for (let i = 0; i < 100 && requests.filter((request) => request.tab === 3).length < 4; i++) await new Promise((resolve) => setTimeout(resolve, 20));
  await c.locator(".lsa-stop-backend-previews").click();
  gateResolve();
  await c.waitForFunction(() => document.querySelector(".lsa-backend-preview-status").textContent.includes("读取已停止"));
  assert.equal(requests.filter((request) => request.tab === 3).length, 4, "停止后不得继续启动剩余详情请求");
  assert.equal(await c.locator(".lsa-backend-preview-progress").evaluate((node) => node.value), 4);
  assert.equal(await c.locator(".lsa-backend-preview-progress").evaluate((node) => node.max), 8);
  await context.close();
  console.log("后台预览图浏览器测试通过：真实页面适配器、缺图与 ID 错配、下载重试、进度、停止、多标签隔离、无 AI 调用");
} finally {
  gateResolve();
  await browser.close();
}
