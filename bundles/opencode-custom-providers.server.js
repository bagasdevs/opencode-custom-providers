// src/server.ts
import { tool } from "@opencode-ai/plugin";

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
function sanitizeDialogText(text) {
  return text.replaceAll(/[\u0000-\u001f\u007f]/g, "");
}
function sanitizeErrorMessage(error) {
  let message = error instanceof Error ? error.message : String(error);
  message = message.replaceAll(
    /https?:\/\/[^\s"'`<>]+/gi,
    (match) => sanitizeUrl(match)
  );
  const redacted = message.replaceAll(/Bearer\s+[^\s]+/gi, "Bearer [REDACTED]").replaceAll(/api[_-]?key[=:]\s*[^\s&]+/gi, "api_key=[REDACTED]").replaceAll(/sk-[a-zA-Z0-9_-]+/g, "sk-[REDACTED]").replaceAll(/\b(key|token|access_token|password)=[^\s&]+/gi, "$1=[REDACTED]");
  const printable = sanitizeDialogText(redacted);
  return printable.length > 400 ? `${printable.slice(0, 400)}\u2026` : printable;
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
var ENDPOINT_PATH_SUFFIXES = ["/chat/completions", "/messages", "/responses", "/models"];
function schemelessHostIsLocal(raw) {
  const host = raw.split(/[/?#]/, 1)[0];
  if (host.startsWith("[")) return true;
  if (/^::1($|:)/.test(host)) return true;
  const name = host.split(":", 1)[0];
  if (/^localhost$/i.test(name) || /\.local$/i.test(name)) return true;
  if (name === "0.0.0.0") return true;
  const octets = /^(\d{1,3})(?:\.(\d{1,3}))?(?:\.\d{1,3}){0,2}$/.exec(name);
  if (!octets) return false;
  const first = Number(octets[1]);
  const second = octets[2] === void 0 ? void 0 : Number(octets[2]);
  return first === 127 || first === 10 || first === 192 && second === 168 || first === 172 && second !== void 0 && second >= 16 && second <= 31;
}
function normalizeBaseUrl(raw) {
  let candidate = raw.trim();
  if (candidate === "") return candidate;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(candidate)) {
    candidate = `${schemelessHostIsLocal(candidate) ? "http" : "https"}://${candidate}`;
  }
  candidate = candidate.replace(/\/+$/, "");
  const schemeEnd = candidate.indexOf("://");
  if (candidate.indexOf("/", schemeEnd + 3) === -1) return candidate;
  let changed = true;
  while (changed) {
    changed = false;
    const lower = candidate.toLowerCase();
    for (const suffix of ENDPOINT_PATH_SUFFIXES) {
      if (lower.endsWith(suffix)) {
        candidate = candidate.slice(0, candidate.length - suffix.length).replace(/\/+$/, "");
        changed = true;
        break;
      }
    }
  }
  return candidate;
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
var PKG_VERSION = (() => {
  try {
    return createRequire(import.meta.url)("../package.json").version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();
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
  return Object.values(catalog).filter((p) => p && typeof p.id === "string" && p.api && isValidUrl(p.api) && p.models && Object.keys(p.models).length > 0).map((p) => ({
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
    label: "OpenAI-compatible (most common)",
    description: "Choose this for OpenAI, OpenRouter, DeepSeek, Groq, Together, LM Studio, vLLM and most other services. If unsure, choose this one",
    listPaths: ["/models"],
    listShape: "openai-list",
    fallbackLimits: { context: 128e3, output: 4096 }
  },
  "openai-responses": {
    flavor: "openai-responses",
    label: "OpenAI Responses API",
    description: "Only for services that explicitly ask for the 'Responses' API. If unsure, choose the first option",
    listPaths: ["/models"],
    listShape: "openai-list",
    fallbackLimits: { context: 128e3, output: 4096 }
  },
  anthropic: {
    flavor: "anthropic",
    label: "Anthropic (Claude)",
    description: "Claude models; the endpoint cannot list models, so add them from the catalog",
    listPaths: [],
    listShape: "none",
    fallbackLimits: { context: 2e5, output: 32e3 }
  },
  gemini: {
    flavor: "gemini",
    label: "Google Gemini",
    description: "Google's Gemini API (get a key at aistudio.google.com)",
    listPaths: ["/v1beta/models", "/models"],
    listShape: "gemini-list",
    fallbackLimits: { context: 1e6, output: 64e3 }
  },
  ollama: {
    flavor: "ollama",
    label: "Ollama (on this computer)",
    description: "A local Ollama install, usually http://localhost:11434",
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
  "opencode",
  "openai",
  "anthropic",
  "google",
  "gemini",
  "deepseek",
  "xai",
  "grok",
  "groq",
  "ollama",
  "openrouter",
  "azure",
  "bedrock",
  "vertex",
  "mistral",
  "together",
  "fireworks",
  "cerebras",
  "perplexity",
  "cohere",
  "moonshot",
  "zhipu",
  "lmstudio",
  "lm-studio",
  "vllm",
  "llamacpp",
  "llama-cpp",
  "github-copilot",
  "copilot"
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
function isLocalHost(host) {
  if (host === "localhost" || host === "::1" || host === "[::1]" || host === "0.0.0.0") return true;
  if (host.endsWith(".local")) return true;
  if (host.startsWith("127.") || host.startsWith("10.") || host.startsWith("192.168.")) return true;
  const second = /^172\.(\d+)\./.exec(host);
  return second !== null && Number(second[1]) >= 16 && Number(second[1]) <= 31;
}
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
    if (url.protocol === "http:" && !isLocalHost(host)) {
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
async function probeEndpointOutcome(baseURL, apiKey, flavor = DEFAULT_FLAVOR) {
  if (!isValidUrl(baseURL)) {
    throw new Error("Invalid Base URL. Please enter a full URL (including https://).");
  }
  if (FLAVORS[flavor].listShape === "none") {
    return { models: [], baseURL, listUnsupported: true };
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
        return {
          models: deep.map((item) => resolveModel(item, lookup, flavor, customs)),
          baseURL: candidate,
          listUnsupported: false
        };
      }
    } catch (error) {
      lastError = sanitizeErrorMessage(error);
    }
  }
  throw new Error(
    `Probe failed for ${baseURL}` + (lastError ? `: ${lastError}` : ". No models found \u2014 retry or add models manually.")
  );
}
async function probeEndpoint(baseURL, apiKey, flavor = DEFAULT_FLAVOR) {
  return (await probeEndpointOutcome(baseURL, apiKey, flavor)).models;
}
function probedToEnriched(probed, displayStyle) {
  const limit = {};
  if (hasEvidence(probed.contextSource)) limit.context = probed.context;
  if (hasEvidence(probed.maxOutputSource)) limit.output = probed.maxOutput;
  const model = {
    name: displayStyle === "slug" ? probed.id : probed.name ?? probed.id,
    limit,
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
function hasEvidence(source) {
  return source !== void 0 && source !== "default" && source !== "api-fallback";
}
function describeProbed(probed) {
  const lines = [`Model: ${probed.id}`];
  if (hasEvidence(probed.contextSource)) {
    lines.push(`  Context window: ${probed.context?.toLocaleString("en-US") ?? "unknown"} tokens${tag(probed.contextSource)}`);
  }
  if (hasEvidence(probed.maxOutputSource)) {
    lines.push(`  Longest reply: ${probed.maxOutput?.toLocaleString("en-US") ?? "unknown"} tokens${tag(probed.maxOutputSource)}`);
  }
  if (probed.reasoning !== void 0) {
    const levels = probed.reasoningLevels?.length ? ` (${probed.reasoningLevels.join("/")})` : "";
    lines.push(`  Thinking: ${probed.reasoning ? "supported" : "not supported"}${levels}${tag(probed.reasoningSource)}`);
  }
  if (hasEvidence(probed.imageSource)) {
    lines.push(`  Image input: ${probed.image ? "supported" : "not supported"}${tag(probed.imageSource)}`);
  }
  if (probed.cost) {
    lines.push(
      `  Price: $${probed.cost.input} per million input tokens, $${probed.cost.output} per million output tokens${tag(probed.costSource)}`
    );
  }
  return lines.join("\n");
}
function tag(source) {
  return source === "detected" || source === void 0 ? "" : ` [${source}]`;
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
      changes.push({ id: p.id, kind: "added", detail: `${p.id}: new model`, searchText: `${p.id} added` });
      continue;
    }
    const detail = describeUpdate(p.id, stored, probedToEnriched(p, displayStyle));
    if (detail) changes.push({ id: p.id, kind: "updated", detail, searchText: `${p.id} updated` });
  }
  for (const id2 of Object.keys(current)) {
    if (!seen.has(id2)) {
      changes.push({ id: id2, kind: "removed", detail: `${id2}: vanished upstream (unsupported)`, searchText: `${id2} removed` });
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
async function rotateProviderApiKey(providerEntry, providerId, apiKey, storeApiKey) {
  await persistProviderApiKey(providerEntry, providerId, apiKey, storeApiKey);
  if (providerEntry.options) delete providerEntry.options.apiKey;
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
function createServerBridge(client) {
  return {
    async setApiKey(id2, key) {
      await client.auth.set({ path: { id: id2 }, body: { type: "api", key } });
    },
    async updateProviders(providers) {
      const body = { provider: providers };
      await client.config.update({ body });
    },
    async getProviders() {
      const { data: config } = await client.config.get();
      return config?.provider ?? {};
    }
  };
}

// src/v2-models.ts
var DEFAULT_REASONING_LEVELS = ["low", "medium", "high"];
function applyEnrichedToDraft(draft, model) {
  draft.name = model.name;
  if (model.family !== void 0) draft.family = model.family;
  const modalities = model.modalities;
  draft.capabilities = {
    tools: model.tool_call ?? true,
    input: modalities?.input?.length ? [...modalities.input] : ["text"],
    output: modalities?.output?.length ? [...modalities.output] : ["text"]
  };
  if (model.reasoning) {
    const levels = model.reasoningLevels?.length ? model.reasoningLevels : DEFAULT_REASONING_LEVELS;
    draft.variants = levels.map((level) => ({ id: level, label: level, thinkingLevel: level }));
  }
  const limit = {};
  if (model.limit.context !== void 0) limit.context = model.limit.context;
  if (model.limit.output !== void 0) limit.output = model.limit.output;
  if (model.limit.input !== void 0) limit.input = model.limit.input;
  draft.limit = limit;
  if (model.cost) {
    draft.cost = [
      {
        input: model.cost.input,
        output: model.cost.output,
        cache: {
          read: model.cost.cache_read ?? 0,
          write: model.cost.cache_write ?? 0
        }
      }
    ];
  }
  if (model.status !== void 0) draft.status = model.status;
  draft.enabled = true;
}
function probedToDraft(probed, displayStyle = "slug") {
  const draft = {};
  applyEnrichedToDraft(draft, probedToEnriched(probed, displayStyle));
  return draft;
}
function mergeDiscoveredIntoStored(target, fresh) {
  for (const [key, value] of Object.entries(fresh)) {
    if (value === void 0) continue;
    const current = target[key];
    if (value !== null && typeof value === "object" && !Array.isArray(value) && current !== null && typeof current === "object" && !Array.isArray(current)) {
      mergeDiscoveredIntoStored(current, value);
      continue;
    }
    target[key] = value;
  }
}

// src/ids.ts
var id = "opencode-custom-providers";

// src/server-v2.ts
var STORAGE_KEY = "providers";
var REMOVED_KEY = "removed";
var OPENAI_COMPATIBLE = "@opencode/ai/providers/openai-compatible";
var DISCOVERED = "discovered";
var RPC_ID = id;
var EMPTY_INPUT = { type: "object", properties: {}, additionalProperties: false };
var MESSAGE_OUTPUT = {
  type: "object",
  properties: { message: { type: "string" } },
  required: ["message"],
  additionalProperties: false
};
var ADD_OUTPUT = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["ok", "invalid", "unreachable", "manual_required", "confirm_endpoint_reuse"] },
    message: { type: "string" },
    detail: { type: "string" },
    usedBy: { type: "array", items: { type: "string" } }
  },
  required: ["status", "message"],
  additionalProperties: false
};
var MANUAL_ADD_OUTPUT = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["ok", "invalid"] },
    message: { type: "string" }
  },
  required: ["status", "message"],
  additionalProperties: false
};
function envKeyNames(providerId) {
  return [`OPENCODE_LOCAL_${providerId.toUpperCase().replaceAll(/[^A-Z0-9]/g, "_")}_API_KEY`];
}
function validId(providerId) {
  return /^[a-zA-Z0-9_-]+$/.test(providerId);
}
function probeHint(error) {
  const text = sanitizeErrorMessage(error);
  if (/\b(401|403)\b|revoked|unauthorized|invalid api key/i.test(text)) {
    return "The endpoint rejected the API key. Check that the key is correct and still active, then try again.";
  }
  if (/\b404\b/.test(text)) {
    return "The endpoint answered 404 (not found). Check the base URL - for OpenAI-compatible APIs it usually ends with /v1.";
  }
  if (/timed out|timeout|ENOTFOUND|ECONNREFUSED|fetch failed/i.test(text)) {
    return "The endpoint could not be reached. Check the base URL and your internet connection.";
  }
  return "Check the base URL and the API key, then try again.";
}
function zeroModelsHint(hasKey) {
  return hasKey ? "The endpoint listed no models. Check the base URL - it usually ends with /v1." : "The endpoint listed no models. Most gateways need an API key before they list models: add one and re-probe.";
}
function storedModelView(modelId, draft) {
  const model = { name: typeof draft.name === "string" ? draft.name : modelId, limit: {} };
  const limit = draft.limit;
  if (typeof limit === "object" && limit !== null) {
    const values = limit;
    if (typeof values.context === "number") model.limit.context = values.context;
    if (typeof values.input === "number") model.limit.input = values.input;
    if (typeof values.output === "number") model.limit.output = values.output;
  }
  const modalities = draft.modalities;
  if (typeof modalities === "object" && modalities !== null) {
    const values = modalities;
    const input = stringList(values.input);
    const output = stringList(values.output);
    if (input.length > 0 || output.length > 0) {
      model.modalities = { input: input.length > 0 ? input : ["text"], output: output.length > 0 ? output : ["text"] };
    }
  } else {
    const capabilities = draft.capabilities;
    if (typeof capabilities === "object" && capabilities !== null) {
      const caps = capabilities;
      const input = stringList(caps.input);
      const output = stringList(caps.output);
      if (input.length > 0 || output.length > 0) {
        model.modalities = { input: input.length > 0 ? input : ["text"], output: output.length > 0 ? output : ["text"] };
      }
    }
  }
  const capabilitiesForReasoning = draft.capabilities;
  const capsReasoning = typeof capabilitiesForReasoning === "object" && capabilitiesForReasoning !== null && capabilitiesForReasoning.reasoning === true;
  if (draft.reasoning === true || capsReasoning || Array.isArray(draft.variants) && draft.variants.length > 0) {
    model.reasoning = true;
  }
  return model;
}
function stringList(raw) {
  if (Array.isArray(raw)) return raw.filter((value) => typeof value === "string");
  if (typeof raw === "object" && raw !== null) {
    return Object.entries(raw).filter(([, on]) => on === true).map(([name]) => name);
  }
  return [];
}
function candidateFrom(record, managed) {
  const provider = record.provider;
  const settings = provider.settings ?? {};
  const baseURL = typeof settings.baseURL === "string" ? settings.baseURL : managed?.baseURL;
  if (!baseURL || !isValidUrl(baseURL)) return void 0;
  if (!managed && settings.dynamic === false) return void 0;
  if (!managed && settings.dynamic !== true) {
    const stored = [...record.models.values()].filter((model) => model[DISCOVERED] !== true && model.enabled !== false);
    if (stored.length > 0) return void 0;
  }
  const flavor = parseFlavor(typeof settings.flavor === "string" ? settings.flavor : void 0) ?? managed?.flavor ?? DEFAULT_FLAVOR;
  const displayStyle = settings.displayStyle === "name" || managed?.displayStyle === "name" ? "name" : "slug";
  return {
    providerId: provider.id,
    baseURL,
    apiKey: typeof settings.apiKey === "string" ? settings.apiKey : void 0,
    flavor,
    displayStyle
  };
}
function parseManaged(raw) {
  const result = /* @__PURE__ */ new Map();
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return result;
  for (const [providerId, value] of Object.entries(raw)) {
    if (typeof value !== "object" || value === null) continue;
    const entry = value;
    if (typeof entry.baseURL !== "string" || !isValidUrl(entry.baseURL)) continue;
    result.set(providerId, {
      baseURL: entry.baseURL,
      flavor: parseFlavor(typeof entry.flavor === "string" ? entry.flavor : void 0) ?? void 0,
      displayStyle: entry.displayStyle === "name" ? "name" : "slug"
    });
  }
  return result;
}
var setup = async (ctx) => {
  const managed = parseManaged(await ctx.storage.get(STORAGE_KEY).catch(() => void 0));
  const removed = new Set(await ctx.storage.get(REMOVED_KEY).catch(() => void 0) ?? []);
  const candidates = /* @__PURE__ */ new Map();
  const discovered = /* @__PURE__ */ new Map();
  const storedIds = /* @__PURE__ */ new Map();
  const storedModels = /* @__PURE__ */ new Map();
  const modelsFor = (providerId) => {
    let models = discovered.get(providerId);
    if (!models) {
      models = /* @__PURE__ */ new Map();
      discovered.set(providerId, models);
    }
    return models;
  };
  const clearRemoval = async (providerId) => {
    if (!removed.delete(providerId)) return;
    await ctx.storage.set(REMOVED_KEY, [...removed]);
  };
  const persist = async () => {
    await ctx.storage.set(STORAGE_KEY, Object.fromEntries(managed));
  };
  await ctx.provider.transform((providers) => {
    const found = /* @__PURE__ */ new Map();
    for (const record of providers.list()) {
      if (removed.has(record.provider.id)) continue;
      const candidate = candidateFrom(record, managed.get(record.provider.id));
      if (candidate) found.set(candidate.providerId, candidate);
    }
    for (const [providerId, entry] of managed) {
      if (found.has(providerId) || removed.has(providerId)) continue;
      const candidate = candidateFrom(
        { provider: { id: providerId, name: providerId, activation: "enabled" }, models: /* @__PURE__ */ new Map() },
        entry
      );
      if (candidate) found.set(providerId, candidate);
    }
    for (const providerId of removed) {
      providers.update(providerId, (provider) => {
        provider.activation = "disabled";
      });
    }
    for (const candidate of found.values()) {
      providers.update(candidate.providerId, (provider) => {
        provider.activation = "enabled";
        if (!provider.package) provider.package = OPENAI_COMPATIBLE;
        provider.settings = { ...provider.settings ?? {}, baseURL: candidate.baseURL };
        provider.integrationID = void 0;
      });
    }
    for (const [providerId, models] of discovered) {
      for (const [modelId, draft] of models) {
        providers.models.update(providerId, modelId, (model) => {
          mergeDiscoveredIntoStored(model, draft);
          model[DISCOVERED] = true;
        });
      }
    }
    candidates.clear();
    for (const [providerId, candidate] of found) candidates.set(providerId, candidate);
    storedIds.clear();
    storedModels.clear();
    for (const record of providers.list()) {
      if (!found.has(record.provider.id)) continue;
      storedIds.set(record.provider.id, /* @__PURE__ */ new Set([...record.models.keys()]));
      storedModels.set(record.provider.id, new Map([...record.models].map(([modelId, draft]) => [modelId, storedModelView(modelId, draft)])));
    }
    for (const providerId of [...discovered.keys()]) {
      if (!found.has(providerId)) discovered.delete(providerId);
    }
  });
  await ctx.integration.transform((integrations) => {
    for (const providerId of candidates.keys()) {
      integrations.update(providerId, (integration) => {
        integration.name = integration.name || providerId;
      });
      integrations.method.update({
        integrationID: providerId,
        method: { type: "key", label: "Manually enter API Key" }
      });
      integrations.method.update({
        integrationID: providerId,
        method: { type: "env", names: envKeyNames(providerId) }
      });
    }
  });
  const credentialKey = async (providerId) => {
    try {
      const connection = await ctx.integration.connection.active(providerId);
      if (!connection) return void 0;
      const credential = await ctx.integration.connection.resolve(connection);
      return credential?.type === "key" ? credential.key : void 0;
    } catch {
      return void 0;
    }
  };
  const discover = async (candidate) => {
    const apiKey = candidate.overrideKey ?? await credentialKey(candidate.providerId) ?? candidate.apiKey;
    const fresh = await probeEndpoint(candidate.baseURL, apiKey, candidate.flavor);
    return fresh.map((item) => ({ ...item, id: sanitizeModelId(item.id) }));
  };
  const registerIntegration = async (providerId) => {
    await ctx.integration.transform((integrations) => {
      integrations.update(providerId, (integration) => {
        integration.name = integration.name || providerId;
      });
      integrations.method.update({
        integrationID: providerId,
        method: { type: "key", label: "Manually enter API Key" }
      });
      integrations.method.update({
        integrationID: providerId,
        method: { type: "env", names: envKeyNames(providerId) }
      });
    });
    await ctx.integration.reload();
  };
  const applyModels = async (providerId, fresh, displayStyle) => {
    const models = modelsFor(providerId);
    for (const probed of fresh) models.set(probed.id, probedToDraft(probed, displayStyle));
    await ctx.provider.reload();
  };
  const refresh = async (only) => {
    const outcome = { checked: 0, updated: [], unchanged: [], empty: [], failed: [] };
    let changed = false;
    for (const candidate of [...candidates.values()]) {
      if (only !== void 0 && candidate.providerId !== only) continue;
      outcome.checked++;
      let fresh;
      try {
        fresh = await discover(candidate);
      } catch {
        outcome.failed.push(candidate.providerId);
        continue;
      }
      lastProbe.set(candidate.providerId, fresh.length);
      lastProbeModels.set(candidate.providerId, fresh);
      if (fresh.length === 0) {
        outcome.empty.push(candidate.providerId);
        continue;
      }
      const models = modelsFor(candidate.providerId);
      const before = fingerprint(models);
      for (const probed of fresh) models.set(probed.id, probedToDraft(probed, candidate.displayStyle));
      if (fingerprint(models) === before) outcome.unchanged.push(candidate.providerId);
      else outcome.updated.push(candidate.providerId);
      changed = true;
    }
    if (changed) await ctx.provider.reload();
    return outcome;
  };
  const fingerprint = (models) => {
    const parts = [];
    for (const [key, value] of [...models.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      parts.push(key + ":" + JSON.stringify(value));
    }
    return parts.join("|");
  };
  const lastProbeModels = /* @__PURE__ */ new Map();
  const lastProbe = /* @__PURE__ */ new Map();
  const pendingCount = (providerId) => {
    const probed = lastProbe.get(providerId);
    if (probed === void 0) return 0;
    return Math.max(0, probed - (discovered.get(providerId)?.size ?? 0));
  };
  const ops = {
    list: async () => {
      await ctx.provider.reload();
      const providers = [];
      for (const [providerId, candidate] of candidates) {
        providers.push({
          id: providerId,
          baseURL: candidate.baseURL,
          flavor: candidate.flavor,
          displayStyle: candidate.displayStyle,
          models: discovered.get(providerId)?.size ?? 0,
          pending: pendingCount(providerId)
        });
      }
      providers.sort((a, b) => a.id.localeCompare(b.id));
      return { providers };
    },
    add: async (input) => {
      if (!validId(input.providerId)) {
        return { status: "invalid", message: "The provider name may only contain letters, numbers, hyphens and underscores. Example: my-proxy" };
      }
      input.baseURL = normalizeBaseUrl(input.baseURL);
      if (!isValidUrl(input.baseURL)) {
        return { status: "invalid", message: "That does not look like a web address. Enter the full base URL, including https://. Example: https://api.example.com/v1" };
      }
      const clash = collisionSuggestion(input.providerId);
      if (clash && !input.overwrite) {
        return {
          status: "invalid",
          message: `'${input.providerId}' is the name of a provider opencode already has, so adding it would change that provider.
Use '${clash}' instead, or add the same provider again with overwrite=true if you really mean to replace it.`
        };
      }
      const reused = [...managed.entries()].filter(
        ([id2, entry]) => id2 !== input.providerId && entry.baseURL.replace(/\/+$/, "") === normalizeBaseUrl(input.baseURL)
      );
      if (reused.length > 0 && !input.confirmReuse) {
        const usedBy = reused.map(([id2]) => id2);
        return {
          status: "confirm_endpoint_reuse",
          usedBy,
          message: `This address is already used by: ${usedBy.join(", ")}. Adding another provider on the same address means every model will appear twice in the picker.`
        };
      }
      const candidate = {
        providerId: input.providerId,
        baseURL: input.baseURL,
        apiKey: input.apiKey,
        overrideKey: input.apiKey,
        flavor: parseFlavor(input.flavor) ?? DEFAULT_FLAVOR,
        displayStyle: input.displayStyle === "name" ? "name" : "slug"
      };
      let fresh;
      try {
        fresh = await discover(candidate);
      } catch (error) {
        return {
          status: "unreachable",
          message: `Nothing was saved: the address ${candidate.baseURL} did not answer with a model list.
${probeHint(error)}`,
          detail: sanitizeErrorMessage(error)
        };
      }
      if (fresh.length === 0) {
        return {
          status: "manual_required",
          message: `The address ${candidate.baseURL} answered but listed no models. Nothing was saved; you can enter model names manually.`
        };
      }
      await clearRemoval(candidate.providerId);
      managed.set(candidate.providerId, {
        baseURL: candidate.baseURL,
        flavor: candidate.flavor,
        displayStyle: candidate.displayStyle
      });
      await persist();
      await registerIntegration(candidate.providerId);
      await applyModels(candidate.providerId, fresh, candidate.displayStyle);
      const lines = [
        `Done. '${candidate.providerId}' is ready with ${fresh.length} model${fresh.length === 1 ? "" : "s"}. Open the model picker and choose one to start using it.`,
        `First model: ${fresh[0].id}`,
        `Details: ${describeProbed(fresh[0])}`
      ];
      if (input.apiKey) {
        try {
          await ctx.integration.connect.key({ integrationID: candidate.providerId, key: input.apiKey });
          lines.push("The API key was saved securely. You will not need to type it again.");
        } catch (error) {
          lines.push(
            `The API key could NOT be saved, so this provider cannot sign in yet.
Run /edit-provider and choose "API key" to add one before using it.

Technical detail: ${sanitizeErrorMessage(error)}`
          );
        }
      } else {
        lines.push('No API key was given. If this provider needs one, run /edit-provider and choose "API key".');
      }
      return { status: "ok", message: lines.join("\n") };
    },
    manualAdd: async (input) => {
      if (!validId(input.providerId)) {
        return { status: "invalid", message: "Use a provider name with letters, numbers, hyphens, or underscores." };
      }
      input.baseURL = normalizeBaseUrl(input.baseURL);
      if (!isValidUrl(input.baseURL)) {
        return { status: "invalid", message: "Enter a complete address starting with https:// (or localhost http://)." };
      }
      const clash = collisionSuggestion(input.providerId);
      if (clash && !input.overwrite) {
        return {
          status: "invalid",
          message: `'${input.providerId}' is a built-in provider name. Use '${clash}' instead.`
        };
      }
      const modelIds = parseModelIds(input.modelIds);
      if (!modelIds?.length) {
        return { status: "invalid", message: "Enter at least one model id, separated by commas." };
      }
      const flavor = input.flavor === void 0 ? DEFAULT_FLAVOR : parseFlavor(input.flavor);
      if (!flavor) {
        return { status: "invalid", message: `'${input.flavor}' is not a known API type. Pick one from the list.` };
      }
      const displayStyle = input.displayStyle === "name" ? "name" : "slug";
      const previews = await previewManualModels(modelIds, flavor, displayStyle);
      if (previews.length === 0) {
        return { status: "invalid", message: "No usable model ids were entered. Add at least one model id and try again." };
      }
      const unique = [...new Map(previews.map((preview) => [preview.id, preview.probed])).values()];
      const candidate = {
        providerId: input.providerId,
        baseURL: input.baseURL,
        apiKey: input.apiKey,
        overrideKey: input.apiKey,
        flavor,
        displayStyle
      };
      await clearRemoval(candidate.providerId);
      managed.set(candidate.providerId, {
        baseURL: candidate.baseURL,
        flavor: candidate.flavor,
        displayStyle: candidate.displayStyle
      });
      await persist();
      await registerIntegration(candidate.providerId);
      await applyModels(candidate.providerId, unique, displayStyle);
      let keyMessage = "";
      if (input.apiKey) {
        try {
          await ctx.integration.connect.key({ integrationID: candidate.providerId, key: input.apiKey });
          keyMessage = " The API key was saved securely.";
        } catch (error) {
          keyMessage = ` The API key could NOT be saved, so this provider cannot sign in yet. Run /edit-provider and choose "API key" to add one before using it. Technical detail: ${sanitizeErrorMessage(error)}`;
        }
      } else {
        keyMessage = " No API key was given; add one later if this provider requires it.";
      }
      return {
        status: "ok",
        message: `Added ${unique.length} model${unique.length === 1 ? "" : "s"} to '${candidate.providerId}'.${keyMessage}`
      };
    },
    edit: async (input) => {
      const current = managed.get(input.providerId);
      if (!current && !candidates.has(input.providerId)) {
        return { message: `There is no provider named '${input.providerId}'. Run /list-custom-providers to see your providers.` };
      }
      if (input.baseURL !== void 0) input.baseURL = normalizeBaseUrl(input.baseURL);
      if (input.baseURL !== void 0 && !isValidUrl(input.baseURL)) {
        return { message: "That does not look like a web address. Enter the full base URL, including https://. Example: https://api.example.com/v1" };
      }
      const flavor = input.flavor === void 0 ? current?.flavor : parseFlavor(input.flavor) ?? void 0;
      if (input.flavor !== void 0 && !flavor) {
        return { message: `'${input.flavor}' is not a known API type. Pick one from the list.` };
      }
      const previousURL = current?.baseURL ?? candidates.get(input.providerId)?.baseURL ?? "";
      const next = {
        baseURL: input.baseURL ?? current?.baseURL ?? candidates.get(input.providerId)?.baseURL ?? "",
        flavor,
        displayStyle: input.displayStyle ?? current?.displayStyle ?? "slug"
      };
      managed.set(input.providerId, next);
      await persist();
      let keyWarning;
      if (input.apiKey) {
        try {
          await ctx.integration.connect.key({ integrationID: input.providerId, key: input.apiKey });
        } catch (error) {
          keyWarning = `The new API key could NOT be saved, so the old one is still in use.
Run /edit-provider and choose "API key" to try again.

Technical detail: ${sanitizeErrorMessage(error)}`;
        }
      }
      const endpointChanged = input.baseURL !== void 0 && input.baseURL !== previousURL || input.flavor !== void 0 && input.flavor !== current?.flavor;
      if (endpointChanged) {
        const candidate = {
          providerId: input.providerId,
          baseURL: next.baseURL,
          flavor: next.flavor ?? DEFAULT_FLAVOR,
          displayStyle: next.displayStyle ?? "slug"
        };
        try {
          const fresh = await discover(candidate);
          await applyModels(input.providerId, fresh, candidate.displayStyle);
        } catch (error) {
          await ctx.provider.reload();
          return {
            message: `Saved. '${input.providerId}' now uses the new address, but it did not answer with a model list yet.
${probeHint(error)}
The address used before was: ${previousURL || "(none)"}. Run /edit-provider and paste it back if the provider stops working.

Technical detail: ${sanitizeErrorMessage(error)}`
          };
        }
      } else if (input.displayStyle !== void 0) {
        const raw = lastProbeModels.get(input.providerId);
        if (raw) {
          await applyModels(input.providerId, raw, next.displayStyle ?? "slug");
        } else {
          const candidate = {
            providerId: input.providerId,
            baseURL: next.baseURL,
            flavor: next.flavor ?? DEFAULT_FLAVOR,
            displayStyle: next.displayStyle ?? "slug"
          };
          try {
            await applyModels(input.providerId, await discover(candidate), candidate.displayStyle);
          } catch (error) {
            return { message: `Saved the new name style, but the provider could not be re-read to apply it.
${probeHint(error)}

Technical detail: ${sanitizeErrorMessage(error)}` };
          }
        }
        await ctx.provider.reload();
      } else {
        await ctx.provider.reload();
      }
      const changed = [];
      if (input.baseURL !== void 0) changed.push("a new address");
      if (input.flavor !== void 0) changed.push("a new API type");
      if (input.displayStyle !== void 0) changed.push("a new model name style");
      if (input.apiKey) changed.push("a new API key (stored securely, used the next time you chat)");
      if (keyWarning) return { message: keyWarning };
      return {
        message: changed.length > 0 ? `Saved. '${input.providerId}' now has ${changed.join(", ")}.` : `Saved. '${input.providerId}' is unchanged.`
      };
    },
    remove: async (providerId) => {
      const wasManaged = managed.delete(providerId);
      if (!wasManaged && !candidates.has(providerId)) {
        return { message: `There is no provider named '${providerId}'. Run /list-custom-providers to see your providers.` };
      }
      if (!wasManaged) {
        return {
          message: `'${providerId}' comes from your opencode config, not from this plugin, so it was left alone.
Remove its entry from your opencode config to stop using it, or use /edit-provider to point it elsewhere.`
        };
      }
      removed.add(providerId);
      await ctx.storage.set(REMOVED_KEY, [...removed]);
      await persist();
      storedIds.delete(providerId);
      lastProbe.delete(providerId);
      lastProbeModels.delete(providerId);
      candidates.delete(providerId);
      const staleModels = [...discovered.get(providerId)?.keys() ?? []];
      await ctx.provider.transform((providers) => {
        providers.update(providerId, (provider) => {
          provider.settings = { ...provider.settings ?? {}, dynamic: false };
        });
        for (const modelId of staleModels) providers.models.remove(providerId, modelId);
      });
      discovered.delete(providerId);
      await ctx.provider.reload();
      return {
        message: `Removed '${providerId}' and its ${staleModels.length} model${staleModels.length === 1 ? "" : "s"}. Your other opencode settings are not touched. You can add it again later with /add-provider.`
      };
    },
    reprobe: async (providerId) => {
      const candidate = candidates.get(providerId);
      if (!candidate) return { message: `There is no provider named '${providerId}'. Run /list-custom-providers to see your providers.` };
      let fresh;
      try {
        fresh = await discover(candidate);
      } catch (error) {
        return { message: `Nothing was saved: the address ${candidate.baseURL} did not answer with a model list.
${probeHint(error)}

Technical detail: ${sanitizeErrorMessage(error)}` };
      }
      lastProbe.set(providerId, fresh.length);
      lastProbeModels.set(providerId, fresh);
      const stored = [...storedIds.get(providerId) ?? []];
      if (fresh.length === 0) {
        return { message: `The provider listed no models.
${zeroModelsHint(Boolean(await credentialKey(providerId) ?? candidate.apiKey))}

Stored models were kept, so nothing broke.` };
      }
      const current = Object.fromEntries(storedModels.get(providerId) ?? /* @__PURE__ */ new Map());
      const changes = diffModels(current, fresh, candidate.displayStyle);
      const added = changes.filter((change) => change.kind === "added");
      const updated = changes.filter((change) => change.kind === "updated");
      const vanished = changes.filter((change) => change.kind === "removed");
      const lines = [
        changes.length === 0 ? `Up to date: the provider still lists the same ${fresh.length} model${fresh.length === 1 ? "" : "s"}. Nothing to do.` : `Found ${fresh.length} model${fresh.length === 1 ? "" : "s"} at the provider (you had ${stored.length}).`
      ];
      const PREVIEW = 5;
      for (const change of added.slice(0, PREVIEW)) lines.push(`  + new: ${change.id}`);
      if (added.length > PREVIEW) lines.push(`  + ...and ${added.length - PREVIEW} more new model(s)`);
      for (const change of updated.slice(0, PREVIEW)) lines.push(`  ~ ${change.detail}`);
      if (updated.length > PREVIEW) lines.push(`  ~ ...and ${updated.length - PREVIEW} more changed model(s)`);
      for (const change of vanished.slice(0, PREVIEW)) lines.push(`  - no longer offered: ${change.id}`);
      if (vanished.length > PREVIEW) lines.push(`  - ...and ${vanished.length - PREVIEW} more removed`);
      if (changes.length > 0) {
        lines.push("");
        lines.push('Nothing has changed yet. Run "Reload all models" to apply everything, or "Review model changes" to choose.');
      }
      return { message: lines.join("\n") };
    },
    apply: async (input) => {
      const candidate = candidates.get(input.providerId);
      if (!candidate) return { message: `There is no provider named '${input.providerId}'. Run /list-custom-providers to see your providers.` };
      const keepOnly = input.mode === "keep";
      const decisions = {};
      if (input.decisions !== void 0 && input.decisions !== "") {
        let parsed;
        try {
          parsed = JSON.parse(input.decisions);
        } catch {
          return { message: 'That is not valid JSON. Use the shape shown in the box, for example {"model-id": "apply"}.' };
        }
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          return { message: 'That is not valid JSON. Use the shape shown in the box, for example {"model-id": "apply"}.' };
        }
        for (const [modelId, decision] of Object.entries(parsed)) {
          if (decision !== "apply" && decision !== "keep" && decision !== "remove") {
            return { message: `'${modelId}' has an unknown choice. Use "apply" (take the new values), "keep" (leave it alone), or "remove".` };
          }
          decisions[modelId] = decision;
        }
      }
      let fresh;
      try {
        fresh = await discover(candidate);
      } catch (error) {
        return { message: `Nothing was saved: the address ${candidate.baseURL} did not answer with a model list.
${probeHint(error)}

Technical detail: ${sanitizeErrorMessage(error)}` };
      }
      if (keepOnly) {
        return { message: `Kept your ${storedIds.get(input.providerId)?.size ?? 0} stored model(s) for '${input.providerId}'. Nothing was changed.` };
      }
      const models = modelsFor(input.providerId);
      const stored = new Set(models.keys());
      const freshIds = new Set(fresh.map((item) => item.id));
      let removed2 = 0;
      for (const probed of fresh) {
        const decision = decisions[probed.id] ?? (stored.has(probed.id) ? "keep" : "apply");
        if (decision === "remove") {
          models.delete(probed.id);
          removed2++;
          continue;
        }
        if (decision === "keep" && stored.has(probed.id)) continue;
        models.set(probed.id, probedToDraft(probed, candidate.displayStyle));
      }
      for (const modelId of stored) {
        if (freshIds.has(modelId)) continue;
        if ((decisions[modelId] ?? "keep") === "keep") continue;
        models.delete(modelId);
        removed2++;
      }
      await ctx.provider.reload();
      const total = [...models.values()].length;
      return {
        message: `Done. '${input.providerId}' now has ${total} model${total === 1 ? "" : "s"} from the provider` + (removed2 > 0 ? `, and ${removed2} old one(s) were removed.` : ".") + "\nOpen the model picker and choose one to start using it."
      };
    },
    refresh: async () => {
      await ctx.provider.reload();
      const outcome = await refresh();
      const lines = [`Checked ${outcome.checked} provider(s).`];
      if (outcome.updated.length > 0) lines.push(`Updated: ${outcome.updated.join(", ")}.`);
      if (outcome.unchanged.length > 0) lines.push(`Already up to date: ${outcome.unchanged.join(", ")}.`);
      if (outcome.empty.length > 0) {
        lines.push(`Answered but listed no models: ${outcome.empty.join(", ")}.`);
      }
      if (outcome.failed.length > 0) {
        lines.push(
          `Could not reach: ${outcome.failed.join(", ")}. Their saved models were kept.
Fix with /edit-provider (check the address and the API key), then run /reload-models again.`
        );
      }
      if (outcome.updated.length === 0 && outcome.failed.length === 0 && outcome.empty.length === 0) {
        lines.push("Nothing to change \u2014 every provider already lists the same models.");
      }
      return { message: lines.join("\n") };
    },
    catalogList: async () => ({ sites: await listCatalogSites() }),
    catalogAdd: async (input) => {
      if (!validId(input.providerId)) {
        return { message: "The provider name may only contain letters, numbers, hyphens and underscores. Example: my-proxy" };
      }
      const catalog = await getCatalog();
      const site = catalog[input.site];
      if (!site) return { message: `'${input.site}' is not in the catalog list. Pick one from the list.` };
      const wanted = input.models ? input.models.split(",").map((value) => value.trim()).filter(Boolean) : Object.keys(site.models);
      const missing = wanted.filter((modelId) => !site.models[modelId]);
      const chosen = wanted.filter((modelId) => site.models[modelId]);
      if (chosen.length === 0) return { message: "None of the ids you typed exist in that catalog site. Leave the field empty to add every model." };
      if (!site.api || !isValidUrl(site.api)) {
        return { message: `The catalog entry for '${input.site}' has no usable web address, so it cannot be added. Pick another site.` };
      }
      const displayStyle = input.displayStyle === "name" ? "name" : "slug";
      await clearRemoval(input.providerId);
      managed.set(input.providerId, { baseURL: site.api, flavor: DEFAULT_FLAVOR, displayStyle });
      await persist();
      await registerIntegration(input.providerId);
      await applyModels(
        input.providerId,
        chosen.map((modelId) => catalogToProbed(site.models[modelId])),
        displayStyle
      );
      const lines = [`Done. '${input.providerId}' is ready with ${chosen.length} model${chosen.length === 1 ? "" : "s"} from '${input.site}'.`];
      if (missing.length > 0) lines.push(`Skipped (not in this catalog site): ${missing.join(", ")}.`);
      if (input.apiKey) {
        try {
          await ctx.integration.connect.key({ integrationID: input.providerId, key: input.apiKey });
          lines.push("The API key was saved securely. You will not need to type it again.");
        } catch (error) {
          lines.push(`The API key could NOT be saved, so this provider cannot sign in yet.
Run /edit-provider and choose "API key" to add one before using it.

Technical detail: ${sanitizeErrorMessage(error)}`);
        }
      }
      return { message: lines.join("\n") };
    }
  };
  await ctx.rpc.register(
    {
      id: RPC_ID,
      methods: {
        list: {
          input: EMPTY_INPUT,
          output: {
            type: "object",
            properties: {
              providers: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    baseURL: { type: "string" },
                    flavor: { type: "string" },
                    displayStyle: { type: "string" },
                    models: { type: "number" },
                    pending: { type: "number" }
                  },
                  required: ["id", "baseURL", "flavor", "displayStyle", "models", "pending"],
                  additionalProperties: false
                }
              }
            },
            required: ["providers"],
            additionalProperties: false
          }
        },
        add: {
          input: {
            type: "object",
            properties: {
              providerId: { type: "string" },
              baseURL: { type: "string" },
              apiKey: { type: "string" },
              flavor: { type: "string" },
              displayStyle: { type: "string", enum: ["slug", "name"] },
              overwrite: { type: "boolean" },
              confirmReuse: { type: "boolean" }
            },
            required: ["providerId", "baseURL"],
            additionalProperties: false
          },
          output: ADD_OUTPUT
        },
        manualAdd: {
          input: {
            type: "object",
            properties: {
              providerId: { type: "string" },
              baseURL: { type: "string" },
              modelIds: { type: "string" },
              apiKey: { type: "string" },
              flavor: { type: "string" },
              displayStyle: { type: "string", enum: ["slug", "name"] },
              overwrite: { type: "boolean" }
            },
            required: ["providerId", "baseURL", "modelIds"],
            additionalProperties: false
          },
          output: MANUAL_ADD_OUTPUT
        },
        edit: {
          input: {
            type: "object",
            properties: {
              providerId: { type: "string" },
              baseURL: { type: "string" },
              flavor: { type: "string" },
              displayStyle: { type: "string", enum: ["slug", "name"] },
              apiKey: { type: "string" }
            },
            required: ["providerId"],
            additionalProperties: false
          },
          output: MESSAGE_OUTPUT
        },
        remove: {
          input: {
            type: "object",
            properties: { providerId: { type: "string" } },
            required: ["providerId"],
            additionalProperties: false
          },
          output: MESSAGE_OUTPUT
        },
        reprobe: {
          input: {
            type: "object",
            properties: { providerId: { type: "string" } },
            required: ["providerId"],
            additionalProperties: false
          },
          output: MESSAGE_OUTPUT
        },
        apply: {
          input: {
            type: "object",
            properties: {
              providerId: { type: "string" },
              decisions: { type: "string" },
              mode: { type: "string", enum: ["apply", "keep"] }
            },
            required: ["providerId"],
            additionalProperties: false
          },
          output: MESSAGE_OUTPUT
        },
        refresh: { input: EMPTY_INPUT, output: MESSAGE_OUTPUT },
        "catalog.list": {
          input: EMPTY_INPUT,
          output: {
            type: "object",
            properties: {
              sites: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    name: { type: "string" },
                    modelCount: { type: "number" }
                  },
                  required: ["id", "name", "modelCount"],
                  additionalProperties: false
                }
              }
            },
            required: ["sites"],
            additionalProperties: false
          }
        },
        "catalog.add": {
          input: {
            type: "object",
            properties: {
              site: { type: "string" },
              providerId: { type: "string" },
              models: { type: "string" },
              apiKey: { type: "string" },
              displayStyle: { type: "string", enum: ["slug", "name"] }
            },
            required: ["site", "providerId"],
            additionalProperties: false
          },
          output: MESSAGE_OUTPUT
        }
      },
      events: {}
    },
    {
      list: () => ops.list(),
      add: (input) => ops.add(input),
      manualAdd: (input) => ops.manualAdd(input),
      edit: (input) => ops.edit(input),
      remove: (input) => ops.remove(input.providerId),
      reprobe: (input) => ops.reprobe(input.providerId),
      apply: (input) => ops.apply(input),
      refresh: () => ops.refresh(),
      "catalog.list": () => ops.catalogList(),
      "catalog.add": (input) => ops.catalogAdd(input)
    }
  );
  await ctx.tool.transform((tools) => {
    tools.namespace({
      name: "custom-providers",
      description: "Add and manage your own AI providers (custom API addresses)."
    });
    tools.add({
      name: "refresh-models",
      description: "Re-discover models from every dynamic provider and update the live catalog. Fetches /models from each provider with a baseURL and enriches it with models.dev metadata.",
      input: EMPTY_INPUT,
      execute: async () => ({ content: (await ops.refresh()).message })
    });
    tools.add({
      name: "list-custom-providers",
      description: "Show your saved providers with their address and number of models.",
      input: EMPTY_INPUT,
      execute: async () => {
        const { providers } = await ops.list();
        const lines = providers.map(
          (provider) => `- ${provider.id}: ${provider.baseURL} [${provider.flavor}] ${provider.models} discovered model(s)`
        );
        return { content: lines.length ? lines.join("\n") : "No dynamic providers configured." };
      }
    });
    tools.add({
      name: "list-catalog-sites",
      description: "List the well-known providers you can add without typing a URL.",
      input: EMPTY_INPUT,
      execute: async () => {
        const { sites } = await ops.catalogList();
        return {
          content: sites.length ? sites.map((site) => `- ${site.id}: ${site.name} (${site.modelCount} model(s))`).join("\n") : "Catalog is empty."
        };
      }
    });
    tools.add({
      name: "add-provider",
      description: "Add a new OpenAI-compatible provider with dynamic model discovery. Validates the endpoint, discovers its models, enriches them with models.dev metadata, and activates the provider.",
      input: {
        type: "object",
        properties: {
          providerId: { type: "string", description: "Short name for this provider (letters, numbers, hyphens and underscores only)" },
          baseURL: { type: "string", description: "Address of the provider's API (usually ends in /v1)" },
          apiKey: { type: "string", description: "API key for this provider (optional for local servers)" },
          flavor: {
            type: "string",
            enum: ["openai-chat", "openai-responses", "anthropic", "gemini", "ollama"],
            description: "Which API style the provider speaks (default: openai-chat)"
          },
          displayStyle: { type: "string", enum: ["slug", "name"], description: "How model names are shown (default: slug = the short id)" },
          confirmReuse: { type: "boolean", description: "Add even though another provider already uses this address" }
        },
        required: ["providerId", "baseURL"],
        additionalProperties: false
      },
      execute: async (raw) => ({ content: (await ops.add(raw)).message })
    });
    tools.add({
      name: "manual-add-models",
      description: "Add models by id when a provider does not list them automatically. Does not contact the provider endpoint.",
      input: {
        type: "object",
        properties: {
          providerId: { type: "string", description: "Short provider name" },
          baseURL: { type: "string", description: "Provider API address" },
          modelIds: { type: "string", description: "Comma-separated model ids; at least one is required" },
          apiKey: { type: "string", description: "Optional API key for this provider" },
          flavor: {
            type: "string",
            enum: ["openai-chat", "openai-responses", "anthropic", "gemini", "ollama"],
            description: "Which API style the provider speaks (default: openai-chat)"
          },
          displayStyle: { type: "string", enum: ["slug", "name"] },
          overwrite: { type: "boolean", description: "Allow replacing a built-in provider with the same id" }
        },
        required: ["providerId", "baseURL", "modelIds"],
        additionalProperties: false
      },
      execute: async (raw) => ({
        content: (await ops.manualAdd(raw)).message
      })
    });
    tools.add({
      name: "reprobe-models",
      description: "Re-probe a provider's endpoint and list model changes (added, vanished, metadata updated). Read-only \u2014 apply-reconcile persists decisions. Defaults per row: changed/vanished \u2192 keep, new \u2192 apply.",
      input: {
        type: "object",
        properties: { providerId: { type: "string", description: "Which provider to check" } },
        required: ["providerId"],
        additionalProperties: false
      },
      execute: async (raw) => ({ content: (await ops.reprobe(raw.providerId)).message })
    });
    tools.add({
      name: "apply-reconcile",
      description: "Choose which model changes to accept (apply / keep / remove per model). Omitted ids default to keep when the model is already stored and apply when it is new.",
      input: {
        type: "object",
        properties: {
          providerId: { type: "string", description: "Which provider to update" },
          decisions: { type: "string", description: 'JSON object mapping model id to "apply", "keep", or "remove"' }
        },
        required: ["providerId", "decisions"],
        additionalProperties: false
      },
      execute: async (raw) => ({
        content: (await ops.apply(raw)).message
      })
    });
    tools.add({
      name: "add-from-catalog",
      description: "Add a provider from the models.dev catalog: takes the site's base URL and model list with catalog metadata. No probing.",
      input: {
        type: "object",
        properties: {
          site: { type: "string", description: "Which known provider to add (see list-catalog-sites)" },
          providerId: { type: "string", description: "Short name for this provider (letters, numbers, hyphens and underscores only)" },
          apiKey: { type: "string", description: "API key for this provider (optional for local servers)" },
          displayStyle: { type: "string", enum: ["slug", "name"], description: "How model names are shown (default: slug = the short id)" },
          models: { type: "string", description: "Model names separated by commas; omit to add every model this provider offers" }
        },
        required: ["site", "providerId"],
        additionalProperties: false
      },
      execute: async (raw) => ({ content: (await ops.catalogAdd(raw)).message })
    });
    tools.add({
      name: "delete-provider",
      description: "Remove a provider and its models from opencode.",
      input: {
        type: "object",
        properties: { providerId: { type: "string", description: "Provider ID to delete" } },
        required: ["providerId"],
        additionalProperties: false
      },
      execute: async (raw) => ({ content: (await ops.remove(raw.providerId)).message })
    });
  });
  await ctx.provider.reload();
  await refresh().catch(() => void 0);
};

// src/server.ts
var server = async ({ client }) => {
  const bridge = createServerBridge(client);
  await client.app.log({
    body: {
      level: "info",
      message: "Plugin initialized",
      service: id
    }
  });
  return {
    config: async (cfg) => {
      if (!cfg.provider) return;
      const eligible = Object.entries(cfg.provider).filter(
        (entry) => shouldDiscover(entry[1])
      );
      const outcomes = [];
      for (let i = 0; i < eligible.length; i += 4) {
        const chunk = eligible.slice(i, i + 4);
        const settled = await Promise.allSettled(
          chunk.map(([providerId, providerConfig]) => {
            const baseURL = providerConfig.options.baseURL;
            const apiKey = getApiKey(providerConfig, providerId);
            const displayStyle = providerConfig.displayStyle ?? "slug";
            const flavor = parseFlavor(providerConfig.flavor) ?? DEFAULT_FLAVOR;
            return discoverAndEnrich(baseURL, apiKey, displayStyle, flavor);
          })
        );
        outcomes.push(...settled);
      }
      for (let i = 0; i < eligible.length; i++) {
        const [providerId, providerConfig] = eligible[i];
        const outcome = outcomes[i];
        const baseURL = providerConfig.options.baseURL;
        try {
          await client.app.log({
            body: {
              level: "info",
              message: `Discovering models from ${providerId} at ${sanitizeUrl(baseURL)}`,
              service: id
            }
          });
          if (outcome.status === "rejected") throw outcome.reason;
          const models = outcome.value;
          const count = Object.keys(models).length;
          if (count === 0) {
            await client.app.log({
              body: {
                level: "warn",
                message: `No models discovered from ${providerId}`,
                service: id
              }
            });
            continue;
          }
          providerConfig.models = { ...providerConfig.models ?? {}, ...models };
          providerConfig.npm = providerConfig.npm ?? "@ai-sdk/openai-compatible";
          providerConfig.api = providerConfig.api ?? baseURL;
          await client.app.log({
            body: {
              level: "info",
              message: `Discovered ${count} model(s) from ${providerId}`,
              service: id
            }
          });
        } catch (error) {
          await client.app.log({
            body: {
              level: "warn",
              message: `Failed to discover models from ${providerId}: ${sanitizeErrorMessage(error)}`,
              service: id
            }
          });
        }
      }
    },
    tool: {
      "refresh-models": tool({
        description: "Re-discover models from all dynamic providers and update the live config. Clears the models.dev metadata cache, fetches /models from every provider with a baseURL, enriches them, and persists the updated config.",
        args: {},
        async execute() {
          const providers = await bridge.getProviders();
          const result = await reloadAllProviders(providers);
          if (result.providerCount === 0) {
            return "No dynamic providers configured. Add a provider with a baseURL first.";
          }
          if (result.totalModels > 0) {
            await bridge.updateProviders(providers);
          }
          const lines = [];
          if (result.failures === 0) {
            lines.push(
              `Reloaded ${result.totalModels} model(s) from ${result.providerCount} provider(s).`
            );
          } else {
            lines.push(
              `Reloaded ${result.totalModels} model(s) with ${result.failures} failure(s).`
            );
          }
          for (const w of result.warnings) lines.push(`Warning: ${w}`);
          for (const e of result.errors) lines.push(`Error: ${e}`);
          return lines.join("\n");
        }
      }),
      "add-provider": tool({
        description: "Add a new OpenAI-compatible provider with dynamic model discovery. Validates the endpoint, discovers available models, enriches them with models.dev metadata, and persists the provider to the config.",
        args: {
          providerId: tool.schema.string().describe("Unique provider ID (alphanumeric, hyphens, underscores only)"),
          baseURL: tool.schema.string().describe("Base URL of the OpenAI-compatible API endpoint (e.g. https://api.example.com/v1)"),
          apiKey: tool.schema.string().optional().describe("API key for authentication (optional)"),
          displayStyle: tool.schema.enum(["slug", "name"]).optional().describe("How to display model names: 'slug' for full ID (default), 'name' for friendly name"),
          flavor: tool.schema.enum(["openai-chat", "openai-responses", "anthropic", "gemini", "ollama"]).optional().describe("Endpoint flavor to probe with (default: openai-chat)"),
          overwrite: tool.schema.boolean().optional().describe("Overwrite if a provider with this ID already exists (default: false)")
        },
        async execute(args) {
          const providers = await bridge.getProviders();
          const validationError = validateAddProviderParams(args, providers);
          if (validationError) return validationError;
          const result = await addProvider(args);
          if (!result.success || !result.providerEntry) return result.message;
          try {
            await persistProviderApiKey(
              result.providerEntry,
              args.providerId,
              args.apiKey,
              async (id2, key) => {
                await bridge.setApiKey(id2, key);
                return true;
              }
            );
          } catch (error) {
            return `Failed to add provider: ${sanitizeErrorMessage(error)}`;
          }
          providers[args.providerId] = result.providerEntry;
          await bridge.updateProviders(providers);
          return result.message;
        }
      }),
      "reprobe-models": tool({
        description: "Re-probe a provider's endpoint and list model changes (added, updated with old -> new values, vanished). Read-only \u2014 call apply-reconcile with decisions to save.",
        args: {
          providerId: tool.schema.string().describe("Provider ID to re-probe")
        },
        async execute(args) {
          const providers = await bridge.getProviders();
          const provider = providers[args.providerId];
          if (!provider) return `Unknown provider '${args.providerId}'.`;
          let rep;
          try {
            rep = await reprobeProvider(args.providerId, provider);
          } catch (error) {
            return `Re-probe failed: ${sanitizeErrorMessage(error)}`;
          }
          if (rep.changes.length === 0) {
            return `No changes for '${args.providerId}' \u2014 ${rep.fresh.length} model(s) already in sync.`;
          }
          const lines = [`${rep.changes.length} change(s) for '${args.providerId}':`];
          const freshById = new Map(rep.fresh.map((p) => [p.id, p]));
          for (const c of rep.changes) {
            lines.push(`- [${c.kind}] ${c.detail}`);
            const fresh = freshById.get(c.id);
            if (fresh) lines.push(`    fresh: ${describeProbed(fresh)}`);
          }
          lines.push(
            `Call apply-reconcile with a decisions object mapping model id to "apply", "keep", or "remove". Defaults when omitted: added/updated -> apply, vanished -> keep.`
          );
          return lines.join("\n");
        }
      }),
      "apply-reconcile": tool({
        description: "Apply tri-state reconcile decisions from reprobe-models and persist the updated config.",
        args: {
          providerId: tool.schema.string().describe("Provider ID to reconcile"),
          decisions: tool.schema.string().describe('JSON object mapping model id to "apply", "keep", or "remove"')
        },
        async execute(args) {
          const providers = await bridge.getProviders();
          const provider = providers[args.providerId];
          if (!provider) return `Unknown provider '${args.providerId}'.`;
          let parsed;
          try {
            parsed = JSON.parse(args.decisions);
          } catch {
            return `Invalid decisions JSON.`;
          }
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            return `Invalid decisions JSON.`;
          }
          const decisions = {};
          for (const [id2, d] of Object.entries(parsed)) {
            if (d !== "apply" && d !== "keep" && d !== "remove") {
              return `Invalid decision for '${id2}': must be "apply", "keep", or "remove".`;
            }
            decisions[id2] = d;
          }
          let rep;
          try {
            rep = await reprobeProvider(args.providerId, provider);
          } catch (error) {
            return `Re-probe failed: ${sanitizeErrorMessage(error)}`;
          }
          const next = applyReconcile(provider, rep.fresh, decisions);
          provider.models = next;
          await bridge.updateProviders(providers);
          return `Reconciled '${args.providerId}': ${rep.fresh.length} model(s) probed, ${Object.keys(next).length} stored.`;
        }
      }),
      "edit-provider": tool({
        description: "Edit a provider: rename, change endpoint/flavor/display style, or rotate the API key. Re-probes models when the endpoint or flavor changes.",
        args: {
          providerId: tool.schema.string().describe("Provider ID to edit"),
          rename: tool.schema.string().optional().describe("New provider ID"),
          baseURL: tool.schema.string().optional().describe("New base URL"),
          flavor: tool.schema.string().optional().describe("New endpoint flavor (openai-chat, openai-responses, anthropic, gemini, ollama)"),
          apiKey: tool.schema.string().optional().describe("New API key"),
          displayStyle: tool.schema.enum(["slug", "name"]).optional().describe("Model display style")
        },
        async execute(args) {
          const providers = await bridge.getProviders();
          const provider = providers[args.providerId];
          if (!provider) return `Unknown provider '${args.providerId}'.`;
          const notes = [];
          let targetId = args.providerId;
          if (args.rename !== void 0 && args.rename !== args.providerId) {
            const oldId = args.providerId;
            const { error, warning } = renameProviderEntry(providers, oldId, args.rename);
            if (error) return error;
            targetId = args.rename.trim();
            if (warning) notes.push(warning);
            if (args.apiKey === void 0) {
              notes.push(`Stored credential (if any) is still keyed by '${oldId}' \u2014 pass apiKey to move it.`);
            }
          }
          const entry = providers[targetId];
          if (args.baseURL !== void 0) {
            const baseURL = args.baseURL.trim().replace(/\/+$/, "");
            if (!isValidUrl(baseURL)) {
              return "Invalid Base URL. Please enter a full URL (including https://).";
            }
            entry.options = { ...entry.options, baseURL };
            entry.api = baseURL;
          }
          if (args.flavor !== void 0) {
            const flavor = parseFlavor(args.flavor);
            if (!flavor) {
              return `Unknown flavor '${args.flavor}'. Valid: ${Object.keys(FLAVORS).join(", ")}.`;
            }
            entry.flavor = flavor;
          }
          if (args.displayStyle !== void 0) entry.displayStyle = args.displayStyle;
          if (args.apiKey !== void 0) {
            try {
              await rotateProviderApiKey(
                entry,
                targetId,
                args.apiKey || void 0,
                async (id2, key) => {
                  await bridge.setApiKey(id2, key);
                  return true;
                }
              );
            } catch (error) {
              return `Failed to update provider: ${sanitizeErrorMessage(error)}`;
            }
          }
          if (args.apiKey === void 0) {
            const migration = await migrateInlineKey(entry, targetId, async (id2, key) => {
              await bridge.setApiKey(id2, key);
              return true;
            });
            if (migration.note) notes.push(migration.note);
          }
          if (args.baseURL !== void 0 || args.flavor !== void 0) {
            try {
              const rep = await reprobeProvider(targetId, entry);
              entry.models = applyReconcile(entry, rep.fresh, {});
              notes.push(`Re-probed: ${Object.keys(entry.models).length} model(s) stored.`);
            } catch (error) {
              notes.push(`Models unchanged (probe failed: ${sanitizeErrorMessage(error)}).`);
            }
          }
          await bridge.updateProviders(providers);
          return [`Provider '${targetId}' updated.`, ...notes].join(" ");
        }
      }),
      "delete-provider": tool({
        description: "Delete a provider and its models from the config.",
        args: {
          providerId: tool.schema.string().describe("Provider ID to delete")
        },
        async execute(args) {
          const providers = await bridge.getProviders();
          const error = deleteProviderEntry(providers, args.providerId);
          if (error) return error;
          await bridge.updateProviders(providers);
          return `Provider '${args.providerId}' deleted. Remove its stored credential separately if one was saved.`;
        }
      }),
      "delete-models": tool({
        description: "Bulk delete stored models from a provider (comma-separated ids).",
        args: {
          providerId: tool.schema.string().describe("Provider ID"),
          modelIds: tool.schema.string().describe("Comma-separated model ids to delete")
        },
        async execute(args) {
          const providers = await bridge.getProviders();
          const provider = providers[args.providerId];
          if (!provider) return `Unknown provider '${args.providerId}'.`;
          const models = getStoredModels(provider);
          if (Object.keys(models).length === 0) {
            return `Provider '${args.providerId}' has no stored models.`;
          }
          const ids = args.modelIds.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
          const unknown = ids.filter((id2) => !models[id2]);
          if (unknown.length > 0) return `Unknown model(s): ${unknown.join(", ")}.`;
          const { deleted } = deleteModels(models, ids);
          provider.models = models;
          await bridge.updateProviders(providers);
          return `Deleted ${deleted.length} model(s) from '${args.providerId}': ${deleted.join(", ")}.`;
        }
      }),
      "list-catalog-sites": tool({
        description: "List known API sites from the models.dev catalog (id, name, model count) for add-from-catalog.",
        args: {},
        async execute() {
          let sites;
          try {
            sites = await listCatalogSites();
          } catch (error) {
            return `Catalog failed: ${sanitizeErrorMessage(error)}`;
          }
          if (sites.length === 0) return "Catalog is empty.";
          return sites.map((s) => `- ${s.id}: ${s.name} (${s.modelCount} model(s))`).join("\n");
        }
      }),
      "add-from-catalog": tool({
        description: "Add a provider from the models.dev catalog: takes the site's base URL and model list with catalog metadata. No probing.",
        args: {
          site: tool.schema.string().describe("Catalog site id (see list-catalog-sites)"),
          providerId: tool.schema.string().describe("Unique provider ID (alphanumeric, hyphens, underscores only)"),
          apiKey: tool.schema.string().optional().describe("API key for authentication (optional)"),
          displayStyle: tool.schema.enum(["slug", "name"]).optional().describe("How to display model names (default: slug)"),
          models: tool.schema.string().optional().describe("Comma-separated model ids; omit to add every catalog model"),
          overwrite: tool.schema.boolean().optional().describe("Overwrite if a provider with this ID already exists (default: false)")
        },
        async execute(args) {
          const providers = await bridge.getProviders();
          const idError = validateProviderId(args.providerId);
          if (idError) return idError;
          if (providers[args.providerId] && !args.overwrite) {
            return `A provider with ID '${args.providerId}' already exists. Set overwrite to true to replace it.`;
          }
          const modelIds = parseModelIds(args.models);
          if (args.models !== void 0 && (!modelIds || modelIds.length === 0)) {
            return "No model ids provided. Pass at least one comma-separated id, or omit 'models' to add every catalog model.";
          }
          let built;
          try {
            built = await buildCatalogModels(
              args.site,
              modelIds,
              args.displayStyle ?? "slug"
            );
          } catch (error) {
            return `Catalog add failed: ${sanitizeErrorMessage(error)}`;
          }
          const providerEntry = {
            name: args.providerId,
            npm: "@ai-sdk/openai-compatible",
            api: built.baseURL,
            options: { baseURL: built.baseURL },
            dynamic: true,
            displayStyle: args.displayStyle ?? "slug",
            models: built.models
          };
          try {
            await persistProviderApiKey(
              providerEntry,
              args.providerId,
              args.apiKey,
              async (id2, key) => {
                await bridge.setApiKey(id2, key);
                return true;
              }
            );
          } catch (error) {
            return `Failed to add provider: ${sanitizeErrorMessage(error)}`;
          }
          providers[args.providerId] = providerEntry;
          await bridge.updateProviders(providers);
          const stored = Object.keys(built.models).length;
          const lines = [
            `Provider '${args.providerId}' added with ${stored} model(s) from catalog site '${args.site}'.`
          ];
          if (built.missing.length > 0) lines.push(`Unknown ids skipped: ${built.missing.join(", ")}.`);
          if (built.resolved.length > 0) {
            lines.push(`Example: ${describeProbed(built.resolved[0])}`);
          }
          return lines.join("\n");
        }
      })
    }
  };
};
var server_default = { id, server, setup };
export {
  server_default as default,
  getApiKey,
  id,
  server
};
