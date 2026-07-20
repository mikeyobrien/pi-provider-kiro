import { describe, expect, it } from "vitest";
import { formatSafeError, redactSensitiveText } from "../src/debug.js";

const profileArn = "arn:aws:codewhisperer:us-east-1:123456789012:profile/private-profile";

describe("debug redaction", () => {
  it("removes bearer tokens, serialized secrets, and full profile ARNs from diagnostics", () => {
    const sensitive =
      `Bearer access-token-value ${profileArn} ` +
      '{"accessToken":"json-access","refresh_token":"json-refresh","clientSecret":"json-secret"}';

    const safe = redactSensitiveText(sensitive);

    expect(safe).not.toContain("access-token-value");
    expect(safe).not.toContain(profileArn);
    expect(safe).not.toContain("json-access");
    expect(safe).not.toContain("json-refresh");
    expect(safe).not.toContain("json-secret");
    expect(safe).toContain("<redacted-profile-arn>");
  });

  it("sanitizes caught error messages", () => {
    const safe = formatSafeError(new Error(`request failed for ${profileArn} with access_token=secret-value`));

    expect(safe).not.toContain(profileArn);
    expect(safe).not.toContain("secret-value");
  });
});
