// Bundles the UI to web/dist (served by TAPI at /app). Run: npm run build
import { build } from "esbuild";
import { mkdirSync, copyFileSync } from "node:fs";
mkdirSync("dist", { recursive: true });
await build({
  entryPoints: ["src/main.jsx"], bundle: true, minify: true, sourcemap: false,
  outfile: "dist/app.js", jsx: "automatic", target: ["es2020"],
  define: { "process.env.NODE_ENV": '"production"' }, loader: { ".css": "css" },
});
await build({ entryPoints: ["src/styles.css"], bundle: true, minify: true, outfile: "dist/app.css" });
copyFileSync("public/index.html", "dist/index.html");
console.log("built web/dist");
