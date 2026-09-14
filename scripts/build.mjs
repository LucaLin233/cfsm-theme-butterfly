import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
// 逐文件递归复制：不依赖 `fs.cp`（部分环境/沙箱下不可用）。
async function copyDir(source, target) {
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = resolve(source, entry.name);
    const to = resolve(target, entry.name);
    if (entry.isDirectory()) await copyDir(from, to);
    else await writeFile(to, await readFile(from));
  }
}
await copyDir(sourceDir, outputDir);

// dist/ 下所有带版本查询串的资源都由这里注入：CFSM 对主题静态资源下发
// `Cache-Control: public, max-age=31536000, immutable`，URL 固定为 /assets/app.js
// 时，新提交与回滚都会被浏览器缓存顶回去（看上去"没生效"）。改动 src 后请递增
// package.json 的 version，否则查询串不变、缓存依旧命中。
const assetDir = resolve(outputDir, "assets");
const assetFiles = (await readdir(assetDir)).filter(name => name.endsWith(".js")).map(name => `assets/${name}`);
const tokenFiles = ["index.html", ...assetFiles];
let injected = 0;
for (const relative of tokenFiles) {
  const filePath = resolve(outputDir, relative);
  const source = await readFile(filePath, "utf8");
  // 模块间相对导入同样带版本号；不含 token 的文件跳过（模板/数据文件）。
  if (!source.includes("__THEME_VERSION__")) continue;
  await writeFile(filePath, source.replaceAll("__THEME_VERSION__", version), "utf8");
  injected += 1;
}
// 入口必须是注入过的：漏掉会静默退回无版本 URL，缓存表现为"改动没生效"。
for (const required of ["index.html", "assets/app.js"]) {
  const content = await readFile(resolve(outputDir, required), "utf8");
  if (content.includes("__THEME_VERSION__")) throw new Error(`${required} still contains the __THEME_VERSION__ build token`);
}
if (injected < 2) throw new Error("build token was not injected into the expected files");

console.log(`Built CFSM Butterfly ${version} into dist/`);
