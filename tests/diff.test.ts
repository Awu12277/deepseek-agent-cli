// ---------------------------------------------------------------------------
// Diff 计算模块测试
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { computeFileDiff } from "../src/tool/diff.js";

// ---------------------------------------------------------------------------
// computeFileDiff 基础测试
// ---------------------------------------------------------------------------

describe("computeFileDiff", () => {
  // --- 快速路径 ---

  it("内容完全相同时返回空 diff", () => {
    const result = computeFileDiff("hello\nworld\n", "hello\nworld\n", "/test/a.ts");
    expect(result.patch).toBe("");
    expect(result.additions).toBe(0);
    expect(result.deletions).toBe(0);
    expect(result.existedBefore).toBe(true);
  });

  it("空字符串到有内容 — 新建文件", () => {
    const newContent = "line1\nline2\n";
    const result = computeFileDiff("", newContent, "/test/new.ts");

    expect(result.existedBefore).toBe(false);
    expect(result.additions).toBe(2);
    expect(result.deletions).toBe(0);
    expect(result.patch).toContain("--- /dev/null");
    expect(result.patch).toContain("+++ b/new.ts");
    expect(result.patch).toContain("+line1");
    expect(result.patch).toContain("+line2");
  });

  it("有内容到空字符串 — 删除文件", () => {
    const oldContent = "line1\nline2\n";
    const result = computeFileDiff(oldContent, "", "/test/del.ts");

    expect(result.existedBefore).toBe(true);
    expect(result.additions).toBe(0);
    expect(result.deletions).toBe(2);
    expect(result.patch).toContain("--- a/del.ts");
    expect(result.patch).toContain("+++ /dev/null");
    expect(result.patch).toContain("-line1");
    expect(result.patch).toContain("-line2");
  });

  // --- 单行变更 ---

  it("单行替换", () => {
    const oldContent = "hello\n";
    const newContent = "world\n";
    const result = computeFileDiff(oldContent, newContent, "/test/a.ts");

    expect(result.additions).toBe(1);
    expect(result.deletions).toBe(1);
    expect(result.patch).toContain("-hello");
    expect(result.patch).toContain("+world");
  });

  it("在文件末尾追加一行", () => {
    const oldContent = "line1\nline2\n";
    const newContent = "line1\nline2\nline3\n";
    const result = computeFileDiff(oldContent, newContent, "/test/a.ts");

    expect(result.additions).toBe(1);
    expect(result.deletions).toBe(0);
    expect(result.patch).toContain("+line3");
  });

  it("在文件开头插入一行", () => {
    const oldContent = "line2\nline3\n";
    const newContent = "line1\nline2\nline3\n";
    const result = computeFileDiff(oldContent, newContent, "/test/a.ts");

    expect(result.additions).toBe(1);
    expect(result.deletions).toBe(0);
    expect(result.patch).toContain("+line1");
  });

  it("删除中间一行", () => {
    const oldContent = "line1\nline2\nline3\n";
    const newContent = "line1\nline3\n";
    const result = computeFileDiff(oldContent, newContent, "/test/a.ts");

    expect(result.additions).toBe(0);
    expect(result.deletions).toBe(1);
    expect(result.patch).toContain("-line2");
  });

  // --- 多行变更 ---

  it("连续多行替换", () => {
    const oldContent = "a\nb\nc\nd\n";
    const newContent = "a\nx\ny\nd\n";
    const result = computeFileDiff(oldContent, newContent, "/test/a.ts");

    expect(result.additions).toBe(2);
    expect(result.deletions).toBe(2);
    expect(result.patch).toContain("-b");
    expect(result.patch).toContain("-c");
    expect(result.patch).toContain("+x");
    expect(result.patch).toContain("+y");
  });

  it("只修改一行，其他不变", () => {
    const oldContent = "line1\nline2\nline3\nline4\nline5\n";
    const newContent = "line1\nMODIFIED\nline3\nline4\nline5\n";
    const result = computeFileDiff(oldContent, newContent, "/test/a.ts");

    expect(result.additions).toBe(1);
    expect(result.deletions).toBe(1);
    expect(result.patch).toContain("-line2");
    expect(result.patch).toContain("+MODIFIED");
    // 上下文行应该出现
    expect(result.patch).toContain(" line1");
    expect(result.patch).toContain(" line3");
  });

  // --- 文件路径处理 ---

  it("从 Unix 路径提取文件名", () => {
    const result = computeFileDiff("a\n", "b\n", "/home/user/project/src/index.ts");
    expect(result.patch).toContain("+++ b/index.ts");
    expect(result.patch).toContain("--- a/index.ts");
  });

  it("从 Windows 路径提取文件名", () => {
    const result = computeFileDiff("a\n", "b\n", "C:\\Users\\project\\src\\main.ts");
    expect(result.patch).toContain("+++ b/main.ts");
    expect(result.patch).toContain("--- a/main.ts");
  });

  // --- 统计准确性 ---

  it("空内容到空内容（两个空字符串）", () => {
    const result = computeFileDiff("", "", "/test/empty.ts");
    expect(result.patch).toBe("");
    expect(result.additions).toBe(0);
    expect(result.deletions).toBe(0);
    expect(result.existedBefore).toBe(false);
  });

  it("filePath 正确存储", () => {
    const result = computeFileDiff("a\n", "b\n", "/custom/path.ts");
    expect(result.filePath).toBe("/custom/path.ts");
  });

  // --- 不以换行结尾的文件 ---

  it("文件不以换行结尾", () => {
    const oldContent = "line1\nline2";
    const newContent = "line1\nmodified";
    const result = computeFileDiff(oldContent, newContent, "/test/a.ts");

    expect(result.additions).toBe(1);
    expect(result.deletions).toBe(1);
    expect(result.patch).toContain("-line2");
    expect(result.patch).toContain("+modified");
  });
});

// ---------------------------------------------------------------------------
// 与 write_file / edit_file 集成的验证（通过 computeFileDiff）
// ---------------------------------------------------------------------------

describe("computeFileDiff — edit_file 场景", () => {
  it("edit_file 场景：替换一小段文本", () => {
    // 模拟 edit_file 的场景：替换一部分文本
    const oldContent = "function hello() {\n  console.log('hello');\n}\n";
    const newContent = "function hello() {\n  console.log('world');\n}\n";

    const result = computeFileDiff(oldContent, newContent, "/src/index.ts");

    expect(result.additions).toBe(1);
    expect(result.deletions).toBe(1);
    expect(result.patch).toContain("-  console.log('hello');");
    expect(result.patch).toContain("+  console.log('world');");
    expect(result.existedBefore).toBe(true);
  });

  it("write_file 场景：新建文件（从空到有内容）", () => {
    const newContent = "import { hello } from './hello';\n\nhello();\n";
    const result = computeFileDiff("", newContent, "/src/new-module.ts");

    expect(result.existedBefore).toBe(false);
    expect(result.additions).toBe(3);
    expect(result.deletions).toBe(0);
    expect(result.patch).toContain("--- /dev/null");
    expect(result.patch).toContain("+++ b/new-module.ts");
    expect(result.patch).toContain("+import");
  });

  it("write_file 场景：覆盖已有文件", () => {
    const oldContent = "old line 1\nold line 2\n";
    const newContent = "new line 1\nnew line 2\n";
    const result = computeFileDiff(oldContent, newContent, "/src/existing.ts");

    expect(result.existedBefore).toBe(true);
    expect(result.additions).toBe(2);
    expect(result.deletions).toBe(2);
  });
});