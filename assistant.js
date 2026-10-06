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
    dragging: null,
    originalCopy: { title: "", summary: "" },
    hasRewritten: false,
    sourceLanguage: { code: "und", label: "原稿语言" },
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
      .filter((part) => part.isWordLike || /^[，。！？：；、,.!?:;،؛؟]$/.test(part.segment))
      .map((part) => part.segment);
  }

  function usesWordSpaces() {
    return !["zh", "ja", "ko"].includes(state.sourceLanguage.code);
  }

  function sentenceTerminator() {
    return state.sourceLanguage.code === "zh" ? "。" : ".";
  }

  function clauseSeparator() {
    if (state.sourceLanguage.code === "zh") return "，";
    if (state.sourceLanguage.code === "ar") return "، ";
    return ", ";
  }

  function fitAtBoundary(value, limit) {
    const cleaned = cleanText(value);
    if (textLength(cleaned) <= limit) return cleaned;
    const words = segmentWords(cleaned);
    const output = [];
    let size = 0;
    for (const word of words) {
      const previous = output.at(-1) || "";
      const punctuation = /^[，。！？：；、,.!?:;،؛؟]$/.test(word);
      const previousPunctuation = /^[，。！？：；、,.!?:;،؛؟]$/.test(previous);
      const spacer = usesWordSpaces() && output.length && !punctuation && !previousPunctuation ? " " : "";
      const wordSize = textLength(word);
      if (size + textLength(spacer) + wordSize > limit) break;
      if (spacer) output.push(spacer);
      output.push(word);
      size += textLength(spacer) + wordSize;
    }
    let result = output.join("").replace(/[，、：；,;،؛的和与及将把被在于\s]$/g, "");
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

    const clauses = source.split(/[：:，,،；;؛。！？!?؟｜|]/).map(cleanText).filter(Boolean);
    const complete = clauses.find((clause) => textLength(clause) >= 5 && textLength(clause) <= limit);
    if (complete) return complete;

    const joined = clauses.slice(0, 2).join(usesWordSpaces() ? " " : "").replace(/的最新消息|相关情况|有关内容/g, "");
    return fitAtBoundary(joined || source, limit);
  }

  function rewriteSummaryLocally(summary, title, limit) {
    let source = stripEditorialFiller(summary || title);
    source = source
      .replace(/(?:对此|同时|此外|另外)[，,]/g, "")
      .replace(/([。！？])\1+/g, "$1");
    if (textLength(source) <= limit) {
      return /[。！？.!?؟]$/.test(source) || textLength(source) === limit
        ? source
        : `${source}${sentenceTerminator()}`;
    }

    const titleTerms = new Set(segmentWords(title).filter((word) => textLength(word) >= 2));
    const clauses = source
      .split(/[。！？.!?؟；;؛]/)
      .flatMap((sentence) => sentence.split(/[，,،]/))
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
      const separator = selected.length ? textLength(clauseSeparator()) : 0;
      if (used + separator + textLength(item.clause) <= limit) {
        selected.push(item);
        used += separator + textLength(item.clause);
      }
    }
    selected.sort((left, right) => left.index - right.index);
    let result = selected.map((item) => item.clause).join(clauseSeparator());
    if (!result) result = fitAtBoundary(source, Math.max(1, limit - 1));
    result = result.replace(/[，、：；,;،؛的和与及将把被在于\s]$/g, "");
    if (textLength(result) < limit && !/[。！？.!?؟]$/.test(result)) result += sentenceTerminator();
    return fitAtBoundary(result, limit);
  }

  function localRewrite(title, summary) {
    const nextTitle = rewriteTitleLocally(title, summary, state.settings.titleLimit);
    const nextSummary = rewriteSummaryLocally(summary, nextTitle, state.settings.summaryLimit);
    return { title: nextTitle, summary: nextSummary };
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
    const title = state.originalCopy.title || query(".lsa-floating-title")?.value || "";
    const summary = state.originalCopy.summary || query(".lsa-floating-summary")?.value || "";
    const source = cleanText(`${title}。${summary}`);
    if (!source.replace(/[。\s]/g, "")) {
      setSearchStatus("请先读取原标题和原简介", true);
      return "";
    }

    if (state.sourceLanguage.code === "und") {
      state.sourceLanguage = await detectTextLanguage(source);
    }

    if (state.sourceLanguage.code === "en") {
      const englishQuery = extractEnglishKeywords(source) || "editorial documentary photography";
      applyEnglishQuery(englishQuery);
      setSearchStatus("原标题和原简介为英语，已直接提取英文视觉关键词");
      return englishQuery;
    }

    setSearchStatus("正在从原标题和原简介生成英文视觉关键词…");
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
          setSearchStatus("已根据改写前原稿生成英文素材关键词（Chrome 本地翻译）");
          return queryText;
        }
      } catch (error) {
        setSearchStatus(`本地翻译暂不可用，已使用内置视觉词典：${error.message}`, true);
      }
    }

    const fallback = dictionaryEnglishQuery(title, summary);
    applyEnglishQuery(fallback);
    if (!query(".lsa-search-status")?.classList.contains("is-error")) {
      setSearchStatus("当前浏览器没有本地翻译模型，已使用内置视觉词典生成英文关键词");
    }
    return fallback;
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
          originalTitle: state.originalCopy.title,
          originalSummary: state.originalCopy.summary,
          hasRewritten: state.hasRewritten,
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
      if (force || (!state.originalCopy.title && !state.originalCopy.summary)) {
        state.originalCopy = {
          title: cleanText(sourceTitle),
          summary: cleanText(sourceSummary),
        };
        state.hasRewritten = false;
      }
      state.sourceLanguage = await detectTextLanguage(
        `${state.originalCopy.title} ${state.originalCopy.summary}`,
      );
      const host = query(".lsa-assistant-host");
      if (host) host.textContent = state.pageContext.hostname || "当前网页";
      updateCounts();
      refreshKeywords(false);
      scheduleDraftSave();
      setStatus(`已读取页面原文，识别为${state.sourceLanguage.label}；改写将保持原语言`);
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
    if (!state.hasRewritten) {
      state.originalCopy = { title: titleInput.value.trim(), summary: summaryInput.value.trim() };
    }
    state.sourceLanguage = await detectTextLanguage(
      `${state.originalCopy.title} ${state.originalCopy.summary}`,
    );
    button.disabled = true;
    button.textContent = "正在改写…";
    setStatus("正在根据关键信息重写标题和简介");

    let result;
    let usedAi = false;
    let aiImageQuery = "";
    try {
      const response = await chrome.runtime.sendMessage({
        type: "REWRITE_COPY",
        title: state.originalCopy.title,
        summary: state.originalCopy.summary,
        context: state.pageContext.boundTitle || state.pageContext.boundSummary
          ? ""
          : [state.pageContext.heading, state.pageContext.description].filter(Boolean).join("；"),
        titleLimit: state.settings.titleLimit,
        summaryLimit: state.settings.summaryLimit,
        sourceLanguage: state.sourceLanguage.code,
        sourceLanguageLabel: state.sourceLanguage.label,
      });
      if (!response?.ok) throw new Error(response?.error || "AI 改写失败");
      if (response.configured) {
        const outputLanguage = await detectTextLanguage(`${response.title} ${response.summary}`);
        if (
          state.sourceLanguage.code !== "und" &&
          outputLanguage.code !== "und" &&
          state.sourceLanguage.code !== outputLanguage.code &&
          (outputLanguage.reliable || outputLanguage.confidence >= 70)
        ) {
          throw new Error(`AI 返回了${outputLanguage.label}，与原稿${state.sourceLanguage.label}不一致`);
        }
        result = localRewrite(response.title, response.summary);
        usedAi = true;
        aiImageQuery = response.imageQueryEn || "";
      } else {
        result = localRewrite(state.originalCopy.title, state.originalCopy.summary);
      }
    } catch (error) {
      result = localRewrite(state.originalCopy.title, state.originalCopy.summary);
      setStatus(`在线改写不可用，已改用本地智能精简：${error.message}`, true);
    }

    titleInput.value = result.title;
    summaryInput.value = result.summary;
    state.hasRewritten = true;
    updateCounts();
    refreshKeywords(false);
    scheduleDraftSave();
    if (aiImageQuery) applyEnglishQuery(aiImageQuery);
    else await generateEnglishQuery();
    if (!query(".lsa-copy-status")?.classList.contains("is-error")) {
      setStatus(usedAi
        ? `AI 语义改写完成，已保持${state.sourceLanguage.label}并校验 12/50 字限制`
        : `本地智能精简完成，内容保持${state.sourceLanguage.label}`);
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
      const use = create("button", "lsa-image-action is-use", "上传到后台");
      use.type = "button";
      use.addEventListener("click", async () => {
        use.disabled = true;
        use.textContent = "正在上传…";
        setSearchStatus("正在下载素材并写入后台图片上传控件…");
        const result = await globalThis.__lsaPageTools.uploadStockImage(item.imageUrl, item.fileName);
        setSearchStatus(result.message, !result.ok);
        if (result.needsBinding) globalThis.__lsaPageTools.startBindingMode();
        use.disabled = false;
        use.textContent = "上传到后台";
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
    let searchQuery = query(".lsa-stock-query").value.trim();
    const source = query(".lsa-source-select").value;
    if (!searchQuery || /[\u3400-\u9fff]/.test(searchQuery)) {
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
            <div class="lsa-section-row"><h2 class="lsa-section-title">搜索可商用素材</h2><button class="lsa-text-action lsa-generate-english" type="button">生成英文关键词</button></div>
            <p class="lsa-section-hint">从改写前原稿总结英文视觉关键词，并只搜索适合锁屏的竖向图片。</p>
            <div class="lsa-keyword-chips"></div>
            <div class="lsa-search-row">
              <select class="lsa-source-select" aria-label="素材来源"><option value="openverse">Openverse</option><option value="pexels">Pexels</option><option value="pixabay">Pixabay</option></select>
              <input class="lsa-assistant-input lsa-stock-query" type="search" placeholder="English image keywords" />
              <button class="lsa-primary-button lsa-search-button" type="button">搜索</button>
            </div>
            <p class="lsa-license-note"><a href="https://openverse.org/" target="_blank" rel="noopener noreferrer">Openverse</a> 无需密钥；<a href="https://www.pexels.com/api/" target="_blank" rel="noopener noreferrer">Pexels</a> 和 <a href="https://pixabay.com/api/docs/" target="_blank" rel="noopener noreferrer">Pixabay</a> 的免费 API Key 可在设置中填写。所有来源仅显示竖图。</p>
            <p class="lsa-status-text lsa-search-status"></p>
          </div>
          <div class="lsa-stock-results"><div class="lsa-empty-result">生成英文关键词后搜索，图片会在这里显示</div></div>
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

    const samePageDraft = draft.pageUrl === location.href;
    query(".lsa-floating-title").value = samePageDraft ? draft.title || "" : "";
    query(".lsa-floating-summary").value = samePageDraft ? draft.summary || "" : "";
    query(".lsa-stock-query").value = samePageDraft ? draft.query || "" : "";
    state.originalCopy = {
      title: samePageDraft ? draft.originalTitle || draft.title || "" : "",
      summary: samePageDraft ? draft.originalSummary || draft.summary || "" : "",
    };
    state.hasRewritten = samePageDraft && Boolean(draft.hasRewritten);
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
    query(".lsa-generate-english").addEventListener("click", generateEnglishQuery);
    query(".lsa-search-button").addEventListener("click", () => searchStock(1));
    query(".lsa-stock-query").addEventListener("keydown", (event) => {
      if (event.key === "Enter") searchStock(1);
    });
    query(".lsa-prev-page").addEventListener("click", () => searchStock(Math.max(1, state.searchPage - 1)));
    query(".lsa-next-page").addEventListener("click", () => searchStock(state.searchPage + 1));
    query(".lsa-open-settings").addEventListener("click", () => chrome.runtime.sendMessage({ type: "OPEN_OPTIONS" }));
    for (const input of [query(".lsa-floating-title"), query(".lsa-floating-summary")]) {
      input.addEventListener("input", () => {
        if (!state.hasRewritten) {
          state.originalCopy = {
            title: query(".lsa-floating-title").value,
            summary: query(".lsa-floating-summary").value,
          };
        }
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
