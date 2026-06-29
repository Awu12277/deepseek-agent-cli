// ---------------------------------------------------------------------------
// Harness 行为观察 — 跑真实 LLM 收集数据
//
// 用法：DEEPSEEK_API_KEY=xxx npx vitest run tests/harness-behavior.test.ts
//
// 跑 5 个真实场景，记录：
//   - 模型是否调 todo_add（何时调）
//   - 是否在 edit_file 之前 read_file
//   - 撞墙后是否恢复
//   - 总成本
//
// 这个测试默认跳过（避免无 API key 时报错 + 避免日常 CI 跑花钱）
// ---------------------------------------------------------------------------

import { describe, it } from "vitest";
import { readFileSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Provider, ChatMessage } from "../src/provider/index.js";
import { Session } from "../src/agent/index.js";
import { DeepSeekProvider } from "../src/provider/deepseek.js";
import { CostTracker } from "../src/provider/cost-tracker.js";
import { readFileTool } from "../src/tool/builtins/read-file.js";
import { writeFileTool } from "../src/tool/builtins/write-file.js";
import { editFileTool } from "../src/tool/builtins/edit-file.js";
import { multiEditTool } from "../src/tool/builtins/multi-edit.js";
import { deleteRangeTool } from "../src/tool/builtins/delete-range.js";
import { bashTool } from "../src/tool/builtins/bash.js";
import { globTool } from "../src/tool/builtins/glob.js";
import { grepTool } from "../src/tool/builtins/grep.js";
import { lsTool } from "../src/tool/builtins/ls.js";
import { fetchTool } from "../src/tool/builtins/fetch.js";

const HAS_KEY = Boolean(process.env.DEEPSEEK_API_KEY) || (() => {
  try {
    const s = JSON.parse(readFileSync(join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".dskcode", "settings.json"), "utf-8"));
    return Boolean(s.providers?.[0]?.apiKey);
  } catch { return false; }
})();

/** 在临时目录里仿真一个最小项目，让模型能 read_file / edit_file，但不污染业务代码 */
function setupSandbox(): string {
  const d = mkdtempSync(join(tmpdir(), "harness-observe-"));
  mkdirSync(join(d, "src", "tool", "builtins"), { recursive: true });
  mkdirSync(join(d, "src", "agent"), { recursive: true });
  writeFileSync(join(d, "src", "tool", "builtins", "edit-file.ts"),
    `// edit-file tool\nfunction editFile() {\n  if (oldText not found) {\n    return "未找到要替换的文本";\n  }\n}\n`);
  writeFileSync(join(d, "src", "agent", "session.ts"),
    `// Session class\n// TODO: 重构这里\nexport class Session { /* TODO: 优化 */ }\n`);
  writeFileSync(join(d, "README.md"),
    `# Test Project\nThis project has 10 built-in tools.\n`);
  return d;
}

const describeIf = HAS_KEY ? describe : describe.skip;

interface SettingsJson {
  providers?: Array<{ name: string; apiKey: string; baseUrl: string; model: string }>;
  defaultProvider?: string;
}

function loadProvider(): Provider {
  const settingsPath = join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".dskcode", "settings.json");
  const settings: SettingsJson = JSON.parse(readFileSync(settingsPath, "utf-8"));
  const cfg = settings.providers?.[0]!;
  return new DeepSeekProvider({
    apiKey: process.env.DEEPSEEK_API_KEY ?? cfg.apiKey,
    baseUrl: cfg.baseUrl,
    model: cfg.model,
  });
}

const tools = [
  readFileTool, writeFileTool, editFileTool, multiEditTool, deleteRangeTool,
  bashTool, globTool, grepTool, lsTool, fetchTool,
];

interface BehaviorRecord {
  scenario: string;
  expectComplexity: string;
  rounds: number;
  toolCalls: Array<{ round: number; name: string; args: unknown; ok?: boolean }>;
  firstTodoAddRound: number;
  readBeforeEdit: boolean;
  editAttemptCount: number;
  editFailCount: number;
  recoveredAfterFail: boolean;
  cost: number;
}

const records: BehaviorRecord[] = [];

async function runScenario(name: string, prompt: string, expectComplexity: string, provider: Provider, sandbox: string): Promise<BehaviorRecord> {
  console.log(`\n[场景] ${name}  (期望复杂度: ${expectComplexity})`);
  console.log(`[prompt] ${prompt}`);

  const session = new Session(provider, tools, new CostTracker({ budgetLimit: 0, tokenBudgetLimit: 0 }), {
    store: false, enableLog: false, enableCheckpoint: false,
    cwd: sandbox,
  });

  const calls: BehaviorRecord["toolCalls"] = [];
  let currentRound = 0;

  for await (const ev of session.chat(prompt)) {
    if (ev.type === "tool_calls") {
      currentRound++;
      for (const tc of ev.calls) {
        let args: unknown = {};
        try { args = JSON.parse(tc.arguments); } catch { /* */ }
        calls.push({ round: currentRound, name: tc.name, args });
        console.log(`  R${currentRound} 调 ${tc.name}`);
      }
    }
    if (ev.type === "tool_result") {
      const lastCall = [...calls].reverse().find((c) => c.name === ev.name && c.ok === undefined);
      if (lastCall) lastCall.ok = ev.result.success;
      console.log(`  R${currentRound} ${ev.name} ${ev.result.success ? "✓" : "✗ " + (ev.result.error ?? "")}`);
    }
    if (ev.type === "error") {
      console.log(`  [错误] ${ev.error.message}`);
    }
  }

  const todoAdds = calls.filter((c) => c.name === "todo_add");
  const editCalls = calls.filter((c) => c.name === "edit_file");
  const readCalls = calls.filter((c) => c.name === "read_file");

  let readBeforeEdit = false;
  for (const e of editCalls) {
    const prevReads = readCalls.filter((r) => r.round < e.round);
    if (prevReads.length > 0) {
      const editPath = String((e.args as { path?: string })?.path ?? "");
      const fname = editPath.split("/").pop() ?? "";
      if (prevReads.some((r) => String((r.args as { path?: string })?.path ?? "").includes(fname))) {
        readBeforeEdit = true; break;
      }
    }
  }

  const editFails = editCalls.filter((c) => c.ok === false);
  const recoveredAfterFail = editFails.length > 0 && calls.length > editCalls.length;

  return {
    scenario: name,
    expectComplexity,
    rounds: currentRound,
    toolCalls: calls,
    firstTodoAddRound: todoAdds.length > 0 ? todoAdds[0]!.round : 0,
    readBeforeEdit,
    editAttemptCount: editCalls.length,
    editFailCount: editFails.length,
    recoveredAfterFail,
    cost: session.accumulatedCost,
  };
}

describeIf("Harness 行为观察（5 个真实场景，需 DEEPSEEK_API_KEY）", () => {
  // 真跑 LLM 会费时间（每场景 30-120s）
  const SCENARIO_TIMEOUT = 180_000;

  it("前置检查：必须 DEEPSEEK_API_KEY", () => {
    if (!HAS_KEY) throw new Error("需要 DEEPSEEK_API_KEY 或 ~/.dskcode/settings.json");
  });

  it("场景 1: 简单改单词（用户那个 TEXT_NOT_FOUND 案例）", { timeout: SCENARIO_TIMEOUT }, async () => {
    const provider = loadProvider();
    const sandbox = setupSandbox();
    try {
      const rec = await runScenario(
        "简单改单词",
        "把 src/tool/builtins/edit-file.ts 第 5 行的「未找到要替换的文本」后面加上「请先 read_file」几个字",
        "medium",
        provider,
        sandbox,
      );
      records.push(rec);
    } finally { rmSync(sandbox, { recursive: true, force: true }); }
  });

  it("场景 2: 找所有 TODO 文件", { timeout: SCENARIO_TIMEOUT }, async () => {
    const provider = loadProvider();
    const sandbox = setupSandbox();
    try {
      const rec = await runScenario(
        "找TODO",
        "在 src/agent/ 下找所有包含 TODO 的文件，列出文件路径",
        "medium",
        provider,
        sandbox,
      );
      records.push(rec);
    } finally { rmSync(sandbox, { recursive: true, force: true }); }
  });

  it("场景 3: 简单查询", { timeout: SCENARIO_TIMEOUT }, async () => {
    const provider = loadProvider();
    const sandbox = setupSandbox();
    try {
      const rec = await runScenario(
        "简单查询",
        "列出 src 目录下所有 .ts 文件",
        "low",
        provider,
        sandbox,
      );
      records.push(rec);
    } finally { rmSync(sandbox, { recursive: true, force: true }); }
  });

  it("场景 4: 写新工具", { timeout: SCENARIO_TIMEOUT }, async () => {
    const provider = loadProvider();
    const sandbox = setupSandbox();
    try {
      const rec = await runScenario(
        "写新工具",
        "在 src/tool/builtins/ 加一个新工具 echo-tool，参数是 text，输出 text 本身",
        "high",
        provider,
        sandbox,
      );
      records.push(rec);
    } finally { rmSync(sandbox, { recursive: true, force: true }); }
  });

  it("场景 5: 分析 bug", { timeout: SCENARIO_TIMEOUT }, async () => {
    const provider = loadProvider();
    const sandbox = setupSandbox();
    try {
      const rec = await runScenario(
        "分析bug",
        "README.md 说项目支持 10 个内置工具，帮我确认下 src/ 下所有 .ts 文件加起来有几个",
        "high",
        provider,
        sandbox,
      );
      records.push(rec);
    } finally { rmSync(sandbox, { recursive: true, force: true }); }
  });
});

import { afterAll } from "vitest";

afterAll(() => {
  if (records.length === 0) return;
  console.log("\n\n========== 行为观察报告 ==========\n");
  console.log("指标：firstTodoAddRound=首次调 todo_add 的轮次（0=没调）；readBeforeEdit=edit 前是否 read 同一文件；recoveredAfterFail=撞墙后是否继续");
  console.log("\n" + "场景".padEnd(16) + "复杂度".padEnd(8) + "todo轮次".padEnd(10) + "read→edit".padEnd(10) + "edit失败".padEnd(10) + "恢复".padEnd(8) + "总轮次".padEnd(8) + "成本");
  console.log("─".repeat(80));
  for (const r of records) {
    console.log(
      r.scenario.padEnd(16),
      r.expectComplexity.padEnd(8),
      (r.firstTodoAddRound || "✗").toString().padEnd(10),
      (r.readBeforeEdit ? "✓" : "✗").padEnd(10),
      String(r.editFailCount).padEnd(10),
      (r.recoveredAfterFail ? "✓" : "—").padEnd(8),
      String(r.rounds).padEnd(8),
      `¥${r.cost.toFixed(4)}`,
    );
  }
  console.log("\n========== 详细调用序列 ==========");
  for (const r of records) {
    console.log(`\n【${r.scenario}】`);
    for (const c of r.toolCalls) {
      const ok = c.ok === undefined ? "?" : c.ok ? "✓" : "✗";
      const args = JSON.stringify(c.args).slice(0, 50);
      console.log(`  R${c.round} ${ok} ${c.name}(${args})`);
    }
  }
});
