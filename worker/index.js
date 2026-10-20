import { createPublicKey, createVerify } from "node:crypto";

const CERTS_URL = "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";
const USER_DAILY = 15;
const GLOBAL_DAILY = 60;
const UNITS = ["гр", "кг", "мл", "л", "ч.л.", "с.л.", "бр.", "щипка", "чаша", "връзка", "скилидка", "глава", "по вкус"];

let certsCache = { at: 0, certs: null };

function b64urlToBytes(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function jsonText(bytes) {
  return JSON.parse(new TextDecoder().decode(bytes));
}

function allowedOrigin(origin) {
  if (!origin) return "";
  if (origin === "https://pavlinagargova.github.io") return origin;
  if (/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) return origin;
  return "";
}

function respond(request, status, body) {
  const origin = allowedOrigin(request.headers.get("Origin"));
  const headers = { "Content-Type": "application/json; charset=utf-8" };
  if (origin) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Vary"] = "Origin";
  }
  return new Response(JSON.stringify(body), { status, headers });
}

function preflight(request) {
  const origin = allowedOrigin(request.headers.get("Origin"));
  if (!origin) return respond(request, 403, { error: "Тази страница не може да праща снимки." });
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    },
  });
}

async function googleCerts() {
  if (certsCache.certs && Date.now() - certsCache.at < 60 * 60 * 1000) return certsCache.certs;
  const response = await fetch(CERTS_URL);
  if (!response.ok) throw new Error("certs");
  const certs = await response.json();
  certsCache = { at: Date.now(), certs };
  return certs;
}

async function userIdFromToken(token, projectId) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw new Error("token");
  const header = jsonText(b64urlToBytes(parts[0]));
  const payload = jsonText(b64urlToBytes(parts[1]));
  const now = Math.floor(Date.now() / 1000);
  if (header.alg !== "RS256" || !header.kid) throw new Error("alg");
  if (payload.aud !== projectId) throw new Error("aud");
  if (payload.iss !== "https://securetoken.google.com/" + projectId) throw new Error("iss");
  if (typeof payload.exp !== "number" || payload.exp < now) throw new Error("exp");
  if (!payload.sub) throw new Error("sub");
  const pem = (await googleCerts())[header.kid];
  if (!pem) throw new Error("kid");
  const verifier = createVerify("RSA-SHA256");
  verifier.update(parts[0] + "." + parts[1]);
  if (!verifier.verify(createPublicKey(pem), b64urlToBytes(parts[2]))) throw new Error("sig");
  return payload.sub;
}

function clean(value, max) {
  return String(value == null ? "" : value).replace(/\s+/g, " ").trim().slice(0, max);
}

function canonicalUnit(value) {
  const raw = clean(value, 40).toLowerCase();
  if (raw === "г" || raw === "g" || raw === "гр") return "гр";
  return UNITS.indexOf(raw) >= 0 ? UNITS[UNITS.indexOf(raw)] : "";
}

export function normalizeRecipe(raw) {
  const data = raw && typeof raw === "object" ? raw : {};
  const ingredients = Array.isArray(data.ingredients) ? data.ingredients : [];
  const steps = Array.isArray(data.steps) ? data.steps : [];
  return {
    title: clean(data.title, 120),
    time: clean(data.time, 40),
    servings: clean(data.servings, 40),
    notes: clean(data.notes, 5000),
    ingredients: ingredients.slice(0, 80).map(function (item) {
      const source = item && typeof item === "object" ? item : { name: item };
      return {
        name: clean(source.name, 160),
        amount: clean(source.amount, 20),
        unit: canonicalUnit(source.unit),
      };
    }).filter(function (item) { return item.name || item.amount; }),
    steps: steps.map(function (step) { return clean(step, 2000); }).filter(Boolean).slice(0, 80),
  };
}

function quotaDay() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

async function overLimit(quota, uid) {
  if (!quota) return false;
  const day = quotaDay();
  const userCount = Number(await quota.get("u:" + uid + ":" + day) || 0);
  const globalCount = Number(await quota.get("g:" + day) || 0);
  return userCount >= USER_DAILY || globalCount >= GLOBAL_DAILY;
}

async function bump(quota, uid) {
  if (!quota) return;
  const day = quotaDay();
  const userKey = "u:" + uid + ":" + day;
  const globalKey = "g:" + day;
  const userCount = Number(await quota.get(userKey) || 0);
  const globalCount = Number(await quota.get(globalKey) || 0);
  const options = { expirationTtl: 60 * 60 * 48 };
  await quota.put(userKey, String(userCount + 1), options);
  await quota.put(globalKey, String(globalCount + 1), options);
}

function geminiPrompt() {
  return [
    "По снимката извлечи рецептата, ако текстът се чете.",
    "Пиши на български, със същите думи като на снимката.",
    "Не измисляй съставки, стъпки, време или порции, които не се виждат.",
    "Ако на снимката няма рецепта, върни празни полета и празни списъци.",
    "amount е само количеството, например 200 или 1/2.",
    "unit е една от: гр, кг, мл, л, ч.л., с.л., бр., щипка, чаша, връзка, скилидка, глава, по вкус. Ако няма такава, остави unit празно.",
    "time е кратко, например 45 мин. servings е броят, например 4.",
  ].join(" ");
}

async function askModel(env, model, base64) {
  return fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model) + ":generateContent",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": env.GEMINI_API_KEY,
      },
      signal: AbortSignal.timeout(20000),
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: geminiPrompt() },
            { inline_data: { mime_type: "image/jpeg", data: base64 } },
          ],
        }],
        generationConfig: {
          temperature: 0.1,
          thinkingConfig: { thinkingLevel: "low" },
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            properties: {
              title: { type: "STRING" },
              time: { type: "STRING" },
              servings: { type: "STRING" },
              notes: { type: "STRING" },
              ingredients: {
                type: "ARRAY",
                items: {
                  type: "OBJECT",
                  properties: {
                    name: { type: "STRING" },
                    amount: { type: "STRING" },
                    unit: { type: "STRING" },
                  },
                  required: ["name", "amount", "unit"],
                },
              },
              steps: { type: "ARRAY", items: { type: "STRING" } },
            },
            required: ["title", "time", "servings", "notes", "ingredients", "steps"],
          },
        },
      }),
    }
  );
}

async function readRecipe(env, base64) {
  const models = [env.GEMINI_MODEL || "gemini-3.8-flash", "gemini-3.5-flash-lite"];
  let busy = false;
  for (let i = 0; i < models.length; i += 1) {
    let response;
    try {
      response = await askModel(env, models[i], base64);
    } catch (error) {
      busy = true;
      continue;
    }
    if (response.status === 429) {
      const error = new Error("quota");
      error.status = 429;
      throw error;
    }
    if (response.status === 404) continue;
    if (response.status === 503 || response.status === 500) {
      busy = true;
      continue;
    }
    if (!response.ok) continue;
    const payload = await response.json();
    const parts = payload && payload.candidates && payload.candidates[0] && payload.candidates[0].content && payload.candidates[0].content.parts
      ? payload.candidates[0].content.parts
      : [];
    const text = parts.filter(function (part) { return part && !part.thought; }).map(function (part) { return part.text || ""; }).join("");
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      parsed = {};
    }
    return normalizeRecipe(parsed);
  }
  const error = new Error(busy ? "busy" : "model");
  error.status = busy ? 503 : 502;
  throw error;
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return preflight(request);
    if (request.method === "GET") return respond(request, 200, { ok: true });
    if (request.method !== "POST") return respond(request, 405, { error: "Само снимка към рецепта." });
    if (!allowedOrigin(request.headers.get("Origin"))) return respond(request, 403, { error: "Тази страница не може да праща снимки." });
    if (!env.GEMINI_API_KEY) return respond(request, 503, { error: "Четенето на снимки още не е включено." });

    const header = request.headers.get("Authorization") || "";
    const token = header.indexOf("Bearer ") === 0 ? header.slice(7).trim() : "";
    let uid = "";
    try {
      uid = await userIdFromToken(token, env.FIREBASE_PROJECT_ID || "recepturnik-pavlina");
    } catch (error) {
      return respond(request, 401, { error: "Влез отново в книгата и опитай пак." });
    }

    let body;
    try {
      body = await request.json();
    } catch (error) {
      return respond(request, 400, { error: "Снимката не се прочете." });
    }
    const image = String(body && body.image || "");
    const match = image.match(/^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/);
    if (!match || image.length > 700000) return respond(request, 413, { error: "Снимката е твърде голяма. Пробвай с по-малка." });

    if (await overLimit(env.QUOTA, uid)) {
      return respond(request, 429, { error: "За днес снимките за теб свършиха. Опитай утре." });
    }

    try {
      const recipe = await readRecipe(env, match[1]);
      await bump(env.QUOTA, uid);
      return respond(request, 200, recipe);
    } catch (error) {
      if (error && error.status === 429) {
        return respond(request, 429, { error: "Безплатните прочитания за днес свършиха. Опитай утре." });
      }
      if (error && error.status === 503) {
        return respond(request, 503, { error: "Моделът е зает в момента. Опитай пак след минута." });
      }
      return respond(request, 502, { error: "Моделът не отговори. Опитай пак след малко." });
    }
  },
};
