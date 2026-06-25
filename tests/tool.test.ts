// ---------------------------------------------------------------------------
// 工具系统单元测试 — 注册表、内置工具、沙箱
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach } from "vitest";
import { ToolRegistry } from "../src/tool/registry.js";
import { builtinTools } from "../src/tool/builtins/index.js";
import { readFileTool } from "../src/tool/builtins/read-file.js";
import { writeFileTool } from "../src/tool/builtins/write-file.js";
import { editFileTool } from "../src/tool/builtins/edit-file.js";
import { bashTool } from "../src/tool/builtins/bash.js";
import { lsTool } from "../src/tool/builtins/ls.js";
import { ToolKind, type AnyAgentTool, type ToolContext } from "../src/tool/types.js";
import { resolvePath, truncateOutput, createTimeoutSignal } from "../src/tool/sandbox.js";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// 工具上下文工厂
// ---------------------------------------------------------------------------

/** 创建测试用工具上下文 */
function createTestContext(cwd?: string): ToolContext {
  return {
    cwd: cwd ?? process.cwd(),
    signal: undefined,
    timeout: 5000,
  };
}

// ---------------------------------------------------------------------------
// ToolRegistry 测试
// ---------------------------------------------------------------------------

describe("ToolRegistry", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  it("注册和获取工具", () => {
    const mockTool: AnyAgentTool = {
      name: "mock",
      description: "测试工具",
      kind: ToolKind.Read,
      parameters: { type: "object", properties: {}, required: [] },
      supportsInputStreaming: false,
      supportedProviders: [],
      execute: async () => ({ success: true, data: "ok" }),
    };

    registry.registerErased(mockTool);
    expect(registry.get("mock")).toBe(mockTool);
  });

  it("重复注册同名工具抛出错误", () => {
    const tool: AnyAgentTool = {
      name: "dup",
      description: "重复",
      kind: ToolKind.Read,
      parameters: { type: "object", properties: {}, required: [] },
      supportsInputStreaming: false,
      supportedProviders: [],
      execute: async () => ({ success: true, data: "ok" }),
    };

    registry.registerErased(tool);
    expect(() => registry.registerErased(tool)).toThrow("已注册");
  });

  it("批量注册工具", () => {
    const tools: AnyAgentTool[] = [
      {
        name: "a",
        description: "A",
        kind: ToolKind.Read,
        parameters: { type: "object", properties: {}, required: [] },
        supportsInputStreaming: false,
        supportedProviders: [],
        execute: async () => ({ success: true, data: "a" }),
      },
      {
        name: "b",
        description: "B",
        kind: ToolKind.Read,
        parameters: { type: "object", properties: {}, required: [] },
        supportsInputStreaming: false,
        supportedProviders: [],
        execute: async () => ({ success: true, data: "b" }),
      },
    ];

    registry.registerAll(tools);
    expect(registry.list()).toHaveLength(2);
  });

  it("注销工具", () => {
    const tool: AnyAgentTool = {
      name: "removeme",
      description: "将被移除",
      kind: ToolKind.Read,
      parameters: { type: "object", properties: {}, required: [] },
      supportsInputStreaming: false,
      supportedProviders: [],
      execute: async () => ({ success: true, data: "ok" }),
    };

    registry.registerErased(tool);
    expect(registry.has("removeme")).toBe(true);
    expect(registry.unregister("removeme")).toBe(true);
    expect(registry.has("removeme")).toBe(false);
  });

  it("禁用和启用工具", () => {
    const tool: AnyAgentTool = {
      name: "toggle",
      description: "可禁用",
      kind: ToolKind.Read,
      parameters: { type: "object", properties: {}, required: [] },
      supportsInputStreaming: false,
      supportedProviders: [],
      execute: async () => ({ success: true, data: "ok" }),
    };

    registry.registerErased(tool);
    expect(registry.isEnabled("toggle")).toBe(true);

    registry.disable("toggle");
    expect(registry.isEnabled("toggle")).toBe(false);
    expect(registry.get("toggle")).toBeUndefined();
    expect(registry.list()).toHaveLength(0);

    registry.enable("toggle");
    expect(registry.isEnabled("toggle")).toBe(true);
    expect(registry.get("toggle")).toBe(tool);
  });

  it("构造函数支持禁用列表", () => {
    const reg = new ToolRegistry({ disabledTools: ["test"] });
    const tool: AnyAgentTool = {
      name: "test",
      description: "被禁用",
      kind: ToolKind.Read,
      parameters: { type: "object", properties: {}, required: [] },
      supportsInputStreaming: false,
      supportedProviders: [],
      execute: async () => ({ success: true, data: "ok" }),
    };

    reg.registerErased(tool);
    expect(reg.has("test")).toBe(true);
    expect(reg.isEnabled("test")).toBe(false);
    expect(reg.get("test")).toBeUndefined();
    expect(reg.list()).toHaveLength(0);
  });

  it("execute 执行已注册工具", async () => {
    const tool: AnyAgentTool = {
      name: "echo",
      description: "回声",
      kind: ToolKind.Read,
      parameters: { type: "object", properties: {}, required: [] },
      supportsInputStreaming: false,
      supportedProviders: [],
      execute: async (args) => ({ success: true, data: JSON.stringify(args) }),
    };

    registry.registerErased(tool);
    const result = await registry.execute("echo", { msg: "hello" }, createTestContext());
    expect(result.success).toBe(true);
    expect(result.data).toContain("hello");
  });

  it("execute 未注册工具返回失败", async () => {
    const result = await registry.execute("nonexistent", {}, createTestContext());
    expect(result.success).toBe(false);
    expect(result.error).toBe("TOOL_NOT_FOUND");
  });

  it("execute 工具抛异常时捕获", async () => {
    const tool: AnyAgentTool = {
      name: "crash",
      description: "抛异常",
      kind: ToolKind.Read,
      parameters: { type: "object", properties: {}, required: [] },
      supportsInputStreaming: false,
      supportedProviders: [],
      execute: async () => {
        throw new Error("工具崩溃了");
      },
    };

    registry.registerErased(tool);
    const result = await registry.execute("crash", {}, createTestContext());
    expect(result.success).toBe(false);
    expect(result.data).toContain("工具崩溃了");
    expect(result.error).toBe("EXECUTION_ERROR");
  });

  it("names 和 list 返回正确结果", () => {
    const tools: AnyAgentTool[] = [
      {
        name: "a",
        description: "A",
        kind: ToolKind.Read,
        parameters: { type: "object", properties: {}, required: [] },
        supportsInputStreaming: false,
        supportedProviders: [],
        execute: async () => ({ success: true, data: "a" }),
      },
      {
        name: "b",
        description: "B",
        kind: ToolKind.Read,
        parameters: { type: "object", properties: {}, required: [] },
        supportsInputStreaming: false,
        supportedProviders: [],
        execute: async () => ({ success: true, data: "b" }),
      },
    ];

    registry.registerAll(tools);
    expect(registry.names()).toEqual(["a", "b"]);
    expect(registry.list()).toHaveLength(2);
    expect(registry.list().map((t) => t.name)).toEqual(["a", "b"]);
  });
});

// ---------------------------------------------------------------------------
// 内置工具列表完整性测试
// ---------------------------------------------------------------------------

describe("内置工具列表", () => {
  it("包含所有 10 个内置工具", () => {
    expect(builtinTools).toHaveLength(10);
    const names = builtinTools.map((t) => t.name);
    expect(names).toContain("read_file");
    expect(names).toContain("write_file");
    expect(names).toContain("edit_file");
    expect(names).toContain("multi_edit");
    expect(names).toContain("delete_range");
    expect(names).toContain("bash");
    expect(names).toContain("glob");
    expect(names).toContain("grep");
    expect(names).toContain("ls");
    expect(names).toContain("fetch");
  });

  it("每个工具都有合法的 name / description / parameters", () => {
    for (const tool of builtinTools) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.parameters.type).toBe("object");
    }
  });
});

// ---------------------------------------------------------------------------
// read_file 工具测试
// ---------------------------------------------------------------------------

describe("read_file 工具", () => {
  const testDir = join(tmpdir(), "dskcode-test-readfile");

  beforeEach(async () => {
    await mkdir(testDir, { recursive: true });
    await writeFile(join(testDir, "test.txt"), "第一行\n第二行\n第三行\n第四行\n第五行", "utf-8");
  });

  it("读取整个文件", async () => {
    const result = await readFileTool.execute(
      { path: join(testDir, "test.txt") },
      createTestContext(),
    );
    expect(result.success).toBe(true);
    expect(result.data).toContain("第一行");
  });

  it("读取指定行范围", async () => {
    const result = await readFileTool.execute(
      { path: join(testDir, "test.txt"), start_line: 2, end_line: 3 },
      createTestContext(),
    );
    expect(result.success).toBe(true);
    expect(result.data).toContain("第二行");
    expect(result.data).toContain("第三行");
  });

  it("缺少 path 参数返回错误", async () => {
    const result = await readFileTool.execute({}, createTestContext());
    expect(result.success).toBe(false);
    expect(result.error).toBe("INVALID_ARGS");
  });

  it("读取不存在的文件返回错误", async () => {
    const result = await readFileTool.execute(
      { path: join(testDir, "nonexistent.txt") },
      createTestContext(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("READ_ERROR");
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true }).catch(() => {});
  });
});

// ---------------------------------------------------------------------------
// write_file 工具测试
// ---------------------------------------------------------------------------

describe("write_file 工具", () => {
  const testDir = join(tmpdir(), "dskcode-test-writefile");

  beforeEach(async () => {
    await mkdir(testDir, { recursive: true });
  });

  it("创建新文件", async () => {
    const filePath = join(testDir, "new-file.txt");
    const result = await writeFileTool.execute(
      { path: filePath, content: "hello world" },
      createTestContext(),
    );
    expect(result.success).toBe(true);

    // 验证文件确实被创建
    const readResult = await readFileTool.execute(
      { path: filePath },
      createTestContext(),
    );
    expect(readResult.data).toContain("hello world");
  });

  it("自动创建中间目录", async () => {
    const filePath = join(testDir, "sub", "dir", "deep.txt");
    const result = await writeFileTool.execute(
      { path: filePath, content: "deep content" },
      createTestContext(),
    );
    expect(result.success).toBe(true);
  });

  it("缺少参数返回错误", async () => {
    const result = await writeFileTool.execute({ path: "test.txt" }, createTestContext());
    expect(result.success).toBe(false);
    expect(result.error).toBe("INVALID_ARGS");
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true }).catch(() => {});
  });
});

// ---------------------------------------------------------------------------
// edit_file 工具测试
// ---------------------------------------------------------------------------

describe("edit_file 工具", () => {
  const testDir = join(tmpdir(), "dskcode-test-editfile");
  const testFile = join(testDir, "edit-test.txt");

  beforeEach(async () => {
    await mkdir(testDir, { recursive: true });
    await writeFile(testFile, "hello world\nfoo bar\nhello again", "utf-8");
  });

  it("精确替换唯一匹配", async () => {
    const result = await editFileTool.execute(
      { path: testFile, old_text: "foo bar", new_text: "baz qux" },
      createTestContext(),
    );
    expect(result.success).toBe(true);
    expect(result.data).toContain("第 2 行");
  });

  it("old_text 未找到返回错误", async () => {
    const result = await editFileTool.execute(
      { path: testFile, old_text: "not_found_text", new_text: "replaced" },
      createTestContext(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("TEXT_NOT_FOUND");
  });

  it("old_text 出现多次返回错误", async () => {
    const result = await editFileTool.execute(
      { path: testFile, old_text: "hello", new_text: "greetings" },
      createTestContext(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("TEXT_MULTIPLE_MATCHES");
  });

  it("缺少参数返回错误", async () => {
    const result = await editFileTool.execute({ path: testFile }, createTestContext());
    expect(result.success).toBe(false);
    expect(result.error).toBe("INVALID_ARGS");
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true }).catch(() => {});
  });
});

// ---------------------------------------------------------------------------
// bash 工具测试
// ---------------------------------------------------------------------------

describe("bash 工具", () => {
  it("执行简单命令", async () => {
    const result = await bashTool.execute(
      { command: "echo hello" },
      createTestContext(),
    );
    expect(result.success).toBe(true);
    // Windows 的 echo 输出可能带回车换行
    expect(result.data.toLowerCase()).toContain("hello");
  });

  it("执行失败命令", async () => {
    // 跨平台触发非零退出码的方法：
    // Windows (cmd): exit /b 1
    // Unix (sh): exit 1
    const isWin = process.platform === "win32";
    const cmd = isWin ? "exit /b 1" : "exit 1";
    const result = await bashTool.execute(
      { command: cmd },
      createTestContext(),
    );
    // 退出码为 1 或 null（进程被 kill 时）
    expect(result.success).toBe(false);
    expect(result.data).toContain("退出码");
  });

  it("缺少 command 参数返回错误", async () => {
    const result = await bashTool.execute({}, createTestContext());
    expect(result.success).toBe(false);
    expect(result.error).toBe("INVALID_ARGS");
  });

  it("命令输出包含 stdout", async () => {
    const result = await bashTool.execute(
      { command: "echo test_output" },
      createTestContext(),
    );
    expect(result.data.toLowerCase()).toContain("test_output");
  });
});

// ---------------------------------------------------------------------------
// ls 工具测试
// ---------------------------------------------------------------------------

describe("ls 工具", () => {
  const testDir = join(tmpdir(), "dskcode-test-ls");

  beforeEach(async () => {
    await mkdir(testDir, { recursive: true });
    await writeFile(join(testDir, "a.txt"), "a", "utf-8");
    await writeFile(join(testDir, "b.ts"), "b", "utf-8");
  });

  it("列出目录内容", async () => {
    const result = await lsTool.execute(
      { path: testDir },
      createTestContext(),
    );
    expect(result.success).toBe(true);
    expect(result.data).toContain("a.txt");
    expect(result.data).toContain("b.ts");
  });

  it("默认列出 cwd", async () => {
    const result = await lsTool.execute({}, createTestContext());
    expect(result.success).toBe(true);
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true }).catch(() => {});
  });
});

// ---------------------------------------------------------------------------
// 沙箱工具测试
// ---------------------------------------------------------------------------

describe("resolvePath", () => {
  it("相对路径解析为绝对路径", () => {
    const resolved = resolvePath("src/index.ts", process.cwd());
    expect(resolved).toContain("src");
    expect(resolved).toContain("index.ts");
  });

  it("绝对路径直接返回规范化路径", () => {
    // 在 Windows 上会返回盘符开头的路径，Linux 上是 / 开头
    const resolved = resolvePath("C:/some/path", "/project");
    expect(typeof resolved).toBe("string");
    expect(resolved.length).toBeGreaterThan(0);
  });
});

describe("truncateOutput", () => {
  it("短内容不截断", () => {
    const result = truncateOutput("hello", 100);
    expect(result).toBe("hello");
  });

  it("长内容被截断", () => {
    const long = "a".repeat(200);
    const result = truncateOutput(long, 100);
    expect(result.length).toBeLessThan(200);
    expect(result).toContain("已截断");
  });
});

describe("createTimeoutSignal", () => {
  it("创建带超时的信号", () => {
    const controller = createTimeoutSignal(undefined, 1000);
    expect(controller.signal.aborted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 工具接口完整性检查
// ---------------------------------------------------------------------------

describe("内置工具接口", () => {
  for (const tool of builtinTools) {
    describe(tool.name, () => {
      it("有合法的 name", () => {
        expect(tool.name).toBeTruthy();
        expect(typeof tool.name).toBe("string");
      });

      it("有合法的 description", () => {
        expect(tool.description).toBeTruthy();
        expect(tool.description.length).toBeGreaterThan(5);
      });

      it("有合法的 parameters JSON Schema", () => {
        expect(tool.parameters.type).toBe("object");
        expect(tool.parameters).toHaveProperty("properties");
      });

      it("execute 是异步函数", () => {
        expect(typeof tool.execute).toBe("function");
      });
    });
  }
});