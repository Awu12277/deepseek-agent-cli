// ---------------------------------------------------------------------------
// Harness 工具 — 把 TodoList 暴露给 LLM 主动调用的工具集
//
// 设计：
// - 3 个工具：todo_add / todo_mark_done / todo_mark_failed
// - 每个工具都接收一个 Session-side 的 TodoList 引用（通过闭包）
// - 不让 LLM 直接读 todo（用 system prompt 注入，避免增加决策负担）
//
// 函数注释规范见仓库根 AGENTS.md「函数注释规范」一节。
// ---------------------------------------------------------------------------

import { ToolKind, type AgentTool, type ToolResult } from "../tool/types.js";
import type { TodoList } from "./todo-list.js";

/**
 * 把 TodoList 包装成 3 个 AgentTool，供 Session 注入到 ToolRegistry。
 *
 * @param todoList — 共享的 TodoList 实例
 * @returns 3 个工具的数组
 */
export function createHarnessTools(todoList: TodoList): AgentTool<unknown>[] {
  return [makeTodoAddTool(todoList), makeTodoMarkDoneTool(todoList), makeTodoMarkFailedTool(todoList)];
}

// ---------------------------------------------------------------------------
// todo_add
// ---------------------------------------------------------------------------

interface TodoAddArgs {
  /** 步骤描述（中文） */
  content: string;
  /** 依赖的 todo id 列表（可选） */
  deps?: number[];
}

function makeTodoAddTool(todoList: TodoList): AgentTool<TodoAddArgs> {
  return {
    name: "todo_add",
    kind: ToolKind.Other,
    description:
      "添加一个待办到当前任务进度。复杂任务应该先用 todo_add 把规划拆成步骤，然后按顺序执行。" +
      "每次只能加一个，多次调用即可。返回分配的数字 id，后续 todo_mark_done/mark_failed 引用。",
    parameters: {
      type: "object",
      properties: {
        content: { type: "string", description: "步骤描述（中文，建议简洁）" },
        deps: {
          type: "array",
          description: "依赖的 todo id 数组（这些都 done 后本项才可执行）",
          items: { type: "number" },
        },
      },
      required: ["content"],
      additionalProperties: false,
    },

    async execute(args): Promise<ToolResult> {
      if (typeof args?.content !== "string" || args.content.length === 0) {
        return { success: false, data: "缺少 content 参数", error: "INVALID_ARGS" };
      }
      const deps = Array.isArray(args.deps) ? args.deps.filter((d) => typeof d === "number") : [];
      const id = todoList.add(args.content, deps);
      return {
        success: true,
        data: `已添加 todo #${id}：${args.content}${deps.length > 0 ? `（依赖: ${deps.join(", ")})` : ""}`,
        summary: `📋 添加 #${id}`,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// todo_mark_done
// ---------------------------------------------------------------------------

interface TodoMarkDoneArgs {
  id: number;
  /** 可选：完成证据（一句话） */
  evidence?: string;
}

function makeTodoMarkDoneTool(todoList: TodoList): AgentTool<TodoMarkDoneArgs> {
  return {
    name: "todo_mark_done",
    kind: ToolKind.Other,
    description: "把 todo 标记为完成（必须先 mark_running，但本工具同时自动 mark_running）。",
    parameters: {
      type: "object",
      properties: {
        id: { type: "number", description: "todo 的 id" },
        evidence: { type: "string", description: "完成证据（一句话，可选）" },
      },
      required: ["id"],
      additionalProperties: false,
    },

    async execute(args): Promise<ToolResult> {
      if (typeof args?.id !== "number") {
        return { success: false, data: "缺少 id 参数", error: "INVALID_ARGS" };
      }
      // 自动 mark_running（如果还 pending），保证状态机一致
      todoList.markRunning(args.id);
      const ok = todoList.markDone(args.id, args.evidence);
      if (!ok) {
        return { success: false, data: `todo #${args.id} 不存在或已完成/失败`, error: "TODO_INVALID" };
      }
      return {
        success: true,
        data: `已标记 todo #${args.id} 完成${args.evidence ? `：${args.evidence}` : ""}`,
        summary: `✅ 完成 #${args.id}`,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// todo_mark_failed
// ---------------------------------------------------------------------------

interface TodoMarkFailedArgs {
  id: number;
  /** 失败原因（一句话） */
  reason: string;
}

function makeTodoMarkFailedTool(todoList: TodoList): AgentTool<TodoMarkFailedArgs> {
  return {
    name: "todo_mark_failed",
    kind: ToolKind.Other,
    description: "把 todo 标记为失败，附失败原因。失败会被 Reflector 看到，触发重新规划。",
    parameters: {
      type: "object",
      properties: {
        id: { type: "number", description: "todo 的 id" },
        reason: { type: "string", description: "失败原因（一句话）" },
      },
      required: ["id", "reason"],
      additionalProperties: false,
    },

    async execute(args): Promise<ToolResult> {
      if (typeof args?.id !== "number") {
        return { success: false, data: "缺少 id 参数", error: "INVALID_ARGS" };
      }
      if (typeof args?.reason !== "string") {
        return { success: false, data: "缺少 reason 参数", error: "INVALID_ARGS" };
      }
      todoList.markRunning(args.id);
      const ok = todoList.markFailed(args.id, args.reason);
      if (!ok) {
        return { success: false, data: `todo #${args.id} 不存在或已完成`, error: "TODO_INVALID" };
      }
      return {
        success: true,
        data: `已标记 todo #${args.id} 失败：${args.reason}`,
        summary: `❌ 失败 #${args.id}`,
      };
    },
  };
}
