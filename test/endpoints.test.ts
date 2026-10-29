import { describe, expect, it } from "vitest";
import { getKiroEndpoints, getKiroRegionFromProfileArn, resolveApiRegion } from "../src/endpoints.js";

describe("Kiro endpoints", () => {
  // Issue #180: AWS region codes are case-insensitive input but lower-case on the wire.
  it.each([
    ["Ap-southeast-1", "https://management.us-east-1.kiro.dev/"],
    [" AP-SOUTHEAST-1 ", "https://management.us-east-1.kiro.dev/"],
    ["Eu-West-1", "https://management.eu-central-1.kiro.dev/"],
    ["US-EAST-1", "https://management.us-east-1.kiro.dev/"],
    ["  ", "https://management.us-east-1.kiro.dev/"],
  ])("routes SSO region %j to %s", (ssoRegion, management) => {
    expect(getKiroEndpoints(resolveApiRegion(ssoRegion)).management).toBe(management);
  });

  it("reads a mis-cased region from a profile ARN", () => {
    expect(getKiroRegionFromProfileArn("arn:aws:codewhisperer:EU-CENTRAL-1:123456789012:profile/EXAMPLE")).toBe(
      "eu-central-1",
    );
  });
});
