import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const require = createRequire(path.join(process.env.LSA_NODE_MODULES || 'C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules', 'package.json'));
const { chromium } = require('playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const browser = await chromium.launch({channel:'chrome',headless:true});
try {
  const context = await browser.newContext({viewport:{width:1440,height:1000}});
  await context.route('**/*', (route) => route.fulfill({contentType:'text/html; charset=utf-8',body:'<!doctype html><html><head><meta charset="UTF-8"></head><body><h1>测试后台</h1><main id="fixture"></main></body></html>'}));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('https://lockscreen-admin.mofeeds.com/#/nav/overseasContent?index=5');
  await page.evaluate(() => {
    const events = [];
    const storage = {sync:{settings:{pageCount:2,autoSearch:true,rewriteMode:'ai',titleLimit:12,summaryLimit:50}},local:{}};
    window.testStorage = storage; window.testCalls = []; window.exports = [];
    const area = (name) => ({get:async (keys) => Object.fromEntries((Array.isArray(keys)?keys:[keys]).map((key)=>[key,structuredClone(storage[name][key])])),set:async (patch)=>{
      const changes = {}; for(const [key,value] of Object.entries(patch)){changes[key]={oldValue:storage[name][key],newValue:structuredClone(value)}; storage[name][key]=structuredClone(value);}
      events.forEach((event)=>event(changes,name));
    }});
    const image = (id) => ({id,source:'pexels',imageUrl:`https://images.pexels.com/photos/${id}/image.jpg`,previewUrl:`https://images.pexels.com/photos/${id}/image.jpg`,width:900,height:1600,safetyStatus:'passed'});
    window.chrome={storage:{sync:area('sync'),local:area('local'),onChanged:{addListener:(fn)=>events.push(fn)}},runtime:{onMessage:{addListener:()=>{}},sendMessage:async(message)=>{
      window.testCalls.push(message);
      if(message.action==='WORK_LOCK')return {ok:true,active:message.operation==='status'?false:true,owns:true};
      if(message.action==='AI_PROCESS_ITEM')return {ok:true,result:{title:'Cat care',summary:'Gentle care for cats',imageQueryEn:'cat at home',language:'en'}};
      if(message.action==='GENERATE_IMAGE_QUERY')return {ok:true,imageQueryEn:'cat resting indoors'};
      if(message.action==='SEARCH_PEXELS_BATCH')return {ok:true,source:'pexels',page:message.page||1,hasNext:(message.page||1)<3,items:[image(message.page||1)]};
      if(message.action==='SAVE_TEXT_FILE'){window.exports.push(JSON.parse(message.text));return{ok:true,fileName:message.fileName};}
      if(message.action==='MARK_IMAGE_DUPLICATE'){const key=`pexels:${message.image.id}`;return {ok:true,key,entry:{manual:message.marked}};}
      if(message.action==='SCAN_OPEN_PAGES')return {ok:true,pages:[{ok:true,pageLabel:'标签页面',items:[{id:'8',originalTitle:'Cat playing',originalSummary:'Cats can play'}]}],warnings:[]};
      return {ok:true};
    }}};
    let n=0;
    const snapshot=()=>({ok:true,pageLabel:`列表第 ${++n} 页`,sourcePage:location.href,items:[{id:String(n),originalTitle:'Caring for cats at home',originalSummary:'Provide a warm and quiet environment',editUrl:`https://lockscreen-admin.mofeeds.com/#/nav/overseasDeliver?index=5&type=editEMPTY&id=${n}`} ]});
    window.__lsaPageTools={scanPageSnapshot:snapshot,nextListPage:snapshot,getPageContext:async()=>({boundTitle:'Caring for cats at home',boundSummary:'Provide a warm and quiet environment'}),applyBatchRecord:async (item)=>{
      document.querySelector('#test-title').value=item.title;document.querySelector('#test-summary').value=item.summary;return {ok:true};
    },applyDraft:async()=>({ok:true})};
  });
  for(const name of ['assistant.css'])await page.addStyleTag({path:path.join(root,name)});
  for(const name of ['workflow.js','assistant.js'])await page.addScriptTag({path:path.join(root,name)});
  await page.locator('.lsa-scan-batch').click();
  await page.waitForFunction(()=>window.testStorage.local.batchState?.items.length===2);
  await page.waitForFunction(()=>!document.querySelector('.lsa-start-batch').disabled);
  await page.locator('.lsa-start-batch').click();
  await page.waitForFunction(()=>window.testStorage.local.batchState?.status==='completed');
  assert.equal(await page.locator('.lsa-page-result').count(),2);
  await page.locator('.lsa-export-completed').click();
  await page.waitForFunction(()=>window.exports.some((data)=>data.format==='lockscreen-results' && data.items.length===2));
  const result = await page.evaluate(()=>window.testStorage.local.batchState);
  await page.locator('.lsa-import-file').setInputFiles({name:'results.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(result))});
  await page.waitForFunction(()=>document.querySelector('.lsa-transfer-status').textContent.includes('已导入'));
  assert.equal(await page.evaluate(()=>window.testStorage.local.batchState.items.length),2);
  await page.locator('.lsa-read-mode').selectOption('tabs');
  await page.locator('.lsa-scan-batch').click();
  await page.waitForFunction(()=>window.testStorage.local.batchState.items.length===3);
  await page.locator('.lsa-read-mode').selectOption('pagination');
  await page.locator('.lsa-scan-batch').click();
  await page.waitForFunction(()=>window.testStorage.local.batchState.items.length===5);
  await page.locator('.lsa-page-count').fill('1');
  await page.locator('.lsa-page-count').dispatchEvent('change');
  await page.locator('.lsa-start-batch').click();
  await page.waitForFunction(()=>window.testStorage.local.batchState.status==='paused');
  assert.equal(await page.evaluate(()=>window.testStorage.local.batchState.items.filter((item)=>item.status==='pending').length),2,'每轮只处理设置的页面数量');
  await page.locator('.lsa-quick-settings summary').click();
  await page.locator('[data-setting="titleLimit"]').fill('18');
  await page.locator('[data-setting="titleLimit"]').dispatchEvent('change');
  await page.waitForFunction(()=>window.testStorage.sync.settings.titleLimit===18);
  await page.locator('.lsa-quick-settings summary').click();
  fs.mkdirSync(path.join(root,'tests','artifacts'),{recursive:true});
  await page.screenshot({path:path.join(root,'tests','artifacts','list-1440.png')});
  await page.evaluate(()=>{
    document.querySelector('#fixture').innerHTML='<label>标题<input id="test-title"></label><label>简介<textarea id="test-summary"></textarea></label><input id="test-file" type="file">';
    location.hash='#/nav/overseasDeliver?index=5&type=editEMPTY&id=1';
  });
  await page.waitForFunction(()=>document.querySelector('.lsa-stock-card'));
  assert.equal(await page.locator('.lsa-assistant').count(),1);
  assert.equal(await page.locator('.lsa-record-title').textContent(),'Cat care');
  await page.locator('.lsa-apply-record').click();
  assert.equal(await page.locator('#test-title').inputValue(),'Cat care');
  assert.equal(await page.locator('#test-file').evaluate((input)=>input.files.length),0);
  assert.equal(await page.evaluate(()=>window.testCalls.filter((call)=>call.action==='FETCH_IMAGE_FILE').length),0);
  await page.locator('[data-tab="images"]').click();
  await page.locator('.lsa-images-next').click();
  await page.waitForFunction(()=>document.querySelector('.lsa-images-page').textContent==='第 2 页');
  await page.locator('.lsa-images-prev').click();
  await page.waitForFunction(()=>document.querySelector('.lsa-images-page').textContent==='第 1 页');
  await page.getByRole('button',{name:'标记重复',exact:true}).click();
  assert.equal(await page.getByRole('button',{name:'取消重复标记',exact:true}).count(),1);
  await page.getByRole('button',{name:'取消重复标记',exact:true}).click();
  await page.screenshot({path:path.join(root,'tests','artifacts','images-1440.png')});
  await page.setViewportSize({width:580,height:700});
  await page.waitForTimeout(300);
  const rect=await page.locator('.lsa-assistant').boundingBox();
  assert.ok(rect.x>=0 && rect.x+rect.width<=580 && rect.y+rect.height<=700,'窄窗口不得溢出');
  await page.screenshot({path:path.join(root,'tests','artifacts','narrow-580.png')});
  assert.deepEqual(errors,[]);
  console.log('浏览器 UI 流程通过：多页/多标签合并、JSON导入导出、快捷设置、自动读取搜图、配图翻页、标记重复、只填文案、响应式窗口');

  const adapter = await context.newPage();
  await adapter.goto('https://lockscreen-admin.mofeeds.com/#/nav/overseasContent?index=5');
  await adapter.evaluate(()=>{
    window.chrome={runtime:{onMessage:{addListener:()=>{}}},storage:{sync:{get:async()=>({settings:{titleLimit:12,summaryLimit:50,siteRules:{'lockscreen-admin.mofeeds.com':{titleSelector:'#bound-title',summarySelector:'#bound-summary'}}}})}}};
    let page=1;
    document.querySelector('#fixture').innerHTML='<div id="cards"></div><div class="el-pagination"><ul class="el-pager"><li class="active">1</li></ul><button class="btn-next">下一页</button></div>';
    function render(){document.querySelector('#cards').innerHTML=`<article style="width:250px;height:300px;padding:12px" data-id="${page}"><span style="float:right">未投递</span><h3>Cat care on page ${page}</h3><a href="https://article.test/${page}">查看链接</a><a href="#/nav/overseasDeliver?index=5&type=editEMPTY&id=${page}">编辑</a></article>`;}
    render();
    document.querySelector('.btn-next').onclick=()=>{page++;document.querySelector('.active').textContent=page;setTimeout(render,400);if(page===2)document.querySelector('.btn-next').disabled=true;};
  });
  for(const name of ['workflow.js','content.js'])await adapter.addScriptTag({path:path.join(root,name)});
  const first = await adapter.evaluate(()=>window.__lsaPageTools.scanPageSnapshot());
  assert.equal(first.items[0].originalTitle,'Cat care on page 1');
  const next = await adapter.evaluate(()=>window.__lsaPageTools.nextListPage());
  assert.equal(next.items[0].id,'2');
  assert.equal(next.pageLabel,'列表第 2 页');
  assert.equal((await adapter.evaluate(()=>window.__lsaPageTools.nextListPage())).ended,true);
  await adapter.evaluate(()=>{
    location.hash='#/nav/overseasDeliver?index=5&type=editEMPTY&id=2';
    document.querySelector('#fixture').innerHTML='<label>标题<input id="bound-title" value="Cat care"></label><label>简介<textarea id="bound-summary">Care for cats</textarea></label><input type="file" id="manual-file">';
  });
  const applied = await adapter.evaluate(()=>window.__lsaPageTools.applyBatchRecord({title:'Healthy cats',summary:'Care for cats at home',imageDataUrl:'data:image/png;base64,YQ=='}));
  assert.equal(applied.ok,true);
  assert.equal(await adapter.locator('#bound-title').inputValue(),'Healthy cats');
  assert.equal(await adapter.locator('#manual-file').evaluate((node)=>node.files.length),0);
  const rejected = await adapter.evaluate(()=>window.__lsaPageTools.applyBatchRecord({title:'This title is too long to fit',summary:'Care for cats'}));
  assert.equal(rejected.ok,false);
  console.log('真实页面适配器通过：排除状态徽标、等待列表更新、识别末页、字符校验、填写不触碰图片控件');

  const options = await context.newPage();
  await options.goto('https://fixture.test/options');
  await options.setContent(fs.readFileSync(path.join(root,'options.html'),'utf8').replace(/<script[\s\S]*?<\/script>/g,''));
  await options.addStyleTag({path:path.join(root,'options.css')});
  await options.evaluate(()=>{
    const data={settings:{aiModel:'my-exact-model'},localSecrets:{aiApiKey:'test-existing-key'}}; window.savedOptions=data;
    window.chrome={storage:{sync:{get:async()=>({settings:data.settings}),set:async(patch)=>Object.assign(data,patch)},local:{get:async()=>data,set:async(patch)=>Object.assign(data,patch)}}};
  });
  for(const name of ['workflow.js','options.js'])await options.addScriptTag({path:path.join(root,name)});
  await options.locator('#pageCount').fill('4');
  await options.locator('#titleLimit').fill('20');
  await options.locator('#rewriteMode').selectOption('local');
  await options.locator('#thinkingLevel').selectOption('off');
  await options.locator('#rewritePrompt').fill('Use a calm tone, at most {titleLimit} characters.');
  await options.locator('#saveSettings').click();
  await options.waitForFunction(()=>window.savedOptions.settings.pageCount===4);
  assert.equal(await options.evaluate(()=>window.savedOptions.settings.aiModel),'my-exact-model');
  assert.equal(await options.evaluate(()=>window.savedOptions.localSecrets.aiApiKey),'test-existing-key');
  assert.equal(await options.evaluate(()=>window.savedOptions.rewritePrompt),'Use a calm tone, at most {titleLimit} characters.');
  await options.screenshot({path:path.join(root,'tests','artifacts','settings.png'),fullPage:true});
  console.log('设置页保存通过：页数、字数、本地模式、思考开关、自定义提示词，以及已有模型和密钥保留');
  await context.close();
} finally { await browser.close(); }
