import { build } from "esbuild";
import fs from "node:fs";

// 构建脚本：主进程扩展 + webview 渲染器
fs.mkdirSync("out", { recursive: true });
fs.mkdirSync("media", { recursive: true });

await build({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "out/extension.js",
  external: ["vscode"],
  platform: "node",
  format: "cjs",
  target: "node16",
});

await build({
  entryPoints: ["src/webview/main.ts"],
  bundle: true,
  outfile: "media/main.js",
  format: "iife",
  target: "es2020",
});

console.log("build done");
