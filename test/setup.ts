import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

const testHome = mkdtempSync(join(tmpdir(), "pi-provider-kiro-test-"));

// Source modules resolve cache and credential paths from the home directory at
// import time. Keep tests independent from a developer's live Kiro state.
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;
process.env.APPDATA = join(testHome, "AppData", "Roaming");
process.env.PATH = testHome;

// Cross-process pacing state is a file shared by every pacer in the process, so
// one test's rate rejection would otherwise pace every later test in the file.
// Sharing is covered explicitly in pacing.test.ts through an injected store.
process.env.KIRO_PACING_SHARED = "off";

// Each test file gets its own setup context and temporary home.
afterAll(() => {
  rmSync(testHome, { recursive: true, force: true });
});
