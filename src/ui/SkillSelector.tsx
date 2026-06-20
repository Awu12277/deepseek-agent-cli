// ---------------------------------------------------------------------------
// SkillSelector — 用户输入 / 时渲染的 skill 列表组件
// 通过 selectedIndex 高亮当前选中项，按 Tab/Enter 可补全 skill 名称
// ---------------------------------------------------------------------------

import { Box, Text } from "ink";
import type { SkillInfo } from "../cli/skill-import.js";

const HIGHLIGHT_COLOR = "#00bfff";

interface SkillSelectorProps {
  /** 所有可用 skill 列表 */
  skills: SkillInfo[];
  /** 当前输入框文本 */
  input: string;
  /** 当前选中的 skill 索引 */
  selectedIndex: number;
}

export function SkillSelector({ skills, input, selectedIndex }: SkillSelectorProps) {
  // 匹配规则：/ 必须在输入开头，或者前面有空格
  const match = input.match(/(?:^|\s)\/([^/]*)$/);
  if (!match) return null;

  const query = match[1]!.toLowerCase().trim();
  if (skills.length === 0) return null;

  // 斜杠在开头且无后续内容时，展示全部 skill 作为提示
  const matched = !query && input.startsWith("/")
    ? skills.slice(0, 3)
    : skills
        .filter((s) => s.name.toLowerCase().includes(query))
        .slice(0, 3);

  // 精确匹配时表示已补全完成，不显示列表
  if (query && matched.length > 0 && matched.some((s) => s.name.toLowerCase() === query)) return null;

  if (matched.length === 0) return null;

  return (
    <Box flexDirection="column" marginLeft={4} marginTop={1}>
      <Text color="#808080" dimColor>
        支持的 Skill：
      </Text>
      {matched.map((skill, i) => (
        <Box key={skill.name}>
          <Text color={i === selectedIndex ? HIGHLIGHT_COLOR : "#808080"}>
            {i === selectedIndex ? "  › " : "    "}{skill.name}
          </Text>
        </Box>
      ))}
      <Box marginTop={1}>
        <Text color="#808080" dimColor>
          ↑↓ 选择 · Tab/Enter 补全
        </Text>
      </Box>
    </Box>
  );
}
