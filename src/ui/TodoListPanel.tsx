// ---------------------------------------------------------------------------
// TodoListPanel — 把 TodoList 的当前状态渲染成"任务进度"面板
//
// 设计：
// - 每行格式：`     <图标> <步骤名>`
// - running 状态在图标位置用 <Spinner/>（持续动画）替代静态三角
// - done 用绿色对勾（✅）、failed 用红色（✗）、其余用 dimColor
// - 不显示 # 编号（终端不渲染 #）
// - 不显示 evidence / reason（保持清爽）
// - 不折叠已完成（用户要求全部展示）
// - todo 为空时不渲染（避免空面板噪音）
// ---------------------------------------------------------------------------

import { Box, Text } from "ink";
import InkSpinner from "ink-spinner";
import type { TodoItem, TodoStatus } from "../harness/todo-list.js";

interface TodoListPanelProps {
  items: ReadonlyArray<TodoItem>;
}

/** 非 running 状态用静态符号；running 单独走 Spinner 组件以保持动画 */
function statusIcon(status: TodoStatus): string {
  switch (status) {
    case "pending": return "☐";
    case "done":    return "☑";
    case "failed":  return "✗";
    case "skipped": return "⊘";
    // running 不走这里，由 TodoIcon 走 Spinner 组件
    case "running": return "▶";
  }
}

/**
 * 单行图标渲染：running 走动画 Spinner，其余走静态符号。
 * 抽成独立组件以让 React 识别 props 变化并重绘动画帧。
 */
function TodoIcon({ status }: { status: TodoStatus }) {
  if (status === "running") {
    return (
      <Text color="cyan">
        <InkSpinner type="dots" />
      </Text>
    );
  }
  // done 用绿色对勾，与 running 的 spinner / 静态状态在颜色上区分
  if (status === "done") {
    return <Text color="green">✅</Text>;
  }
  // failed 用红色，其它状态用 dimColor
  if (status === "failed") {
    return <Text color="red">{statusIcon(status)}</Text>;
  }
  return <Text dimColor>{statusIcon(status)}</Text>;
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
          <Text dimColor>{"     "}</Text>
          <TodoIcon status={it.status} />
          <Text dimColor>{` ${it.content}`}</Text>
        </Box>
      ))}
    </Box>
  );
}
