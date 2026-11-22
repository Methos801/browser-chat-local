// Bundle the React UI with esbuild into a single self-contained bundle.js.
// The Electron main process loads this via file:// — no server needed.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(root, "src", "ui", "main.tsx");
const outfile = join(root, "src", "ui", "bundle.js");

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  format: "esm",
  jsx: "automatic",
  target: "es2021",
  sourcemap: true,
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "info",
});

console.log(`UI bundled -> ${outfile.replace(root, "")}`);
