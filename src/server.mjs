import http from "node:http";
import fs from "node:fs";
import { CODEX_HOME, DEFAULT_HOST, DEFAULT_PORT } from "./paths.mjs";
import { buildCatalog, writeCatalog } from "./catalog.mjs";
import {
  extractApiFormat,
  extractApiKey,
  extractCodexChatReasoning,
  extractWireApi,
  providerKind,
  readCodexProviders
} from "./ccswitch.mjs";
import { chatToResponse, contentToResponsesInputContent, contentToText, extractNamespaceMap, responsesToChat, streamChatToResponses, writeResponseSse } from "./translator.mjs";
import path from "node:path";

const UPSTREAM_TIMEOUT_MS = Number(process.env.CODEX_CCSWITCH_UPSTREAM_TIMEOUT_MS || "180000");

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function json(res, status, body) {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

function logRequest(message, extra = {}) {
  const data = Object.keys(extra).length ? ` ${JSON.stringify(extra)}` : "";
  console.error(`[codex-ccswitch-gateway] ${message}${data}`);
}

function normalizeBaseUrl(baseUrl, kind) {
  let base = String(baseUrl || "").replace(/\/+$/, "");
  if (kind === "opencode" && !base.endsWith("/v1")) {
    base = `${base}/v1`;
  }
  return base;
}

function chatUrl(baseUrl, kind) {
  const base = normalizeBaseUrl(baseUrl, kind);
  return `${base}/chat/completions`;
}

function responsesUrl(baseUrl, kind) {
  const base = normalizeBaseUrl(baseUrl, kind);
  return `${base}/responses`;
}

function effectiveWireApi(provider) {
  const kind = providerKind(provider);
  const configured = extractWireApi(provider);
  const apiFormat = extractApiFormat(provider);
  const name = String(provider?.name || "").toLowerCase();
  if (kind === "volcengine" && configured === "responses") return "responses";
  if (apiFormat === "openai_chat" || apiFormat === "chat_completions") {
    return "chat_completions";
  }
  if (apiFormat === "openai_responses" || apiFormat === "responses") {
    return "responses";
  }
  if (kind === "deepseek" || kind === "mimo" || kind === "opencode") return "chat_completions";
  if (kind === "volcengine" && name.includes("agentplan")) return "responses";
  if (kind === "volcengine" && name.includes("coding")) return "responses";
  return configured === "responses" ? "responses" : "chat_completions";
}

function selectEndpoint(provider) {
  const endpoints = provider.endpoints || [];
  const name = String(provider?.name || "").toLowerCase();
  if (providerKind(provider) === "volcengine") {
    if (name.includes("agentplan")) {
      return endpoints.find((url) => url.includes("/api/plan/")) || endpoints[0];
    }
    if (name.includes("coding")) {
      return endpoints.find((url) => url.includes("/api/coding/")) || endpoints[0];
    }
  }
  return endpoints[0];
}

function findProviderForModel(model, catalog, providers) {
  if (model === "volcengine-glm-5.2") {
    const provider = providers.find((p) => providerKind(p) === "volcengine" && String(p.name || "").toLowerCase().includes("coding"));
    if (provider) return { kind: "volcengine", provider, entry: { model: "GLM-5.2", slug: model } };
  }
  const entry = (catalog.models || []).find((m) => m.slug === model);
  const providerId = entry?.["x-ccswitch-provider"];
  if (providerId === "official") return { kind: "official", entry };
  const provider = providers.find((p) => p.id === providerId);
  if (provider) return { kind: providerKind(provider), provider, entry };

  if (/^gpt-|^o[0-9]/.test(model)) return { kind: "official", entry };
  const guessed = providers.find((p) => model.toLowerCase().includes(providerKind(p)));
  return guessed ? { kind: providerKind(guessed), provider: guessed, entry } : null;
}

function officialAuth() {
  const authPath = path.join(CODEX_HOME, "auth.json");
  if (fs.existsSync(authPath)) {
    try {
      const auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
      const accessToken = auth.tokens?.access_token;
      const accountId = auth.tokens?.account_id;
      if (accessToken) {
        return {
          backend: "chatgpt-codex",
          url: "https://chatgpt.com/backend-api/codex/responses",
          headers: {
            "Authorization": `Bearer ${accessToken}`,
            ...(accountId ? { "chatgpt-account-id": accountId } : {})
          }
        };
      }
    } catch {
      // Fall through to API key mode.
    }
  }
  if (process.env.OPENAI_API_KEY) {
    return {
      backend: "openai",
      url: "https://api.openai.com/v1/responses",
      headers: { "Authorization": `Bearer ${process.env.OPENAI_API_KEY}` }
    };
  }
  return null;
}

function normalizeOfficialChatgptInput(input) {
  if (!Array.isArray(input)) return input;
  return input.map((item) => {
    if (!item || typeof item !== "object") return item;
    const content = Array.isArray(item.content) ? item.content : [];
    const hasAssistantOutputContent = content.some((part) => (
      part &&
      typeof part === "object" &&
      (part.type === "output_text" || part.type === "reasoning_text" || part.type === "summary_text")
    ));
    if (item.role === "assistant" || hasAssistantOutputContent) {
      const text = contentToText(item.content ?? item.output ?? item.text ?? "");
      if (!text) {
        return { ...item, type: "message", role: "assistant", content: [] };
      }
      return {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: `Previous assistant response:\n${text}`
          }
        ]
      };
    }
    return item;
  });
}

function officialBody(body, backend) {
  const normalized = { ...body };
  if (!Object.prototype.hasOwnProperty.call(normalized, "instructions")) {
    normalized.instructions = "";
  }
  if (!Object.prototype.hasOwnProperty.call(normalized, "store")) {
    normalized.store = false;
  }
  if (typeof normalized.input === "string") {
    normalized.input = [
      {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: normalized.input
          }
        ]
      }
    ];
  }
  if (backend === "chatgpt-codex") {
    normalized.input = normalizeOfficialChatgptInput(normalized.input);
    delete normalized.max_output_tokens;
  }
  return normalized;
}

function responsesBody(body) {
  const normalized = { ...body };
  const reasoningEffort = normalized.reasoning_effort || normalized.model_reasoning_effort || normalized.reasoning?.effort;
  if (reasoningEffort && !normalized.reasoning_effort) {
    normalized.reasoning_effort = reasoningEffort;
  }
  delete normalized.reasoning;
  delete normalized.model_reasoning_effort;
  if (!Object.prototype.hasOwnProperty.call(normalized, "store")) {
    normalized.store = false;
  }
  if (typeof normalized.input === "string") {
    normalized.input = [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: normalized.input }]
      }
    ];
  } else if (Array.isArray(normalized.input)) {
    normalized.input = normalized.input.map((item) => {
      if (!item || typeof item !== "object") return item;
      if (item.type === "message" || item.role) {
        const role = item.role || "user";
        const content = contentToResponsesInputContent(item.content ?? item.output ?? item.text ?? "", role);
        return {
          ...item,
          type: "message",
          role,
          content
        };
      }
      if (item.type === "function_call_output") {
        return { ...item, output: contentToText(item.output) };
      }
      return item;
    }).filter((item) => {
      if (!item || typeof item !== "object") return Boolean(item);
      if (item.type !== "message") return true;
      return Array.isArray(item.content) && item.content.length > 0;
    });
  }
  return normalized;
}

async function proxyOfficial(body, req, res) {
  const auth = officialAuth();
  if (!auth) {
    json(res, 401, { error: "Official OpenAI auth not found in ~/.codex/auth.json or OPENAI_API_KEY." });
    return;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("upstream timeout")), UPSTREAM_TIMEOUT_MS);
  req.on("aborted", () => controller.abort(new Error("client disconnected")));
  const upstream = await fetch(auth.url, {
    method: "POST",
    signal: controller.signal,
    headers: {
      "Content-Type": "application/json",
      "Accept": req.headers.accept || (body.stream ? "text/event-stream" : "application/json"),
      ...auth.headers
    },
    body: JSON.stringify(officialBody(body, auth.backend))
  }).finally(() => clearTimeout(timeout));
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(upstream.status, {
    "Content-Type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
    "Cache-Control": "no-cache"
  });
  if (upstream.body) {
    for await (const chunk of upstream.body) {
      if (res.destroyed || res.writableEnded) break;
      res.write(chunk);
    }
  }
  if (!res.destroyed && !res.writableEnded) res.end();
}

async function callCustomProvider(body, route, req, res) {
  const provider = route.provider;
  const apiKey = extractApiKey(provider);
  const endpoint = selectEndpoint(provider);
  if (!endpoint) {
    json(res, 400, { error: `No endpoint configured for provider ${provider.name}.` });
    return;
  }
  if (!apiKey) {
    json(res, 401, { error: `No API key found in CC Switch provider ${provider.name}.` });
    return;
  }
  if (effectiveWireApi(provider) === "responses") {
    await proxyCustomResponses(body, route, req, res, { endpoint, apiKey });
    return;
  }
  const upstreamModel = route.entry?.model || route.entry?.backend_model || body.model;
  const namespaceMap = extractNamespaceMap(body.tools);
  const chatBody = responsesToChat({ ...body, stream: Boolean(body.stream) }, upstreamModel, {
    reasoning: extractCodexChatReasoning(provider),
    thinkingExcludesEffort: route.kind === "opencode",
    textifyToolHistory: route.kind === "opencode" && String(upstreamModel).toLowerCase().includes("kimi"),
    moonshotSchemaCompat: route.kind === "opencode" && String(upstreamModel).toLowerCase().includes("kimi")
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("upstream timeout")), UPSTREAM_TIMEOUT_MS);
  req.on("aborted", () => controller.abort(new Error("client disconnected")));
  const upstream = await fetch(chatUrl(endpoint, route.kind), {
    method: "POST",
    signal: controller.signal,
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify(chatBody)
  }).finally(() => clearTimeout(timeout));
  if (res.destroyed || res.writableEnded) return;
  if (body.stream && upstream.ok) {
    await streamChatToResponses(upstream, res, body.model, { namespaceMap });
    return;
  }
  const text = await upstream.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { error: text };
  }
  if (!upstream.ok) {
    json(res, upstream.status, payload);
    return;
  }
  const response = chatToResponse(payload, body.model, { namespaceMap });
  if (body.stream) {
    writeResponseSse(res, response);
  } else {
    json(res, 200, response);
  }
}

async function proxyCustomResponses(body, route, req, res, { endpoint, apiKey }) {
  const upstreamModel = route.entry?.model || route.entry?.backend_model || body.model;
  const upstreamBody = responsesBody({ ...body, model: upstreamModel });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("upstream timeout")), UPSTREAM_TIMEOUT_MS);
  req.on("aborted", () => controller.abort(new Error("client disconnected")));
  const upstream = await fetch(responsesUrl(endpoint, route.kind), {
    method: "POST",
    signal: controller.signal,
    headers: {
      "Content-Type": "application/json",
      "Accept": req.headers.accept || (body.stream ? "text/event-stream" : "application/json"),
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify(upstreamBody)
  }).finally(() => clearTimeout(timeout));
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(upstream.status, {
    "Content-Type": upstream.headers.get("content-type") || (body.stream ? "text/event-stream; charset=utf-8" : "application/json; charset=utf-8"),
    "Cache-Control": "no-cache"
  });
  if (upstream.body) {
    for await (const chunk of upstream.body) {
      if (res.destroyed || res.writableEnded) break;
      res.write(chunk);
    }
  }
  if (!res.destroyed && !res.writableEnded) res.end();
}

export function createServer() {
  let catalog = buildCatalog();
  writeCatalog(catalog);
  let providers = readCodexProviders();

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
      if (req.method === "GET" && url.pathname === "/health") {
        json(res, 200, {
          ok: true,
          service: "codex-ccswitch-gateway",
          models: catalog.models.length,
          providers: providers.length
        });
        return;
      }
      if (req.method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/v1/models/")) {
        json(res, 200, {
          object: "list",
          data: catalog.models.filter((m) => m.visibility !== "hide").map((m) => ({
            id: m.slug,
            object: "model",
            created: 0,
            owned_by: m["x-ccswitch-provider-name"] || m["x-ccswitch-provider"] || "ccswitch"
          }))
        });
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/config") {
        json(res, 200, {
          providers: providers.map((p) => ({
            id: p.id,
            name: p.name,
            kind: providerKind(p),
            api_format: extractApiFormat(p),
            wire_api: effectiveWireApi(p),
            reasoning: extractCodexChatReasoning(p),
            endpoints: p.endpoints,
            has_api_key: Boolean(extractApiKey(p))
          }))
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/admin/reload") {
        catalog = buildCatalog();
        writeCatalog(catalog);
        providers = readCodexProviders();
        json(res, 200, { ok: true, models: catalog.models.length, providers: providers.length });
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/responses") {
        const body = await readJsonBody(req);
        const route = findProviderForModel(body.model || "", catalog, providers);
        logRequest("responses", {
          model: body.model || "",
          stream: Boolean(body.stream),
          route: route?.kind || "none",
          wireApi: route?.provider ? effectiveWireApi(route.provider) : "official",
          inputItems: Array.isArray(body.input) ? body.input.length : typeof body.input
        });
        if (!route) {
          json(res, 400, { error: `No CC Switch route for model ${body.model || "(empty)"}.` });
          return;
        }
        if (route.kind === "official") {
          await proxyOfficial(body, req, res);
        } else {
          await callCustomProvider(body, route, req, res);
        }
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        const body = await readJsonBody(req);
        const route = findProviderForModel(body.model || "", catalog, providers);
        if (!route || route.kind === "official") {
          json(res, 400, { error: "Chat Completions endpoint is for custom CC Switch providers only." });
          return;
        }
        const apiKey = extractApiKey(route.provider);
        const endpoint = selectEndpoint(route.provider);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(new Error("upstream timeout")), UPSTREAM_TIMEOUT_MS);
        req.on("aborted", () => controller.abort(new Error("client disconnected")));
        const upstream = await fetch(chatUrl(endpoint, route.kind), {
          method: "POST",
          signal: controller.signal,
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
          body: JSON.stringify(body)
        }).finally(() => clearTimeout(timeout));
        if (res.destroyed || res.writableEnded) return;
        res.writeHead(upstream.status, {
          "Content-Type": upstream.headers.get("content-type") || "application/json; charset=utf-8"
        });
        if (upstream.body) {
          for await (const chunk of upstream.body) {
            if (res.destroyed || res.writableEnded) break;
            res.write(chunk);
          }
        }
        if (!res.destroyed && !res.writableEnded) res.end();
        return;
      }
      json(res, 404, { error: "Not found" });
    } catch (err) {
      const message = err.message || String(err);
      if (/client disconnected/i.test(message)) {
        logRequest("client disconnected");
        return;
      }
      logRequest("request failed", { error: message });
      json(res, 500, { error: message });
    }
  });
}

export function startServer({ host = DEFAULT_HOST, port = DEFAULT_PORT } = {}) {
  const server = createServer();
  server.listen(port, host, () => {
    console.error(`[codex-ccswitch-gateway] listening on http://${host}:${port}`);
  });
  return server;
}
