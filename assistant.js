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

  const ENGLISH_STOP_WORDS = new Set([
    "the", "and", "for", "with", "from", "this", "that", "these", "those", "into", "about",
    "according", "report", "reports", "reported", "news", "latest", "today", "says", "said",
    "will", "would", "has", "have", "had", "are", "was", "were", "been", "being", "their",
    "more", "than", "after", "before", "over", "under", "during", "through", "while", "which",
  ]);

  const VISUAL_TRANSLATIONS = [
    ["人工智能", "artificial intelligence"], ["机器人", "robot"], ["科技", "technology"],
    ["手机", "smartphone"], ["电脑", "computer"], ["芯片", "microchip"], ["互联网", "internet"],
    ["汽车", "car"], ["新能源", "electric vehicle"], ["交通", "transportation"], ["高铁", "high speed train"],
    ["飞机", "airplane"], ["航天", "space exploration"], ["火箭", "rocket"], ["卫星", "satellite"],
    ["城市", "city"], ["建筑", "architecture"], ["乡村", "countryside"], ["旅游", "travel"],
    ["自然", "nature"], ["风景", "landscape"], ["森林", "forest"], ["山", "mountain"],
    ["海", "ocean"], ["河流", "river"], ["湖", "lake"], ["沙漠", "desert"],
    ["天气", "weather"], ["暴雨", "rainstorm"], ["雨", "rain"], ["雪", "snow"],
    ["春天", "spring"], ["夏天", "summer"], ["秋天", "autumn"], ["冬天", "winter"],
    ["健康", "healthcare"], ["医生", "doctor"], ["医院", "hospital"], ["运动", "sports"],
    ["足球", "football"], ["篮球", "basketball"], ["教育", "education"], ["学校", "school"],
    ["学生", "students"], ["文化", "culture"], ["艺术", "art"], ["博物馆", "museum"],
    ["音乐", "music"], ["电影", "cinema"], ["美食", "food"], ["农业", "agriculture"],
    ["家庭", "family"], ["儿童", "children"], ["老人", "elderly people"], ["女性", "woman"],
    ["男性", "man"], ["工作", "workplace"], ["商业", "business"], ["经济", "economy"],
    ["环保", "environment"], ["能源", "energy"], ["动物", "wildlife"], ["宠物", "pets"],
  ];

  const LANGUAGE_NAMES = {
    vi: "越南语 / Vietnamese",
    es: "西班牙语 / Spanish",
    ru: "俄语 / Russian",
    be: "白俄罗斯语 / Belarusian",
    en: "英语 / English",
    ar: "阿拉伯语 / Arabic",
    zh: "中文 / Chinese",
  };

  const state = {
    root: null,
    settings: { ...DEFAULT_SETTINGS },
    pageContext: {},
    selectedKeywords: new Set(),
    keywords: [],
    searchPage: 1,
    searchHasNext: false,
    saveTimer: null,
    resizeSaveTimer: null,
    resizeObserver: null,
    dragging: null,
    originalCopy: { title: "", summary: "" },
    sourceLanguage: { code: "und", label: "原稿语言" },
    lastAutoSearchKey: "",
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

  function formatOriginalCopy(title = "", summary = "") {
    if (!title && !summary) return "";
    return `${cleanText(title)}////${cleanText(summary)}`;
  }

  function parseOriginalCopy(value = "") {
    const separatorIndex = String(value).indexOf("////");
    if (separatorIndex < 0) return { title: cleanText(value), summary: "" };
    return {
      title: cleanText(String(value).slice(0, separatorIndex)),
      summary: cleanText(String(value).slice(separatorIndex + 4)),
    };
  }

  function formatDraftCopy(title = "", summary = "") {
    if (!title && !summary) return "";
    return `${String(title).trim()}\n${String(summary).trim()}`.trim();
  }

  function parseDraftCopy(value = "") {
    const lines = String(value).replace(/\r\n?/g, "\n").split("\n");
    while (lines.length && !lines[0].trim()) lines.shift();
    const title = cleanText(lines.shift() || "");
    const summary = cleanText(lines.join(" "));
    return { title, summary };
  }

  function normalizeLanguageCode(code = "") {
    const base = String(code).toLowerCase().split(/[-_]/)[0];
    if (base === "iw") return "he";
    return base || "und";
  }

  function fallbackLanguageDetection(value) {
    const text = cleanText(value);
    if (/[\u0600-\u06ff]/.test(text)) return "ar";
    if (/[ăâđêôơưĂÂĐÊÔƠƯàáạảãầấậẩẫằắặẳẵèéẹẻẽềếệểễìíịỉĩòóọỏõồốộổỗờớợởỡùúụủũừứựửữỳýỵỷỹ]/i.test(text)) return "vi";
    if (/[ñ¿¡]/i.test(text) || /\b(?:el|la|los|las|una|para|con|por|del|que)\b/i.test(text)) return "es";
    if (/[\u0400-\u04ff]/.test(text)) return "ru";
    if (/[A-Za-z]/.test(text)) return "en";
    if (/[\u3400-\u9fff]/.test(text)) return "zh";
    return "und";
  }

  async function detectTextLanguage(value) {
    const text = cleanText(value).slice(0, 1000);
    let code = fallbackLanguageDetection(text);
    let reliable = false;
    let confidence = 0;
    try {
      const result = await chrome.i18n.detectLanguage(text);
      const primary = result?.languages?.[0];
      if (primary?.language) {
        code = normalizeLanguageCode(primary.language);
        confidence = Number(primary.percentage) || 0;
        reliable = Boolean(result.isReliable) || confidence >= 65;
      }
    } catch {
      // The script-based fallback above covers the editorial languages in use.
    }
    return {
      code,
      label: LANGUAGE_NAMES[code] || code.toUpperCase() || "原稿语言",
      reliable,
      confidence,
    };
  }

 function segmentWords(value) {
    if (typeof Intl.Segmenter !== "function") return graphemes(value);
    return [...new Intl.Segmenter("zh-CN", { granularity: "word" }).segment(value)]
      .filter((part) => part.isWordLike || /^[，。！？：；、,.!?:;،؛؟]$/.test(part.segment))
      .map((part) => part.segment);
  }

 function extractEnglishKeywords(value) {
    const words = cleanText(value).match(/[A-Za-z][A-Za-z'-]{1,30}|\d{2,4}/g) || [];
    const selected = [];
    for (const word of words) {
      const normalized = word.toLowerCase();
      if (ENGLISH_STOP_WORDS.has(normalized) || selected.includes(normalized)) continue;
      selected.push(normalized);
      if (selected.length >= 10) break;
    }
    return selected.join(" ");
  }

  function dictionaryEnglishQuery(title, summary) {
    const source = `${title} ${summary}`;
    const terms = [];
    const latinTerms = source.match(/[A-Za-z][A-Za-z0-9.+#_-]{1,24}/g) || [];
    for (const term of latinTerms) {
      if (
        state.sourceLanguage.code !== "en" &&
        !/\d/.test(term) &&
        !/^[A-Z]{2,}$/.test(term)
      ) continue;
      const normalized = term.toLowerCase();
      if (!terms.includes(normalized)) terms.push(normalized);
    }
    for (const [chinese, english] of VISUAL_TRANSLATIONS) {
      if (source.includes(chinese) && !terms.includes(english)) terms.push(english);
      if (terms.length >= 8) break;
    }
    if (!terms.length) terms.push("editorial", "documentary", "news", "photography");
    return terms.slice(0, 10).join(" ");
  }

  function applyEnglishQuery(value) {
    const englishQuery = extractEnglishKeywords(value) || value.trim();
    const input = query(".lsa-stock-query");
    if (input) input.value = englishQuery;
    state.keywords = englishQuery.split(/\s+/).filter(Boolean).slice(0, 10);
    state.selectedKeywords = new Set(state.keywords);
    renderKeywords();
    scheduleDraftSave();
    return englishQuery;
  }

  async function generateEnglishQuery() {
    const title = state.originalCopy.title;
    const source = cleanText(title);
    if (!source) {
      setSearchStatus("请先读取原标题", true);
      return "";
    }

    if (state.sourceLanguage.code === "und") {
      state.sourceLanguage = await detectTextLanguage(source);
    }

    setSearchStatus("正在从原标题生成英文视觉关键词…");
    try {
      const response = await chrome.runtime.sendMessage({
        type: "GENERATE_IMAGE_QUERY",
        title: source,
      });
      if (response?.ok && response.configured && response.imageQueryEn) {
        const queryText = applyEnglishQuery(response.imageQueryEn);
        setSearchStatus("已由 AI 根据原标题生成英文视觉关键词");
        return queryText;
      }
    } catch {
      // Continue with Chrome's local translator and the built-in dictionary.
    }

    if (state.sourceLanguage.code === "en") {
      const englishQuery = extractEnglishKeywords(source) || "editorial documentary photography";
      applyEnglishQuery(englishQuery);
      setSearchStatus("AI 未配置或暂不可用，已直接从英文原标题提取视觉关键词");
      return englishQuery;
    }

    if ("Translator" in globalThis) {
      try {
        const availability = await globalThis.Translator.availability({
          sourceLanguage: state.sourceLanguage.code,
          targetLanguage: "en",
        });
        if (availability !== "unavailable") {
          const translator = await globalThis.Translator.create({
            sourceLanguage: state.sourceLanguage.code,
            targetLanguage: "en",
            monitor(monitor) {
              monitor.addEventListener("downloadprogress", (event) => {
                setSearchStatus(`首次使用正在下载本地翻译模型：${Math.round(event.loaded * 100)}%`);
              });
            },
          });
          const translated = await translator.translate(source);
          translator.destroy?.();
          const queryText = applyEnglishQuery(translated);
          setSearchStatus("已根据原标题生成英文素材关键词（Chrome 本地翻译）");
          return queryText;
        }
      } catch (error) {
        setSearchStatus(`本地翻译暂不可用，已使用内置视觉词典：${error.message}`, true);
      }
    }

    const fallback = dictionaryEnglishQuery(title, "");
    applyEnglishQuery(fallback);
    if (!query(".lsa-search-status")?.classList.contains("is-error")) {
      setSearchStatus("当前浏览器没有本地翻译模型，已使用内置视觉词典生成英文关键词");
    }
    return fallback;
  }

  async function autoSearchFromOriginalTitle(force = false) {
    const title = cleanText(state.originalCopy.title);
    const source = query(".lsa-source-select")?.value || "openverse";
    if (!title) return;
    const searchKey = `${source}|${title}`;
    if (!force && state.lastAutoSearchKey === searchKey) return;
    state.lastAutoSearchKey = searchKey;
    const englishQuery = await generateEnglishQuery();
    if (englishQuery) await searchStock(1, { ensureQuery: false });
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
    const { title, summary } = parseDraftCopy(query(".lsa-draft-copy")?.value || "");
    const titleCount = query(".lsa-title-count");
    const summaryCount = query(".lsa-summary-count");
    if (titleCount) {
      titleCount.textContent = `标题 ${textLength(title)} / ${state.settings.titleLimit}`;
      titleCount.classList.toggle("is-over", textLength(title) > state.settings.titleLimit);
    }
    if (summaryCount) {
      summaryCount.textContent = `简介 ${textLength(summary)} / ${state.settings.summaryLimit}`;
      summaryCount.classList.toggle("is-over", textLength(summary) > state.settings.summaryLimit);
    }
  }

  function scheduleDraftSave() {
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(() => {
      chrome.storage.local.set({
        draft: {
          sourceCopy: query(".lsa-original-copy")?.value || "",
          draftCopy: query(".lsa-draft-copy")?.value || "",
          title: parseDraftCopy(query(".lsa-draft-copy")?.value || "").title,
          summary: parseDraftCopy(query(".lsa-draft-copy")?.value || "").summary,
          query: query(".lsa-stock-query")?.value || "",
          originalTitle: state.originalCopy.title,
          originalSummary: state.originalCopy.summary,
          pageUrl: location.href,
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
    tokenize(state.originalCopy.title, 7, scores);
    tokenize(state.originalCopy.summary, 3, scores);
    tokenize(state.pageContext.selectedText, 5, scores);
    state.keywords = [...scores.entries()]
      .sort((left, right) => right[1] - left[1])
      .map(([word]) => word)
      .filter((word, index, all) => !all.slice(0, index).some((prior) => prior.includes(word)))
      .slice(0, 8);
    if (!state.keywords.length) state.keywords = ["新闻配图", "竖屏配图", "杂志锁屏"];
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
      const originalInput = query(".lsa-original-copy");
      if (force || !originalInput.value) {
        originalInput.value = formatOriginalCopy(sourceTitle, sourceSummary);
      }
      if (force || (!state.originalCopy.title && !state.originalCopy.summary)) {
        state.originalCopy = {
          title: cleanText(sourceTitle),
          summary: cleanText(sourceSummary),
        };
      }
      state.sourceLanguage = await detectTextLanguage(
        `${state.originalCopy.title} ${state.originalCopy.summary}`,
      );
      const host = query(".lsa-assistant-host");
      if (host) host.textContent = state.pageContext.hostname || "当前网页";
      updateCounts();
      refreshKeywords(false);
      scheduleDraftSave();
      setStatus("已按“标题////简介”读取页面原文，并自动搜索原标题配图");
      try {
        await autoSearchFromOriginalTitle(force);
      } catch (error) {
        setSearchStatus(error.message || "自动搜索图片失败", true);
      }
    } catch (error) {
      setStatus(error.message || "读取页面失败", true);
    }
  }

  async function applyDraft() {
    const draftValue = query(".lsa-draft-copy").value;
    const { title, summary } = parseDraftCopy(draftValue);
    if (!draftValue.includes("\n") || !title || !summary) {
      return setStatus("请输入两部分文案：第一行标题，换行后填写简介", true);
    }
    if (textLength(title) > state.settings.titleLimit || textLength(summary) > state.settings.summaryLimit) {
      return setStatus(`文案超限：标题最多 ${state.settings.titleLimit} 字，简介最多 ${state.settings.summaryLimit} 字`, true);
    }
    const result = await globalThis.__lsaPageTools.applyDraft(title, summary);
    setStatus(result.message, !result.ok);
  }

  async function copyOriginalCopy() {
    const input = query(".lsa-original-copy");
    const value = input?.value || "";
    if (!value) return setStatus("页面原稿为空，请先重新读取页面", true);

    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const activeElement = document.activeElement;
      const selectionStart = input.selectionStart;
      const selectionEnd = input.selectionEnd;
      input.focus();
      input.select();
      const copied = document.execCommand("copy");
      input.setSelectionRange(selectionStart, selectionEnd);
      if (activeElement && activeElement !== input) activeElement.focus?.();
      if (!copied) return setStatus("复制失败，请手动选择页面原稿", true);
    }
    setStatus("页面原稿已复制");
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
      const download = create("button", "lsa-image-action", "下载图片");
      download.type = "button";
      download.addEventListener("click", async () => {
        download.disabled = true;
        download.textContent = "下载中…";
        try {
          const response = await chrome.runtime.sendMessage({
            type: "DOWNLOAD_IMAGE",
            url: item.imageUrl,
            fileName: item.fileName,
          });
          if (!response?.ok) throw new Error(response?.error || "图片下载失败");
          setSearchStatus("图片已加入浏览器下载列表");
        } catch (error) {
          setSearchStatus(error.message || "图片下载失败", true);
        } finally {
          download.disabled = false;
          download.textContent = "下载图片";
        }
      });
      actions.append(download);
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

  async function searchStock(page = 1, { ensureQuery = true } = {}) {
    let searchQuery = query(".lsa-stock-query").value.trim();
    const source = query(".lsa-source-select").value;
    if (ensureQuery && (!searchQuery || /[\u3400-\u9fff]/.test(searchQuery))) {
      searchQuery = await generateEnglishQuery();
    }
    if (!searchQuery) return setSearchStatus("请先生成英文图片关键词", true);
    state.searchPage = page;
    renderSearchMessage("正在搜索允许商业使用的竖向图片…", "lsa-loading");
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
      const sourceMessages = {
        pexels: "图片由 Pexels 提供；已双重筛选为竖图，建议保留作者与来源",
        pixabay: "图片由 Pixabay 提供；已双重筛选为竖图，建议保留作者与来源",
        openverse: "Openverse 结果已筛选商业许可和竖向比例；使用前请核对具体条款",
      };
      setSearchStatus(sourceMessages[source] || "只显示实际高度大于宽度的竖向图片");
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

  function applySize(size) {
    if (!state.root || !size) return;
    const availableWidth = Math.max(240, window.innerWidth - 12);
    const availableHeight = Math.max(220, window.innerHeight - 12);
    const minWidth = Math.min(320, availableWidth);
    const minHeight = Math.min(300, availableHeight);
    const width = Math.max(minWidth, Math.min(availableWidth, Number(size.width) || 398));
    const height = Math.max(minHeight, Math.min(availableHeight, Number(size.height) || 720));
    state.root.style.width = `${width}px`;
    state.root.style.height = `${height}px`;
  }

  function observeAssistantSize() {
    if (!state.root || typeof ResizeObserver !== "function") return;
    state.resizeObserver = new ResizeObserver(() => {
      if (!state.root || state.root.classList.contains("is-minimized")) return;
      clearTimeout(state.resizeSaveTimer);
      state.resizeSaveTimer = setTimeout(() => {
        if (!state.root || state.root.classList.contains("is-minimized")) return;
        const rect = state.root.getBoundingClientRect();
        const position = clampPosition(rect.left, rect.top);
        applyPosition(position);
        saveAssistantState({
          size: { width: Math.round(rect.width), height: Math.round(rect.height) },
          position,
        });
      }, 180);
    });
    state.resizeObserver.observe(state.root);
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
    clearTimeout(state.resizeSaveTimer);
    state.resizeObserver?.disconnect();
    state.resizeObserver = null;
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
        <button class="lsa-tab-button is-active" data-tab="copy" type="button">文案填写</button>
        <button class="lsa-tab-button" data-tab="images" type="button">商用配图</button>
      </nav>
      <div class="lsa-assistant-body">
        <section class="lsa-tab-panel" data-panel="copy">
          <div class="lsa-section-card">
            <div class="lsa-section-row"><h2 class="lsa-section-title">原稿与待填写文案</h2><button class="lsa-text-action lsa-read-page" type="button">重新读取页面</button></div>
            <p class="lsa-section-hint">页面原稿按“标题////简介”合并显示；在下方粘贴第一行标题、换行后简介。</p>
            <div class="lsa-field-label"><span>页面原稿</span><span class="lsa-field-tools"><span>标题////简介</span><button class="lsa-text-action lsa-copy-original" type="button">复制原稿</button></span></div>
            <textarea class="lsa-assistant-textarea lsa-original-copy" placeholder="点击重新读取页面后显示：标题////简介"></textarea>
            <label class="lsa-field-label"><span>待填写文案</span><span><span class="lsa-counter lsa-title-count">标题 0 / 12</span> <span class="lsa-counter lsa-summary-count">简介 0 / 50</span></span></label>
            <textarea class="lsa-assistant-textarea lsa-draft-copy" placeholder="第一行输入标题&#10;换行后输入简介"></textarea>
            <div class="lsa-button-row">
              <button class="lsa-primary-button lsa-apply-draft" type="button">填写后台</button>
              <button class="lsa-secondary-button lsa-bind-fields" type="button">绑定字段</button>
            </div>
            <p class="lsa-status-text lsa-copy-status">自动把第一行识别为标题，其余内容识别为简介</p>
          </div>
        </section>
        <section class="lsa-tab-panel" data-panel="images" hidden>
          <div class="lsa-section-card">
            <div class="lsa-section-row"><h2 class="lsa-section-title">搜索可商用素材</h2><button class="lsa-text-action lsa-generate-english" type="button">重新搜索原标题</button></div>
            <p class="lsa-section-hint">读取原标题后自动总结英文视觉关键词并搜索；所有结果均为适合锁屏的竖向图片。</p>
            <div class="lsa-keyword-chips"></div>
            <div class="lsa-search-row">
              <select class="lsa-source-select" aria-label="素材来源"><option value="openverse">Openverse</option><option value="pexels">Pexels</option><option value="pixabay">Pixabay</option></select>
              <input class="lsa-assistant-input lsa-stock-query" type="search" placeholder="English image keywords" />
              <button class="lsa-primary-button lsa-search-button" type="button">搜索</button>
            </div>
            <p class="lsa-license-note"><a href="https://openverse.org/" target="_blank" rel="noopener noreferrer">Openverse</a> 无需密钥；<a href="https://www.pexels.com/api/" target="_blank" rel="noopener noreferrer">Pexels</a> 和 <a href="https://pixabay.com/api/docs/" target="_blank" rel="noopener noreferrer">Pixabay</a> 的免费 API Key 可在设置中填写。所有来源仅显示竖图。</p>
            <p class="lsa-status-text lsa-search-status"></p>
          </div>
          <div class="lsa-stock-results"><div class="lsa-empty-result">读取原标题后会自动搜索，图片将在这里显示</div></div>
          <div class="lsa-pagination">
            <button class="lsa-secondary-button lsa-prev-page" type="button" disabled>上一页</button>
            <span class="lsa-page-number">第 1 页</span>
            <button class="lsa-secondary-button lsa-next-page" type="button" disabled>下一页</button>
          </div>
        </section>
      </div>
      <footer class="lsa-assistant-footer"><span>拖动右下角调整大小 · 草稿自动保存</span><button class="lsa-text-action lsa-open-settings" type="button">设置</button></footer>
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
    if (assistantState.size) applySize(assistantState.size);
    if (assistantState.position) applyPosition(assistantState.position);
    if (assistantState.minimized) {
      state.root.classList.add("is-minimized");
      query(".lsa-restore").textContent = "□";
      query(".lsa-restore").title = "恢复";
    }
    observeAssistantSize();

    const samePageDraft = draft.pageUrl === location.href;
    query(".lsa-original-copy").value = samePageDraft
      ? draft.sourceCopy || formatOriginalCopy(draft.originalTitle, draft.originalSummary)
      : "";
    query(".lsa-draft-copy").value = samePageDraft
      ? draft.draftCopy || formatDraftCopy(draft.title, draft.summary)
      : "";
    query(".lsa-stock-query").value = samePageDraft ? draft.query || "" : "";
    state.originalCopy = {
      title: samePageDraft ? draft.originalTitle || draft.title || "" : "",
      summary: samePageDraft ? draft.originalSummary || draft.summary || "" : "",
    };
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
    query(".lsa-copy-original").addEventListener("click", copyOriginalCopy);
    query(".lsa-apply-draft").addEventListener("click", applyDraft);
    query(".lsa-bind-fields").addEventListener("click", () => globalThis.__lsaPageTools.startBindingMode());
    query(".lsa-generate-english").addEventListener("click", () => autoSearchFromOriginalTitle(true));
    query(".lsa-search-button").addEventListener("click", () => searchStock(1));
    query(".lsa-stock-query").addEventListener("keydown", (event) => {
      if (event.key === "Enter") searchStock(1);
    });
    query(".lsa-prev-page").addEventListener("click", () => searchStock(Math.max(1, state.searchPage - 1)));
    query(".lsa-next-page").addEventListener("click", () => searchStock(state.searchPage + 1));
    query(".lsa-source-select").addEventListener("change", () => autoSearchFromOriginalTitle(true));
    query(".lsa-open-settings").addEventListener("click", () => chrome.runtime.sendMessage({ type: "OPEN_OPTIONS" }));
    query(".lsa-original-copy").addEventListener("input", () => {
      state.originalCopy = parseOriginalCopy(query(".lsa-original-copy").value);
      refreshKeywords(false);
      scheduleDraftSave();
    });
    query(".lsa-draft-copy").addEventListener("input", () => {
      updateCounts();
      scheduleDraftSave();
    });
    query(".lsa-stock-query").addEventListener("input", scheduleDraftSave);
    window.addEventListener("resize", () => {
      if (state.root?.classList.contains("is-minimized")) return;
      const rect = state.root?.getBoundingClientRect();
      if (rect) {
        applySize({ width: rect.width, height: rect.height });
        applyPosition({ left: rect.left, top: rect.top });
      }
    });

    refreshKeywords(false);
    if (samePageDraft && draft.query) applyEnglishQuery(draft.query);
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
