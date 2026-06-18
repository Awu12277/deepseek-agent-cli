import { describe, it, expect } from "vitest";
import { createCli } from "../src/cli/index.js";
import { ExitCode } from "../src/cli/exit-codes.js";

describe("createCli", () => {
  const cli = createCli();

  it("should return a Command instance with name dsk", () => {
    expect(cli.name()).toBe("dsk");
  });

  it("should have a description", () => {
    expect(cli.description()).toBeTruthy();
  });

  it("should register the chat subcommand", () => {
    const cmd = cli.commands.find((c) => c.name() === "chat");
    expect(cmd).toBeDefined();
    expect(cmd!.description()).toBe("启动交互式对话会话");
  });

  it("should register the run subcommand", () => {
    const cmd = cli.commands.find((c) => c.name() === "run");
    expect(cmd).toBeDefined();
    expect(cmd!.description()).toBe("执行一次性任务");
  });

  it("should register the setup subcommand", () => {
    const cmd = cli.commands.find((c) => c.name() === "setup");
    expect(cmd).toBeDefined();
    expect(cmd!.description()).toBe("运行配置向导");
  });

  it("should register the init subcommand", () => {
    const cmd = cli.commands.find((c) => c.name() === "init");
    expect(cmd).toBeDefined();
    expect(cmd!.description()).toBe("在当前项目下生成项目记忆文件（AGENTS.md）");
  });

  it("should register the completion subcommand", () => {
    const cmd = cli.commands.find((c) => c.name() === "completion");
    expect(cmd).toBeDefined();
    expect(cmd!.description()).toContain("shell 自动补全");
  });

  it("should have the --verbose global option", () => {
    const opts = cli.options.map((o) => o.long);
    expect(opts).toContain("--verbose");
  });

  it("should have the --config global option", () => {
    const opts = cli.options.map((o) => o.long);
    expect(opts).toContain("--config");
  });

  it("should output version with --version (exitCode=0)", async () => {
    await expect(
      cli.parseAsync(["node", "dsk", "--version"]),
    ).rejects.toMatchObject({ exitCode: ExitCode.SUCCESS });
  });

  it("should output help with --help (exitCode=0)", async () => {
    await expect(
      cli.parseAsync(["node", "dsk", "--help"]),
    ).rejects.toMatchObject({ exitCode: ExitCode.SUCCESS });
  });

  it("run subcommand should exit with SUCCESS", async () => {
    await expect(
      cli.parseAsync(["node", "dsk", "run", "test"]),
    ).resolves.toBeDefined();
  });
});

describe("ExitCode constants", () => {
  it("should have the correct values", () => {
    expect(ExitCode.SUCCESS).toBe(0);
    expect(ExitCode.GENERAL_ERROR).toBe(1);
    expect(ExitCode.CONFIG_ERROR).toBe(2);
    expect(ExitCode.SIGINT).toBe(130);
  });
});
