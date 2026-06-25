import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isGitRepo, createCheckpoint, restoreCheckpointForce } from "../src/checkpoint/index.js";

const execFileAsync = promisify(execFile);

async function initGitRepo(dir: string): Promise<void> {
  await execFileAsync("git", ["init", "-q", "--initial-branch=main"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "t@t.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "T"], { cwd: dir });
  await execFileAsync("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
  await execFileAsync("git", ["config", "core.autocrlf", "false"], { cwd: dir });
}

describe("checkpoint", () => {
  let tempDir: string;
  beforeEach(async () => { tempDir = await mkdtemp(join(tmpdir(), "dskcode-cp-")); });
  afterEach(async () => {
    await new Promise((r) => setTimeout(r, 50));
    try { await rm(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("isGitRepo 对 git 仓库返回 true", async () => { await initGitRepo(tempDir); expect(await isGitRepo(tempDir)).toBe(true); });
  it("isGitRepo 对非 git 仓库返回 false", async () => { expect(await isGitRepo(tempDir)).toBe(false); });

  it("非 git 仓库的 createCheckpoint 返回 isGitRepo=false", async () => {
    const cp = await createCheckpoint(tempDir);
    expect(cp.isGitRepo).toBe(false);
    expect(cp.stashSha).toBe("");
  });
  it("干净工作区的 createCheckpoint 返回空 SHA", async () => {
    await initGitRepo(tempDir);
    const cp = await createCheckpoint(tempDir);
    expect(cp.isGitRepo).toBe(true);
    expect(cp.stashSha).toBe("");
  });
  it("修改后 createCheckpoint 返回非空 SHA", async () => {
    await initGitRepo(tempDir);
    await writeFile(join(tempDir, "a.txt"), "original\n");
    await execFileAsync("git", ["add", "."], { cwd: tempDir });
    await execFileAsync("git", ["commit", "-q", "-m", "init"], { cwd: tempDir });
    await writeFile(join(tempDir, "a.txt"), "modified\n");
    const cp = await createCheckpoint(tempDir);
    expect(cp.stashSha).toMatch(/^[0-9a-f]{40}$/);
  });
  it("含未跟踪文件时 createCheckpoint 仍能工作", async () => {
    await initGitRepo(tempDir);
    await writeFile(join(tempDir, "a.txt"), "original\n");
    await execFileAsync("git", ["add", "."], { cwd: tempDir });
    await execFileAsync("git", ["commit", "-q", "-m", "init"], { cwd: tempDir });
    await writeFile(join(tempDir, "untracked.txt"), "data\n");
    await writeFile(join(tempDir, "a.txt"), "modified\n");
    const cp = await createCheckpoint(tempDir);
    expect(cp.stashSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("非 git 仓库的 restoreCheckpointForce 抛错", async () => {
    await expect(restoreCheckpointForce({ stashSha: "x", timestamp: 0, cwd: tempDir, isGitRepo: false })).rejects.toThrow("非 git 仓库");
  });
  it("空 SHA 的 restoreCheckpointForce 抛错", async () => {
    await initGitRepo(tempDir);
    const cp = await createCheckpoint(tempDir);
    await expect(restoreCheckpointForce(cp)).rejects.toThrow("检查点为空");
  });
  it("restoreCheckpointForce 恢复文件内容", async () => {
    await initGitRepo(tempDir);
    await writeFile(join(tempDir, "a.txt"), "original\n");
    await execFileAsync("git", ["add", "."], { cwd: tempDir });
    await execFileAsync("git", ["commit", "-q", "-m", "init"], { cwd: tempDir });
    await writeFile(join(tempDir, "a.txt"), "modified\n");
    const cp = await createCheckpoint(tempDir);
    await writeFile(join(tempDir, "a.txt"), "further\n");
    await restoreCheckpointForce(cp);
    expect(await readFile(join(tempDir, "a.txt"), "utf-8")).toBe("modified\n");
  });
  it("restoreCheckpointForce 恢复未跟踪文件", async () => {
    await initGitRepo(tempDir);
    await writeFile(join(tempDir, "a.txt"), "original\n");
    await execFileAsync("git", ["add", "."], { cwd: tempDir });
    await execFileAsync("git", ["commit", "-q", "-m", "init"], { cwd: tempDir });
    await writeFile(join(tempDir, "untracked.txt"), "data\n");
    await writeFile(join(tempDir, "a.txt"), "modified\n");
    const cp = await createCheckpoint(tempDir);
    await execFileAsync("git", ["clean", "-fd"], { cwd: tempDir });
    await writeFile(join(tempDir, "a.txt"), "again\n");
    await restoreCheckpointForce(cp);
    expect(await readFile(join(tempDir, "a.txt"), "utf-8")).toBe("modified\n");
    expect(await readFile(join(tempDir, "untracked.txt"), "utf-8")).toBe("data\n");
  });
  it("restoreCheckpointForce 恢复子目录文件", async () => {
    await initGitRepo(tempDir);
    await mkdir(join(tempDir, "src"));
    await writeFile(join(tempDir, "src", "main.ts"), "v1\n");
    await execFileAsync("git", ["add", "."], { cwd: tempDir });
    await execFileAsync("git", ["commit", "-q", "-m", "init"], { cwd: tempDir });
    await writeFile(join(tempDir, "src", "main.ts"), "v2\n");
    const cp = await createCheckpoint(tempDir);
    await writeFile(join(tempDir, "src", "main.ts"), "v3\n");
    await restoreCheckpointForce(cp);
    expect(await readFile(join(tempDir, "src", "main.ts"), "utf-8")).toBe("v2\n");
  });
});
