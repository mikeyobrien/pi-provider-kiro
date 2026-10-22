import { build } from "esbuild";

await build({
  entryPoints: ["gateway/src/main.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: "gateway/dist/main.js",
  banner: {
    js: "import{createRequire as __gwCreateRequire}from'node:module';const require=__gwCreateRequire(import.meta.url);",
  },
  external: ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"],
});
console.log("gateway built -> gateway/dist/main.js");
