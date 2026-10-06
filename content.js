(() => {
  if (window.__lockscreenAssistantLoaded) return;
  window.__lockscreenAssistantLoaded = true;

  const state = {
    replaceMode: false,
    hoveredImage: null,
    targetImage: null,
    originalImage: null,
    binding: null,
    fieldHover: null,
  };

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
    return element instanceof HTMLImageElement && element.width >= 80 && element.height >= 50;
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

  function nearbyImageText(image) {
    const text = [
      image.alt,
      image.title,
      image.closest("figure")?.querySelector("figcaption")?.textContent,
      document.querySelector("h1")?.textContent,
      document.title,
    ]
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    return text.slice(0, 80);
  }

  async function searchRelatedImage() {
    if (!state.targetImage) return;
    const query = nearbyImageText(state.targetImage);
    const { settings = {} } = await chrome.storage.sync.get("settings");
    chrome.runtime.sendMessage({
      type: "OPEN_IMAGE_SEARCH",
      engine: settings.defaultEngine || "baidu",
      query: query || "高清横图",
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
    { key: "titleSelector", label: "第 1 步：点击后台的标题输入框" },
    { key: "summarySelector", label: "第 2 步：点击后台的简介输入框" },
    { key: "imageSelector", label: "第 3 步：点击图片 URL 输入框（没有可跳过）" },
  ];

  function isEditableField(element) {
    return element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element.isContentEditable;
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
    const actions = [];
    if (state.binding.step === 2) {
      actions.push({ label: "跳过图片字段", onClick: finishBinding });
    }
    actions.push({ label: "取消（Esc）", onClick: stopBindingMode });
    showBar(step.label, actions);
  }

  function onFieldMouseOver(event) {
    const field = event.target.closest?.("input, textarea, [contenteditable='true']");
    if (!isEditableField(field) || field.closest(".lsa-bar")) return;
    state.fieldHover?.classList.remove("lsa-field-hover");
    state.fieldHover = field;
    field.classList.add("lsa-field-hover");
  }

  function onFieldMouseOut(event) {
    const field = event.target.closest?.("input, textarea, [contenteditable='true']");
    if (field && field === state.fieldHover) {
      field.classList.remove("lsa-field-hover");
      state.fieldHover = null;
    }
  }

  function onFieldClick(event) {
    const field = event.target.closest?.("input, textarea, [contenteditable='true']");
    if (!state.binding || !isEditableField(field) || field.closest(".lsa-bar")) return;
    event.preventDefault();
    event.stopPropagation();
    const step = BIND_STEPS[state.binding.step];
    state.binding.rule[step.key] = selectorFor(field);
    field.classList.remove("lsa-field-hover");
    field.classList.add("lsa-field-flash");
    setTimeout(() => field.classList.remove("lsa-field-flash"), 1300);
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
        [location.hostname]: rule,
      },
    };
    await chrome.storage.sync.set({ settings: nextSettings });
    stopBindingMode();
    const doneBar = showBar(`已绑定 ${location.hostname}，现在可以一键填写后台`, [
      { label: "知道了", onClick: removeBar },
    ]);
    setTimeout(() => doneBar.isConnected && removeBar(), 3500);
  }

  function stopBindingMode() {
    if (!state.binding && !state.fieldHover) return;
    state.fieldHover?.classList.remove("lsa-field-hover");
    state.fieldHover = null;
    state.binding = null;
    document.removeEventListener("mouseover", onFieldMouseOver, true);
    document.removeEventListener("mouseout", onFieldMouseOut, true);
    document.removeEventListener("click", onFieldClick, true);
    document.removeEventListener("keydown", onEscape, true);
    removeBar();
  }

  async function getSiteRule() {
    const { settings = {} } = await chrome.storage.sync.get("settings");
    return settings.siteRules?.[location.hostname] || null;
  }

  async function getPageContext() {
    const rule = await getSiteRule();
    const titleField = safeQuery(rule?.titleSelector);
    const summaryField = safeQuery(rule?.summarySelector);
    return {
      title: document.title || "",
      heading: document.querySelector("h1")?.innerText?.trim() || "",
      description:
        document.querySelector('meta[name="description"]')?.content ||
        document.querySelector('meta[property="og:description"]')?.content ||
        "",
      selectedText: window.getSelection()?.toString().trim() || "",
      boundTitle: readFieldValue(titleField),
      boundSummary: readFieldValue(summaryField),
      hostname: location.hostname,
      url: location.href,
    };
  }

  async function applyDraft(title, summary) {
    const rule = await getSiteRule();
    if (!rule?.titleSelector || !rule?.summarySelector) {
      return { ok: false, message: "请先点击“绑定后台字段”完成一次设置" };
    }
    const titleField = safeQuery(rule.titleSelector);
    const summaryField = safeQuery(rule.summarySelector);
    if (!titleField || !summaryField) {
      return { ok: false, message: "未找到已绑定字段，请重新绑定当前网站" };
    }
    setFieldValue(titleField, title);
    setFieldValue(summaryField, summary);
    for (const field of [titleField, summaryField]) {
      field.classList.add("lsa-field-flash");
      setTimeout(() => field.classList.remove("lsa-field-flash"), 1300);
    }
    return { ok: true, message: "标题和简介已填写到后台" };
  }

  function findImageByUrl(url) {
    return [...document.images].find((image) =>
      [image.currentSrc, image.src, image.getAttribute("src")].filter(Boolean).some((src) => src === url),
    );
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "GET_PAGE_CONTEXT") {
      getPageContext().then(sendResponse);
      return true;
    }
    if (message.type === "APPLY_DRAFT") {
      applyDraft(message.title || "", message.summary || "").then(sendResponse);
      return true;
    }
    if (message.type === "TOGGLE_REPLACE_MODE") {
      if (state.replaceMode) stopReplaceMode();
      else startReplaceMode();
      sendResponse({ ok: true });
    }
    if (message.type === "START_BIND_MODE") {
      startBindingMode();
      sendResponse({ ok: true });
    }
    if (message.type === "SET_REPLACE_TARGET") {
      const image = findImageByUrl(message.srcUrl);
      if (image) selectImage(image);
      sendResponse({ ok: Boolean(image) });
    }
  });
})();
