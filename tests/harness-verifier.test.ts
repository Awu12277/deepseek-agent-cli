// ---------------------------------------------------------------------------
// Verifier 单元测试
//
// 注意：这些测试只覆盖 detectProjectSignals（纯探测），不实际跑 npm 命令。
// verifyAfter 涉及子进程，留给集成测试。
// ---------------------------------------------------------------------------

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectProjectSignals } from "../src/harness/verifier.js";

// ---------------------------------------------------------------------------
// 临时目录工具
// ---------------------------------------------------------------------------

const dirs: string[] = [];
function makeProject(): string {
  const d = mkdtempSync(join(tmpdir(), "verifier-test-"));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* */ }
  }
});

// ---------------------------------------------------------------------------
// detectProjectSignals
// ---------------------------------------------------------------------------

describe("detectProjectSignals", () => {
  it("空目录：全部 false / unknown", async () => {
    const cwd = makeProject();
    const s = await detectProjectSignals(cwd);
    expect(s.hasTypeScript).toBe(false);
    expect(s.hasTypeCheckScript).toBe(false);
    expect(s.hasTestScript).toBe(false);
    expect(s.hasLintScript).toBe(false);
    expect(s.hasBuildScript).toBe(false);
    expect(s.testRunner).toBe("unknown");
  });

  it("有 tsconfig.json：hasTypeScript = true", async () => {
    const cwd = makeProject();
    writeFileSync(join(cwd, "tsconfig.json"), "{}");
    const s = await detectProjectSignals(cwd);
    expect(s.hasTypeScript).toBe(true);
  });

  it("package.json 有 typecheck script：hasTypeCheckScript = true", async () => {
    const cwd = makeProject();
    writeFileSync(join(cwd, "package.json"), JSON.stringify({
      scripts: { typecheck: "tsc --noEmit" },
    }));
    const s = await detectProjectSignals(cwd);
    expect(s.hasTypeCheckScript).toBe(true);
  });

  it("package.json 有 type-check script（带连字符）：hasTypeCheckScript = true", async () => {
    const cwd = makeProject();
    writeFileSync(join(cwd, "package.json"), JSON.stringify({
      scripts: { "type-check": "tsc" },
    }));
    const s = await detectProjectSignals(cwd);
    expect(s.hasTypeCheckScript).toBe(true);
  });

  it("package.json 有 test script：hasTestScript = true", async () => {
    const cwd = makeProject();
    writeFileSync(join(cwd, "package.json"), JSON.stringify({
      scripts: { test: "vitest run" },
    }));
    const s = await detectProjectSignals(cwd);
    expect(s.hasTestScript).toBe(true);
  });

  it("package.json test script 为空字符串：hasTestScript = false", async () => {
    const cwd = makeProject();
    writeFileSync(join(cwd, "package.json"), JSON.stringify({
      scripts: { test: "" },
    }));
    const s = await detectProjectSignals(cwd);
    expect(s.hasTestScript).toBe(false);
  });

  it("package.json 有 lint script：hasLintScript = true", async () => {
    const cwd = makeProject();
    writeFileSync(join(cwd, "package.json"), JSON.stringify({
      scripts: { lint: "oxlint" },
    }));
    const s = await detectProjectSignals(cwd);
    expect(s.hasLintScript).toBe(true);
  });

  it("vitest.config.ts 存在：testRunner = vitest", async () => {
    const cwd = makeProject();
    writeFileSync(join(cwd, "vitest.config.ts"), "export default {};");
    const s = await detectProjectSignals(cwd);
    expect(s.testRunner).toBe("vitest");
  });

  it("vitest.config.js 存在：testRunner = vitest", async () => {
    const cwd = makeProject();
    writeFileSync(join(cwd, "vitest.config.js"), "module.exports = {};");
    const s = await detectProjectSignals(cwd);
    expect(s.testRunner).toBe("vitest");
  });

  it("test script 提到 vitest：testRunner = vitest", async () => {
    const cwd = makeProject();
    writeFileSync(join(cwd, "package.json"), JSON.stringify({
      scripts: { test: "vitest run" },
    }));
    const s = await detectProjectSignals(cwd);
    expect(s.testRunner).toBe("vitest");
  });

  it("test script 提到 jest：testRunner = jest", async () => {
    const cwd = makeProject();
    writeFileSync(join(cwd, "package.json"), JSON.stringify({
      scripts: { test: "jest" },
    }));
    const s = await detectProjectSignals(cwd);
    expect(s.testRunner).toBe("jest");
  });

  it("package.json 不是合法 JSON：脚本信号全 false", async () => {
    const cwd = makeProject();
    writeFileSync(join(cwd, "package.json"), "not json");
    const s = await detectProjectSignals(cwd);
    expect(s.hasTestScript).toBe(false);
  });

  it("典型 dskcode 项目：tsconfig + test + lint + build 都有", async () => {
    const cwd = makeProject();
    writeFileSync(join(cwd, "tsconfig.json"), "{}");
    writeFileSync(join(cwd, "vitest.config.ts"), "");
    writeFileSync(join(cwd, "package.json"), JSON.stringify({
      scripts: {
        test: "vitest run",
        lint: "oxlint src/ tests/",
        build: "tsup",
        typecheck: "tsc --noEmit",
      },
    }));
    const s = await detectProjectSignals(cwd);
    expect(s.hasTypeScript).toBe(true);
    expect(s.hasTypeCheckScript).toBe(true);
    expect(s.hasTestScript).toBe(true);
    expect(s.hasLintScript).toBe(true);
    expect(s.hasBuildScript).toBe(true);
    expect(s.testRunner).toBe("vitest");
  });
});
