// ---------------------------------------------------------------------------
// Reflector 单元测试 — 失败归因 → 改写下一轮 prompt
//
// 覆盖：
//   - R1 连续失败（同一工具连续失败 ≥2 次）
//   - R2 文件不存在（TOOL_NOT_FOUND 或 ENOENT 等关键字）
//   - R3 权限拒绝（GATE_DENIED 或 permission/EACCES 等关键字）
//   - R4 写根外（kind ∈ Edit/Delete/Move 且错误码为 OUTSIDE_WRITE_ROOTS）
//   - R2.5 文本未找到（TEXT_NOT_FOUND / TEXT_MULTIPLE_MATCHES）
//   - analyze 编排（去重 / 截断 / 全成功无反射）
//   - injectIntoPrompt 拼装格式
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { ToolKind } from "../src/tool/types.js";
import { Reflector, type AnalyzeItem } from "../src/agent/reflector.js";

// ---------------------------------------------------------------------------
// 工具函数：构造一个 AnalyzeItem 的最小可用形式
// ---------------------------------------------------------------------------

function makeItem(
  name: string,
  success: boolean,
  opts?: {
    error?: string;
    data?: string;
    kind?: ToolKind;
    recentSameTool?: Array<{ success: boolean; error?: string }>;
  },
): AnalyzeItem {
  return {
    name,
    result: {
      success,
      data: opts?.data ?? "",
      ...(opts?.error ? { error: opts.error } : {}),
    },
    kind: opts?.kind ?? ToolKind.Read,
    recentSameTool: opts?.recentSameTool ?? [],
  };
}

const CTX = { writeRoots: ["/root/project"], cwd: "/root/project" };

// ---------------------------------------------------------------------------
// R1 连续失败
// ---------------------------------------------------------------------------

describe("R1 连续失败", () => {
  it("同一工具连续 2 次失败：命中 repeated_failure", () => {
    const r = new Reflector();
    const reflections = r.analyze(
      [
        makeItem("read_file", false, {
          kind: ToolKind.Read,
          error: "EXECUTION_ERROR",
          data: "some error",
          recentSameTool: [
            { success: false, error: "EXECUTION_ERROR" },
            { success: false, error: "EXECUTION_ERROR" },
          ],
        }),
      ],
      CTX,
    );
    expect(reflections).toHaveLength(1);
    expect(reflections[0].category).toBe("repeated_failure");
    expect(reflections[0].toolName).toBe("read_file");
    expect(reflections[0].hint).toContain("read_file");
  });

  it("同一工具只失败 1 次：R1 不命中", () => {
    const r = new Reflector();
    const reflections = r.analyze(
      [
        makeItem("read_file", false, {
          kind: ToolKind.Read,
          error: "EXECUTION_ERROR",
          recentSameTool: [{ success: false, error: "EXECUTION_ERROR" }],
        }),
      ],
      CTX,
    );
    expect(reflections).toHaveLength(0);
  });

  it("连续失败但错误码不同：R1 不命中", () => {
    const r = new Reflector();
    const reflections = r.analyze(
      [
        makeItem("read_file", false, {
          kind: ToolKind.Read,
          error: "EXECUTION_ERROR",
          recentSameTool: [
            { success: false, error: "EXECUTION_ERROR" },
            { success: false, error: "TIMEOUT" },
          ],
        }),
      ],
      CTX,
    );
    expect(reflections).toHaveLength(0);
  });

  it("历史中穿插成功：R1 不命中", () => {
    const r = new Reflector();
    const reflections = r.analyze(
      [
        makeItem("read_file", false, {
          kind: ToolKind.Read,
          error: "EXECUTION_ERROR",
          recentSameTool: [
            { success: false, error: "EXECUTION_ERROR" },
            { success: true },
            { success: false, error: "EXECUTION_ERROR" },
          ],
        }),
      ],
      CTX,
    );
    expect(reflections).toHaveLength(0);
  });

  it("R1 默认 threshold=2，可通过 options 调整", () => {
    const r = new Reflector({ repeatThreshold: 3 });
    const reflections = r.analyze(
      [
        makeItem("read_file", false, {
          kind: ToolKind.Read,
          error: "E1",
          recentSameTool: [
            { success: false, error: "E1" },
            { success: false, error: "E1" },
          ],
        }),
      ],
      CTX,
    );
    expect(reflections).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// R2 文件不存在
// ---------------------------------------------------------------------------

describe("R2 文件不存在", () => {
  it("error=TOOL_NOT_FOUND：命中 file_not_found", () => {
    const r = new Reflector();
    const reflections = r.analyze(
      [
        makeItem("read_file", false, {
          kind: ToolKind.Read,
          error: "TOOL_NOT_FOUND",
          data: "工具 \"read_file\" 不存在或已被禁用",
        }),
      ],
      CTX,
    );
    expect(reflections).toHaveLength(1);
    expect(reflections[0].category).toBe("file_not_found");
    expect(reflections[0].toolName).toBe("read_file");
  });

  it("data 含 ENOENT：命中 file_not_found", () => {
    const r = new Reflector();
    const reflections = r.analyze(
      [
        makeItem("read_file", false, {
          kind: ToolKind.Read,
          data: "ENOENT: no such file or directory, open '/foo.ts'",
        }),
      ],
      CTX,
    );
    expect(reflections).toHaveLength(1);
    expect(reflections[0].category).toBe("file_not_found");
  });

  it("data 含 'No such file'：命中 file_not_found", () => {
    const r = new Reflector();
    const reflections = r.analyze(
      [
        makeItem("read_file", false, {
          kind: ToolKind.Read,
          data: "Error: No such file or directory",
        }),
      ],
      CTX,
    );
    expect(reflections).toHaveLength(1);
    expect(reflections[0].category).toBe("file_not_found");
  });

  it("data 含 'not found'：命中 file_not_found", () => {
    const r = new Reflector();
    const reflections = r.analyze(
      [
        makeItem("grep", false, {
          kind: ToolKind.Read,
          data: "pattern not found in file",
        }),
      ],
      CTX,
    );
    expect(reflections).toHaveLength(1);
    expect(reflections[0].category).toBe("file_not_found");
  });

  it("成功的工具：R2 不命中", () => {
    const r = new Reflector();
    const reflections = r.analyze(
      [makeItem("read_file", true, { kind: ToolKind.Read, data: "ok" })],
      CTX,
    );
    expect(reflections).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// R3 权限拒绝
// ---------------------------------------------------------------------------

describe("R3 权限拒绝", () => {
  it("error=GATE_DENIED：命中 permission_denied", () => {
    const r = new Reflector();
    const reflections = r.analyze(
      [
        makeItem("bash", false, {
          kind: ToolKind.Other,
          error: "GATE_DENIED",
          data: "工具 \"bash\" 被权限门拒绝",
        }),
      ],
      CTX,
    );
    expect(reflections).toHaveLength(1);
    expect(reflections[0].category).toBe("permission_denied");
  });

  it("data 含 'permission denied'：命中 permission_denied", () => {
    const r = new Reflector();
    const reflections = r.analyze(
      [
        makeItem("write_file", false, {
          kind: ToolKind.Edit,
          data: "Error: EACCES: permission denied, open '/etc/passwd'",
        }),
      ],
      CTX,
    );
    expect(reflections).toHaveLength(1);
    expect(reflections[0].category).toBe("permission_denied");
  });

  it("data 含 'EACCES'：命中 permission_denied", () => {
    const r = new Reflector();
    const reflections = r.analyze(
      [
        makeItem("bash", false, {
          kind: ToolKind.Other,
          data: "bash: /usr/local/x: EACCES",
        }),
      ],
      CTX,
    );
    expect(reflections).toHaveLength(1);
    expect(reflections[0].category).toBe("permission_denied");
  });

  it("data 含 'Permission'（大写开头）：命中 permission_denied", () => {
    const r = new Reflector();
    const reflections = r.analyze(
      [
        makeItem("delete_range", false, {
          kind: ToolKind.Delete,
          data: "Permission denied when deleting",
        }),
      ],
      CTX,
    );
    expect(reflections).toHaveLength(1);
    expect(reflections[0].category).toBe("permission_denied");
  });
});

// ---------------------------------------------------------------------------
// R4 写根外
// ---------------------------------------------------------------------------

describe("R4 写根外", () => {
  it("kind=Edit + error=OUTSIDE_WRITE_ROOTS：命中 out_of_write_root", () => {
    const r = new Reflector();
    const reflections = r.analyze(
      [
        makeItem("write_file", false, {
          kind: ToolKind.Edit,
          error: "OUTSIDE_WRITE_ROOTS",
          data: "目标路径 /etc/passwd 不在允许根目录内",
        }),
      ],
      CTX,
    );
    expect(reflections).toHaveLength(1);
    expect(reflections[0].category).toBe("out_of_write_root");
  });

  it("kind=Delete + error=OUTSIDE_WRITE_ROOTS：命中 out_of_write_root", () => {
    const r = new Reflector();
    const reflections = r.analyze(
      [
        makeItem("delete_range", false, {
          kind: ToolKind.Delete,
          error: "OUTSIDE_WRITE_ROOTS",
          data: "目标路径 /etc/x 不在允许根目录内",
        }),
      ],
      CTX,
    );
    expect(reflections).toHaveLength(1);
    expect(reflections[0].category).toBe("out_of_write_root");
  });

  it("kind=Move + error=OUTSIDE_WRITE_ROOTS：命中 out_of_write_root", () => {
    const r = new Reflector();
    const reflections = r.analyze(
      [
        makeItem("bash", false, {
          kind: ToolKind.Move,
          error: "OUTSIDE_WRITE_ROOTS",
          data: "mv failed",
        }),
      ],
      CTX,
    );
    expect(reflections).toHaveLength(1);
    expect(reflections[0].category).toBe("out_of_write_root");
  });

  it("kind=Edit + error=TEXT_NOT_FOUND：R4 不命中（不能误报为写根外）", () => {
    // 回归会话日志 e65f0205 round 13：edit_file 因 CRLF 失配返回
    // TEXT_NOT_FOUND，旧 R4 会误报 out_of_write_root，现在应走 R2.5
    const r = new Reflector();
    const reflections = r.analyze(
      [
        makeItem("edit_file", false, {
          kind: ToolKind.Edit,
          error: "TEXT_NOT_FOUND",
          data: "未找到要替换的文本",
        }),
      ],
      CTX,
    );
    expect(reflections.find((x) => x.category === "out_of_write_root")).toBeUndefined();
    expect(reflections[0].category).toBe("text_not_found");
  });

  it("kind=Read + 失败：R4 不命中（只读工具不涉及写根）", () => {
    const r = new Reflector();
    const reflections = r.analyze(
      [
        makeItem("read_file", false, {
          kind: ToolKind.Read,
          data: "some read error",
        }),
      ],
      CTX,
    );
    // 不应包含 out_of_write_root（可能含其它规则，但不在此断言）
    expect(reflections.find((x) => x.category === "out_of_write_root")).toBeUndefined();
  });

  it("kind=Edit + 成功：R4 不命中", () => {
    const r = new Reflector();
    const reflections = r.analyze(
      [makeItem("write_file", true, { kind: ToolKind.Edit, data: "ok" })],
      CTX,
    );
    expect(reflections).toHaveLength(0);
  });

  it("hint 应包含 writeRoots[0] 路径", () => {
    const r = new Reflector();
    const reflections = r.analyze(
      [
        makeItem("write_file", false, {
          kind: ToolKind.Edit,
          error: "OUTSIDE_WRITE_ROOTS",
          data: "fail",
        }),
      ],
      { writeRoots: ["/my/project"], cwd: "/my/project" },
    );
    expect(reflections[0].hint).toContain("/my/project");
  });
});

// ---------------------------------------------------------------------------
// R2.5 文本未找到（编辑工具高频失败）
// ---------------------------------------------------------------------------

describe("R2.5 文本未找到", () => {
  it("error=TEXT_NOT_FOUND：命中 text_not_found", () => {
    const r = new Reflector();
    const reflections = r.analyze(
      [
        makeItem("edit_file", false, {
          kind: ToolKind.Edit,
          error: "TEXT_NOT_FOUND",
          data: "未找到要替换的文本",
        }),
      ],
      CTX,
    );
    expect(reflections).toHaveLength(1);
    expect(reflections[0].category).toBe("text_not_found");
    expect(reflections[0].hint).toContain("read_file");
  });

  it("error=TEXT_MULTIPLE_MATCHES：命中 text_not_found 且提示唯一性", () => {
    const r = new Reflector();
    const reflections = r.analyze(
      [
        makeItem("multi_edit", false, {
          kind: ToolKind.Edit,
          error: "TEXT_MULTIPLE_MATCHES",
          data: "要替换的文本在文件中出现多次",
        }),
      ],
      CTX,
    );
    expect(reflections).toHaveLength(1);
    expect(reflections[0].category).toBe("text_not_found");
    expect(reflections[0].hint).toContain("多次");
  });

  it("error=EXECUTION_ERROR（编辑工具）：R2.5 不命中", () => {
    const r = new Reflector();
    const reflections = r.analyze(
      [
        makeItem("edit_file", false, {
          kind: ToolKind.Edit,
          error: "EXECUTION_ERROR",
          data: "disk full",
        }),
      ],
      CTX,
    );
    expect(reflections.find((x) => x.category === "text_not_found")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// analyze 编排
// ---------------------------------------------------------------------------

describe("analyze 编排", () => {
  it("全成功：返回空数组", () => {
    const r = new Reflector();
    const reflections = r.analyze(
      [
        makeItem("read_file", true, { kind: ToolKind.Read, data: "ok" }),
        makeItem("grep", true, { kind: ToolKind.Read, data: "ok" }),
      ],
      CTX,
    );
    expect(reflections).toHaveLength(0);
  });

  it("多个失败项：每个独立分析", () => {
    const r = new Reflector();
    const reflections = r.analyze(
      [
        makeItem("read_file", false, { kind: ToolKind.Read, data: "ENOENT" }),
        makeItem("write_file", false, {
          kind: ToolKind.Edit,
          error: "OUTSIDE_WRITE_ROOTS",
          data: "fail",
        }),
      ],
      CTX,
    );
    expect(reflections.length).toBeGreaterThanOrEqual(2);
    const categories = reflections.map((x) => x.category);
    expect(categories).toContain("file_not_found");
    expect(categories).toContain("out_of_write_root");
  });

  it("同一项命中多条规则时去重（只留第一条）", () => {
    // 构造一个同时满足 R2 和 R4 的失败项：Edit 工具 + ENOENT
    // R2（file_not_found）按规则顺序先匹配，应被保留
    const r = new Reflector();
    const reflections = r.analyze(
      [
        makeItem("write_file", false, {
          kind: ToolKind.Edit,
          data: "ENOENT: no such file",
        }),
      ],
      CTX,
    );
    // 不应同时出现 file_not_found + out_of_write_root
    const fileNotFound = reflections.filter((x) => x.category === "file_not_found");
    const outOfWriteRoot = reflections.filter((x) => x.category === "out_of_write_root");
    // 同一条目只产生 1 条反射（先匹配先得）
    expect(fileNotFound.length + outOfWriteRoot.length).toBeLessThanOrEqual(1);
  });

  it("空输入：返回空数组", () => {
    const r = new Reflector();
    expect(r.analyze([], CTX)).toEqual([]);
  });

  it("成功 + 失败混合：只处理失败项", () => {
    const r = new Reflector();
    const reflections = r.analyze(
      [
        makeItem("read_file", true, { kind: ToolKind.Read, data: "ok" }),
        makeItem("write_file", false, {
          kind: ToolKind.Edit,
          error: "OUTSIDE_WRITE_ROOTS",
          data: "fail",
        }),
      ],
      CTX,
    );
    expect(reflections).toHaveLength(1);
    expect(reflections[0].category).toBe("out_of_write_root");
  });
});

// ---------------------------------------------------------------------------
// injectIntoPrompt 拼装
// ---------------------------------------------------------------------------

describe("injectIntoPrompt", () => {
  it("空反射数组：原样返回 prompt", () => {
    const r = new Reflector();
    const prompt = "你是 dskcode。";
    expect(r.injectIntoPrompt(prompt, [])).toBe(prompt);
  });

  it("1 条反射：末尾追加 reflection section", () => {
    const r = new Reflector();
    const result = r.injectIntoPrompt("你是 dskcode。", [
      { category: "file_not_found", toolName: "read_file", hint: "文件不存在" },
    ]);
    expect(result).toContain("你是 dskcode。");
    expect(result).toContain("read_file");
    expect(result).toContain("文件不存在");
    expect(result).toMatch(/反思|reflection/);
  });

  it("多条反射：每条独立一行", () => {
    const r = new Reflector();
    const result = r.injectIntoPrompt("base prompt", [
      { category: "file_not_found", toolName: "read_file", hint: "文件不存在" },
      { category: "permission_denied", toolName: "bash", hint: "权限被拒" },
    ]);
    expect(result).toContain("read_file");
    expect(result).toContain("bash");
    expect(result).toContain("文件不存在");
    expect(result).toContain("权限被拒");
  });
});

// ---------------------------------------------------------------------------
// 限流
// ---------------------------------------------------------------------------

describe("限流", () => {
  it("maxReflections=5：超过 5 条只保留前 5 条", () => {
    const r = new Reflector({ maxReflections: 5 });
    const items: AnalyzeItem[] = Array.from({ length: 7 }, (_, i) =>
      makeItem(`tool_${i}`, false, {
        kind: ToolKind.Edit,
        error: "OUTSIDE_WRITE_ROOTS",
        data: "fail",
      }),
    );
    const reflections = r.analyze(items, CTX);
    expect(reflections).toHaveLength(5);
  });

  it("maxHintChars：单条 hint 超长被截断", () => {
    const r = new Reflector({ maxHintChars: 50 });
    const longHint = "x".repeat(200);
    // 强制注入一条超长 hint（通过 R4 触发，内部拼装的 hint 不会超长，
    // 因此用 injectIntoPrompt 单独验证截断逻辑）
    const result = r.injectIntoPrompt("base", [
      { category: "out_of_write_root", toolName: "t", hint: longHint },
    ]);
    // 输出长度应 <= 50 + 一些前后缀
    expect(result.length).toBeLessThan(longHint.length);
    expect(result).toContain("...");
  });
});
