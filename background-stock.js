(function initBackgroundStock(global) {
  const EXPOSED_SKIN_TERMS = [
    "nude", "nudity", "naked", "topless", "shirtless", "lingerie", "underwear", "bikini",
    "swimsuit", "swimwear", "cleavage", "erotic", "boudoir", "seductive", "sexy",
  ];
  const FRONTAL_FACE_TERMS = [
    "headshot", "selfie", "looking at camera", "facing camera", "front portrait", "close-up face",
    "close up face", "facial portrait",
  ];
  const SAFE_PERSON_POSE_TERMS = [
    "side profile", "profile view", "back view", "from behind", "silhouette", "shadow", "rear view",
  ];
  const PERSON_TERMS = [
    "person", "people", "woman", "women", "man", "men", "girl", "boy", "child", "adult", "model",
    "lady", "gentleman", "couple", "family", "worker", "traveler", "traveller",
  ];
  const BANGLADESH_ANIMAL_TERMS = [
    "animal", "wildlife", "pet", "cat", "kitten", "dog", "puppy", "bird", "horse", "cow", "cattle",
    "rabbit", "lion", "tiger", "elephant", "monkey", "deer", "bear", "sheep", "goat", "chicken", "duck",
  ];
  const BANGLADESH_ALLOWED_ANIMAL_TERMS = ["butterfly", "butterflies", "fish", "fishes", "aquarium"];
  const BANGLADESH_ANIMATION_TERMS = ["anime", "cartoon", "illustration", "animated", "3d render"];
  const BANGLADESH_RESTRICTED_THEME_TERMS = ["pork", "pig", "bacon", "ham", "love", "romance", "romantic", "lover", "couple kissing"];
  const containsWholeTerm = (text, term) => new RegExp(`\\b${term.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\b`, "i").test(text);

  function inspectImageMetadataSafety(item, bangladeshMode = false) {
    const text = `${item.title || ""} ${item.attribution || ""}`.toLowerCase();
    const exposure = EXPOSED_SKIN_TERMS.find((term) => text.includes(term));
    if (exposure) return { safetyStatus: "rejected", safetyReason: `元数据含高裸露风险词：${exposure}` };
    const frontal = FRONTAL_FACE_TERMS.find((term) => text.includes(term));
    if (frontal) return { safetyStatus: "rejected", safetyReason: `元数据显示可能为正脸特写：${frontal}` };
    if (bangladeshMode) {
      const person = PERSON_TERMS.find((term) => containsWholeTerm(text, term));
      if (person) return { safetyStatus: "rejected", safetyReason: `孟加拉模式：元数据含人物（${person}）` };
      const restrictedTheme = BANGLADESH_RESTRICTED_THEME_TERMS.find((term) => containsWholeTerm(text, term));
      if (restrictedTheme) return { safetyStatus: "rejected", safetyReason: `孟加拉模式：元数据含禁忌主题（${restrictedTheme}）` };
      const allowedAnimal = BANGLADESH_ALLOWED_ANIMAL_TERMS.some((term) => containsWholeTerm(text, term));
      const animal = !allowedAnimal && BANGLADESH_ANIMAL_TERMS.find((term) => containsWholeTerm(text, term));
      if (animal) {
        const animated = BANGLADESH_ANIMATION_TERMS.some((term) => text.includes(term));
        return animated
          ? { safetyStatus: "review", safetyReason: `孟加拉模式：疑似动画动物（${animal}），必须人工确认不是写实动物且占比合规` }
          : { safetyStatus: "rejected", safetyReason: `孟加拉模式：元数据含非蝴蝶/鱼类动物（${animal}）` };
      }
      if (Math.min(Number(item.width) || 0, Number(item.height) || 0) < 800) {
        return { safetyStatus: "rejected", safetyReason: "孟加拉模式：图片短边低于 800px" };
      }
    }
    const safePose = SAFE_PERSON_POSE_TERMS.find((term) => text.includes(term));
    if (safePose) return { safetyStatus: "passed", safetyReason: `元数据显示为可用人物姿态：${safePose}` };
    if (PERSON_TERMS.some((term) => new RegExp(`\\b${term}\\b`, "i").test(text))) {
      return { safetyStatus: "review", safetyReason: "图片包含人物，元数据无法确认是否正脸或裸露，请在上传前看缩略图复核" };
    }
    return { safetyStatus: "passed", safetyReason: "元数据未发现正脸或高裸露风险词" };
  }

  function buildSafeStockQuery(query, bangladeshMode = false) {
    const base = String(query || "").replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
    if (!base) throw new Error("请输入图片搜索词");
    const lower = base.toLowerCase();
    const humanQueryTerms = [
      ...PERSON_TERMS,
      "president", "politician", "leader", "doctor", "teacher", "farmer", "athlete", "singer",
      "actor", "actress", "tourist", "mother", "father", "crowd", "pedestrian", "human",
    ];
    if (bangladeshMode) {
      const exclusions = "still life objects scenery detail no people no animals no romance";
      return humanQueryTerms.some((term) => containsWholeTerm(lower, term))
        ? `${base} objects scenery detail no people no animals no romance`.trim()
        : `${base} ${exclusions}`.trim();
    }
    if (!humanQueryTerms.some((term) => new RegExp(`\\b${term}\\b`, "i").test(lower))) return base;
    const additions = ["side profile", "back view", "silhouette", "fully clothed", "wide shot"]
      .filter((term) => !lower.includes(term));
    return `${base} ${additions.join(" ")}`.trim();
  }

  global.LSABackgroundStock = Object.freeze({
    PERSON_TERMS, BANGLADESH_RESTRICTED_THEME_TERMS,
    containsWholeTerm, inspectImageMetadataSafety, buildSafeStockQuery,
  });
})(globalThis);
