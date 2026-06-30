// ---------------------------------------------------------------------------
// 工具系统公共 API
// ---------------------------------------------------------------------------

// 核心类型
export {
  ToolKind,
  type JSONSchema,
  type ToolContext,
  type ToolResult,
  type FileDiff,
  type AgentTool,
  type AnyAgentTool,
  type Gate,
  type ToolCallRecord,
  eraseTool,
  extractDescription,
  isReadOnly,
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
  stripMentionPrefix,
} from "./sandbox.js";

// Diff 计算
export { computeFileDiff, applyChange } from "./diff.js";

// EOL 风格检测与保留（写工具统一使用）
export { detectEol, hasTrailingNewline, normalizeEol, writeFileWithEol } from "./eol.js";

// 内置工具
export { builtinTools, getBuiltinToolMap } from "./builtins/index.js";
export type { ReadFileArgs } from "./builtins/read-file.js";
export { readFileTool } from "./builtins/read-file.js";
export type { WriteFileArgs } from "./builtins/write-file.js";
export { writeFileTool } from "./builtins/write-file.js";
export type { EditFileArgs } from "./builtins/edit-file.js";
export { editFileTool } from "./builtins/edit-file.js";
export type { MultiEditArgs, EditStep } from "./builtins/multi-edit.js";
export { multiEditTool } from "./builtins/multi-edit.js";
export type { DeleteRangeArgs } from "./builtins/delete-range.js";
export { deleteRangeTool } from "./builtins/delete-range.js";
export type { BashArgs } from "./builtins/bash.js";
export { bashTool } from "./builtins/bash.js";
export type { GlobArgs } from "./builtins/glob.js";
export { globTool } from "./builtins/glob.js";
export type { GrepArgs } from "./builtins/grep.js";
export { grepTool } from "./builtins/grep.js";
export type { LsArgs } from "./builtins/ls.js";
export { lsTool } from "./builtins/ls.js";
export type { FetchArgs } from "./builtins/fetch.js";
export { fetchTool } from "./builtins/fetch.js";
