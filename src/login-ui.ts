// Feature 10b: Custom TUI login component
//
// Replaces multiple onPrompt calls with a single ctx.ui.custom() overlay
// to work around pi's stacked-input bug (mirrored cursors on sequential prompts).
//
// Phase 1: SelectList — pick login method (Builder ID / IdC / Google / GitHub)
// Phase 2: Input — enter IAM Identity Center start URL (only for option 2)

import { DynamicBorder, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Container, Input, type SelectItem, SelectList, Text } from "@mariozechner/pi-tui";

export type LoginChoice =
  | { method: "builder-id" }
  | { method: "idc"; startUrl: string }
  | { method: "google" }
  | { method: "github" }
  | null; // cancelled

let _ctx: ExtensionContext | undefined;

export function setExtensionContext(ctx: ExtensionContext) {
  _ctx = ctx;
}

/**
 * Show the login method selection UI using pi's native TUI components.
 * Returns the user's choice or null if cancelled.
 */
export async function showLoginUI(): Promise<LoginChoice> {
  if (!_ctx) return null;
  const ctx = _ctx;

  return ctx.ui.custom<LoginChoice>((tui, theme, _kb, done) => {
    const items: SelectItem[] = [
      { value: "builder-id", label: "Builder ID", description: "AWS Builder ID (default)" },
      { value: "idc", label: "Your organization", description: "IAM Identity Center (SSO)" },
      { value: "google", label: "Google", description: "Social login via kiro-cli" },
      { value: "github", label: "GitHub", description: "Social login via kiro-cli" },
    ];

    let phase: "select" | "url" = "select";
    const container = new Container();
    const border = new DynamicBorder((s: string) => theme.fg("accent", s));
    const title = new Text(theme.fg("accent", theme.bold("Kiro Login")), 1, 0);
    const hint = new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel"), 1, 0);
    const borderBottom = new DynamicBorder((s: string) => theme.fg("accent", s));

    // Phase 1: SelectList
    const selectList = new SelectList(items, items.length, {
      selectedPrefix: (t: string) => theme.fg("accent", t),
      selectedText: (t: string) => theme.fg("accent", t),
      description: (t: string) => theme.fg("muted", t),
      scrollInfo: (t: string) => theme.fg("dim", t),
      noMatch: (t: string) => theme.fg("warning", t),
    });

    selectList.onSelect = (item) => {
      if (item.value === "idc") {
        switchToUrlInput();
      } else {
        done({ method: item.value as "builder-id" | "google" | "github" });
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
        done({ method: "idc", startUrl: trimmed });
      }
    };
    urlInput.onEscape = () => {
      switchToSelect();
    };

    function switchToUrlInput() {
      phase = "url";
      container.clear();
      container.addChild(border);
      container.addChild(new Text(theme.fg("accent", theme.bold("IAM Identity Center")), 1, 0));
      container.addChild(urlLabel);
      container.addChild(urlInput);
      container.addChild(urlHint);
      container.addChild(borderBottom);
      tui.requestRender();
    }

    function switchToSelect() {
      phase = "select";
      urlInput.setValue("");
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
        } else {
          urlInput.handleInput(data);
        }
        tui.requestRender();
      },
    };
  });
}
