// src/security.ts
var VALID_PROTOCOLS = /* @__PURE__ */ new Set(["http:", "https:"]);
function isValidUrl(url) {
  try {
    const parsed = new URL(url);
    return VALID_PROTOCOLS.has(parsed.protocol);
  } catch {
    return false;
  }
}
function sanitizeModelId(id2) {
  return id2.trim().replaceAll(/[^a-zA-Z0-9/_\-:.]/g, "_");
}
function sanitizeUrl(raw) {
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    url.search = "";
    return url.toString();
  } catch {
    return raw.split("?")[0];
  }
}
function sanitizeErrorMessage(error) {
  let message = error instanceof Error ? error.message : String(error);
  message = message.replaceAll(
    /https?:\/\/[^\s"'`<>]+/gi,
    (match) => sanitizeUrl(match)
  );
  return message.replaceAll(/Bearer\s+[^\s]+/gi, "Bearer [REDACTED]").replaceAll(/api[_-]?key[=:]\s*[^\s&]+/gi, "api_key=[REDACTED]").replaceAll(/sk-[a-zA-Z0-9_-]+/g, "sk-[REDACTED]");
}

// src/endpoint.ts
function normalizeModelId(id2) {
  let normalized = id2.toLowerCase();
  if (normalized.startsWith("models/")) {
    normalized = normalized.slice(7);
  }
  const slashIndex = normalized.lastIndexOf("/");
  if (slashIndex !== -1) {
    normalized = normalized.slice(slashIndex + 1);
  }
  return normalized.replaceAll(":", "-");
}
async function fetchEndpointModels(baseURL, apiKey) {
  if (!isValidUrl(baseURL)) return [];
  const url = new URL(baseURL);
  const cleanPath = url.pathname.replace(/\/+$/, "");
  const modelsPath = cleanPath.endsWith("/models") ? cleanPath : `${cleanPath}/models`;
  const modelsUrl = new URL(modelsPath, url.origin);
  modelsUrl.search = url.search;
  const headers = { "Content-Type": "application/json" };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }
  const res = await fetch(modelsUrl.toString(), {
    headers,
    signal: AbortSignal.timeout(15e3)
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.text();
      if (body) detail = sanitizeErrorMessage(body.slice(0, 500));
    } catch {
    }
    throw new Error(`HTTP ${res.status}: ${detail}`);
  }
  const rawData = await res.json();
  const data = Array.isArray(rawData) ? rawData : Array.isArray(rawData?.data) ? rawData.data : null;
  if (!data) {
    throw new Error("Unexpected response format from /v1/models");
  }
  return data.filter((item) => typeof item?.id === "string");
}

// src/catalog.ts
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createRequire } from "node:module";
var require2 = createRequire(import.meta.url);
var { version: PKG_VERSION } = require2("../package.json");
var MODELS_DEV_URL = "https://models.dev/api.json";
var CACHE_TTL = 6 * 60 * 60 * 1e3;
function cacheDir() {
  return path.join(os.homedir() || "/tmp", ".cache", "opencode-custom-providers");
}
function cacheFile() {
  return path.join(cacheDir(), "models-dev.json");
}
var lookupMap = null;
var lookupPromise = null;
var catalogPromise = null;
function readCacheEntry() {
  try {
    const file = cacheFile();
    if (!fs.existsSync(file)) return null;
    const content = fs.readFileSync(file, "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}
function writeCache(data) {
  try {
    const dir = cacheDir();
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { mode: 448, recursive: true });
    }
    fs.writeFileSync(
      cacheFile(),
      JSON.stringify({ timestamp: Date.now(), data }, null, 2),
      { mode: 384 }
    );
  } catch {
  }
}
async function fetchModelsDevCatalog() {
  const entry = readCacheEntry();
  const isFresh = entry && Date.now() - entry.timestamp <= CACHE_TTL;
  if (isFresh && entry) return entry.data;
  try {
    const res = await fetch(MODELS_DEV_URL, {
      headers: { "User-Agent": `opencode-custom-providers/${PKG_VERSION}` },
      signal: AbortSignal.timeout(1e4)
    });
    if (res.ok) {
      const data = await res.json();
      writeCache(data);
      return data;
    }
  } catch {
  }
  if (entry) {
    return entry.data;
  }
  return {};
}
function buildLookupMap(catalog) {
  const map = /* @__PURE__ */ new Map();
  for (const provider of Object.values(catalog)) {
    if (!provider.models) continue;
    for (const model of Object.values(provider.models)) {
      const key = normalizeModelId(model.id);
      if (!map.has(key)) {
        map.set(key, model);
      }
    }
  }
  return map;
}
async function getLookupMap() {
  if (lookupMap) return lookupMap;
  if (!lookupPromise) {
    lookupPromise = fetchModelsDevCatalog().then((catalog) => {
      lookupMap = buildLookupMap(catalog);
      return lookupMap;
    });
  }
  return lookupPromise;
}
function clearModelsDevCache() {
  lookupMap = null;
  lookupPromise = null;
  catalogPromise = null;
  try {
    const file = cacheFile();
    if (!fs.existsSync(file)) return;
    const mtimeMs = fs.statSync(file).mtimeMs;
    if (Date.now() - mtimeMs > CACHE_TTL) fs.unlinkSync(file);
  } catch {
  }
}
async function getCatalog() {
  if (!catalogPromise) {
    catalogPromise = fetchModelsDevCatalog();
  }
  return catalogPromise;
}
function summarizeCatalog(catalog) {
  return Object.values(catalog).filter((p) => p && typeof p.id === "string" && p.models && Object.keys(p.models).length > 0).map((p) => ({
    id: p.id,
    name: p.name || p.id,
    api: p.api,
    modelCount: Object.keys(p.models).length
  })).sort((a, b) => a.name.localeCompare(b.name));
}
async function listCatalogSites() {
  return summarizeCatalog(await getCatalog());
}

// src/rules.ts
import * as fs2 from "node:fs";
import * as path2 from "node:path";
import * as os2 from "node:os";
var EXACT = {
  "gpt-4o": { context: 128e3, output: 16384, reasoning: false, image: true },
  "gpt-4o-mini": { context: 128e3, output: 16384, reasoning: false, image: true },
  "gpt-4.1": { context: 1e6, output: 32768, reasoning: false, image: true },
  "gpt-4.1-mini": { context: 1e6, output: 32768, reasoning: false, image: true },
  "gpt-5": { context: 4e5, output: 128e3, reasoning: true, image: true },
  "gpt-5-mini": { context: 4e5, output: 128e3, reasoning: true, image: true },
  "o1": { context: 2e5, output: 1e5, reasoning: true, image: true },
  "o3": { context: 2e5, output: 1e5, reasoning: true, image: true },
  "o4-mini": { context: 2e5, output: 1e5, reasoning: true, image: true },
  "claude-sonnet-4-6": { context: 1e6, output: 128e3, reasoning: true, image: true },
  "claude-opus-4-6": { context: 1e6, output: 128e3, reasoning: true, image: true },
  "claude-haiku-4-5": { context: 2e5, output: 64e3, reasoning: true, image: true },
  "deepseek-chat": { context: 128e3, output: 8192, reasoning: false, image: false },
  "deepseek-reasoner": { context: 128e3, output: 32768, reasoning: true, image: false },
  "deepseek-r1": { context: 128e3, output: 32768, reasoning: true, image: false },
  "deepseek-v3": { context: 128e3, output: 8192, reasoning: false, image: false },
  "deepseek-v4-pro": { context: 256e3, output: 32768, reasoning: false, image: false },
  "qwen-max": { context: 256e3, output: 8192, reasoning: false, image: false },
  "qwen-plus": { context: 256e3, output: 8192, reasoning: false, image: false },
  "qwen-turbo": { context: 1e6, output: 8192, reasoning: false, image: false },
  "qwq-32b": { context: 128e3, output: 32768, reasoning: true, image: false },
  "kimi-k2": { context: 256e3, output: 16384, reasoning: false, image: false },
  "kimi-k2-thinking": { context: 256e3, output: 32768, reasoning: true, image: false },
  "moonshot-v1-128k": { context: 128e3, output: 4096, reasoning: false, image: false },
  "glm-4.6": { context: 2e5, output: 32768, reasoning: true, image: true },
  "glm-4.5": { context: 128e3, output: 16384, reasoning: true, image: false },
  "gemini-2.5-pro": { context: 1e6, output: 65536, reasoning: true, image: true },
  "gemini-2.5-flash": { context: 1e6, output: 65536, reasoning: true, image: true },
  "gemini-3.1-pro": { context: 1e6, output: 64e3, reasoning: true, image: true },
  "grok-4": { context: 256e3, output: 16384, reasoning: true, image: true },
  "grok-3": { context: 131072, output: 16384, reasoning: false, image: false }
};
var PREFIX = [
  ["gpt-5", { context: 4e5, output: 128e3, reasoning: true, image: true }],
  ["gpt-4", { context: 128e3, output: 16384, reasoning: false, image: true }],
  ["o1", { context: 2e5, output: 1e5, reasoning: true, image: true }],
  ["o3", { context: 2e5, output: 1e5, reasoning: true, image: true }],
  ["claude-opus", { context: 1e6, output: 128e3, reasoning: true, image: true }],
  ["claude-sonnet", { context: 5e5, output: 64e3, reasoning: true, image: true }],
  ["claude-haiku", { context: 2e5, output: 64e3, reasoning: true, image: true }],
  ["claude", { context: 2e5, output: 32e3, reasoning: false, image: true }],
  ["deepseek-r", { context: 128e3, output: 32768, reasoning: true, image: false }],
  ["deepseek", { context: 128e3, output: 8192, reasoning: false, image: false }],
  ["qwen", { context: 128e3, output: 8192, reasoning: false, image: false }],
  ["qwq", { context: 128e3, output: 32768, reasoning: true, image: false }],
  ["kimi", { context: 256e3, output: 16384, reasoning: false, image: false }],
  ["moonshot", { context: 128e3, output: 4096, reasoning: false, image: false }],
  ["glm", { context: 128e3, output: 16384, reasoning: true, image: false }],
  ["gemini", { context: 1e6, output: 64e3, reasoning: true, image: true }],
  ["grok", { context: 131072, output: 16384, reasoning: false, image: false }],
  ["llama", { context: 128e3, output: 8192, reasoning: false, image: false }],
  ["mistral", { context: 128e3, output: 8192, reasoning: false, image: false }],
  ["mixtral", { context: 64e3, output: 8192, reasoning: false, image: false }]
];
function matchLocalRule(id2) {
  const key = normalizeModelId(id2).split("@")[0].replace(/\[.*\]$/, "");
  const exact = EXACT[key];
  if (exact) return { meta: exact, pattern: key };
  let best = null;
  for (const [prefix, meta] of PREFIX) {
    if (key.startsWith(prefix) && (!best || prefix.length > best.pattern.length)) {
      best = { meta, pattern: prefix };
    }
  }
  return best;
}
function isValidRule(v) {
  if (typeof v !== "object" || v === null) return false;
  const r = v;
  return typeof r.context === "number" && Number.isFinite(r.context) && r.context > 0 && typeof r.output === "number" && Number.isFinite(r.output) && r.output > 0 && typeof r.reasoning === "boolean" && typeof r.image === "boolean";
}
var rulesCache = null;
function loadCustomRules() {
  const file = path2.join(os2.homedir(), ".opencode-custom-providers-rules.json");
  let mtimeMs;
  try {
    mtimeMs = fs2.statSync(file).mtimeMs;
  } catch {
    mtimeMs = -1;
  }
  if (rulesCache && rulesCache.file === file && rulesCache.mtimeMs === mtimeMs) {
    return rulesCache.rules;
  }
  if (mtimeMs === -1) {
    const empty = {};
    rulesCache = { file, mtimeMs, rules: empty };
    return empty;
  }
  try {
    const raw = JSON.parse(fs2.readFileSync(file, "utf-8"));
    const exact = raw?.exact;
    if (typeof exact !== "object" || exact === null) {
      const empty = {};
      rulesCache = { file, mtimeMs, rules: empty };
      return empty;
    }
    const valid = {};
    for (const [id2, rule] of Object.entries(exact)) {
      if (isValidRule(rule)) valid[id2] = rule;
    }
    rulesCache = { file, mtimeMs, rules: valid };
    return valid;
  } catch {
    const empty = {};
    rulesCache = { file, mtimeMs, rules: empty };
    return empty;
  }
}

// src/flavors.ts
var FLAVORS = {
  "openai-chat": {
    flavor: "openai-chat",
    label: "OpenAI Chat Completions",
    description: "OpenAI-compatible /models endpoint (default)",
    listPaths: ["/models"],
    listShape: "openai-list",
    fallbackLimits: { context: 128e3, output: 4096 }
  },
  "openai-responses": {
    flavor: "openai-responses",
    label: "OpenAI Responses",
    description: "Responses-style gateways with an OpenAI /models list",
    listPaths: ["/models"],
    listShape: "openai-list",
    fallbackLimits: { context: 128e3, output: 4096 }
  },
  anthropic: {
    flavor: "anthropic",
    label: "Anthropic Messages",
    description: "No list API \u2014 add from catalog or by hand",
    listPaths: [],
    listShape: "none",
    fallbackLimits: { context: 2e5, output: 32e3 }
  },
  gemini: {
    flavor: "gemini",
    label: "Gemini",
    description: "Google Generative Language list API",
    listPaths: ["/v1beta/models", "/models"],
    listShape: "gemini-list",
    fallbackLimits: { context: 1e6, output: 64e3 }
  },
  ollama: {
    flavor: "ollama",
    label: "Ollama",
    description: "Local Ollama daemon (/api/tags)",
    listPaths: ["/api/tags", "/models"],
    listShape: "ollama-tags",
    fallbackLimits: { context: 128e3, output: 4096 }
  }
};
var DEFAULT_FLAVOR = "openai-chat";
function parseFlavor(value) {
  if (!value) return null;
  const v = value.trim().toLowerCase().replaceAll("_", "-");
  const found = Object.keys(FLAVORS).find((f) => f === v);
  return found ?? null;
}
var BUILT_IN_IDS = /* @__PURE__ */ new Set([
  "openai",
  "anthropic",
  "google",
  "gemini",
  "deepseek",
  "xai",
  "groq",
  "ollama",
  "openrouter",
  "azure",
  "bedrock",
  "vertex"
]);
function collisionSuggestion(providerId) {
  if (BUILT_IN_IDS.has(providerId.toLowerCase())) {
    return `${providerId}-custom`;
  }
  return null;
}

// src/deep-probe.ts
var num = (v) => typeof v === "number" && Number.isFinite(v) && v > 0 ? v : void 0;
async function getJson(url, headers, timeoutMs) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    try {
      err.body = await res.text();
    } catch {
      err.body = "";
    }
    throw err;
  }
  return res.json();
}
function authHeaders(apiKey) {
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  return headers;
}
async function fetchModelDetail(modelsUrl, id2, apiKey) {
  const raw = await getJson(
    `${modelsUrl.replace(/\/+$/, "")}/${encodeURIComponent(id2)}`,
    authHeaders(apiKey),
    8e3
  );
  return patchFromRecord(raw);
}
function patchFromRecord(raw) {
  const patch = {};
  const rec = (v) => typeof v === "object" && v !== null ? v : void 0;
  const firstNum = (keys) => {
    for (const k of keys) {
      const v = num(raw[k]);
      if (v !== void 0) return v;
    }
    return void 0;
  };
  const ctx = firstNum(["context_window", "max_model_len", "context_length", "inputTokenLimit"]);
  if (ctx !== void 0) patch.context_length = ctx;
  const out = firstNum(["max_output_tokens", "max_completion_tokens", "outputTokenLimit"]);
  if (out !== void 0) patch.max_output_tokens = out;
  const cost = num(raw["input_cost"]) !== void 0 || num(raw["output_cost"]) !== void 0 ? { input: num(raw["input_cost"]) ?? 0, output: num(raw["output_cost"]) ?? 0 } : void 0;
  if (cost) {
    patch.input_cost = cost.input;
    patch.output_cost = cost.output;
  }
  const pricing = rec(raw["pricing"]);
  if (pricing) {
    const per = (v) => {
      const n = typeof v === "string" ? Number(v) : num(v) !== void 0 ? v : void 0;
      return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n * 1e6 : void 0;
    };
    const pi = per(pricing["prompt"]);
    const po = per(pricing["completion"]);
    if (pi !== void 0 || po !== void 0) {
      patch.input_cost = pi ?? 0;
      patch.output_cost = po ?? 0;
    }
  }
  const caps = rec(raw["capabilities"]);
  if (caps) {
    if (caps["vision"] === true) patch.vision = true;
    const reasoning = rec(caps["reasoning"]);
    const opts = reasoning?.["effort_options"];
    if (Array.isArray(opts)) {
      const levels = opts.filter((e) => typeof e === "string" && e.length > 0);
      if (levels.length > 0) patch.effort_options = levels;
    }
  }
  return patch;
}
async function fetchLitellmInfo(origin, id2, apiKey) {
  const raw = await getJson(
    `${origin}/model/info?model=${encodeURIComponent(id2)}`,
    authHeaders(apiKey),
    8e3
  );
  const data = typeof raw["data"] === "object" && raw["data"] !== null ? raw["data"] : raw;
  const patch = {};
  const perToken = (v) => {
    const n = typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : void 0;
    return n === void 0 ? void 0 : n * 1e6;
  };
  const pi = perToken(data["input_cost_per_token"]);
  const po = perToken(data["output_cost_per_token"] ?? data["output_cost"]);
  if (pi !== void 0 || po !== void 0) {
    patch.input_cost = pi ?? 0;
    patch.output_cost = po ?? 0;
  }
  const ctx = num(data["max_input_tokens"]);
  if (ctx !== void 0) patch.context_length = ctx;
  const out = num(data["max_output_tokens"]);
  if (out !== void 0) patch.max_output_tokens = out;
  if (Object.keys(patch).length === 0) throw new Error("Empty LiteLLM info");
  return patch;
}
async function fetchPublicCatalog(origin) {
  const raw = await getJson(`${origin}/api/models/public`, authHeaders(), 8e3);
  const list = Array.isArray(raw) ? raw : Array.isArray(raw["data"]) ? raw["data"] : [];
  const map = /* @__PURE__ */ new Map();
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const rec = entry;
    if (typeof rec["id"] !== "string") continue;
    try {
      map.set(rec["id"], patchFromRecord(rec));
    } catch {
    }
  }
  return map;
}
async function fetchOllamaShow(base, name) {
  const res = await fetch(`${base.replace(/\/+$/, "")}/api/show`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
    signal: AbortSignal.timeout(8e3)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const raw = await res.json();
  const patch = {};
  const caps = raw["capabilities"];
  if (Array.isArray(caps) && caps.includes("vision")) patch.vision = true;
  if (Object.keys(patch).length === 0) throw new Error("Empty Ollama show");
  return patch;
}
function applyPatch(item, patch) {
  const merged = {
    ...item,
    capabilities: { ...item.capabilities }
  };
  if (patch.context_length !== void 0 && merged.context_length === void 0) {
    merged.context_length = patch.context_length;
  }
  if (patch.max_output_tokens !== void 0 && merged.max_output_tokens === void 0) {
    merged.max_output_tokens = patch.max_output_tokens;
  }
  if (patch.input_cost !== void 0 || patch.output_cost !== void 0) {
    merged.input_cost = patch.input_cost ?? merged.input_cost;
    merged.output_cost = patch.output_cost ?? merged.output_cost;
  }
  if (patch.vision === true && merged.capabilities) {
    merged.capabilities.vision = true;
  }
  if (patch.effort_options && merged.capabilities) {
    const existing = merged.capabilities.reasoning;
    if (existing === void 0 || existing === false) {
      merged.capabilities.reasoning = { effort_options: patch.effort_options };
    }
  }
  return merged;
}
function needsDeep(item) {
  const hasCtx = (item.context_window ?? item.max_model_len ?? item.context_length) !== void 0;
  const hasOut = (item.max_completion_tokens ?? item.max_output_tokens) !== void 0;
  const hasCost = item.input_cost !== void 0 || item.output_cost !== void 0;
  return !hasCtx || !hasOut || !hasCost;
}
async function deepenItem(item, ctx, publicCatalog) {
  let merged = item;
  try {
    const inline = patchFromRecord(item);
    if (inline.input_cost !== void 0 || inline.output_cost !== void 0) {
      merged = applyPatch(merged, inline);
    }
  } catch {
  }
  if (!needsDeep(merged)) return merged;
  const pub = publicCatalog?.get(item.id);
  if (pub && (pub.input_cost !== void 0 || pub.output_cost !== void 0 || pub.context_length !== void 0)) {
    merged = applyPatch(merged, pub);
    if (!needsDeep(merged)) return merged;
  }
  if (ctx.flavor === "openai-chat" || ctx.flavor === "openai-responses") {
    try {
      merged = applyPatch(merged, await fetchModelDetail(ctx.modelsUrl, item.id, ctx.apiKey));
      if (!needsDeep(merged)) return merged;
    } catch {
    }
    try {
      merged = applyPatch(merged, await fetchLitellmInfo(ctx.origin, item.id, ctx.apiKey));
    } catch {
    }
    return merged;
  }
  if (ctx.flavor === "ollama") {
    try {
      merged = applyPatch(merged, await fetchOllamaShow(ctx.origin, item.id));
    } catch {
    }
  }
  return merged;
}
async function mapPool(items, size, fn) {
  const out = new Array(items.length);
  if (items.length === 0) return out;
  const limit = Math.max(1, Math.floor(size) || 1);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return out;
}
async function deepenEndpointItems(items, ctx) {
  if (items.length === 0) return items;
  if (!items.some(needsDeep)) return items;
  let pub;
  try {
    pub = await fetchPublicCatalog(ctx.origin);
    if (pub.size === 0) pub = void 0;
  } catch {
    pub = void 0;
  }
  return mapPool(items, 8, async (item) => {
    try {
      return await deepenItem(item, ctx, pub);
    } catch {
      return item;
    }
  });
}
async function probeDeveloperRole(baseURL, apiKey) {
  if (!apiKey) return void 0;
  let url;
  try {
    url = new URL(baseURL);
  } catch {
    return void 0;
  }
  const clean = url.pathname.replace(/\/+$/, "");
  const target = clean.endsWith("/chat/completions") ? url.toString() : new URL(`${clean}/chat/completions`, url.origin).toString();
  let res;
  try {
    res = await fetch(target, {
      method: "POST",
      headers: { ...authHeaders(apiKey) },
      body: JSON.stringify({ model: "probe", messages: [{ role: "developer", content: "hi" }], max_tokens: 1 }),
      signal: AbortSignal.timeout(1e4)
    });
  } catch {
    return void 0;
  }
  if (res.status === 401 || res.status === 403) return void 0;
  if (res.status === 400) {
    try {
      const body = await res.text();
      if (/developer/i.test(body)) return false;
    } catch {
      return void 0;
    }
  }
  return void 0;
}

// src/probe.ts
function buildCandidateUrls(baseURL) {
  const out = [];
  const push = (u) => {
    const clean = u.replace(/\/+$/, "");
    if (clean && !out.includes(clean)) out.push(clean);
  };
  push(baseURL);
  try {
    const url = new URL(baseURL);
    const cleanPath = url.pathname.replace(/\/+$/, "");
    if (!cleanPath.endsWith("/v1")) {
      push(new URL(`${cleanPath}/v1`, url.origin).toString());
    }
    const host = url.hostname.toLowerCase();
    if (url.protocol === "http:" && host !== "localhost" && host !== "127.0.0.1" && host !== "::1") {
      const https = new URL(url.toString());
      https.protocol = "https:";
      push(https.toString());
    }
  } catch {
  }
  return out;
}
function parseCapabilities(item) {
  let toolCall = false;
  let reasoning = false;
  let temperature = false;
  if (item.capabilities) {
    if (item.capabilities.function_calling || item.capabilities.tool_choice) toolCall = true;
    if (item.capabilities.reasoning) reasoning = true;
    if (item.capabilities.temperature) temperature = true;
  }
  if (item.supported_parameters) {
    if (item.supported_parameters.includes("tools") || item.supported_parameters.includes("tool_choice")) {
      toolCall = true;
    }
    if (item.supported_parameters.includes("temperature")) temperature = true;
  }
  return { toolCall, reasoning, temperature };
}
function parseEffortOptions(item) {
  const raw = item.capabilities?.reasoning;
  if (typeof raw !== "object" || raw === null) return void 0;
  const opts = raw.effort_options;
  if (!Array.isArray(opts)) return void 0;
  const levels = opts.filter((e) => typeof e === "string" && e.length > 0);
  return levels.length > 0 ? levels : void 0;
}
async function fetchFlavorModels(base, apiKey, flavor) {
  const spec = FLAVORS[flavor];
  if (spec.listShape === "none" || spec.listPaths.length === 0) return [];
  if (spec.listShape === "openai-list") {
    const errors = [];
    for (const p of spec.listPaths) {
      try {
        const url = new URL(base);
        const clean = url.pathname.replace(/\/+$/, "");
        const target = clean.endsWith(p) ? base : new URL(`${clean}${p}`, url.origin).toString();
        const models = await fetchEndpointModels(target, apiKey);
        if (models.length > 0) return models;
      } catch (error) {
        errors.push(sanitizeErrorMessage(error));
      }
    }
    if (errors.length > 0) throw new Error(errors[errors.length - 1]);
    return [];
  }
  for (const p of spec.listPaths) {
    try {
      const url = new URL(base);
      const clean = url.pathname.replace(/\/+$/, "");
      const target = clean.endsWith(p) ? base : new URL(`${clean}${p}`, url.origin).toString();
      const listUrl = geminiListUrl(target, spec.listShape, apiKey);
      const res = await fetch(listUrl, {
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(15e3)
      });
      if (!res.ok) continue;
      const raw = await res.json();
      const items = normalizeListShape(raw, spec.listShape);
      if (items.length > 0) return items;
    } catch {
    }
  }
  return [];
}
function geminiListUrl(target, shape, apiKey) {
  if (shape !== "gemini-list" || !apiKey) return target;
  try {
    const url = new URL(target);
    url.searchParams.set("key", apiKey);
    return url.toString();
  } catch {
    return `${target}${target.includes("?") ? "&" : "?"}key=${encodeURIComponent(apiKey)}`;
  }
}
function normalizeListShape(raw, shape) {
  if (shape === "ollama-tags") {
    const models = raw["models"];
    if (!Array.isArray(models)) return [];
    return models.filter((m) => typeof m === "object" && m !== null && typeof m["name"] === "string").map((m) => ({ id: m["name"].split(":")[0].trim() || m["name"] })).filter((m) => m.id.length > 0);
  }
  if (shape === "gemini-list") {
    const models = raw["models"];
    if (!Array.isArray(models)) return [];
    const out = [];
    for (const m of models) {
      if (typeof m !== "object" || m === null) continue;
      const rec = m;
      const name = rec["name"];
      if (typeof name !== "string" || name.length === 0) continue;
      const id2 = name.startsWith("models/") ? name.slice(7) : name;
      const item = { id: id2 };
      if (typeof rec["displayName"] === "string") item.name = rec["displayName"];
      if (typeof rec["inputTokenLimit"] === "number") item.context_length = rec["inputTokenLimit"];
      if (typeof rec["outputTokenLimit"] === "number") item.max_output_tokens = rec["outputTokenLimit"];
      out.push(item);
    }
    return out;
  }
  return [];
}
function resolveModel(item, lookup, flavor, customs) {
  const spec = FLAVORS[flavor];
  const id2 = sanitizeModelId(item.id);
  const key = normalizeModelId(id2);
  const meta = lookup.get(key);
  const custom = customs[key];
  const rule = custom ? { meta: custom, pattern: `custom:${key}` } : matchLocalRule(id2);
  const caps = parseCapabilities(item);
  const levels = parseEffortOptions(item);
  const probed = { id: id2 };
  if (item.name && item.name !== item.id) probed.name = item.name;
  else if (meta) probed.name = meta.name;
  const epContext = [item.context_window, item.max_model_len, item.context_length].find((v) => typeof v === "number");
  if (epContext !== void 0) {
    probed.context = epContext;
    probed.contextSource = "detected";
  } else if (meta) {
    probed.context = meta.limit.context;
    probed.contextSource = "models.dev";
  } else if (rule) {
    probed.context = rule.meta.context;
    probed.contextSource = "local-rules";
  } else {
    probed.context = spec.fallbackLimits.context;
    probed.contextSource = "api-fallback";
  }
  const epOutput = [item.max_completion_tokens, item.max_output_tokens].find((v) => typeof v === "number");
  if (epOutput !== void 0) {
    probed.maxOutput = epOutput;
    probed.maxOutputSource = "detected";
  } else if (meta) {
    probed.maxOutput = meta.limit.output;
    probed.maxOutputSource = "models.dev";
  } else if (rule) {
    probed.maxOutput = rule.meta.output;
    probed.maxOutputSource = "local-rules";
  } else {
    probed.maxOutput = spec.fallbackLimits.output;
    probed.maxOutputSource = "api-fallback";
  }
  if (probed.maxOutput !== void 0 && probed.context !== void 0 && probed.maxOutput >= probed.context) {
    probed.maxOutput = Math.max(1, Math.floor(probed.context / 2));
  }
  if (caps.reasoning || meta?.reasoning) {
    probed.reasoning = true;
    probed.reasoningSource = caps.reasoning ? "detected" : "models.dev";
  } else if (levels && levels.length > 0) {
    probed.reasoning = true;
    probed.reasoningSource = "detected";
  } else if (rule) {
    probed.reasoning = rule.meta.reasoning;
    probed.reasoningSource = "local-rules";
  } else {
    probed.reasoning = true;
    probed.reasoningSource = "default";
  }
  if (levels && levels.length > 0) probed.reasoningLevels = levels;
  const vision = item.capabilities?.vision === true;
  const metaImage = meta?.modalities?.input.includes("image") ?? false;
  if (vision || metaImage) {
    probed.image = true;
    probed.imageSource = vision ? "detected" : "models.dev";
  } else if (rule) {
    probed.image = rule.meta.image;
    probed.imageSource = "local-rules";
  } else {
    probed.image = false;
    probed.imageSource = "default";
  }
  const hasEndpointCost = typeof item.input_cost === "number" || typeof item.output_cost === "number";
  if (hasEndpointCost) {
    probed.cost = {
      input: typeof item.input_cost === "number" ? item.input_cost : 0,
      output: typeof item.output_cost === "number" ? item.output_cost : 0
    };
    probed.costSource = "detected";
  } else if (meta?.cost) {
    probed.cost = {
      input: meta.cost.input ?? 0,
      output: meta.cost.output ?? 0,
      cache_read: meta.cost.cache_read,
      cache_write: meta.cost.cache_write
    };
    probed.costSource = "models.dev";
  }
  return probed;
}
function modelsUrlFor(candidate, flavor) {
  const first = FLAVORS[flavor].listPaths[0] ?? "/models";
  try {
    const url = new URL(candidate);
    const clean = url.pathname.replace(/\/+$/, "");
    if (clean.endsWith(first)) return candidate;
    return new URL(`${clean}${first}`, url.origin).toString();
  } catch {
    return candidate;
  }
}
async function probeEndpoint(baseURL, apiKey, flavor = DEFAULT_FLAVOR) {
  if (!isValidUrl(baseURL)) {
    throw new Error("Invalid Base URL. Please enter a full URL (including https://).");
  }
  const lookup = await getLookupMap();
  const customs = loadCustomRules();
  const candidates = buildCandidateUrls(baseURL);
  let lastError = null;
  for (const candidate of candidates) {
    try {
      const items = await fetchFlavorModels(candidate, apiKey, flavor);
      if (items.length > 0) {
        let origin = "";
        try {
          origin = new URL(candidate).origin;
        } catch {
          origin = candidate;
        }
        const deep = await deepenEndpointItems(items, {
          modelsUrl: modelsUrlFor(candidate, flavor),
          origin,
          apiKey,
          flavor
        });
        return deep.map((item) => resolveModel(item, lookup, flavor, customs));
      }
    } catch (error) {
      lastError = sanitizeErrorMessage(error);
    }
  }
  if (FLAVORS[flavor].listShape === "none") return [];
  throw new Error(
    `Probe failed for ${baseURL}` + (lastError ? `: ${lastError}` : ". No models found \u2014 retry or add models manually.")
  );
}
function probedToEnriched(probed, displayStyle) {
  const model = {
    name: displayStyle === "slug" ? probed.id : probed.name ?? probed.id,
    limit: {
      context: probed.context ?? 128e3,
      output: probed.maxOutput ?? 4096
    },
    modalities: probed.image ? { input: ["text", "image"], output: ["text"] } : { input: ["text"], output: ["text"] }
  };
  if (probed.reasoning) model.reasoning = true;
  if (probed.reasoningLevels?.length) model.reasoningLevels = [...probed.reasoningLevels];
  if (probed.cost) {
    model.cost = {
      input: probed.cost.input,
      output: probed.cost.output,
      cache_read: probed.cost.cache_read,
      cache_write: probed.cost.cache_write
    };
  }
  return model;
}
function fmtNum(n) {
  return n === void 0 ? "?" : String(n);
}
function describeProbed(p) {
  const parts = [
    p.id,
    `ctx ${fmtNum(p.context)} [${p.contextSource ?? "?"}]`,
    `out ${fmtNum(p.maxOutput)} [${p.maxOutputSource ?? "?"}]`,
    `reasoning ${p.reasoning ? p.reasoningLevels?.length ? `(${p.reasoningLevels.join("/")})` : "[+]" : "[-]"} [${p.reasoningSource ?? "?"}]`,
    `image ${p.image ? "[+]" : "[-]"} [${p.imageSource ?? "?"}]`
  ];
  if (p.cost && p.costSource) {
    parts.push(`cost $${p.cost.input}/$${p.cost.output} [${p.costSource}]`);
  }
  return parts.join(" | ");
}
function catalogToProbed(model) {
  const probed = { id: model.id, name: model.name };
  probed.context = model.limit.context;
  probed.contextSource = "models.dev";
  probed.maxOutput = model.limit.output;
  probed.maxOutputSource = "models.dev";
  probed.reasoning = model.reasoning;
  probed.reasoningSource = "models.dev";
  const image = model.modalities?.input.includes("image") ?? false;
  probed.image = image;
  probed.imageSource = "models.dev";
  if (model.cost) {
    probed.cost = {
      input: model.cost.input ?? 0,
      output: model.cost.output ?? 0,
      cache_read: model.cost.cache_read,
      cache_write: model.cost.cache_write
    };
    probed.costSource = "models.dev";
  }
  return probed;
}
function parseModelIds(raw) {
  if (raw === void 0) return void 0;
  return raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}
async function buildCatalogModels(siteId, modelIds, displayStyle) {
  const catalog = await getCatalog();
  const site = catalog[siteId];
  if (!site) throw new Error(`Unknown catalog site '${siteId}'.`);
  if (!site.api || !isValidUrl(site.api)) {
    throw new Error(`Catalog site '${siteId}' has no usable API endpoint.`);
  }
  const wanted = modelIds && modelIds.length > 0 ? new Set(modelIds.map((m) => m.trim()).filter((m) => m.length > 0)) : null;
  const models = {};
  const resolved = [];
  const matched = /* @__PURE__ */ new Set();
  for (const model of Object.values(site.models ?? {})) {
    const id2 = sanitizeModelId(model.id);
    if (wanted) {
      const hit = wanted.has(id2) || wanted.has(model.id);
      if (!hit) continue;
      if (wanted.has(id2)) matched.add(id2);
      if (wanted.has(model.id)) matched.add(model.id);
    }
    const probed = catalogToProbed({ ...model, id: id2 });
    resolved.push(probed);
    models[id2] = probedToEnriched(probed, displayStyle);
  }
  const missing = wanted ? [...wanted].filter((raw) => !matched.has(raw)) : [];
  return { baseURL: site.api, models, resolved, missing };
}
async function previewManualModels(ids, flavor, displayStyle) {
  const lookup = await getLookupMap();
  const customs = loadCustomRules();
  const resolvedFlavor = flavor ?? DEFAULT_FLAVOR;
  const style = displayStyle ?? "slug";
  const out = [];
  for (const raw of ids) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const probed = resolveModel({ id: trimmed }, lookup, resolvedFlavor, customs);
    out.push({ id: probed.id, probed, model: probedToEnriched(probed, style) });
  }
  return out;
}

// src/discovery.ts
async function discoverAndEnrich(baseURL, apiKey, displayStyle = "slug", flavor = DEFAULT_FLAVOR) {
  const probed = await probeEndpoint(baseURL, apiKey, flavor);
  const result = {};
  for (const p of probed) {
    const id2 = sanitizeModelId(p.id);
    result[id2] = probedToEnriched(p, displayStyle);
  }
  return result;
}

// src/types.ts
function getApiKey(provider, providerId) {
  if (provider.options?.apiKey) return provider.options.apiKey;
  const envKey = `OPENCODE_LOCAL_${providerId.toUpperCase().replaceAll(/[^A-Z0-9]/g, "_")}_API_KEY`;
  return process.env[envKey];
}
function shouldDiscover(provider) {
  const baseURL = provider.options?.baseURL;
  if (!baseURL || !isValidUrl(baseURL)) return false;
  if (provider.dynamic === true) return true;
  const models = provider.models;
  return !models || Object.keys(models).length === 0;
}

// src/reconcile.ts
function hasImage(model) {
  return model.modalities?.input.includes("image") ?? false;
}
function describeUpdate(id2, current, fresh) {
  const parts = [];
  if (current.limit.context !== fresh.limit.context) {
    parts.push(`context ${current.limit.context} -> ${fresh.limit.context}`);
  }
  if (current.limit.output !== fresh.limit.output) {
    parts.push(`max-out ${current.limit.output} -> ${fresh.limit.output}`);
  }
  if (current.name !== fresh.name) {
    parts.push(`name "${current.name}" -> "${fresh.name}"`);
  }
  if (!!current.reasoning !== !!fresh.reasoning) {
    parts.push(fresh.reasoning ? "reasoning [+]" : "reasoning [-]");
  }
  if (hasImage(current) !== hasImage(fresh)) {
    parts.push(hasImage(fresh) ? "image [+]" : "image [-]");
  }
  if (parts.length === 0) return null;
  return `${id2}: ${parts.join(", ")}`;
}
function mergeAppliedModel(stored, fresh) {
  const merged = {
    name: fresh.name,
    limit: { ...stored.limit, ...fresh.limit },
    modalities: fresh.modalities ?? stored.modalities
  };
  if (stored.family !== void 0) merged.family = stored.family;
  if (stored.release_date !== void 0) merged.release_date = stored.release_date;
  if (stored.status !== void 0) merged.status = stored.status;
  if (stored.attachment !== void 0) merged.attachment = stored.attachment;
  if (stored.temperature !== void 0) merged.temperature = stored.temperature;
  if (stored.tool_call !== void 0) merged.tool_call = stored.tool_call;
  if (fresh.reasoning) merged.reasoning = true;
  if (fresh.cost) {
    merged.cost = { ...fresh.cost };
  } else if (stored.cost) {
    merged.cost = { ...stored.cost };
  }
  if (fresh.reasoningLevels?.length) {
    merged.reasoningLevels = [...fresh.reasoningLevels];
  } else if (merged.reasoning && stored.reasoningLevels?.length) {
    merged.reasoningLevels = [...stored.reasoningLevels];
  }
  return merged;
}
function diffModels(current, fresh, displayStyle) {
  const changes = [];
  const seen = /* @__PURE__ */ new Set();
  for (const p of fresh) {
    seen.add(p.id);
    const stored = current[p.id];
    if (!stored) {
      changes.push({ id: p.id, kind: "added", detail: `${p.id}: new model` });
      continue;
    }
    const detail = describeUpdate(p.id, stored, probedToEnriched(p, displayStyle));
    if (detail) changes.push({ id: p.id, kind: "updated", detail });
  }
  for (const id2 of Object.keys(current)) {
    if (!seen.has(id2)) {
      changes.push({ id: id2, kind: "removed", detail: `${id2}: vanished upstream (unsupported)` });
    }
  }
  return changes;
}
function applyDecisions(current, fresh, decisions, displayStyle) {
  const next = { ...current };
  const freshById = new Map(fresh.map((p) => [p.id, p]));
  for (const p of fresh) {
    const decision = decisions[p.id] ?? "apply";
    if (!current[p.id]) {
      if (decision === "apply") next[p.id] = probedToEnriched(p, displayStyle);
    } else if (decision === "apply") {
      next[p.id] = mergeAppliedModel(current[p.id], probedToEnriched(p, displayStyle));
    } else if (decision === "remove") {
      delete next[p.id];
    }
  }
  for (const id2 of Object.keys(current)) {
    if (!freshById.has(id2)) {
      const decision = decisions[id2] ?? "keep";
      if (decision !== "keep") delete next[id2];
    }
  }
  return next;
}

// src/commands.ts
async function reloadOneProvider(providerId, providerConfig) {
  const baseURL = providerConfig.options.baseURL;
  const apiKey = getApiKey(providerConfig, providerId);
  const displayStyle = providerConfig.displayStyle ?? "slug";
  try {
    const models = await discoverAndEnrich(baseURL, apiKey, displayStyle, getProviderFlavor(providerConfig));
    const count = Object.keys(models).length;
    if (count > 0) {
      return { providerId, models };
    }
    if (providerConfig.models && Object.keys(providerConfig.models).length > 0) {
      return {
        providerId,
        models: null,
        warning: `${providerId} returned 0 models (keeping previous models). Check endpoint status.`
      };
    }
    return { providerId, models: null };
  } catch (error) {
    return {
      providerId,
      models: null,
      error: `Failed to reload ${providerId}: ${sanitizeErrorMessage(error)}`
    };
  }
}
async function chunkedAllSettled(tasks, size = 4) {
  const outcomes = [];
  for (let i = 0; i < tasks.length; i += size) {
    const settled = await Promise.allSettled(tasks.slice(i, i + size).map((fn) => fn()));
    outcomes.push(...settled);
  }
  return outcomes;
}
async function reloadAllProviders(providers) {
  const dynamicProviders = Object.entries(providers).filter(
    ([, p]) => shouldDiscover(p)
  );
  const result = {
    totalModels: 0,
    failures: 0,
    providerCount: dynamicProviders.length,
    warnings: [],
    errors: []
  };
  if (dynamicProviders.length === 0) return result;
  clearModelsDevCache();
  const outcomes = await chunkedAllSettled(
    dynamicProviders.map(([id2, cfg]) => () => reloadOneProvider(id2, cfg)),
    4
  );
  for (const outcome of outcomes) {
    if (outcome.status === "rejected") {
      result.failures++;
      result.errors.push(`Unexpected error: ${sanitizeErrorMessage(outcome.reason)}`);
      continue;
    }
    const { providerId, models, warning, error } = outcome.value;
    if (error) {
      result.failures++;
      result.errors.push(error);
    } else if (warning) {
      result.warnings.push(warning);
    }
    if (models) {
      const providerConfig = providers[providerId];
      providerConfig.models = models;
      result.totalModels += Object.keys(models).length;
    }
  }
  return result;
}
function validateProviderId(providerId) {
  if (!/^[a-zA-Z0-9_-]+$/.test(providerId)) {
    return "Invalid Provider ID. Use alphanumeric, hyphens, or underscores only.";
  }
  return null;
}
function validateAddProviderParams(params, existingProviders) {
  const idError = validateProviderId(params.providerId);
  if (idError) return idError;
  if (!isValidUrl(params.baseURL)) {
    return "Invalid Base URL. Please enter a full URL (including https://).";
  }
  if (existingProviders[params.providerId] && !params.overwrite) {
    return `A provider with ID '${params.providerId}' already exists. Set overwrite to true to replace it.`;
  }
  return null;
}
async function addProvider(params) {
  const displayStyle = params.displayStyle ?? "slug";
  const baseURL = params.baseURL.trim().replace(/\/+$/, "");
  try {
    const models = await discoverAndEnrich(baseURL, params.apiKey, displayStyle, params.flavor ?? DEFAULT_FLAVOR);
    const modelCount = Object.keys(models).length;
    if (modelCount === 0) {
      return {
        success: false,
        modelCount: 0,
        message: "No models found at the given endpoint. Provider not added."
      };
    }
    const providerEntry = {
      name: params.providerId,
      npm: "@ai-sdk/openai-compatible",
      api: baseURL,
      options: { baseURL },
      dynamic: true,
      displayStyle,
      models
    };
    if (params.flavor) providerEntry.flavor = params.flavor;
    if (params.apiKey) {
      const role = await probeDeveloperRole(baseURL, params.apiKey);
      if (role === false) {
        providerEntry.compat = { supportsDeveloperRole: false };
      }
    }
    return {
      success: true,
      modelCount,
      message: `Provider '${params.providerId}' added with ${modelCount} model(s).`,
      providerEntry
    };
  } catch (error) {
    return {
      success: false,
      modelCount: 0,
      message: `Failed to discover models: ${sanitizeErrorMessage(error)}`
    };
  }
}
async function persistProviderApiKey(providerEntry, providerId, apiKey, storeApiKey) {
  if (!apiKey) return;
  let storedInAuthStore = false;
  try {
    storedInAuthStore = await storeApiKey(providerId, apiKey);
  } catch {
    storedInAuthStore = false;
  }
  if (!storedInAuthStore) {
    throw new Error(
      `Failed to persist API key for provider '${providerId}' in auth store`
    );
  }
}
function getProviderFlavor(provider) {
  const raw = provider.flavor;
  return (typeof raw === "string" ? parseFlavor(raw) : null) ?? DEFAULT_FLAVOR;
}
async function reprobeProvider(providerId, provider) {
  const baseURL = provider.options?.baseURL;
  if (!baseURL || !isValidUrl(baseURL)) {
    throw new Error(`Provider '${providerId}' has no valid baseURL to probe.`);
  }
  const apiKey = getApiKey(provider, providerId);
  const displayStyle = provider.displayStyle ?? "slug";
  const flavor = getProviderFlavor(provider);
  if (FLAVORS[flavor].listShape === "none") {
    return { changes: [], fresh: [] };
  }
  const fresh = await probeEndpoint(baseURL, apiKey, flavor);
  const current = provider.models ?? {};
  return { changes: diffModels(current, fresh, displayStyle), fresh };
}
function applyReconcile(provider, fresh, decisions) {
  const displayStyle = provider.displayStyle ?? "slug";
  const current = provider.models ?? {};
  return applyDecisions(current, fresh, decisions, displayStyle);
}
function renameProviderEntry(providers, oldId, newId) {
  const clean = newId.trim();
  const idError = validateProviderId(clean);
  if (idError) return { error: idError };
  const entry = providers[oldId];
  if (!entry) return { error: `Unknown provider '${oldId}'.` };
  if (clean !== oldId && providers[clean]) {
    return { error: `A provider with ID '${clean}' already exists.` };
  }
  delete providers[oldId];
  entry.name = clean;
  providers[clean] = entry;
  const suggestion = collisionSuggestion(clean);
  if (suggestion && suggestion !== clean) {
    return {
      warning: `'${clean}' matches a well-known built-in id and will merge with it. Consider '${suggestion}' for a fully separate provider.`
    };
  }
  return {};
}
function deleteProviderEntry(providers, providerId) {
  if (!providers[providerId]) return `Unknown provider '${providerId}'.`;
  delete providers[providerId];
  return null;
}
function parseToggle(value) {
  const v = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(v)) return true;
  if (["false", "0", "no", "off"].includes(v)) return false;
  return null;
}
function editModelField(models, modelId, field, value) {
  const model = models[modelId];
  if (!model) return `Unknown model '${modelId}'.`;
  switch (field) {
    case "name": {
      const name = value.trim();
      if (!name) return "Name must not be empty.";
      model.name = name;
      return null;
    }
    case "context":
    case "output": {
      if (!model.limit) return `Model '${modelId}' has no 'limit' configured.`;
      const n = Number(value);
      if (!Number.isInteger(n) || n <= 0) {
        return `'${field}' must be a positive integer (got '${value}').`;
      }
      if (field === "context") model.limit.context = n;
      else model.limit.output = n;
      return null;
    }
    case "reasoning": {
      const b = parseToggle(value);
      if (b === null) return `Use true/false for 'reasoning' (got '${value}').`;
      if (b) model.reasoning = true;
      else delete model.reasoning;
      return null;
    }
    case "image": {
      const b = parseToggle(value);
      if (b === null) return `Use true/false for 'image' (got '${value}').`;
      model.modalities = b ? { input: ["text", "image"], output: ["text"] } : { input: ["text"], output: ["text"] };
      return null;
    }
  }
}
function getStoredModels(provider) {
  return provider.models ?? {};
}
function deleteModels(models, ids) {
  const deleted = [];
  const missing = [];
  for (const raw of ids) {
    const id2 = raw.trim();
    if (!id2) continue;
    if (models[id2]) {
      delete models[id2];
      deleted.push(id2);
    } else {
      missing.push(id2);
    }
  }
  return { deleted, missing };
}
async function migrateInlineKey(provider, providerId, storeApiKey) {
  const inline = provider.options?.apiKey;
  if (!inline) return { migrated: false, note: "" };
  try {
    const ok = await storeApiKey(providerId, inline);
    if (!ok) {
      return { migrated: false, note: `Kept inline API key for '${providerId}' (auth store declined).` };
    }
  } catch {
    return { migrated: false, note: `Kept inline API key for '${providerId}' (auth store unavailable).` };
  }
  if (provider.options) delete provider.options.apiKey;
  return { migrated: true, note: `Migrated inline API key for '${providerId}' to the auth store.` };
}

// src/opencode-client.ts
function createTuiBridge(apiClient) {
  return {
    async setApiKey(id2, key) {
      await apiClient.auth.set({ providerID: id2, auth: { type: "api", key } });
    },
    async removeApiKey(id2) {
      await apiClient.auth.remove({ providerID: id2 });
    },
    async updateProviders(providers) {
      const body = { provider: providers };
      await apiClient.config.update({ config: body });
    },
    async getProviders() {
      const { data: config } = await apiClient.config.get();
      return config?.provider ?? {};
    }
  };
}

// src/tui.ts
var id = "opencode-custom-providers";
function showPrompt(api, title, placeholder) {
  return new Promise((resolve) => {
    api.ui.dialog.replace(
      () => api.ui.DialogPrompt({
        title,
        placeholder,
        onConfirm: (value) => resolve(value),
        onCancel: () => resolve(null)
      }),
      () => resolve(null)
    );
  });
}
function showConfirm(api, title, message) {
  return new Promise((resolve) => {
    api.ui.dialog.replace(
      () => api.ui.DialogConfirm({
        title,
        message,
        onConfirm: () => resolve(true),
        onCancel: () => resolve(false)
      }),
      () => resolve(false)
    );
  });
}
function showSelect(api, title, options) {
  return new Promise((resolve) => {
    api.ui.dialog.replace(
      () => api.ui.DialogSelect({
        title,
        options: options.map((o) => ({
          ...o,
          onSelect: () => resolve(o.value)
        }))
      }),
      () => resolve(null)
    );
  });
}
var tui = async (api) => {
  const bridge = createTuiBridge(api.client);
  api.command.register(() => [
    {
      title: "Reload Models",
      value: "reload-models",
      description: "Re-discover models from all dynamic providers without restarting",
      slash: {
        name: "reload-models",
        aliases: ["refresh-models"]
      },
      onSelect: async () => {
        const providers = await bridge.getProviders();
        const result = await reloadAllProviders(providers);
        if (result.providerCount === 0) {
          api.ui.toast({ message: "No dynamic providers configured.", variant: "warning" });
          return;
        }
        api.ui.toast({
          message: `Reloading models from ${result.providerCount} provider(s)...`,
          variant: "info"
        });
        for (const w of result.warnings) {
          api.ui.toast({ message: w, variant: "warning" });
        }
        for (const e of result.errors) {
          api.ui.toast({ message: e, variant: "error" });
        }
        if (result.totalModels > 0) {
          await bridge.updateProviders(providers);
        }
        if (result.failures === 0) {
          api.ui.toast({
            message: `Reloaded ${result.totalModels} model(s) from ${result.providerCount} provider(s).`,
            variant: "success"
          });
        } else if (result.totalModels > 0) {
          api.ui.toast({
            message: `Reloaded ${result.totalModels} model(s) with ${result.failures} failure(s). Check provider URLs/keys.`,
            variant: "warning"
          });
        }
      }
    },
    {
      title: "Add Provider",
      value: "add-provider",
      description: "Add a new OpenAI-compatible custom provider with dynamic model discovery",
      slash: {
        name: "add-provider"
      },
      onSelect: async () => {
        const source = await showSelect(api, "Add provider", [
          { title: "Custom endpoint", value: "endpoint", description: "Probe /models and metadata sources" },
          { title: "models.dev catalog", value: "catalog", description: "Known site, metadata from catalog, no probing" }
        ]);
        if (!source) return;
        if (source === "catalog") {
          let sites;
          try {
            api.ui.toast({ message: "Loading models.dev catalog...", variant: "info" });
            sites = await listCatalogSites();
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            api.ui.toast({ message: `Catalog failed: ${message}`, variant: "error" });
            return;
          }
          if (sites.length === 0) {
            api.ui.toast({ message: "Catalog is empty.", variant: "warning" });
            return;
          }
          const siteId = await showSelect(api, "Catalog site", sites.map((s) => ({
            title: s.name,
            value: s.id,
            description: `${s.modelCount} model(s)`
          })));
          if (!siteId) return;
          const site = sites.find((s) => s.id === siteId);
          if (!site) return;
          const rawProviderId2 = await showPrompt(api, "Provider ID", siteId);
          if (!rawProviderId2) return;
          const providerId2 = rawProviderId2.trim();
          const idError2 = validateProviderId(providerId2);
          if (idError2) {
            api.ui.toast({ message: idError2, variant: "error" });
            return;
          }
          const suggestion = collisionSuggestion(providerId2);
          if (suggestion && suggestion !== providerId2) {
            api.ui.toast({ message: `'${providerId2}' merges with a built-in id; '${suggestion}' stays separate.`, variant: "warning" });
          }
          const catProviders = await bridge.getProviders();
          if (catProviders[providerId2]) {
            const overwrite2 = await showConfirm(api, "Provider already exists", `Overwrite '${providerId2}'?`);
            if (!overwrite2) return;
          }
          const rawApiKey2 = await showPrompt(api, "API Key (Optional)", "sk-...");
          const apiKey2 = rawApiKey2?.trim() || void 0;
          const displayStyle2 = await showSelect(api, "Model Display Names", [
            { title: "Full Slug", value: "slug", description: "vertex/gemini-3.1-pro (best for proxies)" },
            { title: "Friendly Name", value: "name", description: "Gemini 3.1 Pro (may be ambiguous)" }
          ]);
          if (!displayStyle2) return;
          const scope = await showSelect(api, `${site.modelCount} model(s) available`, [
            { title: "Add all", value: "all", description: `${site.modelCount} model(s)` },
            { title: "Pick ids", value: "pick", description: "Comma-separated" },
            { title: "Cancel", value: "cancel", description: "Add nothing" }
          ]);
          if (!scope || scope === "cancel") return;
          let modelIds;
          if (scope === "pick") {
            const rawIds = await showPrompt(api, "Model ids (comma-separated)");
            if (!rawIds) return;
            modelIds = parseModelIds(rawIds);
            if (!modelIds || modelIds.length === 0) {
              api.ui.toast({ message: "No model ids provided. Enter at least one id (comma-separated).", variant: "error" });
              return;
            }
          }
          api.ui.toast({ message: `Adding ${providerId2} from catalog...`, variant: "info" });
          let built;
          try {
            built = await buildCatalogModels(siteId, modelIds, displayStyle2);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            api.ui.toast({ message: `Catalog add failed: ${message}`, variant: "error" });
            return;
          }
          const entry = {
            name: providerId2,
            npm: "@ai-sdk/openai-compatible",
            api: built.baseURL,
            options: { baseURL: built.baseURL },
            dynamic: true,
            displayStyle: displayStyle2,
            models: built.models
          };
          try {
            await persistProviderApiKey(entry, providerId2, apiKey2, async (id2, key) => {
              await bridge.setApiKey(id2, key);
              return true;
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            api.ui.toast({ message: `Failed to persist API key: ${message}`, variant: "error" });
            return;
          }
          catProviders[providerId2] = entry;
          await bridge.updateProviders(catProviders);
          const stored = Object.keys(built.models).length;
          api.ui.toast({
            message: `Added ${stored} model(s)${built.missing.length > 0 ? `, unknown: ${built.missing.join(", ")}` : ""}.`,
            variant: "success"
          });
          return;
        }
        const rawProviderId = await showPrompt(api, "Provider ID", "e.g., my-proxy (alphanumeric only)");
        if (!rawProviderId) return;
        const providerId = rawProviderId.trim();
        const idError = validateProviderId(providerId);
        if (idError) {
          api.ui.toast({ message: idError, variant: "error" });
          return;
        }
        const providers = await bridge.getProviders();
        let overwrite = false;
        if (providers[providerId]) {
          overwrite = await showConfirm(
            api,
            "Provider already exists",
            `A provider with ID '${providerId}' already exists. Overwrite it?`
          );
          if (!overwrite) return;
        }
        const rawBaseURL = await showPrompt(api, "Base URL", "https://api.example.com/v1");
        if (!rawBaseURL) return;
        const baseURL = rawBaseURL.trim();
        const rawApiKey = await showPrompt(api, "API Key (Optional)", "sk-...");
        const apiKey = rawApiKey?.trim() || void 0;
        const displayStyle = await showSelect(api, "Model Display Names", [
          {
            title: "Full Slug",
            value: "slug",
            description: "vertex/gemini-3.1-pro (best for proxies)"
          },
          {
            title: "Friendly Name",
            value: "name",
            description: "Gemini 3.1 Pro (may be ambiguous)"
          }
        ]);
        if (!displayStyle) return;
        const params = { providerId, baseURL, apiKey, displayStyle, overwrite };
        const validationError = validateAddProviderParams(params, providers);
        if (validationError) {
          api.ui.toast({ message: validationError, variant: "error" });
          return;
        }
        api.ui.toast({ message: `Discovering models from ${baseURL}...`, variant: "info" });
        const result = await addProvider(params);
        if (!result.success || !result.providerEntry) {
          api.ui.toast({ message: result.message, variant: "warning" });
          return;
        }
        try {
          await persistProviderApiKey(
            result.providerEntry,
            providerId,
            apiKey,
            async (id2, key) => {
              await bridge.setApiKey(id2, key);
              return true;
            }
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          api.ui.toast({ message: `Failed to persist API key: ${message}`, variant: "error" });
          return;
        }
        providers[providerId] = result.providerEntry;
        await bridge.updateProviders(providers);
        api.ui.toast({ message: result.message, variant: "success" });
      }
    },
    {
      title: "Re-probe Models",
      value: "reprobe-models",
      description: "Re-probe a provider and reconcile model changes",
      slash: {
        name: "reprobe-models"
      },
      onSelect: async () => {
        const providers = await bridge.getProviders();
        const ids = Object.keys(providers);
        if (ids.length === 0) {
          api.ui.toast({ message: "No providers configured.", variant: "warning" });
          return;
        }
        const providerId = await showSelect(api, "Provider to re-probe", ids.map((id2) => ({ title: id2, value: id2 })));
        if (!providerId) return;
        const provider = providers[providerId];
        api.ui.toast({ message: `Probing ${providerId}...`, variant: "info" });
        let rep;
        try {
          rep = await reprobeProvider(providerId, provider);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          api.ui.toast({ message: `Re-probe failed: ${message}`, variant: "error" });
          return;
        }
        if (rep.changes.length === 0) {
          api.ui.toast({ message: `Already in sync (${rep.fresh.length} model(s)).`, variant: "success" });
          return;
        }
        const mode = await showSelect(api, `${rep.changes.length} change(s) found`, [
          { title: "Apply all", value: "all", description: "Take every fresh value, keep vanished" },
          { title: "Review each", value: "each", description: "Decide per model" },
          { title: "Cancel", value: "cancel", description: "Change nothing" }
        ]);
        if (!mode || mode === "cancel") return;
        const decisions = {};
        if (mode === "each") {
          const freshById = new Map(rep.fresh.map((p) => [p.id, p]));
          for (const change of rep.changes) {
            const fresh = freshById.get(change.id);
            const source = fresh ? `
${describeProbed(fresh)}` : "";
            const choice = await showSelect(api, `[${change.kind}] ${change.id}`, [
              { title: "Apply", value: "apply", description: `${change.detail}${source}` },
              { title: "Keep stored", value: "keep", description: "Leave the current entry unchanged" },
              { title: "Remove", value: "remove", description: "Delete the stored entry" }
            ]);
            if (!choice) return;
            decisions[change.id] = choice;
          }
        }
        const next = applyReconcile(provider, rep.fresh, decisions);
        provider.models = next;
        await bridge.updateProviders(providers);
        api.ui.toast({ message: `Reconciled: ${Object.keys(next).length} model(s) stored.`, variant: "success" });
      }
    },
    {
      title: "Edit Provider",
      value: "edit-provider",
      description: "Rename, re-point, or tweak a provider and its models",
      slash: {
        name: "edit-provider"
      },
      onSelect: async () => {
        const providers = await bridge.getProviders();
        const ids = Object.keys(providers);
        if (ids.length === 0) {
          api.ui.toast({ message: "No providers configured.", variant: "warning" });
          return;
        }
        const providerId = await showSelect(api, "Provider to edit", ids.map((id2) => ({ title: id2, value: id2 })));
        if (!providerId) return;
        const provider = providers[providerId];
        if (provider.options?.apiKey) {
          try {
            const migration = await migrateInlineKey(provider, providerId, async (id2, key) => {
              await bridge.setApiKey(id2, key);
              return true;
            });
            if (migration.migrated) {
              api.ui.toast({ message: migration.note, variant: "success" });
              await bridge.updateProviders(providers);
            } else if (migration.note) {
              api.ui.toast({ message: migration.note, variant: "warning" });
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            api.ui.toast({ message: `Key migration failed: ${message}`, variant: "error" });
          }
        }
        const action = await showSelect(api, `Edit ${providerId}`, [
          { title: "Rename", value: "rename" },
          { title: "Endpoint", value: "endpoint" },
          { title: "Flavor", value: "flavor" },
          { title: "API key", value: "key" },
          { title: "Display style", value: "style" },
          { title: "Edit model", value: "model" },
          { title: "Add models manually", value: "add" },
          { title: "Delete models", value: "delete" }
        ]);
        if (!action) return;
        const save = async () => {
          await bridge.updateProviders(providers);
        };
        if (action === "rename") {
          const raw = await showPrompt(api, "New provider ID", providerId);
          if (!raw) return;
          let finalId = raw.trim();
          const suggestion = collisionSuggestion(finalId);
          if (suggestion && suggestion !== finalId) {
            const useSuggested = await showConfirm(
              api,
              "Built-in id collision",
              `'${finalId}' merges with a built-in provider. Use '${suggestion}' instead?`
            );
            if (useSuggested) finalId = suggestion;
          }
          const { error, warning } = renameProviderEntry(providers, providerId, finalId);
          if (error) {
            api.ui.toast({ message: error, variant: "error" });
            return;
          }
          await save();
          api.ui.toast({ message: `Renamed to '${finalId}'.`, variant: "success" });
          if (warning) api.ui.toast({ message: warning, variant: "warning" });
          api.ui.toast({ message: "Stored credential (if any) is still keyed by the old id \u2014 re-enter it via Edit Provider \u2192 API key.", variant: "warning" });
          return;
        }
        if (action === "endpoint") {
          const raw = await showPrompt(api, "Base URL", provider.options?.baseURL);
          if (!raw) return;
          const baseURL = raw.trim().replace(/\/+$/, "");
          if (!isValidUrl(baseURL)) {
            api.ui.toast({ message: "Invalid Base URL.", variant: "error" });
            return;
          }
          provider.options = { ...provider.options, baseURL };
          provider.api = baseURL;
          await save();
          api.ui.toast({ message: "Endpoint updated. Run Re-probe Models to refresh.", variant: "success" });
          return;
        }
        if (action === "flavor") {
          const flavor = await showSelect(api, "Endpoint flavor", Object.values(FLAVORS).map((f) => ({
            title: f.label,
            value: f.flavor,
            description: f.description
          })));
          if (!flavor) return;
          provider.flavor = flavor;
          await save();
          api.ui.toast({ message: `Flavor set to ${flavor}. Run Re-probe Models to refresh.`, variant: "success" });
          return;
        }
        if (action === "key") {
          const raw = await showPrompt(api, "API Key (blank to clear)", "sk-...");
          if (raw === null) return;
          const key = raw.trim() || void 0;
          try {
            await persistProviderApiKey(provider, providerId, key, async (id2, k) => {
              await bridge.setApiKey(id2, k);
              return true;
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            api.ui.toast({ message: `Failed to persist API key: ${message}`, variant: "error" });
            return;
          }
          if (!key) {
            try {
              await bridge.removeApiKey?.(providerId);
            } catch {
            }
          }
          if (!key && provider.options) delete provider.options.apiKey;
          await save();
          api.ui.toast({ message: key ? "API key updated." : "API key cleared.", variant: "success" });
          return;
        }
        if (action === "style") {
          const style = await showSelect(api, "Model display names", [
            { title: "Full Slug", value: "slug" },
            { title: "Friendly Name", value: "name" }
          ]);
          if (!style) return;
          provider.displayStyle = style;
          await save();
          api.ui.toast({ message: `Display style set to ${style}.`, variant: "success" });
          return;
        }
        const models = getStoredModels(provider);
        if (action === "model") {
          const modelIds = Object.keys(models);
          if (modelIds.length === 0) {
            api.ui.toast({ message: "No models stored.", variant: "warning" });
            return;
          }
          const modelId = await showSelect(api, "Model to edit", modelIds.map((id2) => ({ title: id2, value: id2 })));
          if (!modelId) return;
          const field = await showSelect(api, `Field of ${modelId}`, [
            { title: "Display name", value: "name" },
            { title: "Context window", value: "context" },
            { title: "Max output", value: "output" },
            { title: "Reasoning", value: "reasoning" },
            { title: "Image input", value: "image" }
          ]);
          if (!field) return;
          const m = models[modelId];
          if ((field === "context" || field === "output") && !m.limit) {
            api.ui.toast({ message: `Model '${modelId}' has no 'limit' configured.`, variant: "error" });
            return;
          }
          const current = field === "name" ? m.name : field === "context" ? String(m.limit.context) : field === "output" ? String(m.limit.output) : field === "reasoning" ? String(!!m.reasoning) : String(m.modalities?.input.includes("image") ?? false);
          const raw = await showPrompt(api, `${field} (current: ${current})`);
          if (raw === null) return;
          const error = editModelField(models, modelId, field, raw);
          if (error) {
            api.ui.toast({ message: error, variant: "error" });
            return;
          }
          provider.models = models;
          await save();
          api.ui.toast({ message: `Model '${modelId}' updated.`, variant: "success" });
          return;
        }
        if (action === "add") {
          const raw = await showPrompt(api, "Model ids (comma-separated)");
          if (!raw) return;
          const ids2 = raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
          if (ids2.length === 0) return;
          api.ui.toast({ message: "Resolving metadata...", variant: "info" });
          const previews = await previewManualModels(ids2, provider.flavor, provider.displayStyle);
          const lines = previews.map(({ probed }) => describeProbed(probed));
          const ok = await showConfirm(
            api,
            "Add models",
            `${previews.length} model(s):
${lines.slice(0, 10).join("\n")}${lines.length > 10 ? `
\u2026+${lines.length - 10} more` : ""}`
          );
          if (!ok) return;
          const stored = getStoredModels(provider);
          let added = 0;
          const skipped = [];
          for (const { id: id2, model } of previews) {
            if (!id2 || stored[id2]) {
              skipped.push(id2);
              continue;
            }
            stored[id2] = model;
            added++;
          }
          provider.models = stored;
          await save();
          api.ui.toast({
            message: `Added ${added}${skipped.length > 0 ? `, skipped ${skipped.length}` : ""}.`,
            variant: "success"
          });
          return;
        }
        if (action === "delete") {
          const modelIds = Object.keys(models);
          if (modelIds.length === 0) {
            api.ui.toast({ message: "No models stored.", variant: "warning" });
            return;
          }
          const raw = await showPrompt(api, "Model ids to delete (comma-separated)");
          if (!raw) return;
          const candidates = raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
          const unknown = candidates.filter((id2) => !models[id2]);
          if (unknown.length > 0) {
            api.ui.toast({ message: `Unknown model(s): ${unknown.join(", ")}.`, variant: "error" });
            return;
          }
          const ok = await showConfirm(
            api,
            "Delete models",
            `Remove ${candidates.length} model(s) from ${providerId}?
${candidates.join(", ")}`
          );
          if (!ok) return;
          const { deleted } = deleteModels(models, candidates);
          provider.models = models;
          await save();
          api.ui.toast({ message: `Deleted ${deleted.length} model(s).`, variant: "success" });
        }
      }
    },
    {
      title: "Delete Provider",
      value: "delete-provider",
      description: "Remove a provider and its models",
      slash: {
        name: "delete-provider"
      },
      onSelect: async () => {
        const providers = await bridge.getProviders();
        const ids = Object.keys(providers);
        if (ids.length === 0) {
          api.ui.toast({ message: "No providers configured.", variant: "warning" });
          return;
        }
        const providerId = await showSelect(api, "Provider to delete", ids.map((id2) => ({ title: id2, value: id2 })));
        if (!providerId) return;
        const ok = await showConfirm(api, "Delete provider", `Remove '${providerId}' and all its models?`);
        if (!ok) return;
        const error = deleteProviderEntry(providers, providerId);
        if (error) {
          api.ui.toast({ message: error, variant: "error" });
          return;
        }
        await bridge.updateProviders(providers);
        api.ui.toast({ message: `Provider '${providerId}' deleted.`, variant: "success" });
      }
    }
  ]);
};
var tui_default = { id, tui };
export {
  tui_default as default,
  id,
  tui
};
