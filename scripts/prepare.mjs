import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const executableSuffix = process.platform === "win32" ? ".cmd" : "";
const esbuildPath = join("node_modules", ".bin", `esbuild${executableSuffix}`);
const tscPath = join("node_modules", ".bin", `tsc${executableSuffix}`);
const bundledExtensionPath = join("dist", "index.js");

if (existsSync(esbuildPath) && existsSync(tscPath)) {
	const result = spawnSync("npm", ["run", "build"], { stdio: "inherit", shell: process.platform === "win32" });
	process.exit(result.status ?? 1);
}

if (existsSync(bundledExtensionPath)) {
	console.log("Using the prebuilt extension bundle for a production-only install.");
	process.exit(0);
}

console.error("Missing dist/index.js and local build tools; install development dependencies before preparing the package.");
process.exit(1);
