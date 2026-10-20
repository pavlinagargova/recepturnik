(function (publish) {
  // Cyrillic is not a word character in JavaScript, so \b does not work for units like "г" or "мл".
  const UNIT = "(?:кг|гр|г|мл|литри|литра|литър|л|щипки|щипка|скилидки|скилидка|глави|глава|връзки|връзка|чаши|чаша|с\\.\\s*л\\.?|ч\\.\\s*л\\.?|супени|супена|чаени|чаена|броя|бр\\.)";
  const unitPattern = new RegExp("(?:^|[\\s,(])" + UNIT + "(?=$|[\\s,.)])", "i");

  function cleanLine(line) {
    return line
      .replace(/^#{1,6}\s+/, "")
      .replace(/^[*\u2022\u00b7]\s+/, "")
      .replace(/^[\u2013\u2014]\s+/, "")
      .replace(/^-\s+/, "")
      .replace(/^\d{1,2}[.)]\s+/, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function looksLikeIngredient(line) {
    if (!line || line.length > 90) return false;
    if (/^(?:\d+(?:[.,]\d+)?|[\u00BC\u00BD\u00BE\u2153\u2154])(?:\s|$)/.test(line)) return true;
    if (/^\d+(?:[.,]\d+)?\s?(?:g|kg|ml|l)\b/i.test(line)) return true;
    if (/\b(?:cups?|tbsp|tsp|grams?|oz)\b/i.test(line)) return true;
    return unitPattern.test(line);
  }

  function matchHeader(line) {
    const ingredient = line.match(/^(съставки|необходими продукти|продукти|какво ще ни трябва|ingredients|you will need)(?=$|[\s:\-])\s*[:\-]?\s*(.*)$/i);
    if (ingredient && ingredient[2].length < 80) {
      return { mode: "ingredients", rest: ingredient[2].trim() };
    }
    const step = line.match(/^(начин на приготвяне|приготвяне|приготовление|инструкции|instructions|method|directions|steps|preparation)(?=$|[\s:\-])\s*[:\-]?\s*(.*)$/i);
    if (step && step[2].length < 140) {
      return { mode: "steps", rest: step[2].trim() };
    }
    return null;
  }

  function matchServings(line) {
    if (line.length > 40) return "";
    const labeled = line.match(/^(?:порции|servings|serves|yield)(?=$|[\s:\-])[\s:\-]{0,8}(.+)$/i);
    if (labeled) return labeled[1].trim();
    const plain = line.match(/^(\d+(?:\s*-\s*\d+)?)\s*порци[ия]$/i);
    return plain ? plain[1] : "";
  }

  function matchTime(line) {
    if (line.length > 70) return "";
    const match = line.match(/^(?:време(?:\s+за\s+приготвяне)?|общо време|prep(?:aration)? time|cook time|total time|time)(?=$|[\s:\-])[\s:\-]{0,8}(.+)$/i);
    return match ? match[1].trim() : "";
  }

  function isNoise(line) {
    return /^(реклама|сподели|share|print|отпечатване|коментари|оценете рецептата|подобни рецепти)$/i.test(line);
  }

  function classifyLoose(line) {
    if (looksLikeIngredient(line)) return "ingredients";
    if (line.length > 55 || ((/[.!?]$/.test(line)) && line.length > 20)) return "steps";
    if (line.length <= 40) return "ingredients";
    return "steps";
  }

  function parseRecipeText(raw) {
    const result = {
      title: "",
      servings: "",
      time: "",
      sourceUrl: "",
      ingredients: [],
      steps: [],
    };
    const lines = String(raw || "").replace(/\r/g, "").replace(/\u00a0/g, " ").split("\n");
    let mode = "";
    let sawHeader = false;
    const loose = [];

    for (const original of lines) {
      const line = cleanLine(original);
      if (!line || /^[-=_*]{3,}$/.test(line) || isNoise(line)) continue;

      const header = matchHeader(line);
      if (header) {
        mode = header.mode;
        sawHeader = true;
        if (header.rest) result[mode].push(header.rest);
        continue;
      }

      if (!result.sourceUrl && /^https?:\/\/\S+$/i.test(line)) {
        result.sourceUrl = line;
        continue;
      }

      const servings = matchServings(line);
      if (servings && !result.servings) {
        result.servings = servings;
        continue;
      }

      const time = matchTime(line);
      if (time && !result.time) {
        result.time = time;
        continue;
      }

      if (!result.title && !sawHeader && line.length <= 90 && !looksLikeIngredient(line) && !/[.!?]$/.test(line)) {
        result.title = line.replace(/[:\s]+$/, "");
        continue;
      }

      if (mode === "ingredients" || mode === "steps") result[mode].push(line);
      else loose.push(line);
    }

    if (!sawHeader) {
      for (const line of loose) result[classifyLoose(line)].push(line);
    } else {
      for (const line of loose) {
        if (looksLikeIngredient(line)) result.ingredients.push(line);
      }
    }

    result.ingredients = result.ingredients.map(splitIngredient).filter(Boolean).slice(0, 80);
    result.steps = result.steps.map((item) => item.trim()).filter(Boolean).slice(0, 80);
    return result;
  }

  function canonicalUnit(raw) {
    const value = String(raw || "").toLowerCase().replace(/[\s.]+/g, "");
    if (!value) return "";
    if (value === "кг" || value === "kg") return "кг";
    if (value === "г" || value === "гр" || value === "g" || value === "gr") return "гр";
    if (value === "мл" || value === "ml") return "мл";
    if (value === "л" || value.indexOf("лит") === 0) return "л";
    if (value.indexOf("щип") === 0) return "щипка";
    if (value.indexOf("скилид") === 0) return "скилидка";
    if (value.indexOf("глав") === 0) return "глава";
    if (value.indexOf("връз") === 0) return "връзка";
    if (value.indexOf("чаш") === 0) return "чаша";
    if (value.indexOf("чл") === 0 || value.indexOf("чаен") === 0) return "ч.л.";
    if (value.indexOf("сл") === 0 || value.indexOf("супен") === 0) return "с.л.";
    if (value.indexOf("бр") === 0) return "бр.";
    return "";
  }

  function splitIngredient(line) {
    const text = String(line || "").replace(/\s+/g, " ").trim();
    if (!text) return null;
    const match = text.match(/^(\d+(?:[.,]\d+)?(?:\s*[-–]\s*\d+(?:[.,]\d+)?)?|\d+\s*\/\s*\d+|[¼½¾⅓⅔])\s*(кг|гр|г|мл|литри|литра|литър|л|щипки|щипка|скилидки|скилидка|глави|глава|връзки|връзка|чаши|чаша|с\.\s*л\.?|ч\.\s*л\.?|супени лъжици|супена лъжица|чаени лъжици|чаена лъжица|броя|бр\.?)?\s+(.+)$/i);
    if (!match) return { name: text.slice(0, 160), amount: "", unit: "" };
    const name = match[3].replace(/^[,.\s]+/, "").trim();
    if (!name) return { name: text.slice(0, 160), amount: "", unit: "" };
    return {
      name: name.slice(0, 160),
      amount: match[1].replace(/\s+/g, ""),
      unit: canonicalUnit(match[2] || ""),
    };
  }

  publish({ parseRecipeText, splitIngredient });
})(function (api) {
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.RecipeParse = api;
});
