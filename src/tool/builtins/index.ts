// ---------------------------------------------------------------------------
// 内置工具 — 注册所有内置工具的工厂函数
// ---------------------------------------------------------------------------

import { type AnyAgentTool, eraseTool } from "../types.js";
import { readFileTool } from "./read-file.js";
import { writeFileTool } from "./write-file.js";
import { editFileTool } from "./edit-file.js";
import { multiEditTool } from "./multi-edit.js";
import { deleteRangeTool } from "./delete-range.js";
import { bashTool } from "./bash.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { lsTool } from "./ls.js";
import { fetchTool } from "./fetch.js";

/** 所有内置工具列表（类型已擦除，可直接用于注册） */
export const builtinTools: AnyAgentTool[] = [
  eraseTool(readFileTool),
  eraseTool(writeFileTool),
  eraseTool(editFileTool),
  eraseTool(multiEditTool),
  eraseTool(deleteRangeTool),
  eraseTool(bashTool),
  eraseTool(globTool),
  eraseTool(grepTool),
  eraseTool(lsTool),
  eraseTool(fetchTool),
];

/**
 * 获取所有内置工具映射表（按名称索引）。
 */
export function getBuiltinToolMap(): Map<string, AnyAgentTool> {
  return new Map(builtinTools.map((t) => [t.name, t]));
}
