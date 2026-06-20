import { createInterface } from "node:readline";
import { existsSync, statSync, lstatSync } from "node:fs";
import { mkdir, readdir, cp, access, realpath } from "node:fs/promises";
import { join } from "node:path";
import chalk from "chalk";

/**
 * Claude Code 全局 skills 目录路径（~/.claude/skills）。
 * 跨平台兼容：优先用 HOME，Windows 下回退到 USERPROFILE。
 */
function getClaudeSkillsDir(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "~";
  return join(home, ".claude", "skills");
}

/**
 * dskcode 全局 skills 目录路径（~/.dskcode/skills）。
 */
function getDskcodeSkillsDir(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "~";
  return join(home, ".dskcode", "skills");
}

/**
 * 判断某个目录是否为一个有效的 skill（包含 SKILL.md）。
 */
async function isSkillDir(dir: string): Promise<boolean> {
  try {
    await access(join(dir, "SKILL.md"));
    return true;
  } catch {
    return false;
  }
}

/**
 * 列出 Claude Code skills 目录下所有有效的 skill 名称（子目录包含 SKILL.md）。
 * 找不到目录返回空数组。
 */
export async function listClaudeSkills(): Promise<string[]> {
  const claudeDir = getClaudeSkillsDir();
  if (!existsSync(claudeDir)) return [];

  let entries: string[];
  try {
    entries = await readdir(claudeDir);
  } catch {
    return [];
  }

  const skills: string[] = [];
  for (const name of entries) {
    const full = join(claudeDir, name);
    const stat = statSync(full);
    if (stat.isDirectory() && (await isSkillDir(full))) {
      skills.push(name);
    }
  }
  return skills;
}

/**
 * 是否存在可导入的 Claude skills。
 */
export async function hasClaudeSkills(): Promise<boolean> {
  const skills = await listClaudeSkills();
  return skills.length > 0;
}

/**
 * 交互式询问用户是否确认。默认接受回车视为"否"。
 * 返回 true 表示用户确认。
 */
function askConfirm(question: string): Promise<boolean> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise<boolean>((resolve) => {
    let resolved = false;

    const cleanup = () => {
      if (resolved) return;
      resolved = true;
      process.stdin.removeListener("keypress", onKeypress);
      rl.close();
    };

    const onKeypress = (_: unknown, key: { ctrl?: boolean; name?: string }) => {
      if (key.ctrl && key.name === "c") {
        cleanup();
        resolve(false);
      }
    };

    process.stdin.on("keypress", onKeypress);

    rl.question(question, (answer) => {
      cleanup();
      const trimmed = answer.trim().toLowerCase();
      // 默认回车 = 否；明确输入 y / yes 才算确认
      resolve(trimmed === "y" || trimmed === "yes");
    });
  });
}

/**
 * 将 Claude skills 目录复制到 ~/.dskcode/skills。
 * 已存在的同名 skill 跳过，避免覆盖用户自定义修改。
 * 返回 { imported, skipped } 两个数组。
 */
export async function importClaudeSkills(
  skillNames: string[],
): Promise<{ imported: string[]; skipped: string[] }> {
  const claudeDir = getClaudeSkillsDir();
  const dskcodeDir = getDskcodeSkillsDir();

  await mkdir(dskcodeDir, { recursive: true });

  const imported: string[] = [];
  const skipped: string[] = [];

  for (const name of skillNames) {
    const src = join(claudeDir, name);
    const dest = join(dskcodeDir, name);

    if (existsSync(dest)) {
      skipped.push(name);
      continue;
    }

    // 递归复制整个 skill 目录，保留原始结构（SKILL.md、reference 等）。
    // 两个解引用手段叠加：
    //   1) realpath() 解决 source 顶层是 symlink 的情况（cp 的 dereference 只处理源目录内部 symlink）
    //   2) cp 的 dereference: true 解决源目录内部遇到的 symlink
    // 这样可以避开 Windows 上非管理员无法创建 symlink 的 EPERM 错误
    // （Claude Code 的 skill 目录往往是 symlink 指向 ~/.agents/skills）。
    const realSrc = lstatSync(src).isSymbolicLink() ? await realpath(src) : src;
    await cp(realSrc, dest, { recursive: true, dereference: true });
    imported.push(name);
  }

  return { imported, skipped };
}

/**
 * 统计全局 ~/.dskcode/skills 下的有效 skill 数量。
 */
export async function countDskcodeSkills(): Promise<number> {
  const dskcodeDir = getDskcodeSkillsDir();
  if (!existsSync(dskcodeDir)) return 0;

  let entries: string[];
  try {
    entries = await readdir(dskcodeDir);
  } catch {
    return 0;
  }

  let count = 0;
  for (const name of entries) {
    const full = join(dskcodeDir, name);
    if (statSync(full).isDirectory() && (await isSkillDir(full))) {
      count++;
    }
  }
  return count;
}

/**
 * 项目本地 skill 目录路径（{cwd}/.dskcode/skill）。
 */
export function getProjectSkillDir(cwd: string): string {
  return join(cwd, ".dskcode", "skill");
}

/**
 * 检测项目本地 .dskcode/skill 目录下是否存在有效 skill。
 */
export async function hasProjectLocalSkills(cwd: string): Promise<boolean> {
  const count = await countProjectLocalSkills(cwd);
  return count > 0;
}

/**
 * 统计项目本地 .dskcode/skill 下的有效 skill 数量。
 */
export async function countProjectLocalSkills(cwd: string): Promise<number> {
  const skillDir = getProjectSkillDir(cwd);
  if (!existsSync(skillDir)) return 0;

  let entries: string[];
  try {
    entries = await readdir(skillDir);
  } catch {
    return 0;
  }

  let count = 0;
  for (const name of entries) {
    const full = join(skillDir, name);
    const stat = statSync(full);
    if (stat.isDirectory() && (await isSkillDir(full))) {
      count++;
    }
  }
  return count;
}

/**
 * 检测全局 ~/.dskcode/skills 目录下是否存在有效 skill。
 */
export async function hasDskcodeSkills(): Promise<boolean> {
  const dskcodeDir = getDskcodeSkillsDir();
  if (!existsSync(dskcodeDir)) return false;

  let entries: string[];
  try {
    entries = await readdir(dskcodeDir);
  } catch {
    return false;
  }

  for (const name of entries) {
    const full = join(dskcodeDir, name);
    const stat = statSync(full);
    if (stat.isDirectory() && (await isSkillDir(full))) {
      return true;
    }
  }
  return false;
}

/**
 * 主流程：检测已有 skill 并决定是否提示导入 Claude Code skill。
 * 通常在 chat 命令的 API Key 检查之后调用。
 *
 * 规则（按优先级）：
 * 1. 如果项目本地 .dskcode/skill 下有 skill，跳过导入
 * 2. 如果全局 ~/.dskcode/skills 下有 skill（已导入过），跳过导入
 * 3. 否则检测 Claude Code 并询问是否导入
 */
export async function promptImportClaudeSkills(cwd?: string): Promise<void> {
  // 检查项目本地 .dskcode/skill
  if (cwd) {
    const hasLocal = await hasProjectLocalSkills(cwd);
    if (hasLocal) {
      console.log(chalk.dim("  检测到项目本地 .dskcode/skill，跳过导入 Claude Code skill\n"));
      return;
    }
  }

  // 检查全局 ~/.dskcode/skills（已经导入过的无需再提示）
  const hasGlobal = await hasDskcodeSkills();
  if (hasGlobal) {
    return;
  }

  const skills = await listClaudeSkills();
  if (skills.length === 0) return;

  console.log(chalk.cyan(`\n  ✦ 检测到你在 Claude Code 中安装了 ${String(skills.length)} 个 skill：`));
  // 每行最多展示 5 个，避免列表过长
  const preview = skills.slice(0, 5).map((s) => chalk.dim(`    · ${s}`)).join("\n");
  console.log(preview);
  if (skills.length > 5) {
    console.log(chalk.dim(`    · ...等 ${String(skills.length)} 个`));
  }
  console.log(chalk.dim(`  源目录: ${getClaudeSkillsDir()}`));
  console.log(chalk.dim(`  目标目录: ${getDskcodeSkillsDir()}\n`));

  const confirmed = await askConfirm(
    `  ${chalk.cyan("📦")} 是否将这些 skill 导入到 dskcode？${chalk.dim("[y/N] ")} `,
  );

  if (!confirmed) {
    console.log(chalk.dim("  已跳过 skill 导入\n"));
    return;
  }

  try {
    const { imported, skipped } = await importClaudeSkills(skills);
    if (imported.length > 0) {
      console.log(
        chalk.green(`  ✔ 已导入 ${String(imported.length)} 个 skill 到 ~/.dskcode/skills`),
      );
    }
    if (skipped.length > 0) {
      console.log(
        chalk.yellow(`  ⚠ ${String(skipped.length)} 个 skill 已存在，已跳过：${skipped.join(", ")}`),
      );
    }
    console.log("");
  } catch (err) {
    console.log(
      chalk.red(`  ✖ 导入 skill 失败: ${err instanceof Error ? err.message : String(err)}`),
    );
    console.log(chalk.dim("  你可以稍后手动复制 ~/.claude/skills 到 ~/.dskcode/skills\n"));
  }
}

// 暴露路径获取函数，便于测试
export { getClaudeSkillsDir, getDskcodeSkillsDir };