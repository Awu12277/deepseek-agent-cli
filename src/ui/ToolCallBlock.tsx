// ---------------------------------------------------------------------------
// 工具调用块组件 — 在终端中渲染单个工具调用
// ---------------------------------------------------------------------------

import { Box, Text } from "ink";
import type { ProviderToolCall } from "../provider/index.js";

interface ToolCallBlockProps {
  call: ProviderToolCall;
  /** 是否显示"等待执行"提示（默认 true） */
  showPendingHint?: boolean;
}

/**
 * 格式化工具调用参数的摘要。
 * 短参数直接展示，长参数截断。
 */
function formatArgsSummary(args: string): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const parsed = JSON.parse(args) as unknown as Record<string, unknown>;
    const lines = Object.entries(parsed).map(([key, value]) => {
      const val = String(value);
      const truncated = val.length > 80 ? val.slice(0, 77) + "..." : val;
      return `     ${key}: ${truncated}`;
    });
    return lines.join("\n");
  } catch {
    // 无法解析的 JSON，直接截断展示
    const truncated = args.length > 120 ? args.slice(0, 117) + "..." : args;
    return `     ${truncated}`;
  }
}

/**
 * 渲染单个工具调用信息块。
 *
 * 显示效果：
 *   📦 read_file ─────────────────
 *      📂 path: src/provider/types.ts
 *      ⏳ 等待执行
 */
export function ToolCallBlock({ call, showPendingHint = true }: ToolCallBlockProps) {
  const argsDisplay = formatArgsSummary(call.arguments);

  return (
    <Box flexDirection="column" marginLeft={3} marginTop={1}>
      <Box>
        <Text color="#00ffff" bold>📦 {call.name}</Text>
        <Text color="#555555"> {"─".repeat(Math.max(1, 30 - call.name.length))}</Text>
      </Box>
      <Box flexDirection="column">
        <Text color="#888888">{argsDisplay}</Text>
      </Box>
      {showPendingHint && (
        <Box>
          <Text color="yellow">⏳ 等待执行</Text>
        </Box>
      )}
    </Box>
  );
}