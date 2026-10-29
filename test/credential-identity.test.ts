import { describe, expect, it } from "vitest";
import { sameCredentialIdentity } from "../src/credential-identity.js";

describe("credential identity binding", () => {
  const original = { access: "a", refresh: "r|idc", authMethod: "idc", profileArn: "profile-a", region: "us-east-1" };
  it("allows token rotation within the selected profile", () => {
    expect(sameCredentialIdentity(original, { ...original, access: "b", refresh: "s|idc" })).toBe(true);
  });
  it("rejects another profile even with the same auth family", () => {
    expect(sameCredentialIdentity(original, { ...original, access: "b", profileArn: "profile-b" })).toBe(false);
  });
  it("does not mistake region or auth method for account identity", () => {
    expect(sameCredentialIdentity({ access: "a", authMethod: "idc" }, { access: "b", authMethod: "idc" })).toBe(false);
  });
  it("allows refresh-token continuity when no profile is available", () => {
    expect(sameCredentialIdentity({ access: "a", refresh: "r|idc" }, { access: "b", refresh: "r|idc" })).toBe(true);
  });
  it("rejects changes of auth family", () => {
    expect(sameCredentialIdentity(original, { ...original, authMethod: "desktop" })).toBe(false);
  });
});
