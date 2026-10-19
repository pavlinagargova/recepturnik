(function () {
  const STORAGE_KEY = "recepturnik.v1";
  const COLORS = ["#8a3b1e", "#c47a3a", "#2f4a36", "#3d6b58", "#3d5a73", "#7a3e55", "#6a4632", "#8a6a2f", "#6d6256"];
  const DEFAULT_NAMES = ["Закуски", "Супи", "Салати", "Основни", "Тестени", "Десерти", "Хляб", "Напитки", "Други"];

  const state = {
    route: { name: "list" },
    query: "",
    categoryId: "all",
    checks: {},
  };

  let db = loadState();
  let isDirty = function () { return false; };
  let categoryEditing = null;
  let toastTimer = 0;

  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "id-" + Date.now().toString(16) + "-" + Math.random().toString(16).slice(2);
  }

  function el(tag, props, children) {
    const node = document.createElement(tag);
    const attrs = props || {};
    Object.keys(attrs).forEach(function (key) {
      const value = attrs[key];
      if (value == null || value === false) return;
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key.indexOf("on") === 0 && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value);
      else node.setAttribute(key, value === true ? "" : String(value));
    });
    const list = Array.isArray(children) ? children : children == null ? [] : [children];
    list.forEach(function (child) {
      if (child == null || child === false) return;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    });
    return node;
  }

  function cleanString(value, max) {
    return typeof value === "string" ? value.trim().slice(0, max) : "";
  }

  function cleanColor(value, fallback) {
    return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : fallback;
  }

  function cleanDate(value) {
    const time = Date.parse(value);
    return Number.isNaN(time) ? new Date().toISOString() : new Date(time).toISOString();
  }

  function stringList(value, maxItems, maxLength) {
    if (!Array.isArray(value)) return [];
    return value.map(function (item) { return cleanString(item, maxLength); }).filter(Boolean).slice(0, maxItems);
  }

  function blankState() {
    return {
      version: 1,
      categories: DEFAULT_NAMES.map(function (name, index) {
        return { id: uid(), name: name, color: COLORS[index % COLORS.length] };
      }),
      recipes: [],
    };
  }

  function sanitizeCategory(category, index) {
    if (!category || typeof category !== "object") return null;
    const name = cleanString(category.name, 40);
    if (!name) return null;
    return {
      id: cleanString(category.id, 80) || uid(),
      name: name,
      color: cleanColor(category.color, COLORS[index % COLORS.length]),
    };
  }

  function sanitizeRecipe(recipe) {
    if (!recipe || typeof recipe !== "object") return null;
    const title = cleanString(recipe.title, 120);
    if (!title) return null;
    const createdAt = cleanDate(recipe.createdAt);
    return {
      id: cleanString(recipe.id, 80) || uid(),
      title: title,
      categoryId: cleanString(recipe.categoryId, 80),
      sourceUrl: cleanString(recipe.sourceUrl, 500),
      servings: cleanString(recipe.servings, 40),
      time: cleanString(recipe.time, 40),
      ingredients: stringList(recipe.ingredients, 80, 300),
      steps: stringList(recipe.steps, 80, 2000),
      notes: cleanString(recipe.notes, 5000),
      favorite: Boolean(recipe.favorite),
      createdAt: createdAt,
      updatedAt: cleanDate(recipe.updatedAt || createdAt),
    };
  }

  function sanitizeState(data) {
    const categories = Array.isArray(data.categories) ? data.categories.map(sanitizeCategory).filter(Boolean) : [];
    const recipes = Array.isArray(data.recipes) ? data.recipes.map(sanitizeRecipe).filter(Boolean) : [];
    return {
      version: 1,
      categories: categories.length ? categories : blankState().categories,
      recipes: recipes,
    };
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return blankState();
      const data = JSON.parse(raw);
      if (!data || typeof data !== "object") return blankState();
      return sanitizeState(data);
    } catch (error) {
      return blankState();
    }
  }

  const UID_KEY = "recepturnik.uid";
  let cloudUser = null;
  let remoteTimer = 0;
  let syncing = false;

  function bookPayload() {
    return {
      version: 1,
      categories: db.categories,
      recipes: db.recipes,
      updatedAt: new Date().toISOString(),
    };
  }

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
    } catch (error) {
      toast("Не успях да запазя. Паметта на браузъра може да е пълна.");
      return;
    }
    queueRemoteSave();
  }

  function queueRemoteSave() {
    if (!cloudUser || syncing) return;
    window.clearTimeout(remoteTimer);
    remoteTimer = window.setTimeout(writeRemote, 400);
  }

  function writeRemote() {
    if (!cloudUser) return;
    return firebase.firestore().collection("books").doc(cloudUser.uid).set(bookPayload()).catch(function () {
      toast("Не успях да запиша в базата. В браузъра копието е запазено.");
    });
  }

  async function adoptRemote(user) {
    syncing = true;
    window.clearTimeout(remoteTimer);
    try {
      const ref = firebase.firestore().collection("books").doc(user.uid);
      const snap = await ref.get();
      const previousUid = localStorage.getItem(UID_KEY);
      const localIsThisUser = !previousUid || previousUid === user.uid;
      if (snap.exists) {
        db = sanitizeState(snap.data() || {});
        localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
      } else if (localIsThisUser && db.recipes.length) {
        await ref.set(bookPayload());
      } else if (!localIsThisUser) {
        db = blankState();
        localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
      }
      localStorage.setItem(UID_KEY, user.uid);
    } finally {
      syncing = false;
    }
  }

  function downloadBackup(filename) {
    const blob = new Blob([JSON.stringify(db, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function recipeWord(count) {
    const mod10 = count % 10;
    const mod100 = count % 100;
    return mod10 === 1 && mod100 !== 11 ? "рецепта" : "рецепти";
  }

  function formatCount(count) {
    return count + " " + recipeWord(count);
  }

  function countWord(count, one, many) {
    const mod10 = count % 10;
    const mod100 = count % 100;
    return mod10 === 1 && mod100 !== 11 ? one : many;
  }

  function toast(message) {
    const node = document.querySelector("#toast");
    node.textContent = message;
    node.classList.add("show");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(function () { node.classList.remove("show"); }, 2800);
  }

  function ask(options) {
    const dialog = document.querySelector("#confirm-dialog");
    const ok = document.querySelector("#confirm-ok");
    const cancel = document.querySelector("#confirm-cancel");
    const extra = document.querySelector("#confirm-extra");
    document.querySelector("#confirm-title").textContent = options.title;
    document.querySelector("#confirm-text").textContent = options.text;
    ok.textContent = options.confirmLabel || "Потвърди";
    ok.className = options.danger ? "btn btn-danger" : "btn btn-primary";
    extra.hidden = !options.extraLabel;
    extra.textContent = options.extraLabel || "";
    return new Promise(function (resolve) {
      let settled = false;
      function finish(value) {
        if (settled) return;
        settled = true;
        resolve(value);
        if (dialog.open) dialog.close();
      }
      ok.onclick = function () { finish(options.confirmValue == null ? true : options.confirmValue); };
      cancel.onclick = function () { finish(false); };
      extra.onclick = function () { finish(options.extraValue || "extra"); };
      dialog.addEventListener("close", function () { finish(false); }, { once: true });
      dialog.addEventListener("keydown", function (event) {
        if (event.key === "Enter" && !options.danger) {
          event.preventDefault();
          finish(options.confirmValue == null ? true : options.confirmValue);
        }
      }, { once: true });
      dialog.showModal();
      (options.danger ? cancel : ok).focus();
    });
  }

  function findRecipe(id) {
    return db.recipes.find(function (recipe) { return recipe.id === id; }) || null;
  }

  function categoryOf(id) {
    return db.categories.find(function (category) { return category.id === id; }) || null;
  }

  function isRealCategory(id) {
    return Boolean(categoryOf(id));
  }

  function effectiveCategory(recipe) {
    return isRealCategory(recipe.categoryId) ? recipe.categoryId : "";
  }

  function matchesQuery(recipe) {
    const query = state.query.trim().toLowerCase();
    if (!query) return true;
    const blob = [recipe.title, recipe.notes, recipe.sourceUrl]
      .concat(recipe.ingredients, recipe.steps)
      .join("\n")
      .toLowerCase();
    return blob.indexOf(query) !== -1;
  }

  function visibleRecipes() {
    return db.recipes.filter(function (recipe) {
      if (!matchesQuery(recipe)) return false;
      if (state.categoryId === "favorites") return recipe.favorite;
      if (state.categoryId === "none") return !effectiveCategory(recipe);
      if (state.categoryId !== "all") return effectiveCategory(recipe) === state.categoryId;
      return true;
    }).sort(function (a, b) { return b.updatedAt.localeCompare(a.updatedAt); });
  }

  function syncTitle() {
    if (state.route.name === "detail") {
      const recipe = findRecipe(state.route.id);
      document.title = recipe ? recipe.title + " - Рецептурник" : "Рецептурник";
    } else if (state.route.name === "edit") {
      document.title = (state.route.id ? "Промяна" : "Нова рецепта") + " - Рецептурник";
    } else {
      document.title = "Рецептурник";
    }
  }

  function applyRoute(route) {
    state.route = route;
    render();
    window.scrollTo(0, 0);
  }

  function go(route) {
    if (state.route.name === "edit" && isDirty()) {
      ask({
        title: "Незапазени промени",
        text: "Ако продължиш, написаното в рецептата няма да се запази.",
        confirmLabel: "Продължи",
      }).then(function (ok) {
        if (!ok) return;
        isDirty = function () { return false; };
        applyRoute(route);
      });
      return;
    }
    isDirty = function () { return false; };
    applyRoute(route);
  }

  function setCategory(id) {
    state.categoryId = id;
    if (state.route.name !== "list") {
      go({ name: "list" });
      return;
    }
    renderSidebar();
    renderMain();
  }

  function updateCount() {
    const label = document.querySelector("#count-label");
    label.textContent = db.recipes.length ? formatCount(db.recipes.length) : "Празно засега";
  }

  function filterRow(id, label, count) {
    const row = el("div", { class: state.categoryId === id ? "cat-row is-active" : "cat-row" });
    const button = el("button", {
      type: "button",
      class: "cat",
      onclick: function () { setCategory(id); },
    }, [
      el("span", { class: "name" }, label),
      el("span", { class: "num" }, String(count)),
    ]);
    if (state.categoryId === id) button.setAttribute("aria-current", "true");
    row.append(button);
    return row;
  }

function renderSidebar() {
  const aside = document.querySelector("#sidebar");
  const filters = el("div", { class: "nav-scroll" });
  const searched = db.recipes.filter(matchesQuery);
  filters.append(
    filterRow("all", "Всички", searched.length),
    filterRow("favorites", "Любими", searched.filter(function (recipe) { return recipe.favorite; }).length)
  );
  if (db.recipes.some(function (recipe) { return !effectiveCategory(recipe); })) {
    filters.append(filterRow("none", "Без категория", searched.filter(function (recipe) { return !effectiveCategory(recipe); }).length));
  }

  db.categories.forEach(function (category) {
      const count = searched.filter(function (recipe) { return effectiveCategory(recipe) === category.id; }).length;
      const row = el("div", { class: state.categoryId === category.id ? "cat-row is-active" : "cat-row" });
      const button = el("button", {
        type: "button",
        class: "cat",
        onclick: function () { setCategory(category.id); },
      }, [
        el("span", { class: "dot" }),
        el("span", { class: "name" }, category.name),
        el("span", { class: "num" }, String(count)),
      ]);
      button.querySelector(".dot").style.background = category.color;
      if (state.categoryId === category.id) button.setAttribute("aria-current", "true");
      const edit = el("button", {
        type: "button",
        class: "cat-edit",
        "aria-label": "Промени " + category.name,
        onclick: function () { openCategoryDialog(category); },
      }, "✎");
      row.append(button, edit);
      filters.append(row);
    });

    aside.replaceChildren(
      el("p", { class: "side-label" }, "Категории"),
      filters,
      el("button", {
        type: "button",
        class: "btn btn-ghost",
        id: "add-category",
        onclick: function () { openCategoryDialog(null); },
      }, "Нова категория"),
      el("p", { class: "side-hint" }, "Рецептите са в акаунта ти. Същите те чакат и на телефона, и на компютъра.")
    );
  }

  function siteLabel(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch (error) {
      return url;
    }
  }

  function servingsLabel(value) {
    if (!value) return "";
    if (/порци/i.test(value)) return value;
    return value + " порции";
  }

  function formatDate(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleDateString("bg-BG", { day: "numeric", month: "long", year: "numeric" });
  }

  function previewText(recipe) {
    if (recipe.ingredients.length) return recipe.ingredients.slice(0, 3).join(", ");
    if (recipe.notes) return recipe.notes.slice(0, 90);
    if (recipe.sourceUrl) return siteLabel(recipe.sourceUrl);
    return "Без подробности";
  }

  function listHeading() {
    if (state.categoryId === "favorites") return "Любими";
    if (state.categoryId === "none") return "Без категория";
    const category = categoryOf(state.categoryId);
    return category ? category.name : "Всички рецепти";
  }

  function renderList() {
    const recipes = visibleRecipes();
    const query = state.query.trim();
    const head = el("div", { class: "list-head" }, [
      el("h2", {}, listHeading()),
      el("p", { class: "quiet" }, (recipes.length ? formatCount(recipes.length) : "0 рецепти") + (query ? " за «" + query + "»" : "")),
    ]);

    if (!db.recipes.length) {
      return el("section", { class: "empty" }, [
        el("div", { class: "plate", "aria-hidden": "true" }),
        el("h2", {}, "Все още няма рецепти"),
        el("p", { class: "lead" }, "Когато намериш нещо вкусно, запази го тук. Сложи категория, връзка към страницата и текста на рецептата."),
        el("p", { class: "quiet" }, "Затварянето на страницата не ги трие. На друго устройство влез със същия имейл."),
        el("div", { class: "actions" }, [
          el("button", { type: "button", class: "btn btn-primary", onclick: function () { go({ name: "edit" }); } }, "Нова рецепта"),
        ]),
      ]);
    }

    if (!recipes.length) {
      const inCategory = state.categoryId !== "all" && state.categoryId !== "favorites" && state.categoryId !== "none";
      return el("section", {}, [
        head,
        el("div", { class: "empty" }, [
          el("p", { class: "lead" }, query ? "Няма рецепти за това търсене." : "В тази категория няма нищо."),
          inCategory ? el("div", { class: "actions" }, [
            el("button", { type: "button", class: "btn btn-primary", onclick: function () { go({ name: "edit" }); } }, "Добави рецепта тук"),
          ]) : null,
        ]),
      ]);
    }

    const grid = el("div", { class: "grid" });
    recipes.forEach(function (recipe) {
      const category = categoryOf(effectiveCategory(recipe));
      const card = el("article", { class: "card" });
      card.dataset.id = recipe.id;
      card.style.borderTopColor = category ? category.color : "#d7cbb8";
      const open = el("button", {
        type: "button",
        class: "card-open",
        onclick: function () { go({ name: "detail", id: recipe.id }); },
      }, [
        el("p", { class: "pill" }, category ? category.name : "Без категория"),
        el("h3", {}, recipe.title),
        el("p", { class: "meta" }, [recipe.time, servingsLabel(recipe.servings)].filter(Boolean).join(" · ") || "Без време и порции"),
        el("p", { class: "preview" }, previewText(recipe)),
      ]);
      card.append(open, starButton(recipe));
      grid.append(card);
    });

    return el("section", {}, [head, grid]);
  }

  function starButton(recipe) {
    return el("button", {
      type: "button",
      class: "star",
      "aria-pressed": recipe.favorite ? "true" : "false",
      "aria-label": recipe.favorite ? "Махни от любими" : "Добави в любими",
      onclick: function (event) { toggleFavorite(recipe.id, event); },
    }, recipe.favorite ? "★" : "☆");
  }

  function toggleFavorite(id, event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    const recipe = findRecipe(id);
    if (!recipe) return;
    recipe.favorite = !recipe.favorite;
    persist();
    renderSidebar();
    if (state.route.name === "list" || (state.route.name === "detail" && state.route.id === id)) renderMain();
  }

  function renderDetail(recipe) {
    const category = categoryOf(effectiveCategory(recipe));
    const when = recipe.updatedAt !== recipe.createdAt
      ? "Променена на " + formatDate(recipe.updatedAt)
      : "Запазена на " + formatDate(recipe.createdAt);
    const meta = [recipe.time, servingsLabel(recipe.servings), when].filter(Boolean).join(" · ");
    const checks = state.checks[recipe.id] || {};

    const ingredients = el("ul");
    recipe.ingredients.forEach(function (item, index) {
      const input = el("input", { type: "checkbox" });
      input.checked = Boolean(checks[index]);
      const row = el("li");
      const label = el("label", { class: input.checked ? "ingredient done" : "ingredient" }, [
        input,
        el("span", {}, item),
      ]);
      input.addEventListener("change", function () {
        if (!state.checks[recipe.id]) state.checks[recipe.id] = {};
        state.checks[recipe.id][index] = input.checked;
        label.classList.toggle("done", input.checked);
      });
      row.append(label);
      ingredients.append(row);
    });

    const steps = el("ol", { class: "steps" });
    recipe.steps.forEach(function (step) {
      steps.append(el("li", {}, step));
    });

    const article = el("article", { class: "sheet recipe" }, [
      el("button", {
        type: "button",
        class: "linkish back",
        onclick: function () { go({ name: "list" }); },
      }, "Към рецептите"),
      el("p", { class: "kicker" }, category ? category.name : "Без категория"),
      el("h2", { class: "sheet-title" }, recipe.title),
      meta ? el("p", { class: "meta-line" }, meta) : null,
      (function () {
        if (!recipe.sourceUrl) return null;
        const href = normalizeUrl(recipe.sourceUrl);
        if (!href) return el("p", { class: "source" }, "Източник: " + recipe.sourceUrl);
        return el("p", { class: "source" }, [
          "Оригинал: ",
          el("a", { href: href, target: "_blank", rel: "noopener noreferrer" }, siteLabel(href)),
        ]);
      })(),
      el("div", { class: "recipe-actions" }, [
        starButton(recipe),
        el("button", { type: "button", class: "btn btn-primary", onclick: function () { go({ name: "edit", id: recipe.id }); } }, "Редактирай"),
        el("button", { type: "button", class: "btn btn-ghost", onclick: function () { window.print(); } }, "Печат"),
        el("button", { type: "button", class: "btn btn-danger", onclick: function () { deleteRecipe(recipe); } }, "Изтрий"),
      ]),
      el("div", { class: "recipe-columns" }, [
        recipe.ingredients.length ? el("section", { class: "ingredients" }, [
          el("h3", { class: "block-title" }, "Съставки"),
          ingredients,
        ]) : el("section", { class: "ingredients" }, [
          el("h3", { class: "block-title" }, "Съставки"),
          el("p", { class: "quiet" }, "Няма записани съставки."),
        ]),
        recipe.steps.length ? el("section", {}, [
          el("h3", { class: "block-title" }, "Начин на приготвяне"),
          steps,
        ]) : el("section", {}, [
          el("h3", { class: "block-title" }, "Начин на приготвяне"),
          el("p", { class: "quiet" }, "Няма записани стъпки."),
        ]),
      ]),
      recipe.notes ? el("section", { class: "notes" }, [
        el("h3", { class: "block-title" }, "Бележки"),
        el("p", {}, recipe.notes),
      ]) : null,
    ]);
    return article;
  }

  function deleteRecipe(recipe) {
    ask({
      title: "Изтриване",
      text: "Да се изтрие ли «" + recipe.title + "»? Това не може да се върне, освен ако нямаш свалено копие.",
      confirmLabel: "Изтрий",
      danger: true,
    }).then(function (ok) {
      if (!ok) return;
      db.recipes = db.recipes.filter(function (item) { return item.id !== recipe.id; });
      delete state.checks[recipe.id];
      persist();
      toast("Рецептата е изтрита");
      go({ name: "list" });
    });
  }

  function readForm() {
    const title = document.querySelector("#field-title");
    if (!title) return null;
    return {
      title: title.value.trim(),
      categoryId: document.querySelector("#field-category").value,
      time: document.querySelector("#field-time").value.trim(),
      servings: document.querySelector("#field-servings").value.trim(),
      sourceUrl: document.querySelector("#field-source").value.trim(),
      notes: document.querySelector("#field-notes").value.trim(),
      ingredients: Array.from(document.querySelectorAll("#ingredient-list input")).map(function (input) { return input.value.trim(); }).filter(Boolean),
      steps: Array.from(document.querySelectorAll("#step-list textarea")).map(function (input) { return input.value.trim(); }).filter(Boolean),
    };
  }

  function normalizeUrl(value) {
    const trimmed = String(value || "").trim();
    if (!trimmed) return "";
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : "https://" + trimmed;
    try {
      const url = new URL(withScheme);
      if (url.protocol !== "http:" && url.protocol !== "https:") return null;
      if (!url.hostname || url.hostname.indexOf(".") === -1) return null;
      return url.href;
    } catch (error) {
      return null;
    }
  }

  function classifySource(value) {
    const trimmed = value.trim();
    if (!trimmed) return "";
    const looksLikeUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) || /^[\w.-]+\.[a-z]{2,}([\/?#]|$)/i.test(trimmed);
    if (!looksLikeUrl) return trimmed;
    return normalizeUrl(trimmed);
  }

  function bindList(list, options) {
    function add(value, afterRow, focus) {
      const row = el("div", { class: options.multiline ? "line-row step-row" : "line-row" });
      const field = options.multiline
        ? el("textarea", { rows: "2", maxlength: "2000", placeholder: options.placeholder, "aria-label": options.label }, value || "")
        : el("input", { type: "text", value: value || "", maxlength: "300", placeholder: options.placeholder, "aria-label": options.label });
      const remove = el("button", { type: "button", class: "icon-btn", "aria-label": options.removeLabel }, "×");
      remove.addEventListener("click", function () {
        const previous = row.previousElementSibling;
        row.remove();
        if (!list.children.length) add("");
        else {
          const target = previous || list.querySelector(".line-row");
          const nextField = target.querySelector("input, textarea");
          if (nextField) nextField.focus();
        }
      });
      field.addEventListener("keydown", function (event) {
        if (!options.multiline && event.key === "Enter") {
          event.preventDefault();
          add("", row, true);
        }
        if (options.multiline && event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          add("", row, true);
        }
        if (!options.multiline && event.key === "Backspace" && field.value === "" && list.children.length > 1) {
          event.preventDefault();
          const previous = row.previousElementSibling;
          row.remove();
          const target = previous || list.querySelector(".line-row");
          if (target) target.querySelector("input, textarea").focus();
        }
      });
      row.append(field, remove);
      if (afterRow) afterRow.after(row);
      else list.append(row);
      if (focus) field.focus();
      return field;
    }

    function refill(values) {
      list.replaceChildren();
      if (!values.length) add("");
      else values.forEach(function (value) { add(value); });
    }

    return { add: add, refill: refill };
  }

  function renderEditor() {
    const existing = state.route.id ? findRecipe(state.route.id) : null;
    if (state.route.id && !existing) return renderMissing();

    const presetCategory = existing
      ? effectiveCategory(existing)
      : (isRealCategory(state.categoryId) ? state.categoryId : "");

    const form = el("form", { class: "sheet editor", id: "editor-form", autocomplete: "off" });
    const ingredientList = el("div", { class: "line-list", id: "ingredient-list" });
    const stepList = el("div", { class: "line-list step-list", id: "step-list" });
    const ingredients = bindList(ingredientList, {
      placeholder: "напр. 200 г сирене",
      label: "Съставка",
      removeLabel: "Премахни съставката",
    });
    const steps = bindList(stepList, {
      multiline: true,
      placeholder: "Какво се прави",
      label: "Стъпка",
      removeLabel: "Премахни стъпката",
    });
    ingredients.refill(existing && existing.ingredients.length ? existing.ingredients : []);
    steps.refill(existing && existing.steps.length ? existing.steps : []);

    const categorySelect = el("select", { id: "field-category", "aria-label": "Категория" });
    const pasteStatus = el("p", { class: "parse-status", id: "parse-status", role: "status" });
    const pasteArea = el("textarea", {
      id: "paste-text",
      placeholder: "Постави тук копирания текст от страницата",
    });

    const paste = el("details", { class: "paste" });
    if (!existing) paste.open = true;
    paste.append(
      el("summary", {}, "Имам текст от сайт"),
      el("p", { class: "help" }, "Копирай рецептата от страницата и я постави тук. Връзката сложи отделно, за да можеш да се върнеш към оригинала."),
      pasteArea,
      el("div", { class: "paste-actions" }, [
        el("button", { type: "button", class: "btn btn-ghost", onclick: pasteClipboard }, "Постави от клипборда"),
        el("button", { type: "button", class: "btn btn-primary", onclick: recognizeText }, "Разпознай текста"),
      ]),
      pasteStatus
    );

    form.append(
      el("button", {
        type: "button",
        class: "linkish back",
        onclick: function () { go(existing ? { name: "detail", id: existing.id } : { name: "list" }); },
      }, existing ? "Към рецептата" : "Към рецептите"),
      el("h2", {}, existing ? "Промяна" : "Нова рецепта"),
      el("div", { class: "stack" }, [
        el("label", { class: "field" }, [
          el("span", {}, "Име"),
          el("input", { id: "field-title", name: "title", maxlength: "120", required: true, value: existing ? existing.title : "", placeholder: "напр. Таратор" }),
        ]),
        el("div", { class: "meta-grid" }, [
          el("div", { class: "with-button" }, [
            el("label", { class: "field" }, [
              el("span", {}, "Категория"),
              categorySelect,
            ]),
            el("button", { type: "button", class: "btn btn-ghost", onclick: function () { openCategoryDialog(null); } }, "Нова"),
          ]),
          el("label", { class: "field" }, [
            el("span", {}, "Време"),
            el("input", { id: "field-time", name: "time", maxlength: "40", value: existing ? existing.time : "", placeholder: "45 мин" }),
          ]),
          el("label", { class: "field" }, [
            el("span", {}, "Порции"),
            el("input", { id: "field-servings", name: "servings", maxlength: "40", value: existing ? existing.servings : "", placeholder: "4" }),
          ]),
        ]),
        el("label", { class: "field" }, [
          el("span", {}, "Източник"),
          el("input", { id: "field-source", name: "source", maxlength: "500", inputmode: "url", value: existing ? existing.sourceUrl : "", placeholder: "https://" }),
        ]),
        paste,
        el("section", {}, [
          el("h3", { class: "block-title" }, "Съставки"),
          ingredientList,
          el("button", { type: "button", class: "btn btn-ghost", onclick: function () { ingredients.add("", null, true); } }, "Добави съставка"),
        ]),
        el("section", {}, [
          el("h3", { class: "block-title" }, "Начин на приготвяне"),
          stepList,
          el("button", { type: "button", class: "btn btn-ghost", onclick: function () { steps.add("", null, true); } }, "Добави стъпка"),
        ]),
        el("label", { class: "field" }, [
          el("span", {}, "Бележки"),
          el("textarea", { id: "field-notes", name: "notes", maxlength: "5000", placeholder: "Нещо, което искаш да помниш следващия път" }, existing ? existing.notes : ""),
        ]),
      ]),
      el("div", { class: "editor-actions" }, [
        el("button", { type: "button", class: "btn btn-ghost", onclick: function () { go(existing ? { name: "detail", id: existing.id } : { name: "list" }); } }, "Отказ"),
        el("button", { type: "submit", class: "btn btn-primary" }, "Запази"),
      ])
    );

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      saveEditor(existing);
    });
    form.addEventListener("keydown", function (event) {
      if (event.key !== "Enter" || event.target.tagName !== "INPUT") return;
      if (event.target.closest("#ingredient-list")) return;
      event.preventDefault();
    });

    refreshCategorySelect(presetCategory, categorySelect);

    function setStatus(message) {
      pasteStatus.textContent = message;
    }

    async function pasteClipboard() {
      try {
        const text = await navigator.clipboard.readText();
        if (!text || !text.trim()) {
          setStatus("Клипбордът е празен.");
          return;
        }
        if (/^https?:\/\/\S+$/i.test(text.trim()) && text.trim().length < 500) {
          const source = document.querySelector("#field-source");
          if (source.value.trim()) {
            setStatus("В Източник вече има текст. Оставих го както е.");
            return;
          }
          source.value = text.trim();
          setStatus("Сложих връзката в Източник.");
          return;
        }
        pasteArea.value = text;
        recognizeText();
      } catch (error) {
        pasteArea.focus();
        setStatus("Не успях да прочета клипборда. Кликни в полето и постави с Cmd+V, после Разпознай текста.");
      }
    }

    async function recognizeText() {
      const text = pasteArea.value;
      if (!text.trim()) {
        setStatus("Първо постави текст.");
        pasteArea.focus();
        return;
      }
      const parsed = window.RecipeParse.parseRecipeText(text);
      if (!parsed.title && !parsed.ingredients.length && !parsed.steps.length && !parsed.servings && !parsed.time && !parsed.sourceUrl) {
        setStatus("Не разпознах рецепта в този текст. Копирай заглавието, съставките и стъпките, после опитай пак.");
        return;
      }
      const current = readForm();
      const hasLists = current && (current.ingredients.length || current.steps.length);
      const parsedHasLists = parsed.ingredients.length || parsed.steps.length;
      if (hasLists && parsedHasLists) {
        const ok = await ask({
          title: "Замяна на списъците",
          text: "Има вече попълнени съставки или стъпки. Да се заменят ли с разпознатите?",
          confirmLabel: "Замени",
        });
        if (!ok) {
          applyParsed(parsed, false);
          setStatus("Попълних само празните полета.");
          return;
        }
      }
      applyParsed(parsed, true);
      const parts = [];
      if (parsed.ingredients.length) parts.push(parsed.ingredients.length + " " + countWord(parsed.ingredients.length, "съставка", "съставки"));
      if (parsed.steps.length) parts.push(parsed.steps.length + " " + countWord(parsed.steps.length, "стъпка", "стъпки"));
      setStatus(parts.length ? "Намерих " + parts.join(" и ") + ". Прегледай ги преди да запазиш." : "Попълних каквото успях да отделя. Прегледай полетата.");
    }

    function applyParsed(parsed, replaceLists) {
      const title = document.querySelector("#field-title");
      const source = document.querySelector("#field-source");
      const time = document.querySelector("#field-time");
      const servings = document.querySelector("#field-servings");
      if (!title.value.trim() && parsed.title) title.value = parsed.title;
      if (!source.value.trim() && parsed.sourceUrl) source.value = parsed.sourceUrl;
      if (!time.value.trim() && parsed.time) time.value = parsed.time;
      if (!servings.value.trim() && parsed.servings) servings.value = parsed.servings;
      if (replaceLists) {
        if (parsed.ingredients.length) ingredients.refill(parsed.ingredients);
        if (parsed.steps.length) steps.refill(parsed.steps);
      }
    }

    return form;
  }

  function armDirtyCheck() {
    const initial = JSON.stringify(readForm());
    isDirty = function () {
      const current = readForm();
      return current ? JSON.stringify(current) !== initial : false;
    };
  }

  function refreshCategorySelect(preferId, select, force) {
    const field = select || document.querySelector("#field-category");
    if (!field) return;
    const hadOptions = field.options.length > 0;
    const previous = field.value;
    field.replaceChildren(new Option("Без категория", ""));
    db.categories.forEach(function (category) {
      field.append(new Option(category.name, category.id));
    });
    const keep = !hadOptions || force ? (preferId || "") : previous;
    field.value = Array.from(field.options).some(function (option) { return option.value === keep; }) ? keep : "";
  }

  function saveEditor(existing) {
    const data = readForm();
    if (!data) return;
    const titleInput = document.querySelector("#field-title");
    if (!data.title) {
      titleInput.setCustomValidity("Напиши име на рецептата");
      titleInput.reportValidity();
      titleInput.setCustomValidity("");
      titleInput.focus();
      return;
    }
    let sourceUrl = "";
    if (data.sourceUrl) {
      sourceUrl = classifySource(data.sourceUrl);
      if (sourceUrl == null) {
        const source = document.querySelector("#field-source");
        source.setCustomValidity("Тази връзка не е пълна. Пример: https://example.com/recepta");
        source.reportValidity();
        source.setCustomValidity("");
        source.focus();
        return;
      }
    }
    const now = new Date().toISOString();
    const recipe = {
      id: existing ? existing.id : uid(),
      title: data.title,
      categoryId: isRealCategory(data.categoryId) ? data.categoryId : "",
      sourceUrl: sourceUrl,
      servings: data.servings,
      time: data.time,
      ingredients: data.ingredients,
      steps: data.steps,
      notes: data.notes,
      favorite: existing ? existing.favorite : false,
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
    };
    const index = db.recipes.findIndex(function (item) { return item.id === recipe.id; });
    if (index >= 0) db.recipes[index] = recipe;
    else db.recipes.push(recipe);
    delete state.checks[recipe.id];
    persist();
    isDirty = function () { return false; };
    toast("Рецептата е запазена");
    go({ name: "detail", id: recipe.id });
  }

  function renderMissing() {
    return el("section", { class: "sheet empty" }, [
      el("h2", {}, "Тази рецепта я няма"),
      el("p", {}, "Може да е изтрита."),
      el("div", { class: "actions" }, [
        el("button", { type: "button", class: "btn btn-primary", onclick: function () { go({ name: "list" }); } }, "Към рецептите"),
      ]),
    ]);
  }

  function mount(node) {
    document.querySelector("#main").replaceChildren(node);
  }

  function renderMain() {
    if (state.route.name === "edit") {
      mount(renderEditor());
      armDirtyCheck();
      const title = document.querySelector("#field-title");
      if (title && !state.route.id) title.focus();
      return;
    }
    if (state.route.name === "detail") {
      const recipe = findRecipe(state.route.id);
      mount(recipe ? renderDetail(recipe) : renderMissing());
      return;
    }
    mount(renderList());
  }

  function render() {
    document.body.dataset.view = state.route.name;
    syncTitle();
    updateCount();
    renderSidebar();
    renderMain();
  }

  function openCategoryDialog(category) {
    categoryEditing = category;
    document.querySelector("#category-title").textContent = category ? "Промяна на категория" : "Нова категория";
    const name = document.querySelector("#category-name");
    name.value = category ? category.name : "";
    document.querySelector("#category-delete").hidden = !category;
    const selected = category ? category.color : COLORS[db.categories.length % COLORS.length];
    const colors = COLORS.slice();
    if (selected && colors.indexOf(selected.toLowerCase()) === -1) colors.unshift(selected);
    const wrap = document.querySelector("#color-choices");
    wrap.replaceChildren();
    colors.forEach(function (color, index) {
      const id = "color-" + index;
      const input = el("input", { type: "radio", name: "color", id: id, value: color, "aria-label": "Цвят " + (index + 1) });
      if (color.toLowerCase() === String(selected).toLowerCase()) input.checked = true;
      const swatch = el("label", { class: "swatch", for: id });
      swatch.style.setProperty("--swatch", color);
      wrap.append(input, swatch);
    });
    if (!wrap.querySelector("input:checked")) wrap.querySelector("input").checked = true;
    document.querySelector("#category-dialog").showModal();
    name.focus();
  }

  function saveCategory(event) {
    event.preventDefault();
    const nameInput = document.querySelector("#category-name");
    const name = nameInput.value.trim();
    if (!name) {
      nameInput.setCustomValidity("Напиши име");
      nameInput.reportValidity();
      nameInput.setCustomValidity("");
      return;
    }
    const duplicate = db.categories.some(function (category) {
      return category.name.toLowerCase() === name.toLowerCase() && (!categoryEditing || category.id !== categoryEditing.id);
    });
    if (duplicate) {
      toast("Вече има такава категория");
      return;
    }
    const picked = document.querySelector("#color-choices input:checked");
    const color = cleanColor(picked ? picked.value : "", COLORS[0]);
    let preferId = "";
    if (categoryEditing) {
      categoryEditing.name = name;
      categoryEditing.color = color;
      preferId = categoryEditing.id;
    } else {
      const created = { id: uid(), name: name, color: color };
      db.categories.push(created);
      preferId = created.id;
    }
    persist();
    document.querySelector("#category-dialog").close();
    const createdNew = !categoryEditing;
    renderSidebar();
    refreshCategorySelect(preferId, null, createdNew);
    if (state.route.name !== "edit") renderMain();
    toast("Категорията е запазена");
  }

  function deleteCategory() {
    const current = categoryEditing;
    if (!current) return;
    const used = db.recipes.filter(function (recipe) { return recipe.categoryId === current.id; }).length;
    document.querySelector("#category-dialog").close();
    ask({
      title: "Изтриване на категория",
      text: used
        ? "«" + current.name + "» се ползва от " + formatCount(used) + ". Те ще останат без категория."
        : "Да се изтрие ли «" + current.name + "»?",
      confirmLabel: "Изтрий",
      danger: true,
    }).then(function (ok) {
      if (!ok) return;
      db.categories = db.categories.filter(function (category) { return category.id !== current.id; });
      db.recipes.forEach(function (recipe) {
        if (recipe.categoryId === current.id) recipe.categoryId = "";
      });
      if (state.categoryId === current.id) state.categoryId = "all";
      persist();
      if (state.route.name === "edit") {
        renderSidebar();
        refreshCategorySelect();
      } else {
        render();
      }
      toast("Категорията е изтрита");
    });
  }

  function closeMenu() {
    document.querySelector("#data-menu").open = false;
  }

  function exportData() {
    closeMenu();
    downloadBackup("recepturnik-backup.json");
    toast("Копието е свалено");
  }

  function importPayload(data) {
    if (Array.isArray(data)) return sanitizeState({ categories: [], recipes: data });
    if (!data || typeof data !== "object" || !Array.isArray(data.recipes)) return null;
    return sanitizeState(data);
  }

  function mergeImport(incoming) {
    const idMap = new Map();
    incoming.categories.forEach(function (category) {
      const existing = db.categories.find(function (item) {
        return item.id === category.id || item.name.toLowerCase() === category.name.toLowerCase();
      });
      if (existing) idMap.set(category.id, existing.id);
      else {
        db.categories.push(category);
        idMap.set(category.id, category.id);
      }
    });
    let added = 0;
    incoming.recipes.forEach(function (recipe) {
      if (db.recipes.some(function (item) { return item.id === recipe.id; })) return;
      if (recipe.categoryId) {
        recipe.categoryId = idMap.get(recipe.categoryId) || (isRealCategory(recipe.categoryId) ? recipe.categoryId : "");
      }
      db.recipes.push(recipe);
      added += 1;
    });
    return added;
  }

  async function importData(event) {
    closeMenu();
    const file = event.target.files && event.target.files[0];
    event.target.value = "";
    if (!file) return;
    let parsed;
    try {
      parsed = JSON.parse(await file.text());
    } catch (error) {
      toast("Файлът не е валиден JSON");
      return;
    }
    const incoming = importPayload(parsed);
    if (!incoming) {
      toast("Този файл не прилича на рецептурник");
      return;
    }
    let choice = "add";
    if (db.recipes.length) {
      choice = await ask({
        title: "Зареждане от файл",
        text: "Във файла има " + formatCount(incoming.recipes.length) + ". Можеш да добавиш само новите или да замениш цялата книга с файла.",
        confirmLabel: "Добави новите",
        confirmValue: "add",
        extraLabel: "Замени сегашните",
        extraValue: "replace",
      });
      if (!choice) return;
    }
    if (choice === "replace") {
      db = {
        version: 1,
        categories: incoming.categories,
        recipes: incoming.recipes,
      };
      state.categoryId = "all";
      persist();
      render();
      toast("Книгата е заменена");
      return;
    }
    const added = mergeImport(incoming);
    persist();
    render();
    if (added === 0) toast("Нямаше нови рецепти във файла");
    else if (added === 1) toast("Добавена е 1 рецепта");
    else toast("Добавени са " + added + " " + recipeWord(added));
  }

  document.querySelector("#new-recipe").addEventListener("click", function () { go({ name: "edit" }); });
  document.querySelector("#search-form").addEventListener("submit", function (event) { event.preventDefault(); });
  document.querySelector("#search").addEventListener("input", function (event) {
    state.query = event.target.value;
    if (state.route.name !== "list") return;
    renderSidebar();
    renderMain();
  });
  document.querySelector("#export-btn").addEventListener("click", exportData);
  document.querySelector("#import-btn").addEventListener("click", function () {
    document.querySelector("#import-file").click();
  });
  document.querySelector("#import-file").addEventListener("change", importData);
  document.querySelector("#category-form").addEventListener("submit", saveCategory);
  document.querySelector("#category-cancel").addEventListener("click", function () {
    document.querySelector("#category-dialog").close();
  });
  document.querySelector("#category-delete").addEventListener("click", deleteCategory);
  document.addEventListener("click", function (event) {
    const menu = document.querySelector("#data-menu");
    if (menu.open && !menu.contains(event.target)) menu.open = false;
  });
  window.addEventListener("beforeunload", function (event) {
    if (!isDirty()) return;
    event.preventDefault();
    event.returnValue = "";
  });

  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch(function () {});
  }

  const authModes = {
    login: {
      title: "Вход",
      submit: "Влез",
      switchLabel: "Нямам акаунт",
      password: "current-password",
    },
    register: {
      title: "Нов акаунт",
      submit: "Създай акаунт",
      switchLabel: "Имам акаунт",
      password: "new-password",
    },
  };
  let authMode = "login";

  function authErrorText(code) {
    if (code === "auth/invalid-credential" || code === "auth/wrong-password" || code === "auth/user-not-found" || code === "auth/invalid-login-credentials") {
      return "Имейлът или паролата не съвпадат.";
    }
    if (code === "auth/email-already-in-use") return "Този имейл вече има акаунт. Влез с него.";
    if (code === "auth/weak-password") return "Паролата трябва да е поне 6 знака.";
    if (code === "auth/invalid-email") return "Този имейл не изглежда верен.";
    if (code === "auth/too-many-requests") return "Твърде много опити. Изчакай малко и пробвай пак.";
    if (code === "auth/network-request-failed") return "Няма връзка. Провери интернета.";
    return "Не успях. Опитай отново.";
  }

  function showAuthError(message) {
    const node = document.querySelector("#auth-error");
    node.hidden = !message;
    node.textContent = message || "";
  }

  function setAuthMode(mode) {
    authMode = mode;
    const copy = authModes[mode];
    document.querySelector("#gate-title").textContent = copy.title;
    document.querySelector("#auth-submit").textContent = copy.submit;
    document.querySelector("#auth-switch").textContent = copy.switchLabel;
    document.querySelector("#auth-password").setAttribute("autocomplete", copy.password);
    showAuthError("");
  }

  function showGate(stateName) {
    const gate = document.querySelector("#gate");
    const form = document.querySelector("#auth-form");
    const wait = document.querySelector("#gate-wait");
    const app = document.querySelector("#app");
    gate.hidden = false;
    app.hidden = true;
    if (stateName === "form") {
      wait.hidden = true;
      form.hidden = false;
      setAuthMode(authMode);
      return;
    }
    form.hidden = true;
    wait.hidden = false;
    document.querySelector("#gate-title").textContent = "Рецептурник";
    wait.textContent = stateName === "book" ? "Зареждам книгата..." : "Проверявам входа...";
  }

  function showBook(email) {
    document.querySelector("#gate").hidden = true;
    document.querySelector("#app").hidden = false;
    document.querySelector("#account-label").textContent = email || "";
    render();
  }

  document.querySelector("#auth-switch").addEventListener("click", function () {
    setAuthMode(authMode === "login" ? "register" : "login");
    document.querySelector("#auth-email").focus();
  });

  document.querySelector("#auth-form").addEventListener("submit", async function (event) {
    event.preventDefault();
    const email = document.querySelector("#auth-email").value.trim();
    const password = document.querySelector("#auth-password").value;
    const submit = document.querySelector("#auth-submit");
    showAuthError("");
    submit.disabled = true;
    try {
      const auth = firebase.auth();
      if (authMode === "register") await auth.createUserWithEmailAndPassword(email, password);
      else await auth.signInWithEmailAndPassword(email, password);
    } catch (error) {
      showAuthError(authErrorText(error && error.code));
      submit.disabled = false;
    }
  });

  document.querySelector("#sign-out").addEventListener("click", async function () {
    if (isDirty()) {
      const ok = await ask({
        title: "Незапазени промени",
        text: "Ако продължиш, написаното в рецептата няма да се запази.",
        confirmLabel: "Излез",
        danger: true,
      });
      if (!ok) return;
      isDirty = function () { return false; };
    }
    firebase.auth().signOut();
  });

  if (!window.firebase || !window.RECEPTURNIK_FIREBASE) {
    showGate("form");
    showAuthError("Базата не се зареди. Презареди страницата.");
    document.querySelector("#auth-submit").disabled = true;
    document.querySelector("#auth-switch").disabled = true;
  } else {
    firebase.initializeApp(window.RECEPTURNIK_FIREBASE);
    let shownUid = "";
    firebase.auth().onAuthStateChanged(async function (user) {
      cloudUser = user;
      if (!user) {
        shownUid = "";
        showGate("form");
        document.querySelector("#auth-submit").disabled = false;
        return;
      }
      if (shownUid === user.uid) return;
      shownUid = user.uid;
      showGate("book");
      try {
        await adoptRemote(user);
      } catch (error) {
        toast("Не успях да отворя базата. Показвам копието от този браузър.");
      }
      showBook(user.email);
    });
  }
})();
