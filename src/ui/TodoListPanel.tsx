// ---------------------------------------------------------------------------
// TodoListPanel — 把 TodoList 的当前状态渲染成"任务进度"面板
//
// 设计：
// - 每行格式：`     <图标> <步骤名>`（图标用 checkbox / 三角 / 叉号风格）
// - 不显示 # 编号（终端不渲染 #）
// - 不显示 evidence / reason（保持清爽）
// - 不折叠已完成（用户要求全部展示）
// - todo 为空时不渲染（避免空面板噪音）
// ---------------------------------------------------------------------------

import { Box, Text } from "ink";
import type { TodoItem, TodoStatus } from "../harness/todo-list.js";

interface TodoListPanelProps {
  items: ReadonlyArray<TodoItem>;
}

function statusIcon(status: TodoStatus): string {
  switch (status) {
    case "pending": return "☐";
    case "running": return "▶";
    case "done":    return "☑";
    case "failed":  return "✗";
    case "skipped": return "⊘";
  }
}

/**
 * 把 todo 列表渲染成多行"任务进度"面板。
 * 步骤按原列表顺序展示（id 升序），不做截断 / 折叠。
 */
export function TodoListPanel({ items }: TodoListPanelProps) {
  if (items.length === 0) return null;

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text dimColor>🔧 任务进度</Text>
      </Box>
      {items.map((it) => (
        <Box key={it.id}>
          <Text dimColor>{`     ${statusIcon(it.status)} ${it.content}`}</Text>
        </Box>
      ))}
    </Box>
  );
}
