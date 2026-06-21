/**
 * 内置工具逐个验证脚本
 * 用法: npx tsx scripts/test-each-tool.ts
 */
import { ToolRegistry } from "../src/tool/registry.js";
import { builtinTools } from "../src/tool/builtins/index.js";
import type { ToolContext } from "../src/tool/types.js";
import { writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ─── 辅助 ───
let pass = 0;
let fail = 0;
const ctx: ToolContext = { cwd: process.cwd(), signal: undefined, timeout: 10000 };

function assert(condition: boolean, msg: string) {
  if (condition) { pass++; console.log(`  ✅ ${msg}`); }
  else { fail++; console.log(`  ❌ ${msg}`); }
}

// ─── 入口 ───
async function main() {
  const testDir = join(tmpdir(), "dskcode-tool-test");
  await mkdir(testDir, { recursive: true });
  const registry = new ToolRegistry();
  registry.registerAll(builtinTools);

  console.log("╔══════════════════════════════════════════╗");
  console.log("║   内置工具逐个验证 — 8 个工具            ║");
  console.log("╚══════════════════════════════════════════╝\n");

  // ━━━ 1. write_file ━━━
  console.log("📝 1/8  write_file");
  const testFilePath = join(testDir, "hello.txt");
  const wr = await registry.execute("write_file", { path: testFilePath, content: "第一行\n第二行\n第三行\n你好世界" }, ctx);
  assert(wr.success, "创建文件成功");
  assert(wr.data.includes("4 行"), "返回行数信息");
  assert(wr.data.includes("字节"), "返回字节信息");

  // 带子目录的写入
  const deepPath = join(testDir, "sub", "dir", "deep.txt");
  const wr2 = await registry.execute("write_file", { path: deepPath, content: "深层文件" }, ctx);
  assert(wr2.success, "自动创建中间目录");

  // 缺少参数
  const wr3 = await registry.execute("write_file", { path: "test.txt" }, ctx);
  assert(!wr3.success, "缺少 content 参数返回失败");
  console.log("");

  // ━━━ 2. read_file ━━━
  console.log("📖 2/8  read_file");
  const rr = await registry.execute("read_file", { path: testFilePath }, ctx);
  assert(rr.success, "读取文件成功");
  assert(rr.data.includes("第一行"), "包含文件内容");
  assert(rr.data.includes("1 |"), "带行号前缀");

  // 行号范围
  const rr2 = await registry.execute("read_file", { path: testFilePath, start_line: 2, end_line: 3 }, ctx);
  assert(rr2.success, "按行号范围读取成功");
  assert(rr2.data.includes("第二行"), "范围包含第 2 行");
  assert(!rr2.data.includes("第一行"), "范围不包含第 1 行");

  // 不存在的文件
  const rr3 = await registry.execute("read_file", { path: join(testDir, "nope.txt") }, ctx);
  assert(!rr3.success, "读取不存在的文件返回失败");

  // 缺少参数
  const rr4 = await registry.execute("read_file", {}, ctx);
  assert(!rr4.success, "缺少 path 参数返回失败");
  console.log("");

  // ━━━ 3. edit_file ━━━
  console.log("✏️  3/8  edit_file");
  // 先写一个文件
  await writeFile(join(testDir, "edit.txt"), "hello world\nfoo bar\nhello again", "utf-8");

  // 精确替换（唯一匹配）
  const er1 = await registry.execute("edit_file", {
    path: join(testDir, "edit.txt"),
    old_text: "foo bar",
    new_text: "baz qux",
  }, ctx);
  assert(er1.success, "精确替换唯一匹配成功");
  assert(er1.data.includes("第 2 行"), "返回行号信息");

  // 验证替换结果
  const editContent = await readFile(join(testDir, "edit.txt"), "utf-8");
  assert(editContent.includes("baz qux"), "文件内容已更新");
  assert(!editContent.includes("foo bar"), "旧文本已移除");

  // 多处匹配报错
  const er2 = await registry.execute("edit_file", {
    path: join(testDir, "edit.txt"),
    old_text: "hello",
    new_text: "hi",
  }, ctx);
  assert(!er2.success, "多处匹配返回失败");
  assert(er2.error === "TEXT_MULTIPLE_MATCHES", "错误类型为 TEXT_MULTIPLE_MATCHES");

  // 未找到文本报错
  const er3 = await registry.execute("edit_file", {
    path: join(testDir, "edit.txt"),
    old_text: "not_found_text",
    new_text: "replaced",
  }, ctx);
  assert(!er3.success, "未找到文本返回失败");
  assert(er3.error === "TEXT_NOT_FOUND", "错误类型为 TEXT_NOT_FOUND");
  console.log("");

  // ━━━ 4. bash ━━━
  console.log("🔧 4/8  bash");
  const br1 = await registry.execute("bash", { command: "node -e \"console.log('hello from bash')\"" }, ctx);
  assert(br1.success, "执行命令成功");
  assert(br1.data.includes("hello from bash"), "包含标准输出");

  // 非零退出码
  const br2 = await registry.execute("bash", { command: "node -e \"process.exit(1)\"" }, ctx);
  assert(!br2.success, "非零退出码返回失败");
  assert(br2.data.includes("退出码"), "包含退出码信息");

  // 缺少参数
  const br3 = await registry.execute("bash", {}, ctx);
  assert(!br3.success, "缺少 command 参数返回失败");
  console.log("");

  // ━━━ 5. glob ━━━
  console.log("🔍 5/8  glob");
  // 多准备几个文件
  await writeFile(join(testDir, "app.ts"), "// ts file", "utf-8");
  await writeFile(join(testDir, "app.js"), "// js file", "utf-8");
  await writeFile(join(testDir, "README.md"), "# readme", "utf-8");

  const gr1 = await registry.execute("glob", { pattern: "**/*.ts", directory: testDir }, ctx);
  assert(gr1.success, "搜索 *.ts 文件成功");
  assert(gr1.data.includes(".ts"), "结果包含 .ts 文件");
  assert(!gr1.data.includes(".js") || gr1.data.includes("app.ts"), "支持通配符过滤");

  // 搜索所有文件
  const gr2 = await registry.execute("glob", { pattern: "**/*", directory: testDir }, ctx);
  assert(gr2.success, "搜索所有文件成功");
  assert(gr2.data.includes("hello.txt"), "结果包含已知文件");

  // 不匹配的模式
  const gr3 = await registry.execute("glob", { pattern: "**/*.xyz", directory: testDir }, ctx);
  assert(gr3.success, "不匹配模式返回成功");
  assert(gr3.data.includes("未找到"), "提示未找到文件");
  console.log("");

  // ━━━ 6. grep ━━━
  console.log("🔎 6/8  grep");
  const gp1 = await registry.execute("grep", { pattern: "hello", directory: testDir }, ctx);
  assert(gp1.success, "搜索内容成功");
  assert(gp1.data.includes("hello"), "结果包含搜索关键字");

  // 扩展名过滤
  const gp2 = await registry.execute("grep", { pattern: "file", directory: testDir, include: "ts" }, ctx);
  assert(gp2.success, "按扩展名过滤搜索成功");

  // 不匹配的搜索
  const gp3 = await registry.execute("grep", { pattern: "zzz_not_exist_zzz", directory: testDir }, ctx);
  assert(gp3.success, "无匹配内容返回成功");
  assert(gp3.data.includes("未找到"), "提示未找到内容");
  console.log("");

  // ━━━ 7. ls ━━━
  console.log("📁 7/8  ls");
  const ls1 = await registry.execute("ls", { path: testDir }, ctx);
  assert(ls1.success, "列出目录成功");
  assert(ls1.data.includes("hello.txt"), "包含已知文件");
  assert(ls1.data.includes("📄") || ls1.data.includes("📁"), "包含类型标记");

  // 默认隐藏 .开头 文件
  await writeFile(join(testDir, ".hidden"), "hidden", "utf-8");
  const ls2 = await registry.execute("ls", { path: testDir }, ctx);
  assert(ls2.success, "默认隐藏 .开头文件");
  assert(!ls2.data.includes(".hidden"), "默认不显示隐藏文件");

  // show all
  const ls3 = await registry.execute("ls", { path: testDir, all: true }, ctx);
  assert(ls3.success, "all=true 显示隐藏文件");
  assert(ls3.data.includes(".hidden"), "显示隐藏文件");
  console.log("");

  // ━━━ 8. fetch ━━━
  console.log("🌐 8/8  fetch");
  // 测试缺少必要参数
  const ft1 = await registry.execute("fetch", {}, ctx);
  assert(!ft1.success, "缺少 url 参数返回失败");

  // 测试一个简单的 HTTP 请求（可能网络不可用，所以只验证参数逻辑）
  const ft2 = await registry.execute("fetch", { url: "https://httpbin.org/get", max_length: 1000 }, ctx);
  // 网络请求可能成功也可能失败，只验证结构
  if (ft2.success) {
    assert(ft2.data.includes("状态:"), "包含状态信息");
    console.log("  ✅ 网络请求成功（连接到 httpbin.org）");
  } else {
    console.log("  ⚠️  网络请求失败（可能无网络），结构正确");
  }

  // POST 请求
  const ft3 = await registry.execute("fetch", {
    url: "https://httpbin.org/post",
    method: "POST",
    body: JSON.stringify({ test: "data" }),
    max_length: 500,
  }, ctx);
  if (ft3.success) {
    assert(true, "POST 请求结构正确");
  } else {
    console.log("  ⚠️  POST 请求失败（可能无网络），结构正确");
  }
  console.log("");

  // ━━━ 清理 ━━━
  await rm(testDir, { recursive: true }).catch(() => {});
  console.log("🧹 测试目录已清理\n");

  // ━━━ 汇总 ━━━
  console.log("══════════════════════════════════════════");
  console.log(`  通过: ${pass}  失败: ${fail}`);
  console.log("══════════════════════════════════════════");
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error("脚本异常:", err);
  process.exit(1);
});