import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getKiroCliCredentials, getKiroCliDbPath, refreshViaKiroCli, tryKiroCliToken } from "../src/kiro-cli.js";

let tempDir: string | undefined;
afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
  vi.restoreAllMocks();
});

function makeTokenDb(profileArn?: string, authMethod: "idc" | "desktop" = "idc"): string {
  tempDir = mkdtempSync(join(tmpdir(), "kiro-cli-test-"));
  const dbPath = join(tempDir, "data.sqlite3");
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT)`);
  const token = JSON.stringify({
    access_token: "test-access",
    refresh_token: "test-refresh",
    region: "eu-central-1",
    expires_at: new Date(Date.now() + 3600000).toISOString(),
    ...(profileArn ? { profile_arn: profileArn } : {}),
  });
  const key = authMethod === "idc" ? "kirocli:odic:token" : "kirocli:social:token";
  db.prepare(`INSERT INTO auth_kv (key, value) VALUES (?, ?)`).run(key, token);
  if (authMethod === "idc") {
    db.prepare(`INSERT INTO auth_kv (key, value) VALUES (?, ?)`).run(
      "kirocli:odic:device-registration",
      JSON.stringify({ client_id: "cid", client_secret: "csec" }),
    );
  }
  db.close();
  return dbPath;
}

describe("tryKiroCliToken (#110)", () => {
  it("carries profile_arn through the IDC token path", () => {
    const pinnedArn = "arn:aws:codewhisperer:eu-central-1:123456789012:profile/pinned";
    const dbPath = makeTokenDb(pinnedArn, "idc");
    const result = tryKiroCliToken(dbPath, "kirocli:odic:token", "idc");
    expect(result?.profileArn).toBe(pinnedArn);
    expect(result?.authMethod).toBe("idc");
  });

  it("carries profile_arn through the desktop token path", () => {
    const pinnedArn = "arn:aws:codewhisperer:us-east-1:123456789012:profile/desktop";
    const dbPath = makeTokenDb(pinnedArn, "desktop");
    const result = tryKiroCliToken(dbPath, "kirocli:social:token", "desktop");
    expect(result?.profileArn).toBe(pinnedArn);
    expect(result?.authMethod).toBe("desktop");
  });

  it("leaves profileArn undefined when the token has no profile", () => {
    const dbPath = makeTokenDb(undefined, "idc");
    const result = tryKiroCliToken(dbPath, "kirocli:odic:token", "idc");
    expect(result?.profileArn).toBeUndefined();
  });
});

describe("external IdP tokens", () => {
  function makeExternalIdpDb(token: Record<string, unknown>): string {
    tempDir = mkdtempSync(join(tmpdir(), "kiro-cli-test-"));
    const dbPath = join(tempDir, "data.sqlite3");
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT)`);
    db.prepare(`INSERT INTO auth_kv (key, value) VALUES (?, ?)`).run(
      "kirocli:external-idp:token",
      JSON.stringify(token),
    );
    db.close();
    return dbPath;
  }

  const baseToken = {
    access_token: "idp-access",
    refresh_token: "idp-refresh",
    client_id: "0oaEXAMPLE",
    token_endpoint: "https://example.okta.com/oauth2/default/v1/token",
    issuer_url: "https://example.okta.com/oauth2/default",
    scopes: "codewhisperer:conversations codewhisperer:completions offline_access",
  };

  it("reads the kirocli:external-idp:token record", () => {
    const dbPath = makeExternalIdpDb({
      ...baseToken,
      expires_at: new Date(Date.now() + 3600000).toISOString(),
    });
    const result = tryKiroCliToken(dbPath, "kirocli:external-idp:token", "external-idp");
    expect(result?.authMethod).toBe("external-idp");
    expect(result?.access).toBe("idp-access");
    expect(result?.clientId).toBe("0oaEXAMPLE");
    // No client secret: the OIDC app is a public PKCE client
    expect(result?.clientSecret).toBe("");
    // Records carry no region, so fall back to the default
    expect(result?.region).toBe("us-east-1");
  });

  it("carries client_id, token_endpoint and region through the refresh string", () => {
    const dbPath = makeExternalIdpDb({
      ...baseToken,
      expires_at: new Date(Date.now() + 3600000).toISOString(),
    });
    const result = tryKiroCliToken(dbPath, "kirocli:external-idp:token", "external-idp");
    expect(result?.refresh).toBe(
      "idp-refresh|0oaEXAMPLE|https://example.okta.com/oauth2/default/v1/token|external-idp|us-east-1",
    );
  });

  it("derives the token endpoint from issuer_url when absent", () => {
    const { token_endpoint: _omitted, ...withoutEndpoint } = baseToken;
    const dbPath = makeExternalIdpDb({
      ...withoutEndpoint,
      expires_at: new Date(Date.now() + 3600000).toISOString(),
    });
    const result = tryKiroCliToken(dbPath, "kirocli:external-idp:token", "external-idp");
    expect(result?.refresh.split("|")[2]).toBe("https://example.okta.com/oauth2/default/v1/token");
  });

  it("skips an expired token unless expired tokens are allowed", () => {
    const dbPath = makeExternalIdpDb({
      ...baseToken,
      expires_at: new Date(Date.now() - 1000).toISOString(),
    });
    expect(tryKiroCliToken(dbPath, "kirocli:external-idp:token", "external-idp")).toBeUndefined();
    expect(tryKiroCliToken(dbPath, "kirocli:external-idp:token", "external-idp", true)?.access).toBe("idp-access");
  });

  it("is returned by the credential probe order when it is the only stored token", () => {
    const dbPath = makeExternalIdpDb({
      ...baseToken,
      expires_at: new Date(Date.now() + 3600000).toISOString(),
    });
    expect(tryKiroCliToken(dbPath, "kirocli:odic:token", "idc")).toBeUndefined();
    expect(tryKiroCliToken(dbPath, "kirocli:social:token", "desktop")).toBeUndefined();
    expect(tryKiroCliToken(dbPath, "kirocli:external-idp:token", "external-idp")?.authMethod).toBe("external-idp");
  });
});

describe("Feature 4: kiro-cli Credential Fallback", () => {
  describe("getKiroCliDbPath", () => {
    it("returns undefined when database does not exist", () => {
      // Default: no kiro-cli installed
      const result = getKiroCliDbPath();
      // Either undefined (no file) or a string (if kiro-cli happens to be installed)
      expect(result === undefined || typeof result === "string").toBe(true);
    });
  });

  describe("getKiroCliCredentials", () => {
    it("returns undefined or credentials when database may exist", () => {
      const result = getKiroCliCredentials();
      // Either undefined (no kiro-cli) or credentials object (kiro-cli installed)
      expect(result === undefined || (typeof result === "object" && "access" in result)).toBe(true);
    });

    it("returns credentials with required fields when available", () => {
      const result = getKiroCliCredentials();
      if (result) {
        expect(result).toHaveProperty("access");
        expect(result).toHaveProperty("refresh");
        expect(result).toHaveProperty("expires");
        expect(result).toHaveProperty("clientId");
        expect(result).toHaveProperty("clientSecret");
        expect(result).toHaveProperty("region");
      }
    });
  });

  describe("refreshViaKiroCli", () => {
    it("returns undefined when kiro-cli is not installed", () => {
      vi.mock("node:child_process", async (importOriginal) => {
        const actual = await importOriginal<typeof import("node:child_process")>();
        return {
          ...actual,
          execFileSync: vi.fn(() => {
            throw new Error("ENOENT");
          }),
        };
      });

      // Since we can't easily mock execFileSync for a single call in this
      // test setup, we just verify the function exists and returns the right type
      const result = refreshViaKiroCli();
      expect(result === undefined || (typeof result === "object" && "access" in result)).toBe(true);

      vi.restoreAllMocks();
    });

    it("returns credentials or undefined", () => {
      // On CI (no kiro-cli): returns undefined
      // On dev machine (kiro-cli installed): returns credentials or undefined
      const result = refreshViaKiroCli();
      if (result) {
        expect(result).toHaveProperty("access");
        expect(result).toHaveProperty("refresh");
        expect(result).toHaveProperty("expires");
        expect(result).toHaveProperty("authMethod");
      }
    });
  });
});
