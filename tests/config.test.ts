import { describe, it, expect } from "vitest";
import { defaultConfig } from "../src/config/index.js";

describe("defaultConfig", () => {
  it("should use deepseek as the default provider", () => {
    expect(defaultConfig.defaultProvider).toBe("deepseek");
  });

  it("should include a deepseek provider definition", () => {
    const ds = defaultConfig.providers.find((p) => p.name === "deepseek");
    expect(ds).toBeDefined();
    expect(ds!.baseUrl).toBe("https://api.deepseek.com");
    expect(ds!.model).toBe("deepseek-v4-flash");
  });

  it("should list all 8 built-in tools", () => {
    expect(defaultConfig.tools).toHaveLength(8);
    const names = defaultConfig.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "bash",
      "edit_file",
      "fetch",
      "glob",
      "grep",
      "ls",
      "read_file",
      "write_file",
    ]);
  });

  it("should have no plugins by default", () => {
    expect(defaultConfig.plugins).toHaveLength(0);
  });
});
