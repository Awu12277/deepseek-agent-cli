/**
 * 工具系统集成验证脚本
 * 模拟 AI 工作流：读取文件 → 修改函数名 → 验证结果
 * 
 * 用法: npx tsx scripts/test-tool-flow.ts
 */
import { ToolRegistry } from "../src/tool/registry.js";
import { builtinTools } from "../src/tool/builtins/index.js";
import type { ToolContext } from "../src/tool/types.js";
import { writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function main() {
  console.log("=== 工具系统集成验证脚本 ===\n");

  // 1. 初始化工具注册表
  const registry = new ToolRegistry();
  registry.registerAll(builtinTools);
  console.log(`✅ 已注册 ${registry.list().length} 个内置工具:`);
  console.log(`   ${registry.names().join(", ")}\n`);

  // 2. 创建测试工作目录
  const testDir = join(tmpdir(), "dskcode-tool-flow-test");
  await mkdir(testDir, { recursive: true });
  const testFile = join(testDir, "example.ts");
  const ctx: ToolContext = { cwd: testDir, signal: undefined, timeout: 10000 };

  try {
    // ─── 步骤 1: 写入测试文件 ───
    console.log("📝 步骤 1: write_file 写入测试文件");
    const originalContent = `// 示例模块
export function showCustomHelp(program: Command): string {
  const lines: string[] = [];
  lines.push("帮助信息");
  return lines.join("\\n");
}

export function formatHelp(program: Command): string {
  return showCustomHelp(program);
}
`;
    const writeResult = await registry.execute("write_file", {
      path: testFile,
      content: originalContent,
    }, ctx);
    console.log(`   ${writeResult.data}\n`);

    // ─── 步骤 2: 读取文件 ───
    console.log("📖 步骤 2: read_file 读取文件内容");
    const readResult = await registry.execute("read_file", { path: testFile }, ctx);
    if (!readResult.success) {
      console.error(`   ❌ 读取失败: ${readResult.error}`);
      process.exit(1);
    }
    console.log(`   ✅ 读取成功:\n${readResult.data.split("\n").slice(0, 6).map(l => "   " + l).join("\n")}\n`);

    // ─── 步骤 3: 修改函数定义 ─── showCustomHelp → customHelp
    console.log("✏️  步骤 3: edit_file 修改函数定义 showCustomHelp → customHelp");
    const edit1 = await registry.execute("edit_file", {
      path: testFile,
      old_text: "export function showCustomHelp(program: Command): string {",
      new_text: "export function customHelp(program: Command): string {",
    }, ctx);
    if (!edit1.success) {
      console.error(`   ❌ 修改失败: ${edit1.error} — ${edit1.data}`);
      process.exit(1);
    }
    console.log(`   ✅ ${edit1.data}\n`);

    // ─── 步骤 4: 修改调用处 ───
    console.log("✏️  步骤 4: edit_file 修改调用处 showCustomHelp → customHelp");
    const edit2 = await registry.execute("edit_file", {
      path: testFile,
      old_text: "  return showCustomHelp(program);",
      new_text: "  return customHelp(program);",
    }, ctx);
    if (!edit2.success) {
      console.error(`   ❌ 修改失败: ${edit2.error} — ${edit2.data}`);
      process.exit(1);
    }
    console.log(`   ✅ ${edit2.data}\n`);

    // ─── 步骤 5: 验证修改结果 ───
    console.log("🔍 步骤 5: read_file 再次读取验证");
    const verifyResult = await registry.execute("read_file", { path: testFile }, ctx);
    if (!verifyResult.success) {
      console.error(`   ❌ 验证失败: ${verifyResult.error}`);
      process.exit(1);
    }
    const hasOldName = verifyResult.data.includes("showCustomHelp");
    const hasNewName = verifyResult.data.includes("customHelp");
    console.log(`   旧函数名 showCustomHelp 存在: ${hasOldName ? "❌ 是" : "✅ 否"}`);
    console.log(`   新函数名 customHelp 存在: ${hasNewName ? "✅ 是" : "❌ 否"}\n`);

    // ─── 步骤 6: ls 查看目录 ───
    console.log("📁 步骤 6: ls 查看测试目录");
    const lsResult = await registry.execute("ls", { path: testDir }, ctx);
    if (lsResult.success) {
      console.log(`   ${lsResult.data.split("\n").slice(0, 5).map(l => "   " + l).join("\n")}\n`);
    }

    // ─── 步骤 7: grep 搜索函数名 ───
    console.log("🔎 步骤 7: grep 搜索 customHelp");
    const grepResult = await registry.execute("grep", {
      pattern: "customHelp",
      directory: testDir,
    }, ctx);
    if (grepResult.success) {
      console.log(`   ${grepResult.data.split("\n").map(l => "   " + l).join("\n")}\n`);
    }

    // ─── 步骤 8: bash 执行命令 ───
    console.log("🔧 步骤 8: bash 执行简单命令");
    const bashResult = await registry.execute("bash", {
      command: "node -e \"console.log('工具系统工作正常! 时间: ' + new Date().toISOString())\"",
    }, ctx);
    if (bashResult.success) {
      console.log(`   ✅ ${bashResult.data.trim()}\n`);
    }

    // ─── 最终验证 ───
    const finalContent = await readFile(testFile, "utf-8");
    const finalHasOld = finalContent.includes("showCustomHelp");

    console.log("══════════════════════════════════════════");
    if (!finalHasOld) {
      console.log("✅ 验证通过: 所有 showCustomHelp 已替换为 customHelp");
    } else {
      console.log("⚠️  验证未通过: 仍存在旧函数名");
      process.exit(1);
    }
    console.log("══════════════════════════════════════════\n");

    console.log("最终文件内容:");
    console.log(finalContent.split("\n").map(l => "  " + l).join("\n"));

  } finally {
    await rm(testDir, { recursive: true }).catch(() => {});
    console.log("\n🧹 测试目录已清理");
  }
}

main().catch((err) => {
  console.error("脚本执行出错:", err);
  process.exit(1);
});