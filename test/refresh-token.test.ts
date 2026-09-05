import { describe, expect, it } from "vitest";
import type { KiroCredentials } from "../src/oauth.js";
import { encodeKiroRefresh, kiroCredentialRegion, parseKiroRefresh } from "../src/refresh-token.js";

describe("parseKiroRefresh", () => {
  it("reads the IDC layout written before regions were encoded", () => {
    expect(parseKiroRefresh("rt|cid|csec|idc")).toEqual({
      token: "rt",
      fields: ["cid", "csec"],
      authMethod: "idc",
      region: undefined,
    });
  });

  it("reads the region appended after the IDC marker", () => {
    expect(parseKiroRefresh("rt|cid|csec|idc|eu-west-1")).toEqual({
      token: "rt",
      fields: ["cid", "csec"],
      authMethod: "idc",
      region: "eu-west-1",
    });
  });

  it("locates the marker by scanning, so a region cannot be read as the auth method", () => {
    // The parser this replaced took the last segment, which classifies a
    // region-carrying desktop credential as IDC and refreshes it at the wrong
    // endpoint with the wrong grant.
    expect(parseKiroRefresh("rt|desktop|eu-west-1")).toEqual({
      token: "rt",
      fields: [],
      authMethod: "desktop",
      region: "eu-west-1",
    });
  });

  it("keeps the external IdP token endpoint out of the region slot", () => {
    expect(parseKiroRefresh("rt|0oaEXAMPLE|https://example.okta.com/v1/token|external-idp|us-east-1")).toEqual({
      token: "rt",
      fields: ["0oaEXAMPLE", "https://example.okta.com/v1/token"],
      authMethod: "external-idp",
      region: "us-east-1",
    });
  });

  it("reads an API key string", () => {
    expect(parseKiroRefresh("ksk_abc|apikey")).toEqual({
      token: "ksk_abc",
      fields: [],
      authMethod: "apikey",
      region: undefined,
    });
  });

  it("falls back to IDC when no marker is present", () => {
    expect(parseKiroRefresh("rt|cid|csec")).toEqual({
      token: "rt",
      fields: ["cid", "csec"],
      authMethod: "idc",
      region: undefined,
    });
  });

  it("treats an empty region segment as absent", () => {
    expect(parseKiroRefresh("rt|cid|csec|idc|").region).toBeUndefined();
  });

  it("returns an empty token for an empty string rather than throwing", () => {
    expect(parseKiroRefresh("")).toEqual({ token: "", fields: [], authMethod: "idc", region: undefined });
  });
});

describe("encodeKiroRefresh", () => {
  it("omits the region segment when the region is unknown", () => {
    expect(encodeKiroRefresh({ token: "rt", fields: ["cid", "csec"], authMethod: "idc" })).toBe("rt|cid|csec|idc");
  });

  it("appends the region after the auth method marker", () => {
    expect(encodeKiroRefresh({ token: "rt", fields: [], authMethod: "desktop", region: "eu-west-1" })).toBe(
      "rt|desktop|eu-west-1",
    );
  });

  it("round-trips every layout", () => {
    for (const refresh of [
      "rt|cid|csec|idc",
      "rt|cid|csec|idc|eu-west-1",
      "rt|desktop",
      "rt|desktop|eu-central-1",
      "rt|0oaEXAMPLE|https://example.okta.com/v1/token|external-idp|us-east-1",
      "ksk_abc|apikey",
    ]) {
      expect(encodeKiroRefresh(parseKiroRefresh(refresh))).toBe(refresh);
    }
  });
});

describe("kiroCredentialRegion", () => {
  const persisted = { refresh: "rt|cid|csec|idc|eu-west-1", access: "at", expires: 0 };

  it("recovers the region from a credential stripped down to the persisted fields", () => {
    expect(kiroCredentialRegion(persisted)).toBe("eu-west-1");
  });

  it("prefers the live region field over the encoded one", () => {
    expect(kiroCredentialRegion({ ...persisted, region: "eu-central-1" } as KiroCredentials)).toBe("eu-central-1");
  });

  it("returns undefined when neither source knows the region", () => {
    expect(kiroCredentialRegion({ refresh: "rt|cid|csec|idc", access: "at", expires: 0 })).toBeUndefined();
    expect(kiroCredentialRegion(undefined)).toBeUndefined();
  });
});
