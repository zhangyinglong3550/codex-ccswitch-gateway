import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { CATALOG_PATH, GATEWAY_HOME } from "./paths.mjs";
import { extractConfiguredModel, extractModelCatalog, providerKind, readCodexProviders } from "./ccswitch.mjs";

const FALLBACK_OFFICIAL_MODEL = {
  slug: "gpt-5.5",
  display_name: "GPT-5.5",
  description: "Official Codex model routed through the local CC Switch gateway.",
  base_instructions: "You are Codex, a coding agent. You help the user complete software engineering tasks in their local workspace.",
  visibility: "list",
  priority: 0,
  supported_in_api: true,
  input_modalities: ["text", "image"],
  supported_reasoning_levels: [
    { effort: "low", description: "Fast responses with lighter reasoning" },
    { effort: "medium", description: "Balances speed and reasoning depth" },
    { effort: "high", description: "Greater reasoning depth" },
    { effort: "xhigh", description: "Extra high reasoning depth" }
  ],
  default_reasoning_level: "medium",
  shell_type: "shell_command",
  supports_reasoning_summaries: true,
  default_reasoning_summary: "none",
  support_verbosity: true,
  default_verbosity: "low",
  apply_patch_tool_type: "freeform",
  web_search_tool_type: "text_and_image",
  truncation_policy: { mode: "tokens", limit: 10000 },
  supports_parallel_tool_calls: true,
  supports_image_detail_original: true,
  context_window: 128000,
  max_context_window: 128000,
  effective_context_window_percent: 95,
  experimental_supported_tools: []
};

const INHERITED_CODEX_MODEL_FIELDS = [
  "base_instructions",
  "supports_reasoning_summaries",
  "default_reasoning_summary",
  "support_verbosity",
  "default_verbosity",
  "apply_patch_tool_type",
  "web_search_tool_type",
  "truncation_policy",
  "supports_parallel_tool_calls",
  "supports_image_detail_original",
  "context_window",
  "max_context_window",
  "effective_context_window_percent",
  "experimental_supported_tools"
];

const UNSUPPORTED_PROVIDER_MODELS = {
  opencode: new Set(["qwen3.7-max"])
};

function isUnsupportedProviderModel(provider, slug) {
  return Boolean(UNSUPPORTED_PROVIDER_MODELS[providerKind(provider)]?.has(slug));
}

function readBundledOfficialModels() {
  try {
    const out = execFileSync("codex", ["debug", "models", "--bundled"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 15000
    });
    const parsed = JSON.parse(out);
    return (parsed.models || [])
      .filter((m) => /^gpt-|^o[0-9]/.test(m.slug || ""))
      .map((m) => ({
        ...m,
        visibility: m.visibility || "list",
        "x-ccswitch-provider": "official"
      }));
  } catch {
    return [{ ...FALLBACK_OFFICIAL_MODEL, "x-ccswitch-provider": "official" }];
  }
}

function modelFromSlug(slug, provider) {
  const display = slug;
  return {
    slug,
    display_name: display,
    description: `${provider.name} via CC Switch gateway`,
    visibility: "list",
    priority: 1000,
    supported_in_api: true,
    input_modalities: ["text"],
    default_reasoning_level: "medium",
    supported_reasoning_levels: [
      { effort: "low", description: "Fast responses with lighter reasoning" },
      { effort: "medium", description: "Balanced reasoning" },
      { effort: "high", description: "More reasoning" }
    ],
    shell_type: "shell_command",
    "x-ccswitch-provider": provider.id,
    "x-ccswitch-provider-name": provider.name
  };
}

function aliasSlug(provider, slug) {
  const kind = providerKind(provider);
  return `${kind}-${slug}`.replace(/[^A-Za-z0-9._-]+/g, "-");
}

function withCodexRuntimeDefaults(model, referenceModel = FALLBACK_OFFICIAL_MODEL) {
  const next = { ...model };
  for (const field of INHERITED_CODEX_MODEL_FIELDS) {
    if (next[field] === undefined && referenceModel[field] !== undefined) {
      next[field] = referenceModel[field];
    }
  }
  return next;
}

export function buildCatalog() {
  const providers = readCodexProviders().sort((a, b) => {
    const rank = (p) => {
      const kind = providerKind(p);
      if (kind === "official") return 0;
      if (kind === "opencode") return 10;
      if (kind === "deepseek") return 20;
      if (kind === "mimo") return 30;
      if (kind === "volcengine") return 40;
      return 100;
    };
    return rank(a) - rank(b);
  });
  const modelsBySlug = new Map();

  const officialModels = readBundledOfficialModels();
  const referenceModel = officialModels.find((m) => m.base_instructions) || FALLBACK_OFFICIAL_MODEL;

  for (const model of officialModels) {
    modelsBySlug.set(model.slug, model);
  }

  for (const provider of providers) {
    if (providerKind(provider) === "official") continue;
    const catalogModels = extractModelCatalog(provider);
    const configured = extractConfiguredModel(provider);
    const candidates = [];

    for (const item of catalogModels) {
      if (typeof item === "string") {
        candidates.push(modelFromSlug(item, provider));
      } else if (item && typeof item === "object") {
        const slug = item.slug || item.id || item.model || item.name;
        if (slug) {
          candidates.push({
            ...modelFromSlug(slug, provider),
            ...item,
            slug,
            visibility: item.visibility || "list",
            "x-ccswitch-provider": provider.id,
            "x-ccswitch-provider-name": provider.name
          });
        }
      }
    }

    if (configured && !candidates.some((m) => m.slug === configured)) {
      candidates.push(modelFromSlug(configured, provider));
    }

    for (const model of candidates.filter((candidate) => !isUnsupportedProviderModel(provider, candidate.slug))) {
      if (!modelsBySlug.has(model.slug)) {
        modelsBySlug.set(model.slug, withCodexRuntimeDefaults(model, referenceModel));
        continue;
      }
      const aliased = {
        ...model,
        slug: aliasSlug(provider, model.slug),
        display_name: `${model.slug} (${provider.name})`,
        description: `${provider.name} alias for ${model.slug} via CC Switch gateway`
      };
      if (!modelsBySlug.has(aliased.slug)) {
        modelsBySlug.set(aliased.slug, withCodexRuntimeDefaults(aliased, referenceModel));
      }
    }
  }

  return {
    generated_at: new Date().toISOString(),
    source: "ccswitch",
    models: [...modelsBySlug.values()]
  };
}

export function writeCatalog(catalog = buildCatalog(), outPath = CATALOG_PATH) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.mkdirSync(GATEWAY_HOME, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(catalog, null, 2), "utf8");
  return outPath;
}
