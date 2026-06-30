// ---------------------------------------------------------------------------
// 版本号工具 — 运行时从 package.json 读取 dskcode 的真实版本
//
// 之前两处都写死了版本字符串（cli/index.tsx 的 .version()、ChatSession 的
// /version 斜杠命令），每次发版都得手改两处代码，容易漏。统一从 package.json
// 读，build 时 esbuild 会把 JSON 内容打进 dist/index.js，运行时无需再 IO。
// ---------------------------------------------------------------------------

import packageJson from "../../package.json" with { type: "json" };

/** dskcode 版本号（取自 package.json） */
export const VERSION: string = packageJson.version;
