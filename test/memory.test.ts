import { cbor } from "@smithy/core/cbor";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createKiroMemoryClient,
  KIRO_MEMORY_LIMITS,
  type KiroMemoryCredential,
  KiroMemoryError,
  kiroMemoryIdpHeader,
  resolveKiroMemoryEndpoint,
} from "../src/memory.js";
import { BUILDER_ID_PROFILE_ARN } from "../src/oauth.js";

const PROFILE_ARN = "arn:aws:codewhisperer:us-east-1:123456789012:profile/TEST";
const TOKEN = "test-access-token-SECRET";
const IDC: KiroMemoryCredential = { access: TOKEN, profileArn: PROFILE_ARN, authMethod: "idc" };

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function cborResponse(status: number, body: unknown): Response {
  return new Response(cbor.serialize(body) as Uint8Array<ArrayBuffer>, {
    status,
    headers: { "content-type": "application/cbor", "smithy-protocol": "rpc-v2-cbor" },
  });
}

/** The error body shape app.kiro.dev returns (captured live 2026-10-21). */
function serviceError(status: number, name: string, message: string): Response {
  return cborResponse(status, { __type: `com.amazon.kirowebportalservice#${name}`, message });
}

function decodeRequest(init: RequestInit | undefined): Record<string, unknown> {
  return cbor.deserialize(init?.body as Uint8Array) as Record<string, unknown>;
}

/**
 * A stand-in for the BFF memory operations that keeps state per caller token,
 * so a round trip exercises real request encoding, response decoding and the
 * service's documented semantics (upsert by clientToken, 409 on a deleted id,
 * 404 view before first write, soft delete visible as REMOVE).
 */
function fakeBff() {
  type Row = { memory: Record<string, unknown>; status: "active" | "retired"; version: number };
  const users = new Map<string, Map<string, Row>>();
  const captured: Captured[] = [];
  let clock = 1_790_000_000_000;
  let version = 0;
  let minted = 0;

  const fetch = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
    const headers = init?.headers as Record<string, string>;
    const body = decodeRequest(init);
    captured.push({ url, headers, body });
    const user = headers.Authorization;
    if (!headers["X-Kiro-Idp"] && headers.TokenType !== "API_KEY") {
      return serviceError(401, "UnauthorizedException", "Identity provider is required");
    }
    const store = users.get(user) ?? new Map<string, Row>();
    users.set(user, store);
    const op = url.split("/").pop();
    const ns = String(body.namespace);
    const key = (id: string) => `${ns}/${id}`;

    if (op === "PutMemory") {
      const id = (body.clientToken as string | undefined) ?? `0199-minted-${++minted}`;
      const existing = store.get(key(id));
      if (existing?.status === "retired") return serviceError(409, "ConflictException", "memory was deleted");
      clock += 1000;
      const { clientToken: _ignored, ...fields } = body;
      store.set(key(id), {
        memory: {
          ...fields,
          memoryId: id,
          memoryType: fields.memoryType ?? "SEMANTIC",
          createdAt: (existing?.memory.createdAt as number) ?? clock,
          updatedAt: clock,
        },
        status: "active",
        version: ++version,
      });
      return cborResponse(200, { memoryId: id });
    }
    if (op === "GetMemory") {
      const row = store.get(key(String(body.memoryId)));
      if (!row || row.status !== "active") return serviceError(404, "ResourceNotFoundException", "Memory not found");
      return cborResponse(200, { memory: { ...row.memory, status: "active" } });
    }
    if (op === "DeleteMemory") {
      const row = store.get(key(String(body.memoryId)));
      if (row) {
        row.status = "retired";
        row.version = ++version;
      }
      return cborResponse(200, {});
    }
    if (op === "ListMemoryChanges") {
      const rows = [...store.entries()].filter(([k]) => k.startsWith(`${ns}/`)).map(([, row]) => row);
      if (rows.length === 0) return serviceError(404, "ResourceNotFoundException", "No versions");
      const active = rows.filter((row) => row.status === "active");
      const pageSize = (body.maxResults as number | undefined) ?? 100;
      const start = body.nextToken ? Number(body.nextToken) : 0;
      const slice = active.slice(start, start + pageSize);
      const next = start + pageSize < active.length ? String(start + pageSize) : undefined;
      return cborResponse(200, {
        namespace: ns,
        to: `v${version}`,
        changes: slice.map((row) => {
          const { namespace: _ns, createdAt: _ca, sessionId: _sid, ...entry } = row.memory;
          return { type: "ADD", memoryId: row.memory.memoryId, changedAt: row.memory.updatedAt, memory: entry };
        }),
        ...(next ? { nextToken: next } : {}),
      });
    }
    return serviceError(400, "BadRequestException", "unknown operation");
  });
  return { fetch, captured, users };
}

afterEach(() => {
  delete process.env.KIRO_MEMORY_ENDPOINT;
  vi.restoreAllMocks();
});

describe("Kiro memory client: round trip", () => {
  it("stores a memory, reads it back, finds it in a listing, and deletes it", async () => {
    const bff = fakeBff();
    const client = createKiroMemoryClient({ getCredential: () => IDC, fetch: bff.fetch as typeof fetch });

    const { memoryId } = await client.put({
      content: "The user indents with tabs.",
      title: "Tabs",
      summary: "Prefers tabs",
      memoryType: "USER_PREFERENCE",
      scopes: ["Global"],
      metadata: { source: "pi" },
      memoryId: "pi-test-tabs",
    });
    expect(memoryId).toBe("pi-test-tabs");

    const memory = await client.get(memoryId);
    expect(memory).toMatchObject({
      memoryId: "pi-test-tabs",
      namespace: "KNOWLEDGE",
      content: "The user indents with tabs.",
      title: "Tabs",
      memoryType: "USER_PREFERENCE",
      scopes: ["Global"],
      metadata: { source: "pi" },
      status: "active",
    });
    expect(typeof memory.createdAt).toBe("number");

    const listed = await client.listAll();
    expect(listed.memories.map((entry) => entry.memoryId)).toEqual(["pi-test-tabs"]);
    expect(listed.version).toMatch(/^v\d+$/);

    await client.delete(memoryId);
    await expect(client.get(memoryId)).rejects.toMatchObject({ kind: "notFound", status: 404 });
    // The service keeps a deleted id: reusing it is refused for good.
    await expect(client.put({ content: "again", memoryId })).rejects.toMatchObject({ kind: "conflict", status: 409 });
  });

  it("lets the service mint an id when none is given", async () => {
    const bff = fakeBff();
    const client = createKiroMemoryClient({ getCredential: () => IDC, fetch: bff.fetch as typeof fetch });

    const { memoryId } = await client.put({ content: "minted" });

    expect(memoryId).toMatch(/^0199-minted-/);
    expect(bff.captured[0].body).not.toHaveProperty("clientToken");
  });

  it("pages a listing until the last page", async () => {
    const bff = fakeBff();
    const client = createKiroMemoryClient({ getCredential: () => IDC, fetch: bff.fetch as typeof fetch });
    for (let i = 0; i < 5; i++) await client.put({ content: `m${i}`, memoryId: `m-${i}` });

    const first = await client.listChanges({ maxResults: 2 });
    expect(first.changes).toHaveLength(2);
    expect(first.nextToken).toBe("2");

    const pagesBefore = bff.captured.length;
    const all = [];
    let token: string | undefined;
    do {
      const page = await client.listChanges({ maxResults: 2, nextToken: token });
      all.push(...page.changes);
      token = page.nextToken;
    } while (token);
    expect(all.map((change) => change.memoryId)).toEqual(["m-0", "m-1", "m-2", "m-3", "m-4"]);
    expect(bff.captured.length - pagesBefore).toBe(3);
  });

  it("reads a user with no memory view yet as an empty listing", async () => {
    const bff = fakeBff();
    const client = createKiroMemoryClient({ getCredential: () => IDC, fetch: bff.fetch as typeof fetch });

    await expect(client.listAll()).resolves.toEqual({ memories: [] });
    await expect(client.listChanges()).rejects.toMatchObject({ kind: "notFound" });
  });

  it("applies REMOVE changes when folding a listing", async () => {
    const fetch = vi.fn(async () =>
      cborResponse(200, {
        namespace: "KNOWLEDGE",
        to: "v9",
        changes: [
          { type: "ADD", memoryId: "a", changedAt: 1, memory: { memoryId: "a", updatedAt: 1, content: "A" } },
          { type: "ADD", memoryId: "b", changedAt: 2, memory: { memoryId: "b", updatedAt: 2, content: "B" } },
          { type: "REMOVE", memoryId: "a", changedAt: 3 },
        ],
      }),
    );
    const client = createKiroMemoryClient({ getCredential: () => IDC, fetch: fetch as typeof globalThis.fetch });

    const result = await client.listAll();

    expect(result.memories.map((memory) => memory.memoryId)).toEqual(["b"]);
    expect(result.version).toBe("v9");
  });

  it("keeps memories of different callers apart", async () => {
    const bff = fakeBff();
    const alice = createKiroMemoryClient({ getCredential: () => IDC, fetch: bff.fetch as typeof fetch });
    const bob = createKiroMemoryClient({
      getCredential: () => ({ ...IDC, access: "bob-token" }),
      fetch: bff.fetch as typeof fetch,
    });

    await alice.put({ content: "alice only", memoryId: "shared-id" });

    await expect(bob.get("shared-id")).rejects.toMatchObject({ kind: "notFound" });
    // The client never sends a user id: identity is the bearer token alone.
    for (const request of bff.captured) {
      expect(Object.keys(request.body)).not.toContain("userId");
    }
  });
});

describe("Kiro memory client: wire format", () => {
  it("posts RPCv2 CBOR to the bearer service operation path with identity headers", async () => {
    const bff = fakeBff();
    const client = createKiroMemoryClient({ getCredential: () => IDC, fetch: bff.fetch as typeof fetch });

    await client.put({ content: "c", memoryId: "id-1", topic: "t" });

    const [request] = bff.captured;
    expect(request.url).toBe("https://app.kiro.dev/service/KiroWebBearerService/operation/PutMemory");
    expect(request.headers).toMatchObject({
      "smithy-protocol": "rpc-v2-cbor",
      "Content-Type": "application/cbor",
      Accept: "application/cbor",
      Authorization: `Bearer ${TOKEN}`,
      "X-Kiro-Idp": "AWSIdC",
      "X-Kiro-Profile-Arn": PROFILE_ARN,
    });
    expect(request.headers).not.toHaveProperty("TokenType");
    expect(request.body).toEqual({ namespace: "KNOWLEDGE", content: "c", clientToken: "id-1", topic: "t" });
  });

  it("sends the configured namespace, and a per-call namespace over it", async () => {
    const bff = fakeBff();
    const client = createKiroMemoryClient({
      getCredential: () => IDC,
      fetch: bff.fetch as typeof fetch,
      namespace: "pi-tests",
    });

    await client.put({ content: "c" });
    await client.put({ content: "c", namespace: "other-ns" });

    expect(bff.captured.map((request) => request.body.namespace)).toEqual(["pi-tests", "other-ns"]);
  });

  it("decodes epoch millis that CBOR returns as bigint", async () => {
    const fetch = vi.fn(async () =>
      cborResponse(200, {
        memory: {
          memoryId: "x",
          namespace: "KNOWLEDGE",
          content: "body",
          status: "active",
          createdAt: 1_792_541_580_123n,
          updatedAt: 1_792_541_580_456n,
        },
      }),
    );
    const client = createKiroMemoryClient({ getCredential: () => IDC, fetch: fetch as typeof globalThis.fetch });

    const memory = await client.get("x");

    expect(memory.createdAt).toBe(1_792_541_580_123);
    expect(memory.updatedAt).toBe(1_792_541_580_456);
  });

  it("re-reads the credential on every request", async () => {
    const bff = fakeBff();
    let token = "first";
    const client = createKiroMemoryClient({
      getCredential: () => ({ ...IDC, access: token }),
      fetch: bff.fetch as typeof fetch,
    });

    await client.put({ content: "a" });
    token = "second";
    await client.put({ content: "b" });

    expect(bff.captured.map((request) => request.headers.Authorization)).toEqual(["Bearer first", "Bearer second"]);
  });

  it("succeeds deleting a memory the service does not hold", async () => {
    const fetch = vi.fn(async () => serviceError(404, "ResourceNotFoundException", "not found"));
    const client = createKiroMemoryClient({ getCredential: () => IDC, fetch: fetch as typeof globalThis.fetch });

    await expect(client.delete("gone")).resolves.toBeUndefined();
  });
});

describe("Kiro memory client: identity headers", () => {
  it.each([
    ["internal or org IdC", { access: "t", authMethod: "idc", profileArn: PROFILE_ARN }, "AWSIdC"],
    ["Builder ID by profile", { access: "t", authMethod: "idc", profileArn: BUILDER_ID_PROFILE_ARN }, "BuilderId"],
    [
      "Builder ID by start URL",
      { access: "t", authMethod: "idc", startUrl: "https://view.awsapps.com/start" },
      "BuilderId",
    ],
    ["external IdP", { access: "t", authMethod: "external-idp" }, "ExternalOIDC"],
    ["Google social", { access: "t", authMethod: "desktop", socialProvider: "google" }, "Google"],
    ["GitHub social", { access: "t", authMethod: "desktop", socialProvider: "GitHub" }, "Github"],
    ["social with unknown provider", { access: "t", authMethod: "desktop" }, undefined],
    ["API key", { access: "ksk_abc", authMethod: "apikey" }, undefined],
  ] as const)("names %s as %s", (_label, credential, expected) => {
    expect(kiroMemoryIdpHeader(credential as KiroMemoryCredential)).toBe(expected);
  });

  it("sends an API key as TokenType API_KEY with no IdP or profile header", async () => {
    const bff = fakeBff();
    const client = createKiroMemoryClient({
      getCredential: () => ({ access: "ksk_fake", profileArn: PROFILE_ARN }),
      fetch: bff.fetch as typeof fetch,
    });

    await client.put({ content: "c" });

    const { headers } = bff.captured[0];
    expect(headers.TokenType).toBe("API_KEY");
    expect(headers).not.toHaveProperty("X-Kiro-Idp");
    expect(headers).not.toHaveProperty("X-Kiro-Profile-Arn");
  });

  it("marks an external IdP token with TokenType EXTERNAL_IDP", async () => {
    const bff = fakeBff();
    const client = createKiroMemoryClient({
      getCredential: () => ({ access: "t", authMethod: "external-idp", profileArn: PROFILE_ARN }),
      fetch: bff.fetch as typeof fetch,
    });

    await client.put({ content: "c" });

    expect(bff.captured[0].headers).toMatchObject({ "X-Kiro-Idp": "ExternalOIDC", TokenType: "EXTERNAL_IDP" });
  });

  it("refuses locally, without sending the token, when the sign-in's provider cannot be named", async () => {
    const fetch = vi.fn();
    const client = createKiroMemoryClient({
      getCredential: () => ({ access: TOKEN, authMethod: "desktop" }),
      fetch: fetch as typeof globalThis.fetch,
    });

    await expect(client.put({ content: "c" })).rejects.toMatchObject({ kind: "unauthorized" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses without a credential", async () => {
    const fetch = vi.fn();
    const client = createKiroMemoryClient({ getCredential: () => undefined, fetch: fetch as typeof globalThis.fetch });

    await expect(client.get("x")).rejects.toMatchObject({ name: "KiroMemoryError", kind: "unauthorized" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses when the credential source throws, keeping its error as the cause", async () => {
    const cause = new Error("refresh failed");
    const client = createKiroMemoryClient({
      getCredential: () => Promise.reject(cause),
      fetch: vi.fn() as typeof fetch,
    });

    const error = await client.get("x").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KiroMemoryError);
    expect((error as KiroMemoryError).cause).toBe(cause);
  });
});

describe("Kiro memory client: errors", () => {
  it.each([
    [403, "ForbiddenException", "enableRemoteMemorySync feature is not enabled for this user", "forbidden"],
    [423, "AccountSuspendedException", "suspended", "forbidden"],
    [401, "UnauthorizedException", "Authentication required or profile is invalid.", "unauthorized"],
    [404, "ResourceNotFoundException", "Memory not found", "notFound"],
    [410, "MemoryVersionGoneException", "pruned", "gone"],
    [409, "ConflictException", "deleted", "conflict"],
    [400, "BadRequestException", "Invalid identity provider value", "invalid"],
    [429, "ThrottlingException", "slow down", "throttled"],
    [503, "ServiceUnavailableException", "later", "unavailable"],
    [500, "SomethingNewException", "new", "unavailable"],
  ] as const)("maps %i %s to %s", async (status, name, message, kind) => {
    const fetch = vi.fn(async () => serviceError(status, name, message));
    const client = createKiroMemoryClient({ getCredential: () => IDC, fetch: fetch as typeof globalThis.fetch });

    const error = (await client.get("x").catch((e: unknown) => e)) as KiroMemoryError;

    expect(error).toBeInstanceOf(KiroMemoryError);
    expect(error).toMatchObject({ operation: "GetMemory", kind, status, errorType: name });
    expect(error.message).toBe(`Kiro memory GetMemory failed: ${status} ${name}: ${message}`);
  });

  it("reads the coral validation error shape as invalid", async () => {
    // Captured live: an invalid namespace answers with a coral#ValidationException.
    const fetch = vi.fn(async () =>
      cborResponse(400, { __type: "com.amazon.coral.validate#ValidationException", message: "1 validation error" }),
    );
    const client = createKiroMemoryClient({ getCredential: () => IDC, fetch: fetch as typeof globalThis.fetch });

    await expect(client.get("x")).rejects.toMatchObject({ kind: "invalid", errorType: "ValidationException" });
  });

  it("falls back to the status when the error body is not CBOR", async () => {
    // Captured live: an unknown X-Kiro-Idp value answers 400 with an XML body.
    const fetch = vi.fn(
      async () =>
        new Response("<BadRequestException><Message>Invalid identity provider value</Message></BadRequestException>", {
          status: 400,
        }),
    );
    const client = createKiroMemoryClient({ getCredential: () => IDC, fetch: fetch as typeof globalThis.fetch });

    await expect(client.get("x")).rejects.toMatchObject({ kind: "invalid", status: 400 });
  });

  it("never puts the bearer token or memory content in an error message", async () => {
    const fetch = vi.fn(async () => serviceError(500, "InternalFailure", `echo Bearer ${TOKEN}`));
    const client = createKiroMemoryClient({ getCredential: () => IDC, fetch: fetch as typeof globalThis.fetch });

    const error = (await client.put({ content: "PRIVATE-MEMORY-BODY" }).catch((e: unknown) => e)) as Error;

    expect(error.message).not.toContain(TOKEN);
    expect(error.message).not.toContain("PRIVATE-MEMORY-BODY");
    expect(error.message).toContain("Bearer <redacted>");
  });

  it("reports a network failure as unavailable with the cause kept and no token in the message", async () => {
    const cause = new TypeError("fetch failed");
    const fetch = vi.fn(async () => {
      throw cause;
    });
    const client = createKiroMemoryClient({ getCredential: () => IDC, fetch: fetch as typeof globalThis.fetch });

    const error = (await client.get("x").catch((e: unknown) => e)) as KiroMemoryError;

    expect(error).toMatchObject({ kind: "unavailable", status: undefined });
    expect(error.cause).toBe(cause);
    expect(error.message).not.toContain(TOKEN);
  });

  it("rethrows the caller's abort unchanged", async () => {
    const controller = new AbortController();
    const abort = new DOMException("aborted", "AbortError");
    const fetch = vi.fn(async () => {
      controller.abort();
      throw abort;
    });
    const client = createKiroMemoryClient({ getCredential: () => IDC, fetch: fetch as typeof globalThis.fetch });

    await expect(client.get("x", { signal: controller.signal })).rejects.toBe(abort);
  });

  it("fails a change page holding a change it cannot read", async () => {
    const fetch = vi.fn(async () =>
      cborResponse(200, {
        namespace: "KNOWLEDGE",
        to: "v1",
        changes: [{ type: "MERGE", memoryId: "a", changedAt: 1 }],
      }),
    );
    const client = createKiroMemoryClient({ getCredential: () => IDC, fetch: fetch as typeof globalThis.fetch });

    await expect(client.listChanges()).rejects.toMatchObject({ kind: "unavailable" });
  });

  it("fails a success answer that is not CBOR", async () => {
    const fetch = vi.fn(async () => new Response("<html>login</html>", { status: 200 }));
    const client = createKiroMemoryClient({ getCredential: () => IDC, fetch: fetch as typeof globalThis.fetch });

    await expect(client.get("x")).rejects.toMatchObject({ kind: "unavailable" });
  });
});

describe("Kiro memory client: local validation", () => {
  const client = () => {
    const fetch = vi.fn();
    return {
      fetch,
      client: createKiroMemoryClient({ getCredential: () => IDC, fetch: fetch as typeof globalThis.fetch }),
    };
  };

  it.each([
    ["empty content", { content: "" }, "content is required"],
    ["oversized content", { content: "x".repeat(KIRO_MEMORY_LIMITS.contentMaxLength + 1) }, "content exceeds"],
    ["id with a slash", { content: "c", memoryId: "../etc" }, "memoryId may contain only"],
    ["id with a trailing newline", { content: "c", memoryId: "abc\n" }, "memoryId may contain only"],
    ["unknown memory type", { content: "c", memoryType: "EPISODIC" }, "memoryType must be one of"],
    ["too many scopes", { content: "c", scopes: Array.from({ length: 51 }, () => "s") }, "scopes holds more than"],
    ["non-string metadata", { content: "c", metadata: { k: 1 } }, "metadata values must be strings"],
    ["bad namespace", { content: "c", namespace: "bad ns" }, "namespace may contain only"],
  ])("rejects %s before sending", async (_label, input, detail) => {
    const { fetch, client: memory } = client();

    const error = (await memory.put(input as never).catch((e: unknown) => e)) as KiroMemoryError;

    expect(error).toMatchObject({ kind: "invalid", operation: "PutMemory", status: undefined });
    expect(error.message).toContain(detail);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects an out-of-range page size before sending", async () => {
    const { fetch, client: memory } = client();

    await expect(memory.listChanges({ maxResults: 501 })).rejects.toMatchObject({ kind: "invalid" });
    await expect(memory.listChanges({ maxResults: 0 })).rejects.toMatchObject({ kind: "invalid" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects an invalid memory id on get and delete before sending", async () => {
    const { fetch, client: memory } = client();

    await expect(memory.get("a b")).rejects.toMatchObject({ kind: "invalid", operation: "GetMemory" });
    await expect(memory.delete("")).rejects.toMatchObject({ kind: "invalid", operation: "DeleteMemory" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("Kiro memory endpoint", () => {
  it("defaults to production", () => {
    expect(resolveKiroMemoryEndpoint()).toBe("https://app.kiro.dev");
  });

  it.each([
    "https://beta.app.kiro.dev",
    "https://gamma.app.kiro.dev/",
    "http://localhost:8080",
    "http://127.0.0.1:9000",
  ])("accepts %s", (url) => {
    expect(() => resolveKiroMemoryEndpoint(url)).not.toThrow();
  });

  it.each([
    "http://app.kiro.dev",
    "https://evil.example",
    "https://app.kiro.dev.evil.example",
    "http://localhost.evil.com",
    "not a url",
  ])("refuses %s", (url) => {
    expect(() => resolveKiroMemoryEndpoint(url)).toThrow(KiroMemoryError);
  });

  it("reads the override from KIRO_MEMORY_ENDPOINT and names only scheme and host when refusing it", () => {
    process.env.KIRO_MEMORY_ENDPOINT = "https://user:pass@evil.example/path?sig=secret";

    const error = (() => {
      try {
        resolveKiroMemoryEndpoint();
      } catch (e) {
        return e as Error;
      }
    })();

    expect(error?.message).toContain("https://evil.example");
    expect(error?.message).not.toContain("pass");
    expect(error?.message).not.toContain("secret");
  });

  it("sends requests to the overridden endpoint", async () => {
    const bff = fakeBff();
    const client = createKiroMemoryClient({
      getCredential: () => IDC,
      endpoint: "https://beta.app.kiro.dev",
      fetch: bff.fetch as typeof fetch,
    });

    await client.put({ content: "c" });

    expect(bff.captured[0].url).toBe("https://beta.app.kiro.dev/service/KiroWebBearerService/operation/PutMemory");
  });
});
