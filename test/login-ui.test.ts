import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { setExtensionContext, showLoginUI } from "../src/login-ui.js";

describe("showLoginUI", () => {
  it("requests overlay mode so pi does not restore the editor over the login dialog", async () => {
    // Issue #90: non-overlay custom() calls restoreEditor() on close, which clears
    // the container owning pi's login dialog and blanks the OAuth progress output.
    const custom = vi.fn((_factory: unknown, _options?: unknown) => Promise.resolve(null));
    setExtensionContext({ ui: { custom } } as unknown as ExtensionContext);

    await showLoginUI();

    expect(custom).toHaveBeenCalledTimes(1);
    expect(custom.mock.calls[0]?.[1]).toEqual({ overlay: true });
  });

  // Issue #180: the typed region ends up in every Kiro and OIDC hostname and in
  // the SSO-to-API region lookup, so `Ap-southeast-1` must mean `ap-southeast-1`.
  it.each([
    ["  Ap-southeast-1 ", "ap-southeast-1"],
    ["EU-WEST-1", "eu-west-1"],
    ["   ", undefined],
  ])("returns the typed IAM Identity Center region %j as %j", async (typed, expected) => {
    const paste = (text: string) => `\x1b[200~${text}\x1b[201~`;
    const custom = vi.fn(
      (factory: unknown) =>
        new Promise((resolve) => {
          const tui = { requestRender: vi.fn() };
          const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
          const ui = (factory as (...args: unknown[]) => { handleInput(data: string): void })(tui, theme, {}, resolve);
          ui.handleInput("\x1b[B"); // API Key -> Web Login
          ui.handleInput("\x1b[B"); // Web Login -> Device Code (IAM Identity Center)
          ui.handleInput("\r");
          ui.handleInput(paste("https://example-tenant.awsapps.com/start"));
          ui.handleInput("\r");
          ui.handleInput(paste(typed));
          ui.handleInput("\r");
        }),
    );
    setExtensionContext({ ui: { custom } } as unknown as ExtensionContext);

    const choice = await showLoginUI();

    expect(choice).toEqual({ method: "idc", startUrl: "https://example-tenant.awsapps.com/start", region: expected });
  });
});
