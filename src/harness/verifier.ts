// ---------------------------------------------------------------------------
// Verifier — 智能判断"该跑什么验证"
//
// 设计原则：
// - 不假设用户有测试基建：有 type-check 就跑 type-check，有 test 就跑 test，都没有就跳过
// - 不互锁：每条信号独立 ok/fail，缺一个不阻塞其它
// - 跑过的结果可注入 system prompt / Reflector
//
// 探测策略（按优先级）：
//   1. 读项目根的 package.json scripts，识别 test / typecheck / lint / build
//   2. 探测 tsconfig.json 决定是否跑 tsc
//   3. 探测 vitest.config / jest.config 决定是否跑测试
//   4. 探测 .oxlintrc / .eslintrc 决定是否跑 lint
//   5. 跑过的信号标 "skipped"（不报错）便于 UI 区分
//
// 函数注释规范见仓库根 AGENTS.md「函数注释规范」一节。
// ---------------------------------------------------------------------------

import { readFile, access } from "node:fs/promises";
import { join } from "node:path";

/** 单条验证信号结果 */
export interface VerificationSignal {
  /** 信号种类 */
  kind: "type-check" | "test" | "lint" | "build";
  /** 是否通过；"skipped" 表示项目无对应基建，不算失败 */
  outcome: "pass" | "fail" | "skipped";
  /** 人类可读摘要（一行） */
  summary: string;
  /** 失败时的详细输出（最多 2000 字符） */
  detail?: string;
}

/** 验证整体结果 */
export interface VerificationResult {
  /** 是否"全过或全跳过"（即没有 fail） */
  ok: boolean;
  /** 逐条信号 */
  signals: VerificationSignal[];
  /** 耗时（毫秒） */
  elapsedMs: number;
}

/** 探测到的项目信号 */
export interface ProjectSignals {
  hasTypeScript: boolean;
  hasTypeCheckScript: boolean;  // package.json 有 "typecheck" 或 "type-check" script
  hasTestScript: boolean;       // package.json 有 "test" script 且非空
  hasLintScript: boolean;       // package.json 有 "lint" script
  hasBuildScript: boolean;      // package.json 有 "build" script
  testRunner: "vitest" | "jest" | "unknown";
}

const PREVIEW_LEN = 2000;

/** 截断超长文本 */
function truncate(s: string, n = PREVIEW_LEN): string {
  return s.length <= n ? s : s.slice(0, n) + `\n...[已截断，原始长度 ${s.length}]`;
}

/** 判断路径是否存在 */
async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; }
  catch { return false; }
}

// ---------------------------------------------------------------------------
// 项目信号探测
// ---------------------------------------------------------------------------

/**
 * 探测项目有哪些验证基建可用。
 *
 * @param cwd — 项目根目录
 * @returns 探测结果
 *
 * @pure 仅做 fs 探测，不执行任何命令
 */
export async function detectProjectSignals(cwd: string): Promise<ProjectSignals> {
  const signals: ProjectSignals = {
    hasTypeScript: false,
    hasTypeCheckScript: false,
    hasTestScript: false,
    hasLintScript: false,
    hasBuildScript: false,
    testRunner: "unknown",
  };

  // 探测 tsconfig.json
  signals.hasTypeScript = await exists(join(cwd, "tsconfig.json"));

  // 探测 vitest / jest 配置
  if (await exists(join(cwd, "vitest.config.ts")) || await exists(join(cwd, "vitest.config.js"))) {
    signals.testRunner = "vitest";
  } else if (await exists(join(cwd, "jest.config.ts")) || await exists(join(cwd, "jest.config.js"))) {
    signals.testRunner = "jest";
  }

  // 读 package.json
  let pkg: { scripts?: Record<string, string> } | null = null;
  try {
    const raw = await readFile(join(cwd, "package.json"), "utf-8");
    pkg = JSON.parse(raw);
  } catch { /* 没 package.json */ }

  if (pkg?.scripts) {
    const scripts = pkg.scripts;
    signals.hasTypeCheckScript = Boolean(scripts.typecheck ?? scripts["type-check"]);
    signals.hasTestScript = Boolean(scripts.test && scripts.test.trim().length > 0);
    signals.hasLintScript = Boolean(scripts.lint && scripts.lint.trim().length > 0);
    signals.hasBuildScript = Boolean(scripts.build && scripts.build.trim().length > 0);

    // 如果 test script 里提到 vitest 但上面没探测到，补一下
    if (signals.testRunner === "unknown" && signals.hasTestScript) {
      const t = scripts.test ?? "";
      if (t.includes("vitest")) signals.testRunner = "vitest";
      else if (t.includes("jest")) signals.testRunner = "jest";
    }
  }

  return signals;
}

// ---------------------------------------------------------------------------
// Verifier
// ---------------------------------------------------------------------------

/** Verifier 配置 */
export interface VerifierOptions {
  /** 单个命令超时（毫秒，默认 30000） */
  perCommandTimeoutMs?: number;
}

/**
 * Verifier — 跑完一个 todo 后该跑什么验证。
 *
 * 用法：
 *   const v = new Verifier();
 *   const result = await v.verifyAfter({ id: 5, content: "改 edit-file.ts", status: "running" }, cwd);
 *   if (!result.ok) {
 *     // 把 signals 里 fail 的 detail 喂给 Reflector
 *   }
 *
 * 行为：
 * - 自动探测项目信号，决定跑哪些
 * - 缺基建 → 标记 "skipped"（不阻塞）
 * - 命令超时 → 标记 "fail" + 超时说明
 */
export class Verifier {
  readonly #perCommandTimeoutMs: number;

  /**
   * 构造一个 Verifier。
   *
   * @param options — 超时配置
   * @pure 仅保存配置
   */
  constructor(options: VerifierOptions = {}) {
    this.#perCommandTimeoutMs = options.perCommandTimeoutMs ?? 30_000;
  }

  /**
   * 跑"todo 完成之后该跑的"验证。
   *
   * @param _todo — 刚完成的 todo（保留参数，未来可基于 todo 类型决定跑哪些）
   * @param cwd — 项目根目录
   * @returns 验证结果
   *
   * @sideEffect 执行 npm/pnpm/yarn 子命令
   */
  async verifyAfter(
    _todo: { id: number; content: string; status: string },
    cwd: string,
  ): Promise<VerificationResult> {
    const start = Date.now();
    const signals = await detectProjectSignals(cwd);

    const results: VerificationSignal[] = [];

    // type-check：有 tsconfig + 有 script 时跑
    if (signals.hasTypeScript && signals.hasTypeCheckScript) {
      const r = await this.#runNpmScript(cwd, ["run", "typecheck", "--silent"]);
      results.push(toSignal("type-check", r));
    } else if (signals.hasTypeScript) {
      results.push({
        kind: "type-check",
        outcome: "skipped",
        summary: "项目有 tsconfig 但 package.json 无 typecheck script，跳过",
      });
    } else {
      results.push({
        kind: "type-check",
        outcome: "skipped",
        summary: "项目无 TypeScript",
      });
    }

    // test：有 script 时跑
    if (signals.hasTestScript) {
      const r = await this.#runNpmScript(cwd, ["run", "test", "--silent", "--", "--run"]);
      results.push(toSignal("test", r));
    } else {
      results.push({
        kind: "test",
        outcome: "skipped",
        summary: "项目无 test script",
      });
    }

    // lint：有 script 时跑
    if (signals.hasLintScript) {
      const r = await this.#runNpmScript(cwd, ["run", "lint", "--silent"]);
      results.push(toSignal("lint", r));
    } else {
      results.push({
        kind: "lint",
        outcome: "skipped",
        summary: "项目无 lint script",
      });
    }

    // build：暂不自动跑（太重，未来可加"代码改动了就 build"的判断）
    results.push({
      kind: "build",
      outcome: "skipped",
      summary: "build 默认不自动跑（防止误触发）",
    });

    const elapsedMs = Date.now() - start;
    const ok = results.every((s) => s.outcome !== "fail");
    return { ok, signals: results, elapsedMs };
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  async #runNpmScript(
    cwd: string,
    args: string[],
    _signal?: AbortSignal,
  ): Promise<{ ok: boolean; stdout: string; stderr: string; timedOut: boolean }> {
    const { spawn } = await import("node:child_process");
    return new Promise((resolve) => {
      const child = spawn("npm", args, { cwd, shell: true });
      let stdout = "";
      let stderr = "";
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, this.#perCommandTimeoutMs);

      child.stdout?.on("data", (d: Buffer) => { stdout += d.toString("utf-8"); });
      child.stderr?.on("data", (d: Buffer) => { stderr += d.toString("utf-8"); });

      child.on("close", (code) => {
        clearTimeout(timer);
        if (timedOut) {
          resolve({ ok: false, stdout, stderr, timedOut: true });
          return;
        }
        resolve({ ok: code === 0, stdout, stderr, timedOut: false });
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({ ok: false, stdout, stderr: err.message, timedOut: false });
      });
    });
  }
}

function toSignal(
  kind: VerificationSignal["kind"],
  r: { ok: boolean; stdout: string; stderr: string; timedOut: boolean },
): VerificationSignal {
  if (r.timedOut) {
    return {
      kind,
      outcome: "fail",
      summary: `超时（30s）`,
      detail: truncate(r.stderr || r.stdout || "(无输出)"),
    };
  }
  if (r.ok) {
    return { kind, outcome: "pass", summary: "通过" };
  }
  return {
    kind,
    outcome: "fail",
    summary: "失败",
    detail: truncate(r.stderr || r.stdout || "(无输出)"),
  };
}
