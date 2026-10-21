// ABOUTME: Opt-in pi tools over Kiro's cloud memory API (kiro_memory_save / _get / _list / _delete).
// ABOUTME: Registered only when settings.json enables them, because the backend is rollout-gated per user.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createKiroMemoryClient,
  KIRO_MEMORY_LIMITS,
  KIRO_MEMORY_TYPES,
  type KiroMemoryClient,
  type KiroMemoryCredential,
  KiroMemoryError,
  type KiroMemoryType,
} from "./memory.js";
import { getPiAgentDir } from "./usage-tracking.js";

/** Resolved memory-tools policy. Disabled unless explicitly opted in. */
export interface KiroMemoryToolsConfig {
  enabled: boolean;
  /** Overrides the BFF endpoint (still subject to the trusted-host check). */
  endpoint?: string;
  /** Namespace the tools read and write. Defaults to Kiro's own `KNOWLEDGE`. */
  namespace?: string;
}

/**
 * Load `"pi-provider-kiro": { "memory": { "enabled": true } }` from pi's
 * settings.json. Fails closed on malformed input and never logs file contents.
 */
export function loadKiroMemoryToolsConfig(agentDir = getPiAgentDir()): KiroMemoryToolsConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
  } catch {
    return { enabled: false };
  }
  const section = asRecord(asRecord(asRecord(raw)?.["pi-provider-kiro"])?.memory);
  if (!section || section.enabled !== true) return { enabled: false };
  const config: KiroMemoryToolsConfig = { enabled: true };
  if (typeof section.endpoint === "string" && section.endpoint.trim()) config.endpoint = section.endpoint.trim();
  if (typeof section.namespace === "string" && section.namespace.trim()) config.namespace = section.namespace.trim();
  return config;
}

export interface KiroMemoryToolsDeps {
  loadConfig: () => KiroMemoryToolsConfig;
  /** The Kiro credential to send, resolved per call so refreshed tokens are used. */
  resolveCredential: () => KiroMemoryCredential | undefined;
  /** Injected for tests. */
  createClient?: typeof createKiroMemoryClient;
}

const SAVE_PARAMS = Type.Object({
  content: Type.String({
    description: "The memory body: a durable fact, preference or summary worth recalling in later sessions.",
    minLength: 1,
    maxLength: KIRO_MEMORY_LIMITS.contentMaxLength,
  }),
  title: Type.Optional(Type.String({ description: "Short title.", maxLength: KIRO_MEMORY_LIMITS.textMaxLength })),
  summary: Type.Optional(
    Type.String({ description: "One-line summary.", maxLength: KIRO_MEMORY_LIMITS.textMaxLength }),
  ),
  memoryType: Type.Optional(
    Type.Union(
      KIRO_MEMORY_TYPES.map((type) => Type.Literal(type)),
      {
        description:
          "SEMANTIC (default): durable fact. USER_PREFERENCE: a stated preference. SUMMARIZATION: a session summary.",
      },
    ),
  ),
  scopes: Type.Optional(
    Type.Array(Type.String({ maxLength: KIRO_MEMORY_LIMITS.scopeMaxLength }), {
      description: 'Scope tags, e.g. ["Global"] or a workspace name. Tags only; they do not isolate memories.',
      maxItems: KIRO_MEMORY_LIMITS.maxScopes,
    }),
  ),
  memoryId: Type.Optional(
    Type.String({
      description: "Existing memory id to replace. Omit to create a new memory.",
      pattern: "^[A-Za-z0-9-]+$",
      maxLength: KIRO_MEMORY_LIMITS.idMaxLength,
    }),
  ),
});

const ID_PARAMS = Type.Object({
  memoryId: Type.String({
    description: "The memory id.",
    pattern: "^[A-Za-z0-9-]+$",
    maxLength: KIRO_MEMORY_LIMITS.idMaxLength,
  }),
});

const LIST_PARAMS = Type.Object({
  query: Type.Optional(
    Type.String({
      description:
        "Case-insensitive text to match in title, summary, content or scopes. The service has no search; matching is local.",
    }),
  ),
  limit: Type.Optional(
    Type.Integer({ description: "Maximum memories to return (default 20).", minimum: 1, maximum: 200 }),
  ),
});

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }], details: undefined };
}

/**
 * A failed call as a tool result the model can act on. Only the kind and the
 * redacted service message are shown; never the token or the memory contents.
 */
function failure(error: unknown): never {
  if (error instanceof KiroMemoryError) {
    const hint =
      error.kind === "forbidden"
        ? " Kiro cloud memory is not enabled for this account (it is rolled out per user)."
        : error.kind === "unauthorized"
          ? " Log in to Kiro again (`/login kiro` or `kiro-cli login`)."
          : "";
    throw new Error(`${error.message} [${error.kind}]${hint}`);
  }
  throw error;
}

function preview(value: string | undefined, max = 200): string {
  if (!value) return "";
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** Register the memory tools when opted in. When disabled this returns without registering anything. */
export function registerKiroMemoryTools(pi: ExtensionAPI, deps: KiroMemoryToolsDeps): void {
  const config = deps.loadConfig();
  if (!config.enabled) return;

  const create = deps.createClient ?? createKiroMemoryClient;
  let client: KiroMemoryClient;
  try {
    client = create({ getCredential: deps.resolveCredential, endpoint: config.endpoint, namespace: config.namespace });
  } catch (error) {
    console.warn(
      `[pi-provider-kiro] Kiro memory tools disabled: ${error instanceof Error ? error.message : "invalid configuration"}`,
    );
    return;
  }

  pi.registerTool({
    name: "kiro_memory_save",
    label: "Kiro memory: save",
    description:
      "Save a memory to the user's Kiro cloud memory so it is available in later sessions and other Kiro clients. Pass memoryId to replace an existing memory.",
    promptSnippet: "kiro_memory_save — store a durable fact or preference in the user's Kiro cloud memory",
    promptGuidelines: [
      "Save to Kiro memory only what the user would want recalled later; never save secrets, credentials or tokens.",
    ],
    parameters: SAVE_PARAMS,
    async execute(_id, params, signal) {
      try {
        const { memoryId } = await client.put(
          {
            content: params.content,
            title: params.title,
            summary: params.summary,
            memoryType: params.memoryType as KiroMemoryType | undefined,
            scopes: params.scopes,
            memoryId: params.memoryId,
          },
          signal,
        );
        return text(`Saved Kiro memory ${memoryId}.`);
      } catch (error) {
        return failure(error);
      }
    },
  });

  pi.registerTool({
    name: "kiro_memory_get",
    label: "Kiro memory: get",
    description: "Read one memory from the user's Kiro cloud memory by id, including its full content.",
    parameters: ID_PARAMS,
    async execute(_id, params, signal) {
      try {
        const memory = await client.get(params.memoryId, { signal });
        const header = [
          memory.title,
          memory.memoryType,
          memory.scopes?.length ? `scopes: ${memory.scopes.join(", ")}` : undefined,
        ]
          .filter(Boolean)
          .join(" · ");
        return text(`${memory.memoryId}${header ? ` (${header})` : ""}\n\n${memory.content}`);
      } catch (error) {
        return failure(error);
      }
    },
  });

  pi.registerTool({
    name: "kiro_memory_list",
    label: "Kiro memory: list",
    description:
      "List memories in the user's Kiro cloud memory, optionally filtered by text. Returns ids, titles and summaries; use kiro_memory_get for full content.",
    parameters: LIST_PARAMS,
    async execute(_id, params, signal) {
      try {
        const { memories } = await client.listAll({ signal });
        const query = params.query?.trim().toLowerCase();
        const matches = query
          ? memories.filter((memory) =>
              [memory.title, memory.summary, memory.content, ...(memory.scopes ?? [])].some((field) =>
                field?.toLowerCase().includes(query),
              ),
            )
          : memories;
        matches.sort((a, b) => b.updatedAt - a.updatedAt);
        const limit = params.limit ?? 20;
        const shown = matches.slice(0, limit);
        if (shown.length === 0) return text(query ? "No Kiro memories match." : "No Kiro memories saved yet.");
        const lines = shown.map(
          (memory) =>
            `- ${memory.memoryId}: ${preview(memory.title || memory.summary || memory.content, 120)}${
              memory.title && memory.summary ? ` — ${preview(memory.summary, 160)}` : ""
            }`,
        );
        const more = matches.length > shown.length ? `\n(${matches.length - shown.length} more not shown)` : "";
        return text(`${lines.join("\n")}${more}`);
      } catch (error) {
        return failure(error);
      }
    },
  });

  pi.registerTool({
    name: "kiro_memory_delete",
    label: "Kiro memory: delete",
    description: "Delete a memory from the user's Kiro cloud memory by id. A deleted memory's id cannot be reused.",
    parameters: ID_PARAMS,
    async execute(_id, params, signal) {
      try {
        await client.delete(params.memoryId, { signal });
        return text(`Deleted Kiro memory ${params.memoryId}.`);
      } catch (error) {
        return failure(error);
      }
    },
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
