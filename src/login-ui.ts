// Feature 10b: Custom TUI login component
//
// Replaces multiple onPrompt calls with a single ctx.ui.custom() overlay
// to work around pi's stacked-input bug (mirrored cursors on sequential prompts).
//
// Phase 1: SelectList — pick login method (Builder ID / IdC / Google / GitHub)
// Phase 2: Input — enter IAM Identity Center start URL (only for option 2)

import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { DynamicBorder, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Input, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";

export type LoginChoice =
  | { method: "cached" }
  | { method: "personal" }
  | { method: "builder-id" }
  | { method: "google" }
  | { method: "github" }
  | { method: "idc"; startUrl: string; region?: string }
  | { method: "apikey"; apiKey: string }
  | null; // cancelled

let _ctx: ExtensionContext | undefined;

export function setExtensionContext(ctx: ExtensionContext) {
  _ctx = ctx;
}

export function hasExtensionContext(): boolean {
  return _ctx !== undefined;
}

/**
 * Show the login method selection UI using pi's native TUI components.
 * Returns the user's choice or null if cancelled.
 */
export async function showLoginUI(hasCached?: boolean): Promise<LoginChoice> {
  if (!_ctx) return null;
  const ctx = _ctx;

  return ctx.ui.custom<LoginChoice>((tui, theme, _kb, done) => {
    const mainItems: SelectItem[] = [];
    if (hasCached) {
      mainItems.push({ value: "cached", label: "Use existing credentials", description: "Use cached/IDE credentials" });
    }
    mainItems.push(
      { value: "apikey", label: "API Key", description: "Use a KIRO_API_KEY (ksk_...)" },
      { value: "personal", label: "Web Login", description: "Sign in via browser (Google, GitHub, Builder ID)" },
      { value: "idc", label: "Device Code", description: "IAM Identity Center" },
    );

    let phase: "select" | "url" | "region" | "apikey" = "select";
    let enteredStartUrl = "";
    let enteredApiKey = "";

    const container = new Container();
    const border = new DynamicBorder((s: string) => theme.fg("accent", s));
    const title = new Text(theme.fg("accent", theme.bold("Kiro Login")), 1, 0);
    const hint = new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel"), 1, 0);
    const borderBottom = new DynamicBorder((s: string) => theme.fg("accent", s));

    // Phase 1: SelectList
    const selectList = new SelectList(mainItems, mainItems.length, {
      selectedPrefix: (t: string) => theme.fg("accent", t),
      selectedText: (t: string) => theme.fg("accent", t),
      description: (t: string) => theme.fg("muted", t),
      scrollInfo: (t: string) => theme.fg("dim", t),
      noMatch: (t: string) => theme.fg("warning", t),
    });

    selectList.onSelect = (item) => {
      if (item.value === "idc") {
        switchToUrlInput();
      } else if (item.value === "apikey") {
        switchToApiKeyInput();
      } else if (item.value === "personal") {
        done({ method: "personal" });
      } else {
        done({ method: "cached" });
      }
    };
    selectList.onCancel = () => done(null);

    // Phase 2: URL Input
    const urlLabel = new Text("Start URL (e.g. https://mycompany.awsapps.com/start)", 1, 0);
    const urlInput = new Input();
    const urlHint = new Text(theme.fg("dim", "enter submit • esc back"), 1, 0);

    urlInput.onSubmit = (value) => {
      const trimmed = value.trim();
      if (trimmed?.startsWith("http")) {
        enteredStartUrl = trimmed;
        switchToRegionInput();
      }
    };
    urlInput.onEscape = () => {
      switchToSelect();
    };

    // Phase 3: Region Input
    const regionLabel = new Text("SSO Region (e.g. us-east-1, or blank to auto-detect)", 1, 0);
    const regionInput = new Input();
    const regionHint = new Text(theme.fg("dim", "enter submit • esc back"), 1, 0);

    regionInput.onSubmit = (value) => {
      const region = value.trim();
      done({ method: "idc", startUrl: enteredStartUrl, region: region || undefined });
    };
    regionInput.onEscape = () => {
      switchToUrlInput();
    };

    // Phase 3b: API Key Input
    const apiKeyLabel = new Text("Enter your Kiro API key (from app.kiro.dev → API Keys)", 1, 0);
    const apiKeyInput = new Input();
    const apiKeyHint = new Text(theme.fg("dim", "enter submit • esc back"), 1, 0);
    const apiKeyFormatHint = new Text(theme.fg("muted", "Format: ksk_..."), 1, 0);

    apiKeyInput.onSubmit = (value) => {
      const trimmed = value.trim();
      if (trimmed?.startsWith("ksk_")) {
        enteredApiKey = trimmed;
        done({ method: "apikey", apiKey: enteredApiKey });
      }
    };
    apiKeyInput.onEscape = () => {
      switchToSelect();
    };

    function switchToApiKeyInput() {
      phase = "apikey";
      container.clear();
      container.addChild(border);
      container.addChild(new Text(theme.fg("accent", theme.bold("API Key Authentication")), 1, 0));
      container.addChild(apiKeyLabel);
      container.addChild(apiKeyFormatHint);
      container.addChild(apiKeyInput);
      container.addChild(apiKeyHint);
      container.addChild(borderBottom);
      tui.requestRender();
    }

    function switchToUrlInput() {
      phase = "url";
      urlInput.setValue("");
      regionInput.setValue("");
      container.clear();
      container.addChild(border);
      container.addChild(new Text(theme.fg("accent", theme.bold("IAM Identity Center")), 1, 0));
      container.addChild(urlLabel);
      container.addChild(urlInput);
      container.addChild(urlHint);
      container.addChild(borderBottom);
      tui.requestRender();
    }

    function switchToRegionInput() {
      phase = "region";
      container.clear();
      container.addChild(border);
      container.addChild(new Text(theme.fg("accent", theme.bold("IAM Identity Center Region")), 1, 0));
      container.addChild(regionLabel);
      container.addChild(regionInput);
      container.addChild(regionHint);
      container.addChild(borderBottom);
      tui.requestRender();
    }

    function switchToSelect() {
      phase = "select";
      urlInput.setValue("");
      regionInput.setValue("");
      apiKeyInput.setValue("");
      container.clear();
      container.addChild(border);
      container.addChild(title);
      container.addChild(selectList);
      container.addChild(hint);
      container.addChild(borderBottom);
      tui.requestRender();
    }

    // Initial state
    switchToSelect();

    return {
      render(width: number) {
        return container.render(width);
      },
      invalidate() {
        container.invalidate();
      },
      handleInput(data: string) {
        if (phase === "select") {
          selectList.handleInput(data);
        } else if (phase === "url") {
          urlInput.handleInput(data);
        } else if (phase === "region") {
          regionInput.handleInput(data);
        } else if (phase === "apikey") {
          apiKeyInput.handleInput(data);
        }
        tui.requestRender();
      },
    };
  });
}

/**
 * Show a waiting UI wrapper with an Escape return loop logic.
 * The user can press Escape or 'q' to abort the current login flow immediately.
 */
export async function showWaitingUI(
  outerCallbacks: OAuthLoginCallbacks,
  _choice: Exclude<LoginChoice, null>,
  runAuth: (mergedCallbacks: OAuthLoginCallbacks) => Promise<OAuthCredentials>,
): Promise<OAuthCredentials | null> {
  if (!_ctx) {
    return runAuth(outerCallbacks);
  }
  const ctx = _ctx;

  return ctx.ui.custom<OAuthCredentials | null>((tui, theme, _kb, done) => {
    const container = new Container();
    const border = new DynamicBorder((s: string) => theme.fg("accent", s));
    const title = new Text(theme.fg("accent", theme.bold("Kiro Login - Authorization")), 1, 0);
    const borderBottom = new DynamicBorder((s: string) => theme.fg("accent", s));

    const statusText = new Text("Initiating login flow...", 1, 0);
    const urlText = new Text("", 1, 0);
    const instructionsText = new Text("", 1, 0);
    const hint = new Text(theme.fg("dim", "esc cancel / back"), 1, 0);

    container.addChild(border);
    container.addChild(title);
    container.addChild(statusText);
    container.addChild(urlText);
    container.addChild(instructionsText);
    container.addChild(hint);
    container.addChild(borderBottom);

    const abortCtrl = new AbortController();
    let onAuthCalled = false;

    const mergedCallbacks: OAuthLoginCallbacks = {
      ...outerCallbacks,
      onProgress: (msg: string) => {
        outerCallbacks.onProgress?.(msg);
        statusText.setText(msg);
        tui.requestRender();
      },
      onAuth: (info: { url: string; instructions?: string }) => {
        if (!onAuthCalled) {
          onAuthCalled = true;
          outerCallbacks.onAuth?.(info);
        }
        urlText.setText(`URL: ${info.url}`);
        instructionsText.setText(info.instructions || "");
        tui.requestRender();
      },
      signal: abortCtrl.signal,
    };

    runAuth(mergedCallbacks).then(
      (creds) => {
        done(creds);
      },
      (err) => {
        if (abortCtrl.signal.aborted) {
          done(null);
        } else {
          statusText.setText(theme.fg("warning", `Error: ${err.message || err}`));
          tui.requestRender();
          setTimeout(() => done(null), 3000);
        }
      },
    );

    return {
      render(width: number) {
        return container.render(width);
      },
      invalidate() {
        container.invalidate();
      },
      handleInput(data: string) {
        // Escape key (standalone 0x1B) or 'q' to cancel
        if ((data.length === 1 && data.charCodeAt(0) === 0x1b) || data === "q") {
          abortCtrl.abort();
          done(null);
        }
      },
    };
  });
}
