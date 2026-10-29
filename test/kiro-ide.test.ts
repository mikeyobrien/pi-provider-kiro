import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getKiroIdeCredentials } from "../src/kiro-ide.js";

// test/setup.ts points HOME at a per-file temporary directory.
const cacheDir = join(homedir(), ".aws", "sso", "cache");

afterEach(() => {
  rmSync(cacheDir, { recursive: true, force: true });
});

describe("getKiroIdeCredentials", () => {
  // Issue #180: the region lands in Kiro and OIDC hostnames.
  it("lower-cases and trims a mis-cased token region", () => {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      join(cacheDir, "kiro-auth-token.json"),
      JSON.stringify({
        accessToken: "ide-access",
        refreshToken: "ide-refresh",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        region: "Eu-West-1 ",
      }),
    );

    expect(getKiroIdeCredentials()?.region).toBe("eu-west-1");
  });
});
