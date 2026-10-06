(() => {
  const SUPPORTED_HOST = "lockscreen-admin.mofeeds.com";
  if (location.hostname !== SUPPORTED_HOST) return;
  if (window.__lockscreenAssistantLoaded) return;
  window.__lockscreenAssistantLoaded = true;

  const state = {
    replaceMode: false,
    hoveredImage: null,
    targetImage: null,
    originalImage: null,
    pendingImage: null,
    binding: null,
    fieldHover: null,
    fieldCandidate: null,
    routeSignature: "",
    siteStateSignature: "",
    siteStateTimer: null,
    capturedRecords: [],
    originalTitles: new Map(),
  };

  const ACTION_LABELS = ["查看链接", "编辑", "下载图片", "复用锁屏"];
  const CARD_META_EXACT = new Set([
    "未投递", "已投递", "待投递", "投递中", "投递失败", "停止投递",
    "未审核", "待审核", "审核中", "已审核", "审核失败", "审核通过", "审核不通过",
    "未发布", "待发布", "发布中", "已发布", "发布失败",
    "未处理", "处理中", "处理成功", "处理失败",
    "草稿", "已下线", "已上线", "启用", "停用",
  ]);

  function isCardMetaText(value) {
    const text = cleanText(value).replace(/[：:]+$/g, "");
    if (!text) return true;
    if (CARD_META_EXACT.has(text)) return true;
    if (/^(?:未|已|待)?(?:投递|审核|发布|处理)(?:中|成功|失败|通过|不通过)?(?:\s*[（(]\d+[）)])?$/i.test(text)) return true;
    if (/^(?:状态|投递状态|审核状态|发布状态)\s*[：:]?/i.test(text)) return true;
    if (/^(?:创建|更新|发布|投递)?时间\s*[：:]?/i.test(text)) return true;
    return false;
  }

  function normalizedTitleKey(value) {
    return cleanText(value).toLocaleLowerCase().replace(/[\p{P}\p{S}\s]+/gu, "");
  }

  function acceptBridgeRecords(records) {
    if (!Array.isArray(records)) return;
    const normalized = records
      .map((record) => ({
        id: cleanText(record?.id),
        title: cleanText(record?.title),
        summary: cleanText(record?.summary),
        sourceUrl: cleanText(record?.sourceUrl),
        editUrl: cleanText(record?.editUrl),
      }))
      .filter((record) => record.id && record.title)
      .slice(-300);
    if (normalized.length) state.capturedRecords = normalized;
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== "lsa-page-bridge" || event.data.type !== "records") return;
    acceptBridgeRecords(event.data.records);
  });

  async function requestBridgeRecords() {
    window.postMessage({ source: "lsa-extension", type: "request-records" }, location.origin);
    await new Promise((resolve) => setTimeout(resolve, 90));
  }

  function capturedRecordForTitle(title) {
    const key = normalizedTitleKey(title);
    if (!key) return null;
    const ranked = state.capturedRecords
      .map((record) => {
        const candidate = normalizedTitleKey(record.title);
        let score = 0;
        if (candidate === key) score = 100;
        else if (candidate.includes(key) || key.includes(candidate)) {
          score = 60 + Math.min(candidate.length, key.length) / Math.max(candidate.length, key.length) * 30;
        }
        return { record, score };
      })
      .filter((entry) => entry.score >= 70)
      .sort((left, right) => right.score - left.score);
    return ranked[0]?.record || null;
  }

  function editUrlForId(id) {
    if (!id) return "";
    return `${location.origin}/#/nav/overseasDeliver?index=5&type=editEMPTY&id=${encodeURIComponent(id)}`;
  }

  function cleanText(value) {
    return String(value || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  }

  function wordCount(value) {
    return LSAWorkflow.count(value);
  }

  function createElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text) element.textContent = text;
    return element;
  }

  function showBar(message, actions = []) {
    document.querySelector(".lsa-bar")?.remove();
    const bar = createElement("div", "lsa-bar");
    const copy = createElement("div", "lsa-bar-copy");
    copy.append(createElement("strong", "", "锁"), createElement("span", "", message));
    const actionWrap = createElement("div", "lsa-bar-actions");
    for (const action of actions) {
      const button = createElement("button", "", action.label);
      button.type = "button";
      button.addEventListener("click", action.onClick);
      actionWrap.append(button);
    }
    bar.append(copy, actionWrap);
    document.documentElement.append(bar);
    return bar;
  }

  function removeBar() {
    document.querySelector(".lsa-bar")?.remove();
  }

  function isUsableImage(element) {
    return element instanceof HTMLImageElement &&
      element.width >= 80 &&
      element.height >= 50 &&
      !element.closest(".lsa-assistant, .lsa-panel");
  }

  function onReplaceMouseOver(event) {
    const image = event.target.closest?.("img");
    if (!isUsableImage(image) || image === state.hoveredImage) return;
    state.hoveredImage?.classList.remove("lsa-image-hover");
    state.hoveredImage = image;
    image.classList.add("lsa-image-hover");
  }

  function onReplaceMouseOut(event) {
    const image = event.target.closest?.("img");
    if (image && image === state.hoveredImage) {
      image.classList.remove("lsa-image-hover");
      state.hoveredImage = null;
    }
  }

  function onReplaceClick(event) {
    const image = event.target.closest?.("img");
    if (!isUsableImage(image)) return;
    event.preventDefault();
    event.stopPropagation();
    selectImage(image);
  }

  function startReplaceMode() {
    stopBindingMode();
    state.replaceMode = true;
    document.addEventListener("mouseover", onReplaceMouseOver, true);
    document.addEventListener("mouseout", onReplaceMouseOut, true);
    document.addEventListener("click", onReplaceClick, true);
    document.addEventListener("keydown", onEscape, true);
    showBar("换图模式：点击页面里需要替换的图片", [
      { label: "退出（Esc）", onClick: stopReplaceMode },
    ]);
  }

  function stopReplaceMode() {
    state.replaceMode = false;
    state.hoveredImage?.classList.remove("lsa-image-hover");
    state.hoveredImage = null;
    document.removeEventListener("mouseover", onReplaceMouseOver, true);
    document.removeEventListener("mouseout", onReplaceMouseOut, true);
    document.removeEventListener("click", onReplaceClick, true);
    document.removeEventListener("keydown", onEscape, true);
    removeBar();
  }

  function onEscape(event) {
    if (event.key !== "Escape") return;
    if (state.binding) stopBindingMode();
    else if (state.replaceMode) stopReplaceMode();
  }

  function snapshotImage(image) {
    return {
      src: image.getAttribute("src"),
      srcset: image.getAttribute("srcset"),
      sourceSrcsets: [...(image.closest("picture")?.querySelectorAll("source") || [])].map(
        (source) => ({ source, srcset: source.getAttribute("srcset") }),
      ),
    };
  }

  function restoreImage() {
    if (!state.targetImage || !state.originalImage) return;
    const { src, srcset, sourceSrcsets, boundInput, boundInputValue } = state.originalImage;
    if (src === null) state.targetImage.removeAttribute("src");
    else state.targetImage.setAttribute("src", src);
    if (srcset === null) state.targetImage.removeAttribute("srcset");
    else state.targetImage.setAttribute("srcset", srcset);
    sourceSrcsets.forEach(({ source, srcset: value }) => {
      if (value === null) source.removeAttribute("srcset");
      else source.setAttribute("srcset", value);
    });
    if (boundInput) setFieldValue(boundInput, boundInputValue);
    updatePanelPreview(state.targetImage.currentSrc || state.targetImage.src);
    setPanelResult("已恢复原图与原图片地址");
  }

  async function selectImage(image) {
    stopReplaceMode();
    state.targetImage?.classList.remove("lsa-image-target");
    state.targetImage = image;
    state.targetImage.classList.add("lsa-image-target");
    state.originalImage = snapshotImage(image);

    const { settings = {} } = await chrome.storage.sync.get("settings");
    const rule = settings.siteRules?.[location.hostname];
    if (rule?.imageSelector) {
      const input = safeQuery(rule.imageSelector);
      if (input) {
        state.originalImage.boundInput = input;
        state.originalImage.boundInputValue = readFieldValue(input);
      }
    }
    renderReplacePanel();
    if (state.pendingImage?.url) {
      const urlInput = document.querySelector(".lsa-url-input");
      if (urlInput) urlInput.value = state.pendingImage.url;
      applyImageSource(state.pendingImage.url, state.pendingImage.url);
      setPanelResult(`已应用来自 ${state.pendingImage.source || "素材库"} 的图片；请核对许可与最终效果`);
      state.pendingImage = null;
    }
  }

  function renderReplacePanel() {
    document.querySelector(".lsa-panel")?.remove();
    const panel = createElement("div", "lsa-panel");
    panel.innerHTML = `
      <div class="lsa-panel-header">
        <div>
          <p class="lsa-panel-title">替换页面图片</p>
          <p class="lsa-panel-subtitle"></p>
        </div>
        <button class="lsa-close" type="button" title="关闭">×</button>
      </div>
      <img class="lsa-preview" alt="替换预览" />
      <label class="lsa-url-label" for="lsa-url-input">新图片 URL</label>
      <input id="lsa-url-input" class="lsa-url-input" type="url" placeholder="粘贴图片链接，或从本地选择" />
      <div class="lsa-panel-actions">
        <button class="lsa-related" type="button">搜相关图</button>
        <button class="lsa-similar" type="button">搜相似图</button>
        <label class="lsa-file-label">本地图片<input class="lsa-file" type="file" accept="image/*" /></label>
        <button class="lsa-undo" type="button">撤销</button>
        <button class="lsa-apply" type="button">应用预览</button>
      </div>
      <p class="lsa-result">替换只影响当前页面；绑定图片 URL 字段后会同时写入后台表单。</p>
    `;
    document.documentElement.append(panel);

    const currentUrl = state.targetImage.currentSrc || state.targetImage.src || "";
    panel.querySelector(".lsa-panel-subtitle").textContent =
      state.targetImage.alt || state.targetImage.title || "已选中页面图片";
    panel.querySelector(".lsa-preview").src = currentUrl;
    panel.querySelector(".lsa-url-input").value = currentUrl.startsWith("data:") ? "" : currentUrl;
    panel.querySelector(".lsa-close").addEventListener("click", closeReplacePanel);
    panel.querySelector(".lsa-undo").addEventListener("click", restoreImage);
    panel.querySelector(".lsa-apply").addEventListener("click", applyUrlFromPanel);
    panel.querySelector(".lsa-file").addEventListener("change", applyLocalFile);
    panel.querySelector(".lsa-similar").addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "OPEN_VISUAL_SEARCH", imageUrl: currentUrl });
    });
    panel.querySelector(".lsa-related").addEventListener("click", searchRelatedImage);
  }

  function closeReplacePanel() {
    document.querySelector(".lsa-panel")?.remove();
    state.targetImage?.classList.remove("lsa-image-target");
    state.targetImage = null;
    state.originalImage = null;
  }

  function updatePanelPreview(src) {
    const preview = document.querySelector(".lsa-preview");
    if (preview) preview.src = src;
  }

  function setPanelResult(message) {
    const result = document.querySelector(".lsa-result");
    if (result) result.textContent = message;
  }

  function applyImageSource(src, syncValue = "") {
    if (!state.targetImage) return;
    state.targetImage.removeAttribute("srcset");
    state.originalImage.sourceSrcsets.forEach(({ source }) => source.removeAttribute("srcset"));
    state.targetImage.src = src;
    updatePanelPreview(src);

    if (state.originalImage.boundInput && syncValue) {
      setFieldValue(state.originalImage.boundInput, syncValue);
      setPanelResult("已应用预览，并同步写入绑定的图片 URL 字段");
    } else if (src.startsWith("data:")) {
      setPanelResult("已应用本地图片预览；本地文件不能直接写入 URL 字段");
    } else {
      setPanelResult("已应用页面预览。若需写入后台，请先绑定图片 URL 字段");
    }
  }

  function applyUrlFromPanel() {
    const input = document.querySelector(".lsa-url-input");
    const url = input?.value.trim();
    if (!url || !/^https?:\/\//i.test(url)) {
      setPanelResult("请输入以 http:// 或 https:// 开头的图片链接");
      return;
    }
    applyImageSource(url, url);
  }

  function applyLocalFile(event) {
    const [file] = event.target.files || [];
    if (!file) return;
    const reader = new FileReader();
    reader.addEventListener("load", () => applyImageSource(reader.result));
    reader.readAsDataURL(file);
  }

  async function searchRelatedImage() {
    if (!state.targetImage) return;
    const page = await getPageContext();
    const query = cleanText(page.originalTitle || page.boundTitle);
    if (!query) return setPanelResult("没有读取到原标题，无法搜索替换图片");
    const { settings = {} } = await chrome.storage.sync.get("settings");
    chrome.runtime.sendMessage({
      type: "OPEN_IMAGE_SEARCH",
      engine: settings.defaultEngine || "baidu",
      query,
    });
  }

  function safeQuery(selector) {
    if (!selector) return null;
    try {
      return document.querySelector(selector);
    } catch {
      return null;
    }
  }

  function readFieldValue(element) {
    if (!element) return "";
    if (element.isContentEditable) return element.innerText || element.textContent || "";
    return element.value || "";
  }

  function setFieldValue(element, value) {
    if (!element) return;
    if (element.isContentEditable) {
      element.focus();
      element.textContent = value;
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }

    const prototype = element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (setter) setter.call(element, value);
    else element.value = value;
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function cssEscape(value) {
    return window.CSS?.escape ? CSS.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  function selectorFor(element) {
    if (element.id) return `#${cssEscape(element.id)}`;
    if (element.getAttribute("name")) {
      const name = element.getAttribute("name").replace(/"/g, '\\"');
      const selector = `${element.tagName.toLowerCase()}[name="${name}"]`;
      if (document.querySelectorAll(selector).length === 1) return selector;
    }
    for (const attribute of ["data-testid", "data-field", "aria-label", "placeholder"]) {
      const value = element.getAttribute(attribute);
      if (!value) continue;
      const escaped = value.replace(/"/g, '\\"');
      const selector = `${element.tagName.toLowerCase()}[${attribute}="${escaped}"]`;
      if (document.querySelectorAll(selector).length === 1) return selector;
    }

    const parts = [];
    let current = element;
    while (current && current !== document.body && parts.length < 5) {
      let part = current.tagName.toLowerCase();
      const siblings = [...current.parentElement.children].filter((item) => item.tagName === current.tagName);
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      parts.unshift(part);
      const selector = parts.join(" > ");
      if (document.querySelectorAll(selector).length === 1) return selector;
      current = current.parentElement;
    }
    return parts.join(" > ");
  }

  const BIND_STEPS = [
    { key: "titleSelector", kind: "text", label: "第 1 步：点击后台的标题输入框" },
    { key: "summarySelector", kind: "text", label: "第 2 步：点击后台的简介输入框" },
  ];

  function isEditableField(element) {
    return Boolean(element) && ((element instanceof HTMLInputElement && element.type !== "file") ||
      element instanceof HTMLTextAreaElement ||
      element.isContentEditable);
  }

  function fileInputFromTarget(target) {
    if (!(target instanceof Element)) return null;
    if (target.matches("input[type='file']")) return target;
    const nested = target.closest("label, [class*='upload'], [class*='Upload'], [class*='uploader']")
      ?.querySelector("input[type='file']");
    if (nested) return nested;
    const label = target.closest("label[for]");
    if (label) {
      const linked = document.getElementById(label.htmlFor);
      if (linked?.matches?.("input[type='file']")) return linked;
    }
    const nearby = target.closest("button, [role='button'], div, section, form")
      ?.querySelector("input[type='file']");
    if (nearby) return nearby;
    const pageInputs = [...document.querySelectorAll("input[type='file']")]
      .filter((item) => !item.closest(".lsa-assistant, .lsa-bar, .lsa-panel"));
    return pageInputs.length === 1 ? pageInputs[0] : null;
  }

  function getBindingCandidate(target) {
    if (!state.binding) return null;
    const step = BIND_STEPS[state.binding.step];
    if (step?.kind === "file") {
      const input = fileInputFromTarget(target);
      if (!input) return null;
      const highlight = target.closest?.("label, button, [role='button'], [class*='upload'], [class*='Upload']") || input;
      if (highlight.closest?.(".lsa-assistant, .lsa-bar, .lsa-panel")) return null;
      return { field: input, highlight };
    }
    const field = target?.closest?.("input, textarea, [contenteditable='true']");
    if (!isEditableField(field) || field.closest(".lsa-assistant, .lsa-bar, .lsa-panel")) return null;
    return { field, highlight: field };
  }

  function startBindingMode() {
    stopReplaceMode();
    stopBindingMode();
    state.binding = { step: 0, rule: {} };
    document.addEventListener("mouseover", onFieldMouseOver, true);
    document.addEventListener("mouseout", onFieldMouseOut, true);
    document.addEventListener("click", onFieldClick, true);
    document.addEventListener("keydown", onEscape, true);
    renderBindingBar();
  }

  function renderBindingBar() {
    if (!state.binding) return;
    const step = BIND_STEPS[state.binding.step];
    showBar(step.label, [{ label: "取消（Esc）", onClick: stopBindingMode }]);
  }

  function onFieldMouseOver(event) {
    const candidate = getBindingCandidate(event.target);
    if (!candidate) return;
    state.fieldHover?.classList.remove("lsa-field-hover");
    state.fieldHover = candidate.highlight;
    state.fieldCandidate = candidate.field;
    candidate.highlight.classList.add("lsa-field-hover");
  }

  function onFieldMouseOut(event) {
    if (state.fieldHover && !state.fieldHover.contains(event.relatedTarget)) {
      state.fieldHover.classList.remove("lsa-field-hover");
      state.fieldHover = null;
      state.fieldCandidate = null;
    }
  }

  function onFieldClick(event) {
    const candidate = getBindingCandidate(event.target);
    if (!state.binding || !candidate) return;
    event.preventDefault();
    event.stopPropagation();
    const step = BIND_STEPS[state.binding.step];
    state.binding.rule[step.key] = selectorFor(candidate.field);
    candidate.highlight.classList.remove("lsa-field-hover");
    candidate.highlight.classList.add("lsa-field-flash");
    setTimeout(() => candidate.highlight.classList.remove("lsa-field-flash"), 1300);
    state.binding.step += 1;
    if (state.binding.step >= BIND_STEPS.length) finishBinding();
    else renderBindingBar();
  }

  async function finishBinding() {
    if (!state.binding) return;
    const rule = state.binding.rule;
    const { settings = {} } = await chrome.storage.sync.get("settings");
    const nextSettings = {
      titleLimit: settings.titleLimit || 12,
      summaryLimit: settings.summaryLimit || 50,
      defaultEngine: settings.defaultEngine || "baidu",
      ...settings,
      siteRules: {
        ...(settings.siteRules || {}),
        [location.hostname]: {
          ...(settings.siteRules?.[location.hostname] || {}),
          ...rule,
        },
      },
    };
    await chrome.storage.sync.set({ settings: nextSettings });
    stopBindingMode();
    const doneBar = showBar(`已绑定 ${location.hostname}，现在可以一键填写标题和简介`, [
      { label: "知道了", onClick: removeBar },
    ]);
    setTimeout(() => doneBar.isConnected && removeBar(), 3500);
  }

  function stopBindingMode() {
    if (!state.binding && !state.fieldHover) return;
    state.fieldHover?.classList.remove("lsa-field-hover");
    state.fieldHover = null;
    state.fieldCandidate = null;
    state.binding = null;
    document.removeEventListener("mouseover", onFieldMouseOver, true);
    document.removeEventListener("mouseout", onFieldMouseOut, true);
    document.removeEventListener("click", onFieldClick, true);
    document.removeEventListener("keydown", onEscape, true);
    removeBar();
  }

  function getSiteRoute() {
    let hash = location.hash || "";
    try {
      hash = decodeURIComponent(hash);
    } catch {
      // Keep the raw hash when it contains a malformed escape sequence.
    }
    const questionAt = hash.indexOf("?");
    const path = (questionAt >= 0 ? hash.slice(0, questionAt) : hash).replace(/\/$/, "");
    const params = new URLSearchParams(questionAt >= 0 ? hash.slice(questionAt + 1) : "");
    const isIndexFive = params.get("index") === "5";
    const isList = path === "#/nav/overseasContent" && isIndexFive;
    const isEdit = path === "#/nav/overseasDeliver" && isIndexFive && params.get("type") === "editEMPTY";
    return {
      supported: isList || isEdit,
      hostname: location.hostname,
      kind: isList ? "list" : isEdit ? "edit" : "other",
      isList,
      isEdit,
      id: params.get("id") || "",
      index: params.get("index") || "",
      hash,
      url: location.href,
    };
  }

  function fieldLabelText(field) {
    const texts = [];
    if (field.labels) texts.push(...[...field.labels].map((label) => label.textContent));
    for (const attribute of ["aria-label", "placeholder", "name", "data-field", "data-testid"]) {
      texts.push(field.getAttribute?.(attribute));
    }
    const formItem = field.closest?.(
      ".el-form-item, .ant-form-item, [class*='form-item'], [class*='formItem'], [class*='field']",
    );
    if (formItem) {
      texts.push(formItem.querySelector("label, .el-form-item__label, [class*='label']")?.textContent);
    }
    return cleanText(texts.filter(Boolean).join(" ")).toLowerCase();
  }

  function isFieldAvailable(field) {
    if (!field || field.disabled || field.readOnly) return false;
    if (field.closest?.(".lsa-assistant, .lsa-bar, .lsa-panel")) return false;
    return true;
  }

  function textFieldScore(field, kind) {
    if (!isFieldAvailable(field) || !isEditableField(field)) return -Infinity;
    const label = fieldLabelText(field);
    const maxLength = Number(field.getAttribute?.("maxlength")) || 0;
    let score = 0;
    if (kind === "title") {
      if (/(标题|title|headline|subject)/i.test(label)) score += 16;
      if (/(简介|摘要|描述|summary|description|content|正文)/i.test(label)) score -= 12;
      if (field instanceof HTMLInputElement) score += 3;
      if (maxLength === 12) score += 12;
      else if (maxLength > 0 && maxLength <= 30) score += 4;
    } else {
      if (/(简介|摘要|描述|summary|description|subtitle|abstract)/i.test(label)) score += 16;
      if (/(标题|title|headline)/i.test(label)) score -= 10;
      if (field instanceof HTMLTextAreaElement || field.isContentEditable) score += 4;
      if (maxLength === 50) score += 12;
      else if (maxLength >= 30 && maxLength <= 200) score += 4;
    }
    if (field.offsetParent !== null) score += 1;
    return score;
  }

  function autoDetectTextField(kind, excluded = new Set()) {
    const candidates = [...document.querySelectorAll(
      "input:not([type]), input[type='text'], textarea, [contenteditable='true']",
    )]
      .filter((field) => !excluded.has(field))
      .map((field, domIndex) => ({ field, domIndex, score: textFieldScore(field, kind) }))
      .filter((item) => Number.isFinite(item.score))
      .sort((a, b) => b.score - a.score || a.domIndex - b.domIndex);
    if (!candidates.length) return null;
    if (candidates[0].score > 0) return candidates[0].field;
    if (kind === "summary") {
      return candidates.find((item) => item.field instanceof HTMLTextAreaElement)?.field || null;
    }
    return candidates.length === 1 ? candidates[0].field : null;
  }

  function autoDetectUploadField() {
    const candidates = [...document.querySelectorAll("input[type='file']")]
      .filter(isFieldAvailable)
      .map((field, domIndex) => {
        const accept = String(field.accept || "").toLowerCase();
        const context = cleanText([
          fieldLabelText(field),
          field.closest("label, [class*='upload'], [class*='Upload'], .el-form-item")?.textContent,
        ].filter(Boolean).join(" ")).toLowerCase();
        let score = 0;
        if (!accept || accept.includes("image") || accept.includes(".jpg") || accept.includes(".png")) score += 4;
        if (/(图片|封面|配图|上传|替换|image|cover|upload)/i.test(context)) score += 10;
        return { field, domIndex, score };
      })
      .sort((a, b) => b.score - a.score || a.domIndex - b.domIndex);
    if (!candidates.length) return null;
    return candidates[0].score > 0 || candidates.length === 1 ? candidates[0].field : null;
  }

  async function getSiteRule() {
    const { settings = {} } = await chrome.storage.sync.get("settings");
    return settings.siteRules?.[location.hostname] || null;
  }

  async function resolveSiteFields() {
    const rule = await getSiteRule();
    const storedTitle = safeQuery(rule?.titleSelector);
    const storedSummary = safeQuery(rule?.summarySelector);
    const storedUploadTarget = safeQuery(rule?.imageUploadSelector);
    const titleField = isFieldAvailable(storedTitle) ? storedTitle : autoDetectTextField("title");
    const summaryField = isFieldAvailable(storedSummary)
      ? storedSummary
      : autoDetectTextField("summary", new Set(titleField ? [titleField] : []));
    const imageUploadField = storedUploadTarget?.matches?.("input[type='file']")
      ? storedUploadTarget
      : fileInputFromTarget(storedUploadTarget) || autoDetectUploadField();
    const statusFor = (field, selector, storedField) => ({
      found: Boolean(field),
      selector: selector || (field ? selectorFor(field) : ""),
      source: field && field === storedField ? "saved" : field ? "auto" : "missing",
    });
    return {
      rule,
      titleField,
      summaryField,
      imageUploadField,
      bindingStatus: {
        title: statusFor(titleField, rule?.titleSelector, storedTitle),
        summary: statusFor(summaryField, rule?.summarySelector, storedSummary),
        upload: statusFor(imageUploadField, rule?.imageUploadSelector, storedUploadTarget),
      },
    };
  }

  async function getPageContext() {
    const { titleField, summaryField, bindingStatus } = await resolveSiteFields();
    const route = getSiteRoute();
    const boundTitle = readFieldValue(titleField);
    const originalKey = route.id ? `id:${route.id}` : location.href;
    if (boundTitle && !state.originalTitles.has(originalKey)) state.originalTitles.set(originalKey, boundTitle);
    return {
      title: document.title || "",
      heading: document.querySelector("h1")?.innerText?.trim() || "",
      description:
        document.querySelector('meta[name="description"]')?.content ||
        document.querySelector('meta[property="og:description"]')?.content ||
        "",
      selectedText: window.getSelection()?.toString().trim() || "",
      boundTitle,
      originalTitle: state.originalTitles.get(originalKey) || boundTitle,
      boundSummary: readFieldValue(summaryField),
      hostname: location.hostname,
      url: location.href,
      route,
      bindingStatus,
    };
  }

  async function applyDraft(title, summary) {
    return applyBatchRecord({ title, summary });
  }

  function actionLabelFor(element) {
    const text = cleanText(element?.textContent);
    if (!text || text.length > 24) return "";
    return ACTION_LABELS.find((label) => text === label || text.startsWith(`${label} `)) || "";
  }

  function findActionElements(root = document) {
    const selector = "a, button, [role='button'], .el-button, span, div";
    return [...root.querySelectorAll(selector)].filter((element) => {
      if (element.closest(".lsa-assistant, .lsa-bar, .lsa-panel")) return false;
      const label = actionLabelFor(element);
      if (!label) return false;
      return ![...element.children].some((child) => actionLabelFor(child) === label);
    });
  }

  function actionLabelsInside(container) {
    return new Set(findActionElements(container).map(actionLabelFor).filter(Boolean));
  }

  function textWithoutActions(container) {
    let text = cleanText(container?.textContent);
    for (const label of ACTION_LABELS) text = text.replace(new RegExp(label, "g"), " ");
    text = text.replace(/^(相关)?操作$|^更多$/g, " ");
    return cleanText(text);
  }

  function plausibleContainer(element) {
    const rect = element.getBoundingClientRect();
    if (rect.width < 80 || rect.height < 30) return false;
    const text = cleanText(element.textContent);
    return text.length >= 3 && text.length <= 6000;
  }

  function findCardContainer(actionElement) {
    let current = actionElement;
    let fallback = null;
    for (let depth = 0; current && current !== document.body && depth < 12; depth += 1) {
      if (!plausibleContainer(current)) {
        current = current.parentElement;
        continue;
      }
      const labels = actionLabelsInside(current);
      const remaining = textWithoutActions(current);
      const tag = current.tagName.toLowerCase();
      const className = String(current.className || "");
      const semanticContainer = tag === "tr" || tag === "li" || tag === "article" ||
        current.getAttribute("role") === "row" || /(card|content-item|list-item|grid-item)/i.test(className);
      if (labels.size && remaining.length >= 2) {
        fallback ||= current;
        if (semanticContainer || labels.size >= 2) return current;
      }
      current = current.parentElement;
    }
    return fallback;
  }

  function normalizeHref(value) {
    const raw = cleanText(value);
    if (!raw || /^(javascript:|void\b)/i.test(raw) || raw === "#") return "";
    try {
      return new URL(raw, location.href).href;
    } catch {
      return "";
    }
  }

  function urlFromAction(element, container) {
    if (!element) return "";
    const candidates = [];
    const anchor = element.matches("a") ? element : element.closest("a") || element.querySelector("a");
    if (anchor) candidates.push(anchor);
    candidates.push(element);
    let parent = element.parentElement;
    for (let depth = 0; parent && parent !== container?.parentElement && depth < 3; depth += 1) {
      candidates.push(parent);
      parent = parent.parentElement;
    }
    for (const candidate of candidates) {
      for (const attribute of ["href", "data-href", "data-url", "data-link", "data-source", "to"]) {
        const url = normalizeHref(candidate.getAttribute?.(attribute));
        if (url) return url;
      }
      for (const [key, value] of Object.entries(candidate.dataset || {})) {
        if (!/(url|href|link|source|target)/i.test(key) && !/^(https?:\/\/|#\/)/i.test(value)) continue;
        const url = normalizeHref(value);
        if (url) return url;
      }
      const inlineHandler = candidate.getAttribute?.("onclick") || "";
      const inlineUrl = inlineHandler.match(/(?:https?:\/\/[^'"\s)]+|#\/[^'"\s)]+)/i)?.[0];
      if (inlineUrl) {
        const url = normalizeHref(inlineUrl);
        if (url) return url;
      }
    }
    return "";
  }

  function actionByLabel(container, label) {
    return findActionElements(container).find((element) => actionLabelFor(element) === label) || null;
  }

  function findFallbackUrl(container, kind) {
    const anchors = [...container.querySelectorAll("a[href]")]
      .map((anchor) => normalizeHref(anchor.getAttribute("href")))
      .filter(Boolean);
    if (kind === "edit") {
      return anchors.find((url) => /#\/nav\/overseasDeliver\b/i.test(url) || /type=editEMPTY/i.test(url)) || "";
    }
    return anchors.find((url) => {
      try {
        const parsed = new URL(url);
        return parsed.hostname !== location.hostname && /^https?:$/i.test(parsed.protocol);
      } catch {
        return false;
      }
    }) || "";
  }

  function extractItemId(container, editUrl) {
    const idMatch = String(editUrl || "").match(/[?&]id=([^&#]+)/i);
    if (idMatch) return decodeURIComponent(idMatch[1]);
    const idNodes = [container, ...container.querySelectorAll("[data-id], [data-row-key], [row-key], [key]")];
    for (const node of idNodes) {
      for (const attribute of ["data-id", "data-row-key", "row-key", "key"]) {
        const value = cleanText(node.getAttribute?.(attribute));
        if (value && /^[\w.-]{2,}$/.test(value)) return value;
      }
    }
    const labelledId = cleanText(container?.textContent).match(/(?:内容\s*ID|文章\s*ID|content\s*id|article\s*id)\s*[:：#]?\s*([\w.-]{2,})/i)?.[1];
    if (labelledId) return labelledId;
    return "";
  }

  function titleCandidateScore(element, text, cardRect, domIndex) {
    const tag = element.tagName.toLowerCase();
    const identity = `${element.className || ""} ${element.getAttribute("data-field") || ""}`;
    const rect = element.getBoundingClientRect();
    let score = 0;
    if (isCardMetaText(text)) return -1000;
    if (/^h[1-6]$/.test(tag)) score += 18;
    if (/(^|[-_\s])(title|headline|subject)([-_\s]|$)/i.test(identity)) score += 24;
    if (/(^|[-_\s])(status|state|tag|badge|delivery|deliver-status)([-_\s]|$)/i.test(identity)) score -= 45;
    if (text.length >= 4 && text.length <= 80) score += 8;
    else if (text.length <= 140) score += 2;
    if (/^(原标题|标题|title)\s*[:：]/i.test(text)) score += 8;
    if (/(简介|摘要|创建时间|更新时间|发布时间|状态|国家|语言|作者|来源|下载|复用)/i.test(text)) score -= 16;
    if (/^\d{1,8}$/.test(text) || /^https?:\/\//i.test(text)) score -= 18;
    if (rect.top >= cardRect.top - 2 && rect.top < cardRect.top + cardRect.height * 0.65) score += 4;
    const nearRightEdge = rect.left > cardRect.left + cardRect.width * 0.68;
    const nearTopEdge = rect.top < cardRect.top + cardRect.height * 0.35;
    if (nearRightEdge && nearTopEdge && text.length <= 10) score -= 18;
    score -= domIndex / 10000;
    return score;
  }

  function extractOriginalTitle(container) {
    const cardRect = container.getBoundingClientRect();
    const preferred = [...container.querySelectorAll(
      "h1, h2, h3, h4, h5, h6, [class*='title'], [class*='Title'], [data-field*='title'], [data-field*='Title']",
    )];
    const fallback = [...container.querySelectorAll("p, span, strong, b, div")]
      .filter((element) => element.children.length === 0 || element.childElementCount <= 1);
    const seen = new Set();
    const candidates = [...preferred, ...fallback]
      .map((element, domIndex) => {
        let text = cleanText(element.textContent);
        text = text.replace(/^(原标题|标题|title)\s*[:：]\s*/i, "");
        if (!text || seen.has(text) || text.length > 200 || isCardMetaText(text)
          || ACTION_LABELS.some((label) => text === label)) return null;
        seen.add(text);
        return { element, text, score: titleCandidateScore(element, text, cardRect, domIndex) };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);
    return candidates[0]?.score > -5 ? candidates[0].text : "";
  }

  function deduplicateContainers(containers) {
    const unique = [...new Set(containers.filter(Boolean))];
    return unique.filter((candidate) => !unique.some((other) => {
      if (candidate === other || !candidate.contains(other)) return false;
      const candidateArea = candidate.getBoundingClientRect().width * candidate.getBoundingClientRect().height;
      const otherArea = other.getBoundingClientRect().width * other.getBoundingClientRect().height;
      return otherArea > 0 && candidateArea > otherArea * 2.5;
    }));
  }

  async function scanListItems(limit = 30) {
    await requestBridgeRecords();
    const route = getSiteRoute();
    const numericLimit = Math.max(1, Math.min(40, Number(limit) || 30));
    if (!route.isList) {
      return {
        ok: false,
        items: [],
        message: "当前不是海外内容列表页",
        diagnostics: { route, actionCount: 0, containerCount: 0, warnings: ["route_mismatch"] },
      };
    }
    const actions = findActionElements();
    const containers = deduplicateContainers(actions.map(findCardContainer));
    const positioned = containers
      .map((container, domIndex) => ({ container, domIndex, rect: container.getBoundingClientRect() }))
      .filter((item) => item.rect.width > 0 && item.rect.height > 0)
      .sort((a, b) => {
        const rowTolerance = Math.max(20, Math.min(60, Math.min(a.rect.height, b.rect.height) * 0.2));
        if (Math.abs(a.rect.top - b.rect.top) > rowTolerance) return a.rect.top - b.rect.top;
        return a.rect.left - b.rect.left || a.domIndex - b.domIndex;
      });
    const warnings = [];
    const items = positioned.slice(0, numericLimit).map(({ container, rect }, position) => {
      const viewAction = actionByLabel(container, "查看链接");
      const editAction = actionByLabel(container, "编辑");
      let sourceUrl = urlFromAction(viewAction, container) || findFallbackUrl(container, "source");
      let editUrl = urlFromAction(editAction, container) || findFallbackUrl(container, "edit");
      const originalTitle = extractOriginalTitle(container);
      const captured = capturedRecordForTitle(originalTitle);
      const id = extractItemId(container, editUrl) || captured?.id || "";
      sourceUrl ||= captured?.sourceUrl || "";
      editUrl ||= captured?.editUrl || editUrlForId(id);
      const missing = [];
      if (!originalTitle) missing.push("originalTitle");
      if (!sourceUrl) missing.push("sourceUrl");
      if (!editUrl) missing.push("editUrl");
      if (!id) missing.push("id");
      if (missing.length) warnings.push(`item_${position + 1}:${missing.join(",")}`);
      return {
        index: position + 1,
        id,
        originalTitle,
        originalSummary: captured?.summary || "",
        title: originalTitle,
        summary: captured?.summary || "",
        sourceUrl,
        editUrl,
        diagnostics: {
          missing,
          actions: [...actionLabelsInside(container)],
          position: { top: Math.round(rect.top), left: Math.round(rect.left) },
        },
      };
    });
    return {
      ok: items.length > 0,
      items,
      message: items.length ? `已按从上到下、从左到右识别 ${items.length} 条内容` : "未识别到内容卡片",
      diagnostics: {
        route,
        actionCount: actions.length,
        containerCount: containers.length,
        visibleContainerCount: positioned.length,
        capturedRecordCount: state.capturedRecords.length,
        returnedCount: items.length,
        warnings,
      },
    };
  }

  function listPageNumber() {
    return cleanText(document.querySelector('.el-pagination .el-pager .active, .ant-pagination-item-active, [aria-current="page"]')?.textContent) || "当前页";
  }

  function readListMetadata() {
    const readFilter = (label) => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (!new RegExp(`^${label}\\s*[:：]?$`).test(cleanText(node.textContent)) || node.parentElement?.closest('.lsa-assistant')) continue;
        const parent = node.parentElement;
        const candidates = [node.nextSibling, parent?.nextElementSibling, parent, parent?.parentElement];
        for (const candidate of candidates) {
          if (!(candidate instanceof Element)) continue;
          if (candidate.querySelectorAll('input:not([type="hidden"]), select, .ant-select-selection-item').length > 1) continue;
          const control = candidate.matches('input, select') ? candidate : candidate.querySelector('input:not([type="hidden"]), select, .ant-select-selection-item');
          if (!control || control.closest('.lsa-assistant')) continue;
          const value = cleanText(control instanceof HTMLSelectElement ? control.selectedOptions[0]?.textContent : control.value || control.textContent);
          if (value && !/^(全部|请选择|语言|国家|分类)$/.test(value)) return value;
        }
      }
      return '';
    };
    return { language: readFilter('语言'), country: readFilter('国家'), capturedAt: Date.now() };
  }

  async function scanPageSnapshot(limit = 30) {
    const route = getSiteRoute();
    if (route.isEdit) {
      const context = await getPageContext();
      if (!context.boundTitle) throw new Error("编辑页标题尚未加载，请等待页面加载后再读取");
      return { ok: true, pageLabel: `编辑页 ${route.id}`, sourcePage: location.href,
        items: [{ id: route.id, originalTitle: context.boundTitle, originalSummary: context.boundSummary, editUrl: location.href }] };
    }
    const result = await scanListItems(limit);
    const page = listPageNumber();
    return { ...result, metadata: readListMetadata(), sourcePage: location.href, pageLabel: page === "当前页" ? "当前列表页" : `列表第 ${page} 页` };
  }

  function dataUrlToBlob(dataUrl, fallbackMime = "image/jpeg") {
    const match = String(dataUrl || "").match(/^data:([^;,]+)?(;base64)?,([\s\S]*)$/);
    if (!match) throw new Error("图片数据不是有效的 data URL");
    const mime = match[1] || fallbackMime;
    const binary = match[2] ? atob(match[3]) : decodeURIComponent(match[3]);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new Blob([bytes], { type: mime });
  }

  function normalizeUploadPayload(record, imagePayload = {}) {
    const nestedImage = record?.image || {};
    const payload = imagePayload || {};
    const mime = payload.mime || payload.mimeType || record?.imageMime || nestedImage.mime || nestedImage.mimeType || "image/jpeg";
    const base64 = payload.base64 || record?.imageBase64 || nestedImage.base64 || "";
    return {
      imageDataUrl: payload.imageDataUrl || payload.dataUrl || record?.imageDataUrl || nestedImage.imageDataUrl || nestedImage.dataUrl ||
        (base64 ? `data:${mime};base64,${base64}` : ""),
      mime,
      fileName: payload.fileName || record?.imageFileName || nestedImage.fileName || "lockscreen-image.jpg",
    };
  }

  async function injectUploadFile(input, uploadPayload) {
    if (!uploadPayload.imageDataUrl) {
      return { requested: false, ok: true, message: "本条记录未附带图片数据" };
    }
    if (!input) {
      return { requested: true, ok: false, message: "未找到后台图片上传控件，请重新绑定" };
    }
    try {
      const blob = dataUrlToBlob(uploadPayload.imageDataUrl, uploadPayload.mime);
      const fileName = cleanText(uploadPayload.fileName) || "lockscreen-image.jpg";
      const file = new File([blob], fileName, { type: blob.type || uploadPayload.mime, lastModified: Date.now() });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      input.files = transfer.files;
      const assigned = input.files?.length === 1 && input.files[0]?.size === file.size;
      input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      input.classList.add("lsa-field-flash");
      setTimeout(() => input.classList.remove("lsa-field-flash"), 1300);
      return {
        requested: true,
        ok: assigned,
        message: assigned ? "图片已写入后台上传控件，请确认上传预览" : "浏览器未接受图片文件",
        fileName: file.name,
        size: file.size,
        mime: file.type,
      };
    } catch (error) {
      return { requested: true, ok: false, message: error?.message || "图片写入上传控件失败" };
    }
  }

  async function fieldApplyStatus(field, value, label, characterLimit) {
    if (!field) return { ok: false, expected: value, actual: "", message: `未找到${label}字段` };
    const count = wordCount(value);
    if (!cleanText(value)) {
      return { ok: false, expected: value, actual: readFieldValue(field), message: `${label}为空，未覆盖原内容` };
    }
    if (characterLimit && count > characterLimit) {
      return {
        ok: false,
        expected: value,
        actual: readFieldValue(field),
        wordCount: count,
        message: `${label}为 ${count} 词，超过 ${characterLimit} 词限制，未写入`,
      };
    }
    setFieldValue(field, value);
    await new Promise((resolve) => setTimeout(resolve, 40));
    const actual = readFieldValue(field);
    const ok = actual === value;
    field.classList.add("lsa-field-flash");
    setTimeout(() => field.classList.remove("lsa-field-flash"), 1300);
    return { ok, expected: value, actual, wordCount: count, message: ok ? `${label}已填写` : `${label}写入后读回不一致` };
  }

  async function applyBatchRecord(record = {}) {
    const route = getSiteRoute();
    if (!route.isEdit) {
      return {
        ok: false,
        message: "当前不是海外内容编辑页，未执行填写",
        diagnostics: { route },
      };
    }
    const [{ titleField, summaryField, bindingStatus }, { settings: defaults = {} }, tab] = await Promise.all([
      resolveSiteFields(),
      chrome.storage.sync.get("settings"),
      chrome.runtime.sendMessage({ action: "GET_TAB_CONTEXT" }),
    ]);
    if (!tab?.keys?.settings) throw new Error("当前标签页设置未就绪，请刷新页面");
    const overrides = (await chrome.storage.local.get(tab.keys.settings))[tab.keys.settings] || {};
    const settings = { ...defaults, ...overrides };
    const title = String(record.title ?? record.rewrittenTitle ?? record.generatedTitle ?? record.newTitle ?? "");
    const summary = String(
      record.summary ?? record.rewrittenSummary ?? record.generatedSummary ?? record.newSummary ?? record.description ?? "",
    );
    const [titleStatus, summaryStatus] = await Promise.all([
      fieldApplyStatus(titleField, title, "标题", Number(settings.titleLimit) || 12),
      fieldApplyStatus(summaryField, summary, "简介", Number(settings.summaryLimit) || 50),
    ]);
    const ok = titleStatus.ok && summaryStatus.ok;
    return {
      ok,
      message: ok ? "标题和简介已写入后台，请人工核对后保存" : "部分文案未能写入，请查看分项结果或重新绑定字段",
      title: titleStatus,
      summary: summaryStatus,
      diagnostics: { route, bindingStatus, finalSaveClicked: false },
    };
  }

  function findImageByUrl(url) {
    return [...document.images].find((image) =>
      [image.currentSrc, image.src, image.getAttribute("src")].filter(Boolean).some((src) => src === url),
    );
  }

  function chooseReplacement(url, source = "素材库") {
    state.pendingImage = { url, source };
    startReplaceMode();
  }

  function scheduleSiteStateCheck(source = "dom") {
    clearTimeout(state.siteStateTimer);
    state.siteStateTimer = setTimeout(() => {
      const route = getSiteRoute();
      const signature = [
        route.kind,
        route.id,
        document.querySelectorAll("input, textarea, [contenteditable='true']").length,
        document.querySelectorAll("input[type='file']").length,
        route.isList ? findActionElements().length : 0,
      ].join(":");
      if (signature === state.siteStateSignature) return;
      state.siteStateSignature = signature;
      document.dispatchEvent(new CustomEvent("lsa:site-state-change", {
        detail: { source, route, signature },
      }));
    }, source === "hashchange" ? 30 : 250);
  }

  window.addEventListener("hashchange", () => scheduleSiteStateCheck("hashchange"));
  window.addEventListener("popstate", () => scheduleSiteStateCheck("popstate"));
  const siteObserver = new MutationObserver(() => scheduleSiteStateCheck("dom"));
  siteObserver.observe(document.documentElement, { childList: true, subtree: true });
  scheduleSiteStateCheck("initial");

  globalThis.__lsaPageTools = {
    getSiteRoute,
    scanListItems,
    scanPageSnapshot,
    getPageContext,
    applyDraft,
    applyBatchRecord,
    startReplaceMode,
    startBindingMode,
    chooseReplacement,
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const action = message?.action || message?.type;
    if (action === "SCAN_PAGE_SNAPSHOT") {
      scanPageSnapshot(message.limit).then(sendResponse).catch((error) => sendResponse({ ok: false, message: error.message }));
      return true;
    }
    if (action === "GET_SITE_ROUTE") {
      sendResponse(getSiteRoute());
      return;
    }
    if (action === "SCAN_LIST_ITEMS") {
      scanListItems(message.limit).then(sendResponse).catch((error) => sendResponse({
        ok: false,
        items: [],
        message: error?.message || "扫描列表失败",
        diagnostics: { route: getSiteRoute(), warnings: ["scan_failed"] },
      }));
      return true;
    }
    if (action === "GET_PAGE_CONTEXT") {
      getPageContext().then(sendResponse).catch((error) => sendResponse({
        ok: false,
        message: error?.message || "读取页面内容失败",
        route: getSiteRoute(),
      }));
      return true;
    }
    if (action === "APPLY_DRAFT") {
      applyDraft(message.title || "", message.summary || "").then(sendResponse).catch((error) => sendResponse({
        ok: false,
        message: error?.message || "填写标题和简介失败",
      }));
      return true;
    }
    if (action === "APPLY_BATCH_RECORD") {
      const imagePayload = message.imagePayload || message.image || {
        imageDataUrl: message.imageDataUrl,
        dataUrl: message.dataUrl,
        base64: message.base64,
        mime: message.mime || message.mimeType,
        fileName: message.fileName,
      };
      applyBatchRecord(message.record || message, imagePayload).then(sendResponse)
        .catch((error) => sendResponse({ ok: false, message: error?.message || "批次内容写入失败" }));
      return true;
    }
    if (action === "TOGGLE_REPLACE_MODE") {
      if (state.replaceMode) stopReplaceMode();
      else startReplaceMode();
      sendResponse({ ok: true });
    }
    if (action === "START_BIND_MODE") {
      startBindingMode();
      sendResponse({ ok: true });
    }
    if (action === "SET_REPLACE_TARGET") {
      const image = findImageByUrl(message.srcUrl);
      if (image) selectImage(image);
      sendResponse({ ok: Boolean(image) });
    }
  });
})();
