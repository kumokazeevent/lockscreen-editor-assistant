(() => {
  if (globalThis.__lockscreenFloatingAssistantLoaded) return;
  globalThis.__lockscreenFloatingAssistantLoaded = true;

  const DEFAULT_SETTINGS = {
    titleLimit: 12,
    summaryLimit: 50,
    defaultEngine: "baidu",
    siteRules: {},
  };

  const STOP_WORDS = new Set([
    "的", "了", "和", "与", "及", "或", "在", "将", "是", "为", "对", "从", "到", "让",
    "这", "那", "一个", "一种", "如何", "为什么", "最新", "今日", "目前", "相关", "进行",
    "the", "and", "for", "with", "from", "this", "that", "into", "your", "about",
  ]);

  const state = {
    root: null,
    settings: { ...DEFAULT_SETTINGS },
    pageContext: {},
    selectedKeywords: new Set(),
    keywords: [],
    searchPage: 1,
    searchHasNext: false,
    saveTimer: null,
    dragging: null,
  };

  function graphemes(value = "") {
    if (typeof Intl.Segmenter === "function") {
      return [...new Intl.Segmenter("zh-CN", { granularity: "grapheme" }).segment(value)].map(
        (part) => part.segment,
      );
    }
    return Array.from(value);
  }

  function textLength(value) {
    return graphemes(value).length;
  }

  function cleanText(value = "") {
    return String(value)
      .replace(/<[^>]+>/g, "")
      .replace(/[\u200b-\u200d\ufeff]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function stripEditorialFiller(value = "") {
    return cleanText(value)
      .replace(/^(?:重磅|速看|必看|刚刚|最新消息|记者获悉|据了解|据悉|近日|今日)[！!：:\s]*/g, "")
      .replace(/(?:值得注意的是|众所周知|不难发现|可以看到|有消息称|相关消息显示)[，,：:]*/g, "")
      .replace(/[“”‘’]/g, "")
      .replace(/\s*[-_|｜]\s*[^，。！？]{1,18}$/g, "")
      .trim();
  }

  function segmentWords(value) {
    if (typeof Intl.Segmenter !== "function") return graphemes(value);
    return [...new Intl.Segmenter("zh-CN", { granularity: "word" }).segment(value)]
      .filter((part) => part.isWordLike || /^[，。！？：；、]$/.test(part.segment))
      .map((part) => part.segment);
  }

  function fitAtBoundary(value, limit) {
    const cleaned = cleanText(value);
    if (textLength(cleaned) <= limit) return cleaned;
    const words = segmentWords(cleaned);
    const output = [];
    let size = 0;
    for (const word of words) {
      const wordSize = textLength(word);
      if (size + wordSize > limit) break;
      output.push(word);
      size += wordSize;
    }
    let result = output.join("").replace(/[，、：；的和与及将把被在于]$/g, "");
    if (!result) result = graphemes(cleaned).slice(0, limit).join("");
    return result;
  }

  function rewriteTitleLocally(title, summary, limit) {
    let source = stripEditorialFiller(title || summary.split(/[。！？]/)[0]);
    source = source
      .replace(/全新|最新|重磅|正式|首次曝光|震撼|火速|赶紧|即将|已经|正在/g, "")
      .replace(/[！!。.]$/g, "")
      .trim();
    if (textLength(source) <= limit) return source;

    const clauses = source.split(/[：:，,；;。！？!?｜|]/).map(cleanText).filter(Boolean);
    const complete = clauses.find((clause) => textLength(clause) >= 5 && textLength(clause) <= limit);
    if (complete) return complete;

    const joined = clauses.slice(0, 2).join("").replace(/的最新消息|相关情况|有关内容/g, "");
    return fitAtBoundary(joined || source, limit);
  }

  function rewriteSummaryLocally(summary, title, limit) {
    let source = stripEditorialFiller(summary || title);
    source = source
      .replace(/(?:对此|同时|此外|另外)[，,]/g, "")
      .replace(/([。！？])\1+/g, "$1");
    if (textLength(source) <= limit) {
      return /[。！？]$/.test(source) || textLength(source) === limit ? source : `${source}。`;
    }

    const titleTerms = new Set(segmentWords(title).filter((word) => textLength(word) >= 2));
    const clauses = source
      .split(/[。！？；;]/)
      .flatMap((sentence) => sentence.split(/[，,]/))
      .map(cleanText)
      .filter((clause) => textLength(clause) >= 3)
      .map((clause, index) => ({
        clause,
        index,
        score: (index === 0 ? 5 : 0) + segmentWords(clause).filter((word) => titleTerms.has(word)).length * 4,
      }))
      .sort((left, right) => right.score - left.score || left.index - right.index);

    const selected = [];
    let used = 1;
    for (const item of clauses) {
      const separator = selected.length ? 1 : 0;
      if (used + separator + textLength(item.clause) <= limit) {
        selected.push(item);
        used += separator + textLength(item.clause);
      }
    }
    selected.sort((left, right) => left.index - right.index);
    let result = selected.map((item) => item.clause).join("，");
    if (!result) result = fitAtBoundary(source, Math.max(1, limit - 1));
    result = result.replace(/[，、：；的和与及将把被在于]$/g, "");
    if (textLength(result) < limit && !/[。！？]$/.test(result)) result += "。";
    return fitAtBoundary(result, limit);
  }

  function localRewrite(title, summary) {
    const nextTitle = rewriteTitleLocally(title, summary, state.settings.titleLimit);
    const nextSummary = rewriteSummaryLocally(summary, nextTitle, state.settings.summaryLimit);
    return { title: nextTitle, summary: nextSummary };
  }

  function create(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function query(selector) {
    return state.root?.querySelector(selector) || null;
  }

  function setStatus(message, isError = false) {
    const status = query(".lsa-copy-status");
    if (!status) return;
    status.textContent = message;
    status.classList.toggle("is-error", isError);
  }

  function updateCounts() {
    const title = query(".lsa-floating-title")?.value || "";
    const summary = query(".lsa-floating-summary")?.value || "";
    const titleCount = query(".lsa-title-count");
    const summaryCount = query(".lsa-summary-count");
    if (titleCount) {
      titleCount.textContent = `${textLength(title)} / ${state.settings.titleLimit}`;
      titleCount.classList.toggle("is-over", textLength(title) > state.settings.titleLimit);
    }
    if (summaryCount) {
      summaryCount.textContent = `${textLength(summary)} / ${state.settings.summaryLimit}`;
      summaryCount.classList.toggle("is-over", textLength(summary) > state.settings.summaryLimit);
    }
  }

  function scheduleDraftSave() {
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(() => {
      chrome.storage.local.set({
        draft: {
          title: query(".lsa-floating-title")?.value || "",
          summary: query(".lsa-floating-summary")?.value || "",
          query: query(".lsa-stock-query")?.value || "",
          updatedAt: Date.now(),
        },
      });
    }, 250);
  }

  function tokenize(value, weight, scores) {
    const text = cleanText(value);
    if (!text) return;
    const add = (token, score) => {
      const normalized = token.replace(/^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu, "");
      const size = textLength(normalized);
      if (size < 2 || size > 12 || STOP_WORDS.has(normalized.toLowerCase())) return;
      scores.set(normalized, (scores.get(normalized) || 0) + score + Math.min(size, 5) * .1);
    };
    const words = segmentWords(text).filter((word) => !/^[，。！？：；、]$/.test(word));
    words.forEach((word) => add(word, weight));
    for (let index = 0; index < words.length - 1; index += 1) {
      const separator = /^[\x00-\x7F]/.test(words[index + 1]) ? " " : "";
      add(`${words[index]}${separator}${words[index + 1]}`, weight * .72);
    }
  }

  function refreshKeywords(updateSearch = true) {
    const scores = new Map();
    tokenize(query(".lsa-floating-title")?.value, 7, scores);
    tokenize(query(".lsa-floating-summary")?.value, 3, scores);
    tokenize(state.pageContext.selectedText, 5, scores);
    state.keywords = [...scores.entries()]
      .sort((left, right) => right[1] - left[1])
      .map(([word]) => word)
      .filter((word, index, all) => !all.slice(0, index).some((prior) => prior.includes(word)))
      .slice(0, 8);
    if (!state.keywords.length) state.keywords = ["新闻配图", "高清横图", "杂志锁屏"];
    state.selectedKeywords = new Set(state.keywords.slice(0, 3));
    renderKeywords();
    if (updateSearch) updateSearchFromKeywords();
  }

  function renderKeywords() {
    const wrap = query(".lsa-keyword-chips");
    if (!wrap) return;
    wrap.replaceChildren();
    for (const keyword of state.keywords) {
      const chip = create("button", "lsa-keyword-chip", keyword);
      chip.type = "button";
      chip.classList.toggle("is-active", state.selectedKeywords.has(keyword));
      chip.addEventListener("click", () => {
        if (state.selectedKeywords.has(keyword)) state.selectedKeywords.delete(keyword);
        else state.selectedKeywords.add(keyword);
        chip.classList.toggle("is-active", state.selectedKeywords.has(keyword));
        updateSearchFromKeywords();
      });
      wrap.append(chip);
    }
  }

  function updateSearchFromKeywords() {
    const input = query(".lsa-stock-query");
    if (!input) return;
    input.value = state.keywords.filter((word) => state.selectedKeywords.has(word)).join(" ");
    scheduleDraftSave();
  }

  async function readPage(force = true) {
    if (!globalThis.__lsaPageTools) return;
    try {
      state.pageContext = await globalThis.__lsaPageTools.getPageContext();
      const sourceTitle = state.pageContext.boundTitle || state.pageContext.selectedText ||
        state.pageContext.heading || state.pageContext.title;
      const sourceSummary = state.pageContext.boundSummary || state.pageContext.description ||
        state.pageContext.selectedText;
      const titleInput = query(".lsa-floating-title");
      const summaryInput = query(".lsa-floating-summary");
      if (force || !titleInput.value) titleInput.value = cleanText(sourceTitle);
      if (force || !summaryInput.value) summaryInput.value = cleanText(sourceSummary);
      const host = query(".lsa-assistant-host");
      if (host) host.textContent = state.pageContext.hostname || "当前网页";
      updateCounts();
      refreshKeywords(!query(".lsa-stock-query")?.value);
      scheduleDraftSave();
      setStatus("已读取页面原文；可点击智能改写生成合规文案");
    } catch (error) {
      setStatus(error.message || "读取页面失败", true);
    }
  }

  async function rewriteCopy() {
    const titleInput = query(".lsa-floating-title");
    const summaryInput = query(".lsa-floating-summary");
    if (!titleInput.value.trim() && !summaryInput.value.trim()) {
      return setStatus("请先输入或读取原文", true);
    }
    const button = query(".lsa-rewrite-button");
    button.disabled = true;
    button.textContent = "正在改写…";
    setStatus("正在根据关键信息重写标题和简介");

    let result;
    let usedAi = false;
    try {
      const response = await chrome.runtime.sendMessage({
        type: "REWRITE_COPY",
        title: titleInput.value,
        summary: summaryInput.value,
        context: [state.pageContext.heading, state.pageContext.description].filter(Boolean).join("；"),
        titleLimit: state.settings.titleLimit,
        summaryLimit: state.settings.summaryLimit,
      });
      if (!response?.ok) throw new Error(response?.error || "AI 改写失败");
      if (response.configured) {
        result = localRewrite(response.title, response.summary);
        usedAi = true;
      } else {
        result = localRewrite(titleInput.value, summaryInput.value);
      }
    } catch (error) {
      result = localRewrite(titleInput.value, summaryInput.value);
      setStatus(`在线改写不可用，已改用本地智能精简：${error.message}`, true);
    }

    titleInput.value = result.title;
    summaryInput.value = result.summary;
    updateCounts();
    refreshKeywords(true);
    scheduleDraftSave();
    if (!query(".lsa-copy-status")?.classList.contains("is-error")) {
      setStatus(usedAi ? "AI 语义改写完成，已校验 12/50 字限制" : "本地智能精简完成；配置 AI 接口后可获得更自然的语义改写");
    }
    button.disabled = false;
    button.textContent = "智能改写";
  }

  async function applyDraft() {
    const title = query(".lsa-floating-title").value.trim();
    const summary = query(".lsa-floating-summary").value.trim();
    if (textLength(title) > state.settings.titleLimit || textLength(summary) > state.settings.summaryLimit) {
      return setStatus("文案仍然超限，请先点击“智能改写”", true);
    }
    const result = await globalThis.__lsaPageTools.applyDraft(title, summary);
    setStatus(result.message, !result.ok);
  }

  function switchTab(tabName) {
    state.root.querySelectorAll(".lsa-tab-button").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.tab === tabName);
    });
    state.root.querySelectorAll(".lsa-tab-panel").forEach((panel) => {
      panel.hidden = panel.dataset.panel !== tabName;
    });
  }

  function renderSearchMessage(message, className = "lsa-empty-result") {
    const results = query(".lsa-stock-results");
    results.replaceChildren(create("div", className, message));
  }

  function createLink(label, url) {
    const link = create("a", "", label);
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    return link;
  }

  function renderStockResults(items) {
    const results = query(".lsa-stock-results");
    results.replaceChildren();
    if (!items.length) return renderSearchMessage("没有找到匹配素材，请换一组关键词");
    for (const item of items) {
      const card = create("article", "lsa-stock-card");
      const image = create("img", "lsa-stock-image");
      image.src = item.previewUrl;
      image.alt = item.title;
      image.loading = "lazy";
      image.referrerPolicy = "no-referrer";
      const copy = create("div", "lsa-stock-copy");
      copy.append(create("p", "lsa-stock-title", item.title));
      const meta = create("p", "lsa-stock-meta");
      meta.append(document.createTextNode(`${item.creator} · `));
      meta.append(createLink(item.license || "查看许可", item.licenseUrl));
      const actions = create("div", "lsa-stock-actions");
      const use = create("button", "lsa-image-action is-use", "用于换图");
      use.type = "button";
      use.addEventListener("click", () => {
        globalThis.__lsaPageTools.chooseReplacement(item.imageUrl, item.source === "pexels" ? "Pexels" : "Openverse");
        setSearchStatus("请在网页上点击需要替换的图片；按 Esc 可取消");
      });
      const source = create("button", "lsa-image-action", "查看来源");
      source.type = "button";
      source.addEventListener("click", () => window.open(item.pageUrl, "_blank", "noopener"));
      const credit = create("button", "lsa-image-action is-attribution", "复制署名信息");
      credit.type = "button";
      credit.addEventListener("click", async () => {
        const attribution = item.attribution || `${item.title} — ${item.creator} · ${item.license} · ${item.pageUrl}`;
        await navigator.clipboard.writeText(attribution);
        setSearchStatus("作者、许可和来源信息已复制");
      });
      actions.append(use, source, credit);
      copy.append(meta, actions);
      card.append(image, copy);
      results.append(card);
    }
  }

  function setSearchStatus(message, isError = false) {
    const status = query(".lsa-search-status");
    status.textContent = message;
    status.classList.toggle("is-error", isError);
  }

  async function searchStock(page = 1) {
    const searchQuery = query(".lsa-stock-query").value.trim();
    const source = query(".lsa-source-select").value;
    if (!searchQuery) return setSearchStatus("请先输入或选择搜索词", true);
    state.searchPage = page;
    renderSearchMessage("正在搜索允许商业使用的图片…", "lsa-loading");
    setSearchStatus("");
    try {
      const response = await chrome.runtime.sendMessage({
        type: "SEARCH_STOCK_IMAGES",
        source,
        query: searchQuery,
        page,
      });
      if (!response?.ok) throw new Error(response?.error || "素材搜索失败");
      state.searchHasNext = response.hasNext;
      renderStockResults(response.items || []);
      query(".lsa-page-number").textContent = `第 ${response.page || page} 页`;
      query(".lsa-prev-page").disabled = page <= 1;
      query(".lsa-next-page").disabled = !response.hasNext;
      setSearchStatus(source === "pexels"
        ? "图片由 Pexels 提供；署名非强制但建议保留作者与来源"
        : "已按商业使用许可筛选；使用前请打开来源页核对署名和具体条款");
    } catch (error) {
      renderSearchMessage(error.message || "素材搜索失败");
      setSearchStatus(error.message || "素材搜索失败", true);
    }
  }

  async function saveAssistantState(patch) {
    const { assistantState = {} } = await chrome.storage.local.get("assistantState");
    await chrome.storage.local.set({ assistantState: { ...assistantState, ...patch } });
  }

  function clampPosition(left, top) {
    const width = state.root?.offsetWidth || 398;
    const height = state.root?.offsetHeight || 58;
    return {
      left: Math.max(6, Math.min(window.innerWidth - width - 6, left)),
      top: Math.max(6, Math.min(window.innerHeight - height - 6, top)),
    };
  }

  function applyPosition(position) {
    if (!state.root || !position) return;
    const next = clampPosition(Number(position.left) || 6, Number(position.top) || 6);
    state.root.style.left = `${next.left}px`;
    state.root.style.top = `${next.top}px`;
    state.root.style.right = "auto";
  }

  function startDrag(event) {
    if (event.button !== 0 || event.target.closest("button")) return;
    const rect = state.root.getBoundingClientRect();
    state.dragging = { offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top };
    document.addEventListener("pointermove", moveDrag, true);
    document.addEventListener("pointerup", stopDrag, true);
  }

  function moveDrag(event) {
    if (!state.dragging) return;
    applyPosition({
      left: event.clientX - state.dragging.offsetX,
      top: event.clientY - state.dragging.offsetY,
    });
  }

  function stopDrag() {
    if (!state.dragging) return;
    state.dragging = null;
    document.removeEventListener("pointermove", moveDrag, true);
    document.removeEventListener("pointerup", stopDrag, true);
    const rect = state.root.getBoundingClientRect();
    saveAssistantState({ position: { left: rect.left, top: rect.top } });
  }

  function setMinimized(minimized) {
    if (!state.root) return;
    state.root.classList.toggle("is-minimized", minimized);
    query(".lsa-restore").textContent = minimized ? "□" : "×";
    query(".lsa-restore").title = minimized ? "恢复" : "关闭";
    saveAssistantState({ minimized });
  }

  function closeAssistant() {
    state.root?.remove();
    state.root = null;
    saveAssistantState({ enabled: false });
  }

  function buildAssistant() {
    const root = create("aside", "lsa-assistant");
    root.setAttribute("aria-label", "锁屏编辑助手悬浮窗");
    root.innerHTML = `
      <header class="lsa-assistant-header">
        <div class="lsa-assistant-logo">锁</div>
        <div class="lsa-assistant-name"><strong>锁屏编辑助手</strong><small class="lsa-assistant-host">当前网页</small></div>
        <div class="lsa-window-actions">
          <button class="lsa-window-button lsa-minimize" type="button" title="最小化">—</button>
          <button class="lsa-window-button lsa-restore" type="button" title="关闭">×</button>
        </div>
      </header>
      <nav class="lsa-assistant-nav">
        <button class="lsa-tab-button is-active" data-tab="copy" type="button">文案改写</button>
        <button class="lsa-tab-button" data-tab="images" type="button">商用配图</button>
      </nav>
      <div class="lsa-assistant-body">
        <section class="lsa-tab-panel" data-panel="copy">
          <div class="lsa-section-card">
            <div class="lsa-section-row"><h2 class="lsa-section-title">原稿与合规文案</h2><button class="lsa-text-action lsa-read-page" type="button">重新读取页面</button></div>
            <p class="lsa-section-hint">可先保留长原稿；点击智能改写后生成完整、自然且不超限的内容。</p>
            <label class="lsa-field-label"><span>标题</span><span class="lsa-counter lsa-title-count">0 / 12</span></label>
            <input class="lsa-assistant-input lsa-floating-title" type="text" placeholder="输入原标题或从页面读取" />
            <label class="lsa-field-label"><span>简介</span><span class="lsa-counter lsa-summary-count">0 / 50</span></label>
            <textarea class="lsa-assistant-textarea lsa-floating-summary" placeholder="输入原简介，允许先超过 50 字"></textarea>
            <div class="lsa-button-row">
              <button class="lsa-primary-button lsa-rewrite-button" type="button">智能改写</button>
              <button class="lsa-secondary-button lsa-apply-draft" type="button">填写后台</button>
              <button class="lsa-secondary-button lsa-bind-fields" type="button">绑定字段</button>
            </div>
            <p class="lsa-status-text lsa-copy-status">标题限制 12 字，简介限制 50 字</p>
          </div>
        </section>
        <section class="lsa-tab-panel" data-panel="images" hidden>
          <div class="lsa-section-card">
            <div class="lsa-section-row"><h2 class="lsa-section-title">搜索可商用素材</h2><button class="lsa-text-action lsa-refresh-keywords" type="button">重算关键词</button></div>
            <p class="lsa-section-hint">根据标题和简介推荐关键词，结果优先横图。</p>
            <div class="lsa-keyword-chips"></div>
            <div class="lsa-search-row">
              <select class="lsa-source-select" aria-label="素材来源"><option value="openverse">Openverse</option><option value="pexels">Pexels</option></select>
              <input class="lsa-assistant-input lsa-stock-query" type="search" placeholder="图片搜索词" />
              <button class="lsa-primary-button lsa-search-button" type="button">搜索</button>
            </div>
            <p class="lsa-license-note"><a href="https://openverse.org/" target="_blank" rel="noopener noreferrer">素材由 Openverse 提供</a>并默认筛选商业使用许可；<a href="https://www.pexels.com/api/" target="_blank" rel="noopener noreferrer">Pexels 免费 API Key</a> 可在设置中填写。</p>
            <p class="lsa-status-text lsa-search-status"></p>
          </div>
          <div class="lsa-stock-results"><div class="lsa-empty-result">输入关键词后搜索，图片会在这里显示</div></div>
          <div class="lsa-pagination">
            <button class="lsa-secondary-button lsa-prev-page" type="button" disabled>上一页</button>
            <span class="lsa-page-number">第 1 页</span>
            <button class="lsa-secondary-button lsa-next-page" type="button" disabled>下一页</button>
          </div>
        </section>
      </div>
      <footer class="lsa-assistant-footer"><span>悬浮于网页最上层 · 草稿自动保存</span><button class="lsa-text-action lsa-open-settings" type="button">设置</button></footer>
    `;
    return root;
  }

  async function mountAssistant({ restore = false } = {}) {
    if (state.root) {
      if (state.root.classList.contains("is-minimized")) setMinimized(false);
      return;
    }
    const [{ settings: savedSettings = {} }, { draft = {}, assistantState = {} }] = await Promise.all([
      chrome.storage.sync.get("settings"),
      chrome.storage.local.get(["draft", "assistantState"]),
    ]);
    state.settings = { ...DEFAULT_SETTINGS, ...savedSettings, siteRules: savedSettings.siteRules || {} };
    state.root = buildAssistant();
    document.documentElement.append(state.root);
    if (assistantState.position) applyPosition(assistantState.position);
    if (assistantState.minimized) {
      state.root.classList.add("is-minimized");
      query(".lsa-restore").textContent = "□";
      query(".lsa-restore").title = "恢复";
    }

    query(".lsa-floating-title").value = draft.title || "";
    query(".lsa-floating-summary").value = draft.summary || "";
    query(".lsa-stock-query").value = draft.query || "";
    updateCounts();

    query(".lsa-assistant-header").addEventListener("pointerdown", startDrag);
    query(".lsa-minimize").addEventListener("click", () => setMinimized(true));
    query(".lsa-restore").addEventListener("click", () => {
      if (state.root.classList.contains("is-minimized")) setMinimized(false);
      else closeAssistant();
    });
    state.root.querySelectorAll(".lsa-tab-button").forEach((button) =>
      button.addEventListener("click", () => switchTab(button.dataset.tab)));
    query(".lsa-read-page").addEventListener("click", () => readPage(true));
    query(".lsa-rewrite-button").addEventListener("click", rewriteCopy);
    query(".lsa-apply-draft").addEventListener("click", applyDraft);
    query(".lsa-bind-fields").addEventListener("click", () => globalThis.__lsaPageTools.startBindingMode());
    query(".lsa-refresh-keywords").addEventListener("click", () => refreshKeywords(true));
    query(".lsa-search-button").addEventListener("click", () => searchStock(1));
    query(".lsa-stock-query").addEventListener("keydown", (event) => {
      if (event.key === "Enter") searchStock(1);
    });
    query(".lsa-prev-page").addEventListener("click", () => searchStock(Math.max(1, state.searchPage - 1)));
    query(".lsa-next-page").addEventListener("click", () => searchStock(state.searchPage + 1));
    query(".lsa-open-settings").addEventListener("click", () => chrome.runtime.sendMessage({ type: "OPEN_OPTIONS" }));
    for (const input of [query(".lsa-floating-title"), query(".lsa-floating-summary")]) {
      input.addEventListener("input", () => {
        updateCounts();
        scheduleDraftSave();
      });
      input.addEventListener("change", () => refreshKeywords(false));
    }
    query(".lsa-stock-query").addEventListener("input", scheduleDraftSave);
    window.addEventListener("resize", () => {
      const rect = state.root?.getBoundingClientRect();
      if (rect) applyPosition({ left: rect.left, top: rect.top });
    });

    refreshKeywords(!draft.query);
    await readPage(false);
    if (!restore) await saveAssistantState({ enabled: true });
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type !== "TOGGLE_FLOATING_ASSISTANT") return;
    if (state.root) closeAssistant();
    else mountAssistant().catch(() => {});
    sendResponse({ ok: true });
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync" || !changes.settings?.newValue) return;
    state.settings = { ...state.settings, ...changes.settings.newValue };
    updateCounts();
  });

  chrome.storage.local.get("assistantState").then(({ assistantState = {} }) => {
    if (assistantState.enabled !== false) mountAssistant({ restore: true }).catch(() => {});
  });
})();
