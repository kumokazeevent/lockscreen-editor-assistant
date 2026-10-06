import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(path.join(process.env.LSA_NODE_MODULES || 'C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules','package.json'));
const { chromium } = require('playwright');
const browser = await chromium.launch({channel:'chrome',headless:true});
const store = {local:{localSecrets:{aiApiKey:'test-key',pexelsApiKey:'test-key'}},sync:{settings:{aiEndpoint:'https://api.test/chat/completions',aiModel:'exact-test-model',titleLimit:12,summaryLimit:50,rewriteMode:'ai',autoSearch:false}}};
const pages = new Map(), messages = [], savedExports = [], savedPaths = [];
let handler, startup, activeAi = 0, peakAi = 0;
const gates = new Map();
const noop = () => {};
const event = () => ({addListener:noop});
const storageArea = (area) => ({
  get:async(keys) => structuredClone(keys===null ? store[area] : Object.fromEntries((Array.isArray(keys)?keys:[keys]).map((key)=>[key,store[area][key]]))),
  set:async(patch) => {
    const changes={};
    for(const [key,value] of Object.entries(patch)) {changes[key]={oldValue:store[area][key],newValue:structuredClone(value)};store[area][key]=structuredClone(value);}
    await Promise.all([...pages.keys()].map((page)=>page.evaluate(({changes,area})=>window.storageListeners?.forEach((fn)=>fn(changes,area)),{changes,area}).catch(()=>{})));
  },
});
const chrome={
  storage:{local:storageArea('local'),sync:storageArea('sync')},
  runtime:{onMessage:{addListener:(fn)=>handler=fn},onInstalled:event(),onStartup:{addListener:(fn)=>startup=fn}},
  action:{onClicked:event()},contextMenus:{onClicked:event()},
  downloads:{onChanged:event(),download:async(data)=>{savedPaths.push(data.filename);if(data.url.startsWith('data:application/json'))savedExports.push(JSON.parse(Buffer.from(data.url.split(',')[1],'base64').toString()));return savedPaths.length;}},
};
const sandbox=vm.createContext({chrome,console,crypto:webcrypto,URL,URLSearchParams,TextEncoder,Uint8Array,ArrayBuffer,AbortController,setTimeout,clearTimeout,btoa,atob,importScripts:noop,
  fetch:async(url,options={})=>{
    if(String(url).includes('api.test')) {
      const body=JSON.parse(options.body), tag=body.messages.at(-1).content.includes('Room A')?'A':'B';
      activeAi++;peakAi=Math.max(peakAi,activeAi);
      if(gates.has(tag))await gates.get(tag).promise;
      activeAi--;
      return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({title:'A calm guide to caring for cats at home',summary:'Keep cats comfortable and give them a quiet place to rest.',image_query_en:'cat sleeping at home room '+tag,language:'en'})},finish_reason:'stop'}]}),{headers:{'content-type':'application/json'}});
    }
    if(String(url).includes('api.pexels.com'))return new Response(JSON.stringify({page:1,total_results:1,photos:[{id:501,width:900,height:1600,alt:'Cat resting at home',src:{original:'https://image.test/cat.jpg',medium:'https://image.test/cat.jpg'}}]}),{headers:{'content-type':'application/json'}});
    return new Response('image bytes',{headers:{'content-type':'image/jpeg'}});
  },
});
for(const file of ['workflow.js','background.js'])vm.runInContext(fs.readFileSync(path.join(root,file),'utf8'),sandbox);
const run=(text)=>vm.runInContext(text,sandbox);
const keys=async(id)=>(await run(`getTabContext(${id})`)).keys;
const gate=(tag)=>{let release;const promise=new Promise((resolve)=>release=resolve);gates.set(tag,{promise,release});};
gate('A');gate('B');
try {
  const context=await browser.newContext({viewport:{width:1366,height:940}});
  await context.route('**/*',(route)=>route.fulfill({contentType:'text/html; charset=utf-8',body:'<!doctype html><meta charset="utf-8"><h1>模拟锁屏后台</h1><main id="fixture"></main>'}));
  await context.exposeBinding('lsaTestRpc',async({page},data)=>{
    if(data.kind==='get')return chrome.storage[data.area].get(data.keys);
    if(data.kind==='set')return chrome.storage[data.area].set(data.patch);
    const tabId=pages.get(page);messages.push({tabId,...data.message});
    return new Promise((resolve)=>{if(!handler(data.message,{tab:{id:tabId}},resolve))resolve({ok:false,error:'Unexpected message'});});
  });
  const inject=async(page,id)=>{
    await page.evaluate(({id})=>{
      window.storageListeners=[];
      const area=(name)=>({get:(keys)=>window.lsaTestRpc({kind:'get',area:name,keys}),set:(patch)=>window.lsaTestRpc({kind:'set',area:name,patch})});
      window.chrome={storage:{local:area('local'),sync:area('sync'),onChanged:{addListener:(fn)=>window.storageListeners.push(fn)}},runtime:{onMessage:{addListener:()=>{}},sendMessage:(message)=>window.lsaTestRpc({kind:'message',message})}};
      window.fixtureId=id;
    },{id});
    await page.addStyleTag({path:path.join(root,'assistant.css')});
    for(const file of ['workflow.js','content.js'])await page.addScriptTag({path:path.join(root,file)});
    await page.evaluate(()=>{
      window.realPageSnapshot = window.__lsaPageTools.scanPageSnapshot;
      window.__lsaPageTools.scanPageSnapshot=async()=>({ok:true,pageLabel:'当前页',sourcePage:location.href,items:[{id:String(window.fixtureId),originalTitle:'How to care for cats in Room '+(window.fixtureId===101?'A':'B'),originalSummary:'Give your cats a comfortable home',editUrl:'https://lockscreen-admin.mofeeds.com/#/nav/overseasDeliver?index=5&type=editEMPTY&id='+window.fixtureId}]});
    });
    await page.addScriptTag({path:path.join(root,'assistant.js')});
    await page.locator('.lsa-assistant').waitFor();
  };
  const create=async(id)=>{
    const page=await context.newPage();pages.set(page,id);
    await page.goto('https://lockscreen-admin.mofeeds.com/#/nav/overseasContent?index=5');
    await inject(page,id);return page;
  };
  const a=await create(101), b=await create(202);
  const ka=await keys(101),kb=await keys(202);
  assert.notEqual(ka.batchState,kb.batchState);
  await a.locator('.lsa-scan-batch').click();
  await b.locator('.lsa-scan-batch').click();
  await a.locator('.lsa-start-batch').click();
  await b.locator('.lsa-start-batch').click();
  await a.waitForFunction(()=>document.querySelector('.lsa-item-status')?.textContent==='AI 改写');
  await b.waitForFunction(()=>document.querySelector('.lsa-item-status')?.textContent==='AI 改写');
  for(let attempt=0;attempt<100&&peakAi<2;attempt++)await new Promise((resolve)=>setTimeout(resolve,20));
  assert.equal(peakAi,2,'两个标签页必须同时有AI请求在运行');
  await a.locator('.lsa-pause-batch').click();
  assert.equal(store.local[kb.batchState].status,'running');
  gates.get('A').release();gates.get('B').release();
  await a.waitForFunction(()=>document.querySelector('.lsa-batch-status').textContent.includes('已暂停'));
  await b.waitForFunction(()=>document.querySelector('.lsa-batch-status').textContent.includes('处理完成'));
  assert.equal(store.local[ka.batchState].items[0].id,'101');
  assert.equal(store.local[kb.batchState].items[0].id,'202');
  assert.equal(store.local[kb.batchState].items[0].title,'A calm guide to caring for cats at home');
  const reviewCopy=structuredClone(store.local[kb.batchState]);
  reviewCopy.items[0].status='needs_review';reviewCopy.updatedAt=Date.now()+1000;
  await chrome.storage.local.set({[kb.batchState]:reviewCopy});
  await b.waitForFunction(()=>document.querySelector('.lsa-download-all')?.textContent.includes('（1）'));
  assert.equal(await b.locator('.lsa-download-all').isEnabled(),true,'文案需复核但图片已通过时，批量下载按钮必须可用');
  const beforeDownloads=messages.filter((message)=>message.action==='DOWNLOAD_FINAL_IMAGE').length;
  await b.locator('.lsa-download-all').click();
  await b.waitForFunction(()=>document.querySelector('.lsa-batch-status').textContent.includes('下载结束'));
  assert.equal(messages.filter((message)=>message.action==='DOWNLOAD_FINAL_IMAGE').length,beforeDownloads+1,'批量下载按钮必须发送图片下载请求');
  assert.ok((await b.locator('.lsa-batch-status').textContent()).includes('1 张加入下载'));
  const bSnapshot=structuredClone(store.local[kb.batchState]);
  await a.locator('.lsa-quick-settings summary').click();
  await a.locator('[data-setting="titleLimit"]').fill('5');
  await a.locator('[data-setting="titleLimit"]').dispatchEvent('change');
  assert.equal(store.local[ka.settings].titleLimit,5);
  assert.equal(store.local[kb.settings].titleLimit,12);
  await a.locator('.lsa-quick-settings summary').click();
  await a.locator('.lsa-transfer > summary').click();
  await a.locator('.lsa-new-batch').click();
  await a.waitForFunction(()=>document.querySelector('.lsa-transfer-status').textContent.includes('旧批次已导出'));
  assert.equal(store.local[ka.batchState],null);
  assert.deepEqual(store.local[kb.batchState],bSnapshot);
  await a.locator('.lsa-import-file').setInputFiles({name:'a.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(savedExports.find((batch)=>batch.items?.some((item)=>item.id==='101') && batch.version)))});
  await a.waitForFunction(()=>document.querySelector('.lsa-transfer-status').textContent.includes('已导入'));
  assert.equal(store.local[ka.batchState].items[0].status,'error','导入按当前标签页的5词限制重检');
  assert.deepEqual(store.local[kb.batchState],bSnapshot);
  await a.locator('.lsa-minimize').click();
  assert.equal(await b.locator('.lsa-assistant.is-minimized').count(),0);
  await b.reload();await inject(b,202);
  assert.equal(await b.locator('.lsa-batch-card').count(),1,'刷新恢复当前标签页');
  const c=await create(303);
  assert.equal(await c.locator('.lsa-batch-card').count(),0,'同一个URL的新标签页不继承其他批次');
  const kc=await keys(303);
  assert.equal(await c.locator('.lsa-transfer').evaluate((node)=>node.open),false,'当前文件夹默认折叠');
  assert.equal(await c.locator('.lsa-quick-settings').evaluate((node)=>node.open),false,'当前标签页设置默认折叠');
  assert.ok(await c.locator('[data-panel="batch"] > .lsa-section-card').first().evaluate((main)=>main.compareDocumentPosition(document.querySelector('.lsa-transfer'))&Node.DOCUMENT_POSITION_FOLLOWING),'列表页文件夹设置应位于处理功能下面');
  await c.locator('.lsa-transfer > summary').click();
  await c.evaluate(()=>{
    document.querySelector('#fixture').innerHTML='<div><label>语言：<select><option>俄语</option></select></label><label>国家：<select><option>白俄罗斯</option></select></label></div><section id="cards"></section>';
    for(let i=1;i<=45;i++) {
      const article=document.createElement('article');article.style.cssText='width:260px;height:100px';
      article.innerHTML=`<h3>Care for cats at home ${i}</h3><a href="https://article.test/${i}">查看链接</a><a href="https://lockscreen-admin.mofeeds.com/#/nav/overseasDeliver?index=5&type=editEMPTY&id=${i+1000}">编辑</a>`;
      document.querySelector('#cards').append(article);
    }
    window.__lsaPageTools.scanPageSnapshot=window.realPageSnapshot;
  });
  await c.locator('[data-setting="batchLimit"]').selectOption('40');
  await c.locator('.lsa-scan-batch').click();
  await c.waitForFunction(()=>document.querySelectorAll('.lsa-batch-card').length===40);
  assert.equal(store.local[kc.batchState].items.length,40,'实际 content.js 必须突破旧30条上限');
  assert.equal(store.local[kc.batchState].metadata.language,'俄语');
  assert.equal(store.local[kc.batchState].metadata.country,'白俄罗斯');
  assert.equal(store.local[kc.batchState].batchLimit,40);
  assert.match(await c.locator('.lsa-current-folder').textContent(),/^俄语_白俄罗斯_\d{8}-/);
  const cOriginal=structuredClone(store.local[kc.batchState]);
  await c.locator('.lsa-scan-batch').click();
  await c.waitForFunction(()=>document.querySelector('.lsa-batch-status').textContent.includes('相同页面保留'));
  assert.equal(store.local[kc.batchState].batchId,cOriginal.batchId,'重读相同页面不新建或追加');
  const mixed={version:4,batchId:'import-mixed-71',createdAt:1788508800000,batchLimit:40,items:Array.from({length:71},(_,i)=>({
    ...bSnapshot.items[0],id:'import-'+i,pageKey:i<30?'page1':i<60?'page2':'page3',
    pageLabel:'列表第 '+(Math.floor(i/30)+1)+' 页',pageLanguage:i<30?'英语':'俄语',pageCountry:i<30?'南非':'白俄罗斯'
  }))};
  const uploadMixed=async()=>{
    await c.locator('.lsa-import-file').setInputFiles({name:'mixed.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(mixed))});
    await c.waitForFunction(()=>document.querySelector('.lsa-transfer-status').textContent.includes('分为 3 个文件夹'));
  };
  await uploadMixed();
  assert.equal(store.local[kc.batchState].items.length,30,'71条导入不追加到原40条');
  assert.equal(await c.locator('.lsa-page-result').count(),1,'界面只显示一个文件夹的页面进度');
  const folderCount=()=>Object.keys(store.local).filter(key=>key.startsWith(kc.batchState+':folder:')).length;
  const countBefore=folderCount();
  await uploadMixed();
  assert.equal(store.local[kc.batchState].items.length,30,'重复导入不叠加');
  assert.equal(folderCount(),countBefore,'重复导入不无限创建归档');
  await c.locator('.lsa-restore summary').click();
  await c.locator('.lsa-list-saved').click();
  const oldFolderKey=Object.keys(store.local).find(key=>key.startsWith(kc.batchState+':folder:')&&store.local[key].batchId===cOriginal.batchId);
  assert.ok(oldFolderKey,'旧40条批次应保留');
  await c.locator('.lsa-saved-batches').selectOption(oldFolderKey);
  await c.locator('.lsa-restore-saved').click();
  await c.waitForFunction(()=>document.querySelector('.lsa-transfer-status').textContent.includes('已导入 40 条'));
  assert.equal(await c.locator('.lsa-batch-card').count(),40);
  assert.equal(store.local[kc.batchState].batchId,cOriginal.batchId,'可以切回旧文件夹');
  await c.locator('.lsa-save-batch-json').click();
  await c.waitForFunction(()=>document.querySelector('.lsa-batch-status').textContent.includes('已保存'));
  assert.ok(savedPaths.some(name=>name.includes('俄语_白俄罗斯_')&&name.endsWith('批次结果.json')),'JSON 保存到语言国家时间目录');
  await c.locator('[data-setting="batchLimit"]').selectOption('30');
  await c.waitForFunction(async(key)=>(await window.chrome.storage.local.get(key))[key]?.batchLimit===30,kc.batchState);
  assert.equal(store.local[kc.batchState].items.length,40,'切换30档不删除已有记录');
  assert.equal(store.local[kc.batchState].batchLimit,30);
  await c.evaluate(()=>{
    const filters=document.querySelectorAll('#fixture select');
    filters[0].selectedOptions[0].textContent='英语';filters[1].selectedOptions[0].textContent='南非';
  });
  await c.locator('.lsa-scan-batch').click();
  await c.waitForFunction(()=>document.querySelector('.lsa-batch-status').textContent.includes('已读取 30 / 30'));
  assert.equal(store.local[kc.batchState].items.length,30,'切换后台语言国家后读取建立新文件夹，不追加');
  assert.equal(await c.locator('.lsa-page-result').count(),1);
  assert.equal(store.local[kc.batchState].metadata.country,'南非');
  assert.deepEqual(store.local[kb.batchState],bSnapshot,'C的扫描导入切换不影响B');
  fs.mkdirSync(path.join(root,'tests','artifacts'),{recursive:true});
  await c.locator('.lsa-restore summary').click();
  await c.evaluate(()=>document.querySelector('.lsa-assistant-body').scrollTop=0);
  await c.screenshot({path:path.join(root,'tests','artifacts','folders-0.11.png')});
  await b.evaluate(()=>{
    document.querySelector('#fixture').innerHTML='<label>标题<input id="title" value="Original title"></label><label>简介<textarea id="summary">Original summary</textarea></label><input id="picture" type="file">';
    location.hash='#/nav/overseasDeliver?index=5&type=editEMPTY&id=202';
  });
  await chrome.storage.sync.set({settings:{...store.sync.settings,siteRules:{'lockscreen-admin.mofeeds.com':{titleSelector:'#title',summarySelector:'#summary'}}}});
  await b.locator('.lsa-apply-record').click();
  assert.equal(await b.locator('#title').inputValue(),bSnapshot.items[0].title,'超过12字符但只有10词的标题应能填写');
  assert.equal(await b.locator('#picture').evaluate((input)=>input.files.length),0);
  assert.ok(await b.locator('[data-panel="record"] > .lsa-section-card').first().evaluate((main)=>main.compareDocumentPosition(document.querySelector('.lsa-transfer'))&Node.DOCUMENT_POSITION_FOLLOWING),'编辑页文件夹与设置应位于批次填入下面');
  assert.equal(await b.locator('.lsa-record-fold').evaluate((node)=>node.open),true,'有批次记录时列表默认展开');
  await b.screenshot({path:path.join(root,'tests','artifacts','edit-layout-0.12.png')});
  await b.locator('.lsa-record-fold > summary').click();
  assert.equal(await b.locator('.lsa-record-fold').evaluate((node)=>node.open),false,'批次记录应可折叠');
  await b.locator('[data-tab="manual"]').click();
  await b.locator('.lsa-draft-copy').fill('one two three four five six seven eight nine ten eleven twelve thirteen\nA valid summary');
  await b.locator('.lsa-apply-draft').click();
  assert.ok((await b.locator('.lsa-manual-status').textContent()).includes('超过限制'));
  assert.equal(await b.locator('#title').inputValue(),bSnapshot.items[0].title,'13词拒绝后不能覆盖旧值');
  await b.locator('.lsa-draft-copy').fill('How to care for cats\nA valid summary');
  assert.equal(await b.locator('.lsa-title-count').textContent(),'标题 5 / 12 词');
  assert.ok(!messages.some((message)=>['NEXT_LIST_PAGE','SCAN_OPEN_PAGES'].includes(message.action)));
  fs.mkdirSync(path.join(root,'tests','artifacts'),{recursive:true});
  await b.screenshot({path:path.join(root,'tests','artifacts','word-count-0.10.png')});
  const before=await run('getTabContext(202)');startup();const after=await run('getTabContext(202)');
  assert.notEqual(before.keys.batchState,after.keys.batchState,'浏览器重启后不误认复用的标签ID');
  assert.ok((await run('savedBatches()')).batches.some((batch)=>batch.key===before.keys.batchState),'旧批次保留可恢复');
  console.log('0.12.1 浏览器测试通过：实际扫描40条、语言国家读取、重复导入不堆积、71条拆3文件夹、归档恢复、JSON目录、30/40切换及原双标签并行测试');
  await context.close();
} finally { await browser.close(); }
