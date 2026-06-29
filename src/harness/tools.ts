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
 * 把 TodoList 包装成 5 个 AgentTool，供 Session 注入到 ToolRegistry。
 *
 * 工具集：
 * - `todo_add` — 添加新步骤
 * - `todo_mark_running` — 把 pending 推进到 running（依赖必须已 done/skipped）
 * - `todo_mark_done` — 把 running 标记完成（不允许从 pending 跳过 running）
 * - `todo_mark_failed` — 把 running 标记失败（不允许从 pending 跳过 running）
 * - `todo_retry` — 把 failed 重置回 pending
 *
 * @param todoList — 共享的 TodoList 实例
 * @returns 5 个工具的数组
 */
export function createHarnessTools(todoList: TodoList): AgentTool<unknown>[] {
  return [
    makeTodoAddTool(todoList),
    makeTodoMarkRunningTool(todoList),
    makeTodoMarkDoneTool(todoList),
    makeTodoMarkFailedTool(todoList),
    makeTodoRetryTool(todoList),
  ];
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
      "⚠️ 【复杂任务第一步】添加一个待办到当前任务进度。\n\n" +
      "什么情况下调我：\n" +
      "  - 需要多步才能完成（改多个文件 / 跨多轮）\n" +
      "  - 需先读后改（edit/write 之前）\n" +
      "  - 依赖外部状态（文件、API、运行结果）\n\n" +
      "什么情况下不要调：\n" +
      "  - 一句话能完成的事（查、列、问）\n\n" +
      "用法：每次加一个 step，多步就调多次。有依赖关系传 deps=[前步 id]。返回分配的 id，后续用 todo_mark_done / todo_mark_failed 引用。\n\n" +
      "示例：用户说「把 X 改成 Y」→ 调 1) todo_add(\"读 X\")  2) todo_add(\"改 X\", deps=[0])  3) todo_add(\"检查改动\", deps=[1])",
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
      try {
        const id = todoList.add(args.content, deps);
        return {
          success: true,
          data: `已添加 todo #${id}：${args.content}${deps.length > 0 ? `（依赖: ${deps.join(", ")})` : ""}`,
          summary: `📋 添加 #${id}`,
        };
      } catch (err) {
        return {
          success: false,
          data: err instanceof Error ? err.message : String(err),
          error: "TODO_DEPS_INVALID",
        };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// todo_mark_running
// ---------------------------------------------------------------------------

interface TodoMarkRunningArgs {
  id: number;
}

/**
 * 把 pending 推进到 running。
 *
 * 不允许从其他状态转换（避免破坏依赖语义：必须先 mark_running，再 mark_done/failed）。
 */
function makeTodoMarkRunningTool(todoList: TodoList): AgentTool<TodoMarkRunningArgs> {
  return {
    name: "todo_mark_running",
    kind: ToolKind.Other,
    description:
      "把 todo 从 pending 推进到 running，表示你「正在做」这一步。\n" +
      "前提：该 todo 存在、当前是 pending、且所有 deps 已 done 或 skipped。\n" +
      "工作流：先调 todo_mark_running，再去调实际的工具（read_file / edit_file 等），最后用 todo_mark_done 或 todo_mark_failed 收尾。\n" +
      "**不要跳过 mark_running 直接 mark_done** — 会破坏依赖检查，下游步骤可能误以为依赖已满足。",
    parameters: {
      type: "object",
      properties: {
        id: { type: "number", description: "todo 的 id" },
      },
      required: ["id"],
      additionalProperties: false,
    },

    async execute(args): Promise<ToolResult> {
      if (typeof args?.id !== "number") {
        return { success: false, data: "缺少 id 参数", error: "INVALID_ARGS" };
      }
      const item = todoList.items.find((it) => it.id === args.id);
      if (!item) {
        return { success: false, data: `todo #${args.id} 不存在`, error: "TODO_NOT_FOUND" };
      }
      if (item.status !== "pending") {
        return {
          success: false,
          data: `todo #${args.id} 当前状态是 ${item.status}，只有 pending 可以推进到 running`,
          error: "TODO_INVALID_STATE",
        };
      }
      const ok = todoList.markRunning(args.id);
      if (!ok) {
        return {
          success: false,
          data: `todo #${args.id} 依赖未全部完成（依赖: #${item.deps.join(", #")}）`,
          error: "TODO_DEPS_NOT_READY",
        };
      }
      return {
        success: true,
        data: `已开始 todo #${args.id}：${item.content}`,
        summary: `▶ 开始 #${args.id}`,
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

/**
 * 把 running 标记完成。
 *
 * 故意不允许从 pending 直接 done：必须先 todo_mark_running，避免 LLM 跳过「声明开始」这一步。
 */
function makeTodoMarkDoneTool(todoList: TodoList): AgentTool<TodoMarkDoneArgs> {
  return {
    name: "todo_mark_done",
    kind: ToolKind.Other,
    description:
      "把 todo 标记为完成。evidence 填「完成证据」（如「读到 120 行」、「typecheck 通过」、「edit 成功」），不填也行。\n" +
      "前提：当前状态必须是 running。若还是 pending，先调 todo_mark_running。",
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
      const item = todoList.items.find((it) => it.id === args.id);
      if (!item) {
        return { success: false, data: `todo #${args.id} 不存在`, error: "TODO_NOT_FOUND" };
      }
      if (item.status !== "running") {
        return {
          success: false,
          data: `todo #${args.id} 当前状态是 ${item.status}，只有 running 可以 mark_done；如需重试请先 todo_retry`,
          error: "TODO_INVALID_STATE",
        };
      }
      const ok = todoList.markDone(args.id, args.evidence);
      if (!ok) {
        return { success: false, data: `todo #${args.id} 状态转换失败`, error: "TODO_INVALID" };
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

/**
 * 把 running 标记失败。
 *
 * 故意不允许从 pending 直接 failed：必须先 todo_mark_running。
 */
function makeTodoMarkFailedTool(todoList: TodoList): AgentTool<TodoMarkFailedArgs> {
  return {
    name: "todo_mark_failed",
    kind: ToolKind.Other,
    description:
      "把 todo 标记为失败，reason 填「失败原因」（如「old_text 拼错」、「文件不存在」）。\n" +
      "前提：当前状态必须是 running。若还是 pending，先调 todo_mark_running。\n" +
      "调用后该 step 状态变为 failed。想重试：调 todo_retry(id) 重置回 pending，再 mark_running → 跑工具 → mark_done。",
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
      const item = todoList.items.find((it) => it.id === args.id);
      if (!item) {
        return { success: false, data: `todo #${args.id} 不存在`, error: "TODO_NOT_FOUND" };
      }
      if (item.status !== "running") {
        return {
          success: false,
          data: `todo #${args.id} 当前状态是 ${item.status}，只有 running 可以 mark_failed`,
          error: "TODO_INVALID_STATE",
        };
      }
      const ok = todoList.markFailed(args.id, args.reason);
      if (!ok) {
        return { success: false, data: `todo #${args.id} 状态转换失败`, error: "TODO_INVALID" };
      }
      return {
        success: true,
        data: `已标记 todo #${args.id} 失败：${args.reason}`,
        summary: `❌ 失败 #${args.id}`,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// todo_retry
// ---------------------------------------------------------------------------

interface TodoRetryArgs {
  id: number;
}

/**
 * 把 failed 重置回 pending，用于「修完 bug 再重跑一次」。
 */
function makeTodoRetryTool(todoList: TodoList): AgentTool<TodoRetryArgs> {
  return {
    name: "todo_retry",
    kind: ToolKind.Other,
    description:
      "把失败的 todo 重置回 pending（清空 evidence），然后你可以重新走 todo_mark_running → 跑工具 → todo_mark_done 的流程。\n" +
      "前提：当前状态必须是 failed。done / skipped / running 不允许重试（done 不可反悔、running 应先 mark_failed）。",
    parameters: {
      type: "object",
      properties: {
        id: { type: "number", description: "todo 的 id" },
      },
      required: ["id"],
      additionalProperties: false,
    },

    async execute(args): Promise<ToolResult> {
      if (typeof args?.id !== "number") {
        return { success: false, data: "缺少 id 参数", error: "INVALID_ARGS" };
      }
      const item = todoList.items.find((it) => it.id === args.id);
      if (!item) {
        return { success: false, data: `todo #${args.id} 不存在`, error: "TODO_NOT_FOUND" };
      }
      if (item.status !== "failed") {
        return {
          success: false,
          data: `todo #${args.id} 当前状态是 ${item.status}，只有 failed 可以重试`,
          error: "TODO_INVALID_STATE",
        };
      }
      const ok = todoList.resetForRetry(args.id);
      if (!ok) {
        return { success: false, data: `todo #${args.id} 状态转换失败`, error: "TODO_INVALID" };
      }
      return {
        success: true,
        data: `已重置 todo #${args.id} 为 pending，可重新跑`,
        summary: `🔄 重试 #${args.id}`,
      };
    },
  };
}
