import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const sourceDir = resolve(root, "src");
const outputDir = resolve(root, "dist");
const packagePath = resolve(root, "package.json");

const pkg = JSON.parse(await readFile(packagePath, "utf8"));
const version = pkg.version;
if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error("package.json: version must be a semantic version");
}

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });
await cp(sourceDir, outputDir, { recursive: true });

// dist/ 下所有带版本查询串的资源都由这里注入：CFSM 对主题静态资源下发
// `Cache-Control: public, max-age=31536000, immutable`，URL 固定为 /assets/app.js
// 时，新提交与回滚都会被浏览器缓存顶回去（看上去"没生效"）。改动 src 后请递增
// package.json 的 version，否则查询串不变、缓存依旧命中。
const tokenFiles = ["index.html", "assets/app.js"];
for (const relative of tokenFiles) {
  const filePath = resolve(outputDir, relative);
  const source = await readFile(filePath, "utf8");
  if (!source.includes("__THEME_VERSION__")) {
    throw new Error(`${relative} does not contain the __THEME_VERSION__ build token`);
  }
  await writeFile(filePath, source.replaceAll("__THEME_VERSION__", version), "utf8");
}

console.log(`Built CFSM Butterfly ${version} into dist/`);
