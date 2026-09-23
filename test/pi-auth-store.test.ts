import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getPiHostKiroCredentials } from "../src/pi-auth-store.js";

describe("getPiHostKiroCredentials", () => {
  let agentDir: string;

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), "kiro-pi-auth-"));
  });

  afterEach(() => {
    rmSync(agentDir, { recursive: true, force: true });
  });

  function writeAuth(auth: unknown): void {
    writeFileSync(join(agentDir, "auth.json"), JSON.stringify(auth));
  }

  it("returns undefined when the auth file is absent", () => {
    expect(getPiHostKiroCredentials(agentDir)).toBeUndefined();
  });

  it("returns undefined when there is no kiro entry", () => {
    writeAuth({ openai: { access: "x" } });
    expect(getPiHostKiroCredentials(agentDir)).toBeUndefined();
  });

  it("reads a valid, non-expired kiro credential", () => {
    const expires = Date.now() + 60 * 60 * 1000;
    writeAuth({
      kiro: { access: "tok", refresh: "r", expires, region: "us-east-1", profileArn: "arn", authMethod: "desktop" },
    });
    expect(getPiHostKiroCredentials(agentDir)).toMatchObject({
      access: "tok",
      region: "us-east-1",
      profileArn: "arn",
    });
  });

  it("returns undefined when the access token is expired", () => {
    writeAuth({ kiro: { access: "tok", refresh: "r", expires: Date.now() - 1000, region: "us-east-1" } });
    expect(getPiHostKiroCredentials(agentDir)).toBeUndefined();
  });

  it("accepts a credential with no expiry field", () => {
    writeAuth({ kiro: { access: "tok", region: "us-east-1", profileArn: "arn" } });
    expect(getPiHostKiroCredentials(agentDir)?.access).toBe("tok");
  });

  it("returns undefined when access is missing", () => {
    writeAuth({ kiro: { refresh: "r", region: "us-east-1" } });
    expect(getPiHostKiroCredentials(agentDir)).toBeUndefined();
  });

  it("fails closed on unparseable auth json", () => {
    writeFileSync(join(agentDir, "auth.json"), "{ not json");
    expect(getPiHostKiroCredentials(agentDir)).toBeUndefined();
  });
});
