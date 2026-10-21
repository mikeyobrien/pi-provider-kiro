import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { KiroMemoryClient } from "../src/memory.js";
import { KiroMemoryError } from "../src/memory.js";
import { loadKiroMemoryToolsConfig, registerKiroMemoryTools } from "../src/memory-tools.js";

type RegisteredTool = {
  name: string;
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<{ content: { text: string }[] }>;
};

function agentDirWith(settings: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "kiro-memory-tools-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.json"), typeof settings === "string" ? settings : JSON.stringify(settings));
  return dir;
}

function fakeClient(overrides: Partial<KiroMemoryClient> = {}): KiroMemoryClient {
  return {
    endpoint: "https://app.kiro.dev",
    namespace: "KNOWLEDGE",
    put: vi.fn(async () => ({ memoryId: "m-1" })),
    get: vi.fn(async () => ({
      memoryId: "m-1",
      namespace: "KNOWLEDGE",
      content: "The user indents with tabs.",
      status: "active" as const,
      createdAt: 1,
      updatedAt: 2,
      title: "Tabs",
      memoryType: "USER_PREFERENCE",
      scopes: ["Global"],
    })),
    delete: vi.fn(async () => {}),
    listChanges: vi.fn(),
    listAll: vi.fn(async () => ({
      memories: [
        { memoryId: "old", updatedAt: 1, title: "Kotlin", content: "Uses Kotlin" },
        {
          memoryId: "new",
          updatedAt: 5,
          title: "Tabs",
          summary: "Prefers tabs",
          content: "The user indents with tabs.",
        },
      ],
      version: "v1",
    })),
    ...overrides,
  } as KiroMemoryClient;
}

function tool(tools: Map<string, RegisteredTool>, name: string): RegisteredTool {
  const found = tools.get(name);
  if (!found) throw new Error(`tool ${name} not registered`);
  return found;
}

function register(client: KiroMemoryClient, enabled = true) {
  const tools = new Map<string, RegisteredTool>();
  const pi = { registerTool: vi.fn((tool: RegisteredTool) => tools.set(tool.name, tool)) } as unknown as ExtensionAPI;
  const createClient = vi.fn(() => client);
  registerKiroMemoryTools(pi, {
    loadConfig: () => ({ enabled, namespace: "pi-ns" }),
    resolveCredential: () => ({ access: "t", authMethod: "idc" }),
    createClient,
  });
  return { tools, pi, createClient };
}

describe("Kiro memory tools: settings", () => {
  it("is off without a settings file", () => {
    expect(loadKiroMemoryToolsConfig(mkdtempSync(join(tmpdir(), "kiro-memory-none-")))).toEqual({ enabled: false });
  });

  it("is off for malformed settings", () => {
    expect(loadKiroMemoryToolsConfig(agentDirWith("{not json"))).toEqual({ enabled: false });
  });

  it("is off unless enabled is exactly true", () => {
    expect(loadKiroMemoryToolsConfig(agentDirWith({ "pi-provider-kiro": { memory: { enabled: "yes" } } }))).toEqual({
      enabled: false,
    });
  });

  it("reads enabled, endpoint and namespace", () => {
    const dir = agentDirWith({
      "pi-provider-kiro": { memory: { enabled: true, endpoint: " https://beta.app.kiro.dev ", namespace: "pi" } },
    });
    expect(loadKiroMemoryToolsConfig(dir)).toEqual({
      enabled: true,
      endpoint: "https://beta.app.kiro.dev",
      namespace: "pi",
    });
  });
});

describe("Kiro memory tools: registration", () => {
  it("registers nothing when disabled", () => {
    const { pi, createClient } = register(fakeClient(), false);
    expect(pi.registerTool).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
  });

  it("registers the four tools when enabled, passing the configured namespace", () => {
    const { tools, createClient } = register(fakeClient());
    expect([...tools.keys()]).toEqual([
      "kiro_memory_save",
      "kiro_memory_get",
      "kiro_memory_list",
      "kiro_memory_delete",
    ]);
    expect(createClient).toHaveBeenCalledWith(expect.objectContaining({ namespace: "pi-ns" }));
  });

  it("stays unregistered, with a warning, when the endpoint is refused", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const pi = { registerTool: vi.fn() } as unknown as ExtensionAPI;
    registerKiroMemoryTools(pi, {
      loadConfig: () => ({ enabled: true, endpoint: "https://evil.example" }),
      resolveCredential: () => undefined,
    });
    expect(pi.registerTool).not.toHaveBeenCalled();
    expect(warn.mock.calls[0][0]).toContain("https://evil.example");
    warn.mockRestore();
  });
});

describe("Kiro memory tools: execution", () => {
  it("saves a memory and reports its id", async () => {
    const client = fakeClient();
    const { tools } = register(client);

    const result = await tool(tools, "kiro_memory_save").execute("call", {
      content: "c",
      title: "t",
      memoryType: "SEMANTIC",
      scopes: ["Global"],
    });

    expect(client.put).toHaveBeenCalledWith(
      expect.objectContaining({ content: "c", title: "t", memoryType: "SEMANTIC", scopes: ["Global"] }),
      undefined,
    );
    expect(result.content[0].text).toBe("Saved Kiro memory m-1.");
  });

  it("returns full content for get", async () => {
    const { tools } = register(fakeClient());
    const result = await tool(tools, "kiro_memory_get").execute("call", { memoryId: "m-1" });
    expect(result.content[0].text).toBe("m-1 (Tabs · USER_PREFERENCE · scopes: Global)\n\nThe user indents with tabs.");
  });

  it("lists newest first and filters locally by text", async () => {
    const { tools } = register(fakeClient());

    const all = await tool(tools, "kiro_memory_list").execute("call", {});
    expect(all.content[0].text.split("\n")).toEqual(["- new: Tabs — Prefers tabs", "- old: Kotlin"]);

    const filtered = await tool(tools, "kiro_memory_list").execute("call", { query: "KOTLIN" });
    expect(filtered.content[0].text).toBe("- old: Kotlin");

    const limited = await tool(tools, "kiro_memory_list").execute("call", { limit: 1 });
    expect(limited.content[0].text).toBe("- new: Tabs — Prefers tabs\n(1 more not shown)");
  });

  it("says so when there are no memories", async () => {
    const { tools } = register(fakeClient({ listAll: vi.fn(async () => ({ memories: [] })) }));
    const result = await tool(tools, "kiro_memory_list").execute("call", {});
    expect(result.content[0].text).toBe("No Kiro memories saved yet.");
  });

  it("deletes by id", async () => {
    const client = fakeClient();
    const { tools } = register(client);
    const result = await tool(tools, "kiro_memory_delete").execute("call", { memoryId: "m-1" });
    expect(client.delete).toHaveBeenCalledWith("m-1", { signal: undefined });
    expect(result.content[0].text).toBe("Deleted Kiro memory m-1.");
  });

  it("throws a tool error naming the rollout gate for a forbidden account", async () => {
    const forbidden = new KiroMemoryError(
      "Kiro memory PutMemory failed: 403 ForbiddenException: enableRemoteMemorySync feature is not enabled for this user",
      "PutMemory",
      "forbidden",
      403,
      "ForbiddenException",
    );
    const { tools } = register(fakeClient({ put: vi.fn(async () => Promise.reject(forbidden)) }));

    await expect(tool(tools, "kiro_memory_save").execute("call", { content: "c" })).rejects.toThrow(
      /\[forbidden\] Kiro cloud memory is not enabled for this account/,
    );
  });

  it("throws a tool error suggesting login for an unauthorized call", async () => {
    const unauthorized = new KiroMemoryError("Kiro memory GetMemory failed: 401", "GetMemory", "unauthorized", 401);
    const { tools } = register(fakeClient({ get: vi.fn(async () => Promise.reject(unauthorized)) }));

    await expect(tool(tools, "kiro_memory_get").execute("call", { memoryId: "x" })).rejects.toThrow(
      /Log in to Kiro again/,
    );
  });
});
