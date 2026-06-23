// ---------------------------------------------------------------------------
// 工具系统公共 API
// ---------------------------------------------------------------------------

// 核心类型
export type {
  JSONSchema,
  ToolContext,
  ToolResult,
  FileDiff,
  Tool,
  Previewer,
  Gate,
  ToolCallRecord,
} from "./types.js";
export { AlwaysAllowGate } from "./types.js";

// 注册表
export { ToolRegistry } from "./registry.js";
export type { ToolRegistryOptions } from "./registry.js";

// 沙箱工具
export {
  resolvePath,
  confine,
  truncateOutput,
  getDefaultTimeout,
  getDefaultMaxFileSize,
  createTimeoutSignal,
  execCommand,
} from "./sandbox.js";

// Diff 计算
export { computeFileDiff, applyChange } from "./diff.js";

// EOL 风格检测与保留（写工具统一使用）
export { detectEol, hasTrailingNewline, normalizeEol, writeFileWithEol } from "./eol.js";

// 内置工具
export { builtinTools, getBuiltinToolMap } from "./builtins/index.js";
export { readFileTool } from "./builtins/read-file.js";
export { writeFileTool } from "./builtins/write-file.js";
export { editFileTool } from "./builtins/edit-file.js";
export { multiEditTool } from "./builtins/multi-edit.js";
export { deleteRangeTool } from "./builtins/delete-range.js";
export { bashTool } from "./builtins/bash.js";
export { globTool } from "./builtins/glob.js";
export { grepTool } from "./builtins/grep.js";
export { lsTool } from "./builtins/ls.js";
export { fetchTool } from "./builtins/fetch.js";
