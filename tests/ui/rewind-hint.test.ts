// 单元测试：ChatSession 导出的文件修改工具判定
import { describe, it, expect } from "vitest";
import { isFileMutatingTool } from "../../src/ui/ChatSession.js";

describe("isFileMutatingTool", () => {
  it("识别 edit_file / write_file / multi_edit / delete_range 为修改类", () => {
    expect(isFileMutatingTool("edit_file")).toBe(true);
    expect(isFileMutatingTool("write_file")).toBe(true);
    expect(isFileMutatingTool("multi_edit")).toBe(true);
    expect(isFileMutatingTool("delete_range")).toBe(true);
  });
  it("其他工具不视为修改类", () => {
    expect(isFileMutatingTool("read_file")).toBe(false);
    expect(isFileMutatingTool("glob")).toBe(false);
    expect(isFileMutatingTool("grep")).toBe(false);
    expect(isFileMutatingTool("ls")).toBe(false);
    expect(isFileMutatingTool("fetch")).toBe(false);
    expect(isFileMutatingTool("bash")).toBe(false);
  });
});
