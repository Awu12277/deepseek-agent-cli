import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Provider, ChatChunk, ChatMessage } from "../src/provider/index.js";
import { Session } from "../src/agent/index.js";
import { SessionStore } from "../src/session-store/index.js";

const execFileAsync = promisify(execFile);

async function initGitRepo(dir: string): Promise<void> {
  await execFileAsync("git", ["init", "-q", "--initial-branch=main"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "t@t.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "T"], { cwd: dir });
  await execFileAsync("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
  await execFileAsync("git", ["config", "core.autocrlf", "false"], { cwd: dir });
}

function textProvider(text: string, modelId = "deepseek-v4-flash"): Provider {
  return {
    name: "mock", model: () => modelId, countTokens: (t: string) => Math.ceil(t.length / 3),
    chat: async function* (_m: ChatMessage[]): AsyncIterable<ChatChunk> {
      yield { content: text, finishReason: "stop" };
    },
  };
}

async function runChat(session: Session, input: string): Promise<void> {
  for await (const _e of session.chat(input)) { /* ignore */ }
}

describe("Session 持久化与 Rewind", () => {
  let tempDir: string;
  let projectDir: string;
  let storeDir: string;
  let store: SessionStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "dskcode-session-"));
    projectDir = join(tempDir, "project");
    storeDir = join(tempDir, "sessions");
    await mkdir(projectDir, { recursive: true });
    await initGitRepo(projectDir);
    await writeFile(join(projectDir, "a.txt"), "original\n");
    await execFileAsync("git", ["add", "."], { cwd: projectDir });
    await execFileAsync("git", ["commit", "-q", "-m", "init"], { cwd: projectDir });
    store = new SessionStore(storeDir);
  });

  afterEach(async () => {
    await new Promise((r) => setTimeout(r, 50));
    try { await rm(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("新会话自动生成 UUID 格式 ID", () => {
    const s = new Session(textProvider("hi"), [], undefined, { cwd: projectDir, store: false });
    expect(s.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/i);
  });
  it("传入 sessionId 则复用", () => {
    const s = new Session(textProvider("hi"), [], undefined, { cwd: projectDir, store: false, sessionId: "my-id" });
    expect(s.id).toBe("my-id");
  });
  it("store: false 禁用持久化", () => {
    const s = new Session(textProvider("hi"), [], undefined, { cwd: projectDir, store: false });
    expect(s.store).toBeNull();
  });

  it("chat 结束后会话被保存到磁盘", async () => {
    const s = new Session(textProvider("回复"), [], undefined, { cwd: projectDir, store });
    await runChat(s, "你好");
    await s.persistNow();
    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(s.id);
    expect(list[0]!.messageCount).toBe(2);
  });
  it("保存的消息包含 checkpoint", async () => {
    const s = new Session(textProvider("好的"), [], undefined, { cwd: projectDir, store });
    await writeFile(join(projectDir, "a.txt"), "modified\n");
    await runChat(s, "测试");
    await s.persistNow();
    const loaded = await store.load(s.id);
    const userMsg = loaded!.messages.find((m) => m.role === "user");
    expect(userMsg?.checkpoint?.isGitRepo).toBe(true);
    expect(userMsg?.checkpoint?.stashSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("Session.resume 恢复之前保存的会话", async () => {
    const s1 = new Session(textProvider("第一轮"), [], undefined, { cwd: projectDir, store });
    await runChat(s1, "你好");
    await s1.persistNow();
    const s2 = await Session.resume(s1.id, textProvider("二"), [], undefined, { cwd: projectDir, store });
    expect(s2.id).toBe(s1.id);
    expect(s2.messages).toHaveLength(2);
    expect(s2.messages[0]!.content).toBe("你好");
  });
  it("resume 后能继续 chat", async () => {
    const s1 = new Session(textProvider("r1"), [], undefined, { cwd: projectDir, store });
    await runChat(s1, "m1");
    await s1.persistNow();
    const s2 = await Session.resume(s1.id, textProvider("r2"), [], undefined, { cwd: projectDir, store });
    await runChat(s2, "m2");
    expect(s2.messages).toHaveLength(4);
  });
  it("resume 不存在的会话抛错", async () => {
    await expect(
      Session.resume("not-exists", textProvider("x"), [], undefined, { cwd: projectDir, store }),
    ).rejects.toThrow("会话 not-exists 不存在");
  });
  it("resume 恢复 checkpoint", async () => {
    const s1 = new Session(textProvider("hi"), [], undefined, { cwd: projectDir, store });
    await writeFile(join(projectDir, "a.txt"), "v1\n");
    await runChat(s1, "msg1");
    await s1.persistNow();
    const s2 = await Session.resume(s1.id, textProvider("hi2"), [], undefined, { cwd: projectDir, store });
    const cps = s2.listCheckpoints();
    expect(cps).toHaveLength(1);
    expect(cps[0]!.preview).toBe("msg1");
  });

  it("listCheckpoints 列出所有 user 消息对应的 checkpoint", async () => {
    const s = new Session(textProvider("ok"), [], undefined, { cwd: projectDir, store: false });
    await runChat(s, "first");
    await writeFile(join(projectDir, "a.txt"), "v2\n");
    await runChat(s, "second");
    await writeFile(join(projectDir, "a.txt"), "v3\n");
    await runChat(s, "third");
    const cps = s.listCheckpoints();
    expect(cps).toHaveLength(3);
    expect(cps.map((c) => c.preview)).toEqual(["first", "second", "third"]);
  });

  it("rewind 截断消息到目标 user 消息", async () => {
    const s = new Session(textProvider("reply"), [], undefined, { cwd: projectDir, store: false });
    await runChat(s, "first");
    await runChat(s, "second");
    await runChat(s, "third");
    const firstIdx = s.messages.findIndex((m) => m.content === "first");
    const r = await s.rewind(firstIdx);
    expect(r.ok).toBe(true);
    expect(s.messages).toHaveLength(firstIdx + 1);
  });
  it("rewind 同时恢复文件", async () => {
    const s = new Session(textProvider("ok"), [], undefined, { cwd: projectDir, store: false });
    // 用户手动改 a.txt
    await writeFile(join(projectDir, "a.txt"), "user-edit-1\n");
    // 第一轮 chat — 修复后：工作区修改应保留，不被 checkpoint 拿走到 stash
    await runChat(s, "first");
    expect(await readFile(join(projectDir, "a.txt"), "utf-8")).toBe("user-edit-1\n");
    // 用户继续改 a.txt
    await writeFile(join(projectDir, "a.txt"), "user-edit-2\n");
    // 第二轮 chat — 同样，修改必须保留
    await runChat(s, "second");
    expect(await readFile(join(projectDir, "a.txt"), "utf-8")).toBe("user-edit-2\n");
    // rewind 到第一轮 user 消息 — checkpoint 快照是 "user-edit-1"，应恢复到此
    const firstIdx = s.messages.findIndex((m) => m.content === "first");
    const r = await s.rewind(firstIdx);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.fileRestored).toBe(true);
    expect(await readFile(join(projectDir, "a.txt"), "utf-8")).toBe("user-edit-1\n");
    // rewind 成功后该检查点应从列表中移除
    expect(s.listCheckpoints()).toHaveLength(0);
    expect(s.hasCheckpoints()).toBe(false);
  });

  it("rewind 到中间检查点后，目标检查点及其后的检查点均从列表中移除", async () => {
    const s = new Session(textProvider("ok"), [], undefined, { cwd: projectDir, store: false });
    await runChat(s, "round-1");
    await writeFile(join(projectDir, "a.txt"), "v2\n");
    await runChat(s, "round-2");
    await writeFile(join(projectDir, "a.txt"), "v3\n");
    await runChat(s, "round-3");
    expect(s.listCheckpoints()).toHaveLength(3);

    const idx1 = s.messages.findIndex((m) => m.content === "round-2");
    const r = await s.rewind(idx1);
    expect(r.ok).toBe(true);
    // 目标检查点（idx1）及其后的检查点（idx2）都应移除
    expect(s.listCheckpoints()).toHaveLength(1);
    expect(s.listCheckpoints()[0]!.preview).toBe("round-1");
  });
  it("无效索引返回错误", async () => {
    const s = new Session(textProvider("ok"), [], undefined, { cwd: projectDir, store: false });
    await runChat(s, "msg");
    expect((await s.rewind(-1)).ok).toBe(false);
    expect((await s.rewind(999)).ok).toBe(false);
  });
  it("对 assistant 消息返回错误", async () => {
    const s = new Session(textProvider("reply"), [], undefined, { cwd: projectDir, store: false });
    await runChat(s, "hi");
    expect((await s.rewind(1)).ok).toBe(false);
  });
  it("rewind 后能继续 chat", async () => {
    const s = new Session(textProvider("ok"), [], undefined, { cwd: projectDir, store: false });
    await runChat(s, "first");
    await runChat(s, "second");
    const firstIdx = s.messages.findIndex((m) => m.content === "first");
    await s.rewind(firstIdx);
    await runChat(s, "after-rewind");
    expect(s.messages[firstIdx + 1]!.content).toBe("after-rewind");
  });

  it("delete 从磁盘移除会话", async () => {
    const s = new Session(textProvider("ok"), [], undefined, { cwd: projectDir, store });
    await runChat(s, "hi");
    await s.persistNow();
    expect(await store.exists(s.id)).toBe(true);
    await s.delete();
    expect(await store.exists(s.id)).toBe(false);
  });

  it("reset 清空 checkpoint，listCheckpoints 返回空（/plan、/code 切换后的预期）", async () => {
    const s = new Session(textProvider("ok"), [], undefined, { cwd: projectDir, store: false });
    await runChat(s, "first");
    await writeFile(join(projectDir, "a.txt"), "v2\n");
    await runChat(s, "second");
    expect(s.listCheckpoints()).toHaveLength(2);
    s.reset();
    expect(s.listCheckpoints()).toHaveLength(0);
    expect(s.hasCheckpoints()).toBe(false);
  });
});
