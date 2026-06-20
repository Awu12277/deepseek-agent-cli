import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listClaudeSkills,
  importClaudeSkills,
  getClaudeSkillsDir,
  getDskcodeSkillsDir,
} from "../src/cli/skill-import.js";
import { existsSync, readdirSync } from "node:fs";

/**
 * 通过临时改写 HOME / USERPROFILE 让路径解析指向 tmp。
 */
function setHome(home: string) {
  process.env.HOME = home;
  process.env.USERPROFILE = home;
}

describe("skill-import", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "dskcode-skill-test-"));
    setHome(home);
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("路径基于 HOME 解析", () => {
    expect(getClaudeSkillsDir()).toBe(join(home, ".claude", "skills"));
    expect(getDskcodeSkillsDir()).toBe(join(home, ".dskcode", "skills"));
  });

  it("Claude skills 目录不存在时返回空数组", async () => {
    expect(await listClaudeSkills()).toEqual([]);
  });

  it("只列出有 SKILL.md 的子目录", async () => {
    const claudeSkills = getClaudeSkillsDir();
    await mkdir(join(claudeSkills, "alpha"), { recursive: true });
    await writeFile(join(claudeSkills, "alpha", "SKILL.md"), "alpha skill");
    await mkdir(join(claudeSkills, "beta"), { recursive: true });
    // beta 没有 SKILL.md，应被忽略
    await mkdir(join(claudeSkills, "not-a-dir.txt"), { recursive: true });

    const skills = await listClaudeSkills();
    expect(skills).toEqual(["alpha"]);
  });

  it("importClaudeSkills 复制 skill 到 ~/.dskcode/skills", async () => {
    const claudeSkills = getClaudeSkillsDir();
    await mkdir(join(claudeSkills, "alpha"), { recursive: true });
    await writeFile(join(claudeSkills, "alpha", "SKILL.md"), "alpha");
    await mkdir(join(claudeSkills, "alpha", "reference"), { recursive: true });
    await writeFile(join(claudeSkills, "alpha", "reference", "doc.md"), "doc");

    const { imported, skipped } = await importClaudeSkills(["alpha"]);
    expect(imported).toEqual(["alpha"]);
    expect(skipped).toEqual([]);

    const dest = join(getDskcodeSkillsDir(), "alpha");
    expect(existsSync(join(dest, "SKILL.md"))).toBe(true);
    expect(existsSync(join(dest, "reference", "doc.md"))).toBe(true);
  });

  it("已存在的 skill 跳过而不覆盖", async () => {
    const claudeSkills = getClaudeSkillsDir();
    await mkdir(join(claudeSkills, "alpha"), { recursive: true });
    await writeFile(join(claudeSkills, "alpha", "SKILL.md"), "new");

    // 预先放置一个 old 版本
    const dskcodeSkills = getDskcodeSkillsDir();
    await mkdir(join(dskcodeSkills, "alpha"), { recursive: true });
    await writeFile(join(dskcodeSkills, "alpha", "SKILL.md"), "old");

    const { imported, skipped } = await importClaudeSkills(["alpha"]);
    expect(imported).toEqual([]);
    expect(skipped).toEqual(["alpha"]);

    // 老内容保留
    const { readFile } = await import("node:fs/promises");
    const content = await readFile(join(dskcodeSkills, "alpha", "SKILL.md"), "utf-8");
    expect(content).toBe("old");
  });

  it("importClaudeSkills 在目标目录不存在时自动创建", async () => {
    const claudeSkills = getClaudeSkillsDir();
    await mkdir(join(claudeSkills, "alpha"), { recursive: true });
    await writeFile(join(claudeSkills, "alpha", "SKILL.md"), "x");

    await importClaudeSkills(["alpha"]);
    expect(existsSync(getDskcodeSkillsDir())).toBe(true);
    expect(readdirSync(getDskcodeSkillsDir())).toEqual(["alpha"]);
  });

  it("符号链接的 skill 会解引用复制真实内容（deref）", async () => {
    // 这个用例主要验证传给 cp 的 deref 生效；创建 symlink 本身可能在普通
    // Windows 账号上失败（缺权限），此时跳过该用例而不是判错。
    const real = await mkdtemp(join(tmpdir(), "dskcode-real-src-"));
    await writeFile(join(real, "SKILL.md"), "real content");

    const claudeSkills = getClaudeSkillsDir();
    await mkdir(join(claudeSkills), { recursive: true });

    let linkCreated = true;
    try {
      await symlink(real, join(claudeSkills, "linked"), process.platform === "win32" ? "junction" : "dir");
    } catch (err) {
      if (process.platform === "win32" && err instanceof Error && (err.code === "EPERM" || err.code === "EEXIST")) {
        linkCreated = false;
      } else {
        throw err;
      }
    }

    if (!linkCreated) {
      // 无法创建 symlink，跳过该用例
      return;
    }

    await importClaudeSkills(["linked"]);
    const { lstat, readFile } = await import("node:fs/promises");
    const destStat = await lstat(join(getDskcodeSkillsDir(), "linked"));
    // 复制后应是一个普通目录，不是 symlink
    expect(destStat.isDirectory()).toBe(true);
    expect(destStat.isSymbolicLink()).toBe(false);
    const content = await readFile(join(getDskcodeSkillsDir(), "linked", "SKILL.md"), "utf-8");
    expect(content).toBe("real content");
  });
});