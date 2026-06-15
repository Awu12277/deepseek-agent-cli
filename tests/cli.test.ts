import { describe, it, expect } from "vitest";
import { createCli } from "../src/cli/index.js";

describe("createCli", () => {
  const cli = createCli();

  it("should return a Command instance with name dsk", () => {
    expect(cli.name()).toBe("dsk");
  });

  it("should have a description", () => {
    expect(cli.description()).toBeTruthy();
  });

  it("should register the chat subcommand", () => {
    const chatCmd = cli.commands.find((c) => c.name() === "chat");
    expect(chatCmd).toBeDefined();
    expect(chatCmd!.description()).toBe("启动交互式对话会话");
  });

  it("should register the run subcommand", () => {
    const runCmd = cli.commands.find((c) => c.name() === "run");
    expect(runCmd).toBeDefined();
    expect(runCmd!.description()).toBe("执行一次性任务");
  });

  it("should register the setup subcommand", () => {
    const setupCmd = cli.commands.find((c) => c.name() === "setup");
    expect(setupCmd).toBeDefined();
    expect(setupCmd!.description()).toBe("运行配置向导");
  });

  it("should have the --verbose global option", () => {
    const opts = cli.options.map((o) => o.long);
    expect(opts).toContain("--verbose");
  });

  it("should output version with --version", async () => {
    // exitOverride makes Commander throw a CommanderError with code 0
    await expect(
      cli.parseAsync(["node", "dsk", "--version"]),
    ).rejects.toMatchObject({ exitCode: 0 });
  });

  it("should output help with --help", async () => {
    await expect(
      cli.parseAsync(["node", "dsk", "--help"]),
    ).rejects.toMatchObject({ exitCode: 0 });
  });
});
