// ABOUTME: Guards the published package surface — entry fields and the pi host
// ABOUTME: packages the bundle imports rather than bundling must stay declared.

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const pkg = JSON.parse(readFileSync(`${repoRoot}package.json`, "utf8")) as {
  main?: string;
  types?: string;
  files?: string[];
  scripts: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  pi?: { extensions?: string[] };
  omp?: { extensions?: string[] };
};

// Read from disk rather than a hardcoded list: a new source file must not be
// able to introduce an undeclared host import without failing this test.
const SRC_FILES = readdirSync(`${repoRoot}src`).filter((f) => f.endsWith(".ts"));

const HOST_SCOPE = "@earendil-works/";

/**
 * `import type` is erased at compile time, so it creates no runtime resolution
 * requirement. Anything else does.
 *
 * Matches every import statement regardless of specifier, then filters to host
 * packages. Anchoring the pattern on the host scope instead would let a single
 * match straddle statements — its clause may swallow a later `import` — so a
 * leading `import type { X } from "./local.js"` would hide the host value
 * import beneath it, and a leading value import would falsely mark a host
 * type-only import as a runtime one.
 */
function runtimeHostImports(source: string): string[] {
  const found = new Set<string>();
  for (const match of source.matchAll(/\bimport\s+(type\s+)?([\s\S]*?)\bfrom\s+"([^"]+)"/g)) {
    const [, typeOnlyKeyword, clause, specifier] = match;
    if (!specifier.startsWith(HOST_SCOPE) || typeOnlyKeyword) continue;
    // `import { type Api, clampThinkingLevel }` still emits a runtime import;
    // `import { type Api, type Model }` does not.
    const bindings = clause.replace(/[{}]/g, "").split(",");
    const hasValueBinding = bindings.some((b) => b.trim().length > 0 && !b.trim().startsWith("type "));
    if (hasValueBinding || !clause.includes("{")) found.add(specifier);
  }
  // Side-effect imports have no clause to inspect and are always runtime.
  for (const [, specifier] of source.matchAll(/\bimport\s+"([^"]+)"/g)) {
    if (specifier.startsWith(HOST_SCOPE)) found.add(specifier);
  }
  return [...found];
}

describe("published package surface", () => {
  // Without these a bare-specifier `import "pi-provider-kiro"` cannot resolve at
  // all: Node falls back to the package root, which is not published.
  it("publishes a resolvable entry point and types", () => {
    expect(pkg.main).toBe("./dist/index.js");
    expect(pkg.types).toBe("./dist/index.d.ts");
    expect(pkg.files).toContain("dist");
    expect(pkg.pi?.extensions).toEqual(["./dist/index.js"]);
  });

  // Oh My Pi runs TypeScript directly and Bun skips `prepare` on git installs,
  // so OMP loads the source entry — which only resolves if `src` is published.
  it("publishes the source entry Oh My Pi loads", () => {
    expect(pkg.omp?.extensions).toEqual(["./src/index.ts"]);
    expect(pkg.files).toContain("src");
  });

  it("emits declarations alongside the bundle", () => {
    expect(pkg.scripts.build).toContain("tsc --emitDeclarationOnly");
  });

  // Bundled CJS dependencies call `require("buffer")` — the @smithy/core
  // event-stream marshaller `stream.ts` uses reaches it through util-utf8. In an
  // ESM bundle esbuild's `__require` shim throws for those unless a real
  // `require` is in scope, and the call sites sit inside lazily-initialised CJS
  // wrappers, so dropping this banner still imports cleanly and only fails when
  // a stream is actually opened. Nothing else catches that: the suite runs from
  // src, never from dist.
  it("gives the bundled CJS graph a real require", () => {
    expect(pkg.scripts.build).toContain("--banner:js=");
    expect(pkg.scripts.build).toMatch(/createRequire[^"]*from\s*'node:module'/);
    expect(pkg.scripts.build).toMatch(/\brequire\s*=\s*\w*[cC]reateRequire\(import\.meta\.url\)/);
  });

  // The bundle keeps pi's packages external, so they must be resolvable in the
  // consumer's tree. Declaring them makes that requirement machine-readable
  // instead of an ERR_MODULE_NOT_FOUND at first import; `optional` keeps npm
  // from installing a second copy beside the host's own.
  it("declares every pi host package the bundle imports at runtime", () => {
    const imported = new Set<string>();
    for (const file of SRC_FILES) {
      for (const specifier of runtimeHostImports(readFileSync(`${repoRoot}src/${file}`, "utf8"))) {
        imported.add(specifier);
      }
    }

    expect(imported.size).toBeGreaterThan(0);
    for (const specifier of imported) {
      expect(pkg.peerDependencies ?? {}, `${specifier} is imported but not declared`).toHaveProperty(specifier);
      expect(pkg.peerDependenciesMeta?.[specifier]?.optional).toBe(true);
    }
  });

  // esbuild only produces dist/index.js; nothing in src/ or the bundle imports
  // it. As a runtime dependency every consumer installed a full esbuild plus its
  // platform binary beside whatever esbuild its own tree already carried.
  it("keeps the bundler out of the runtime dependency set", () => {
    expect(pkg.dependencies ?? {}).not.toHaveProperty("esbuild");
    expect(pkg.devDependencies?.esbuild).toMatch(/^0\.28\.\d+$/);
    expect(pkg.scripts.build).toMatch(/^esbuild /);
  });

  it("keeps pi's packages external so the host's own copy is used", () => {
    for (const specifier of Object.keys(pkg.peerDependencies ?? {})) {
      expect(pkg.scripts.build).toContain(`--external:${specifier}`);
    }
  });
});

describe("runtimeHostImports", () => {
  it("ignores type-only imports", () => {
    expect(runtimeHostImports('import type { Api } from "@earendil-works/pi-ai";')).toEqual([]);
    expect(runtimeHostImports('import { type Api, type Model } from "@earendil-works/pi-ai";')).toEqual([]);
  });

  it("detects value imports, including mixed type/value clauses", () => {
    expect(runtimeHostImports('import { type Api, clampThinkingLevel } from "@earendil-works/pi-ai";')).toEqual([
      "@earendil-works/pi-ai",
    ]);
    expect(runtimeHostImports('import * as PiAi from "@earendil-works/pi-ai";')).toEqual(["@earendil-works/pi-ai"]);
  });

  // The guard exists to fail when a new source file imports an undeclared host
  // package, so a preceding statement must not be able to hide one.
  it("detects a host value import beneath a type-only import of another module", () => {
    const source = ['import type { Foo } from "./foo.js";', 'import { Container } from "@earendil-works/pi-tui";'].join(
      "\n",
    );
    expect(runtimeHostImports(source)).toEqual(["@earendil-works/pi-tui"]);
  });

  it("detects a multi-line host value import beneath other statements", () => {
    const source = [
      'import { readFileSync } from "node:fs";',
      "import {",
      "  type Api,",
      "  clampThinkingLevel,",
      '} from "@earendil-works/pi-ai";',
    ].join("\n");
    expect(runtimeHostImports(source)).toEqual(["@earendil-works/pi-ai"]);
  });

  it("detects bare side-effect host imports", () => {
    expect(runtimeHostImports('import "@earendil-works/pi-tui";\nimport { readFileSync } from "node:fs";')).toEqual([
      "@earendil-works/pi-tui",
    ]);
  });

  it("ignores a host type-only import beneath a value import of another module", () => {
    const source = [
      'import { readFileSync } from "node:fs";',
      'import type { Api } from "@earendil-works/pi-ai";',
    ].join("\n");
    expect(runtimeHostImports(source)).toEqual([]);
  });
});
