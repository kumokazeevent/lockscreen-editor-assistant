import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
const root = new URL("../", import.meta.url);
const local = {}, sync = { settings: { rewriteMode: "local", titleLimit: 12, summaryLimit: 50 } };
const noop = () => {};
const getStore = (store) => ({ get: async (key) => Object.fromEntries((Array.isArray(key) ? key : [key]).map((name) => [name, structuredClone(store[name])])),
  set: async (patch) => Object.assign(store, structuredClone(patch)) });
const downloads = [];
let fetches = 0, onDownloadChanged;
const chrome = {
  runtime: { onInstalled: { addListener: noop }, onMessage: { addListener: noop } },
  action: { onClicked: { addListener: noop } },
  contextMenus: { onClicked: { addListener: noop } },
  storage: { local: getStore(local), sync: getStore(sync) },
  tabs: { query: async () => [{id:1,index:0,url:'https://lockscreen-admin.mofeeds.com/#/nav/overseasContent?index=5'}, {id:2,index:1,url:'https://lockscreen-admin.mofeeds.com/#/nav/overseasDeliver?index=5&type=editEMPTY&id=2'}],
    sendMessage: async (id) => ({ok:true,items:[{id:String(id)}],pageLabel:`page${id}`}) },
  downloads: { download: async (data) => { downloads.push(data); return downloads.length; }, onChanged: { addListener: (fn) => { onDownloadChanged = fn; } } },
};
const context = vm.createContext({chrome, console, URL, URLSearchParams, TextEncoder, Uint8Array, ArrayBuffer, AbortController,
  setTimeout, clearTimeout, crypto: webcrypto, btoa, atob, importScripts: noop,
  fetch: async (url) => { fetches += 1; return new Response(`image-bytes:${String(url).includes('alias') ? 'same' : new URL(url).pathname}`, {headers:{'content-type':'image/jpeg'}}); },
});
for (const name of ["workflow.js", "background.js"]) vm.runInContext(fs.readFileSync(new URL(name, root), "utf8"), context, {filename:name});
const run = (code) => vm.runInContext(code, context);
assert.equal(run('LSAWorkflow.count("á")'), 1);
assert.equal(run('LSAWorkflow.count("🐱 A!")'), 4);
for (const source of ['Care for cats at home', 'Как ухаживать за котом', 'Cómo cuidar las flores', 'Cách chăm sóc mèo', 'العناية بالقطط']) {
  context.sourceText = source;
  const shortened = run('LSAWorkflow.localShorten(sourceText, 12)');
  assert.ok(run(`LSAWorkflow.count(${JSON.stringify(shortened)})`) <= 12);
  assert.ok(!/[\u3400-\u9fff]/.test(shortened));
}
await run('generateBatchItemWithAi({item:{originalTitle:"Care for cats",originalSummary:"Keep cats comfortable in a warm quiet home"}})');
await run('generateImageQueryWithAi({title:"cat"})');
assert.equal(fetches, 0, '本地模式必须完全跳过 AI 网络');
for (const level of ['off','low','medium','high','max','provider']) {
  const body = run(`configureThinking({}, 'deepseek-v4-flash','https://api.deepseek.com/chat/completions', '${level}')`);
  assert.equal(body.thinking?.type, level === 'provider' ? undefined : level === 'off' ? 'disabled' : 'enabled');
  assert.equal(body.reasoning_effort, ['off','provider'].includes(level) ? undefined : level);
}
assert.ok(run(`buildAiMessages({originalTitle:'Cat care',originalSummary:'Care for cats',titleLimit:18,summaryLimit:60,rewritePrompt:'Use a calm tone within {titleLimit} and {summaryLimit} characters.'})[0].content`).includes('Use a calm tone within 18 and 60 characters.'));
const exported = {version:3,batchId:'test',items:[{id:'1',pageKey:'a',pageLabel:'第1页',originalTitle:'Cat care', title:'Cat care',summary:'Gentle care for cats',imageQueryEn:'cat at home',image:{id:'1',source:'pexels',imageUrl:'https://images.pexels.com/photos/1/a.jpg',width:900,height:1600,safetyStatus:'passed'}}]};
context.exported = exported;
const batch = run('LSAWorkflow.importBatch(exported, {titleLimit:12,summaryLimit:50})');
assert.equal(batch.items[0].status, 'completed');
assert.equal(batch.items[0].pageKey, 'a');
assert.equal(batch.items[0].downloadStatus, '');
exported.items[0].title = 'A title exceeding the current limit';
assert.equal(run('LSAWorkflow.importBatch(exported, {titleLimit:12,summaryLimit:50}).items[0].status'), 'error');
exported.items[0].editUrl = 'javascript:alert(1)';
assert.ok(run('LSAWorkflow.importBatch(exported).items[0].editUrl').startsWith('https://lockscreen-admin.mofeeds.com/'));
assert.throws(() => run('LSAWorkflow.importBatch({items:[{title:"Original only"}]})'));
await run('workLock("acquire", "one", 1)');
await assert.rejects(run('workLock("acquire", "two", 2)'));
await run('workLock("release", "one", 1)');
await run('workLock("acquire", "two", 2)');
await run('workLock("release", "two", 2)');
assert.equal((await run('scanOpenPages({pageCount:2}, {tab:{id:1}})')).pages.length,2);
for (let i = 1; i <= 31; i++) {
  const result = await run(`downloadFinalImage({image:{id:'${i}',source:'pexels',imageUrl:'https://images.pexels.com/photos/${i}/image.jpg'},item:{index:${i},title:'Cat',summary:'Resting'}})`);
  assert.equal(result.sequenceNumber, i);
  assert.ok(result.folder.includes(i <= 30 ? '第001组' : '第002组'));
}
assert.equal((await run("downloadFinalImage({image:{id:'1',source:'pexels',imageUrl:'https://images.pexels.com/photos/1/other-size.jpg'}})")).skipped,true);
const pair = await Promise.all([run("downloadFinalImage({image:{id:'a',source:'pixabay',imageUrl:'https://image.test/alias-a.jpg'}})"), run("downloadFinalImage({image:{id:'b',source:'pixabay',imageUrl:'https://image.test/alias-b.jpg'}})")]);
assert.equal(pair.filter((item) => item.skipped).length,1,'并发同内容只允许一个下载');
await run("markDuplicate({image:{id:'55',source:'pexels'},marked:true})");
assert.equal((await run("downloadFinalImage({image:{id:'55',source:'pexels',imageUrl:'https://image.test/new.jpg'}})")).skipped,true);
const pendingId = local.imageHistory['pexels:1'].downloadId;
onDownloadChanged({id:pendingId,state:{current:'interrupted'}});
await run('imageHistoryChain');
assert.equal(local.imageHistory['pexels:1'].status,'interrupted');
assert.equal((await run("downloadFinalImage({image:{id:'1',source:'pexels',imageUrl:'https://images.pexels.com/photos/1/image.jpg'}})")).skipped,undefined);
console.log('0.9.0 工作流测试通过：多语言本地候选、纯本地模式、思考档位、JSON恢复、工作占用、多标签读取、分组及并发内容去重');
