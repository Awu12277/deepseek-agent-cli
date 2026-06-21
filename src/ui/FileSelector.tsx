// ---------------------------------------------------------------------------
// FileSelector — 用户输入 @ 时渲染的文件列表组件
// ---------------------------------------------------------------------------

import { Box, Text } from "ink";

interface FileSelectorProps {
  /** 所有项目文件路径列表（相对于 CWD） */
  files: string[];
  /** 当前输入框文本 */
  input: string;
  /** 当前选中的文件索引 */
  selectedIndex: number;
}

const HIGHLIGHT_COLOR = "#00ff41";

export function FileSelector({ files, input, selectedIndex }: FileSelectorProps) {
  // 匹配规则：@ 必须在输入开头，或者前面有空格
  const match = input.match(/(?:^|\s)@([^@]*)$/);
  if (!match) return null;

  const query = match[1]!.toLowerCase().trim();
  if (files.length === 0) return null;

  // @ 在开头且无后续内容时，展示前 5 个文件作为提示
  const matched = !query && input.startsWith("@")
    ? files.slice(0, 5)
    : files
        .filter((f) => f.toLowerCase().includes(query))
        .slice(0, 5);

  // 精确匹配时表示已补全完成，不显示列表
  if (query && matched.some((f) => f.toLowerCase() === query)) return null;

  if (matched.length === 0) return null;

  return (
    <Box flexDirection="column" marginLeft={4} marginTop={1}>
      <Text color="#808080" dimColor>
        项目文件：
      </Text>
      {matched.map((file, i) => (
        <Box key={file}>
          <Text color={i === selectedIndex ? HIGHLIGHT_COLOR : "#808080"}>
            {i === selectedIndex ? "  › " : "    "}{file}
          </Text>
        </Box>
      ))}
      <Box marginTop={1}>
        <Text color="#808080" dimColor>
          ↑↓ 选择 · Tab 补全
        </Text>
      </Box>
    </Box>
  );
}
