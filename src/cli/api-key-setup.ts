import { createInterface } from "node:readline";
import chalk from "chalk";

/**
 * 检测是否有可用的 API Key。
 * 遍历所有 provider 检查是否配置了 apiKey，同时检查 DEEPSEEK_API_KEY 环境变量。
 */
export function hasApiKey(providers: Array<{ apiKey?: string }>): boolean {
  if (providers.some((p) => p.apiKey)) return true;
  if (process.env.DEEPSEEK_API_KEY) return true;
  return false;
}

/**
 * 交互式提示用户输入 DeepSeek API Key。
 * 使用 Node readline 的 password 模式（输入不可见）。
 * 返回用户输入的 Key，如果用户取消则返回 null。
 */
export async function promptForApiKey(): Promise<string | null> {
  console.log(
    chalk.yellow("\n  ⚠ 未检测到 API Key 配置"),
  );
  console.log(
    chalk.dim("  你可以通过以下任一方式配置："),
  );
  console.log(
    chalk.dim("    · 环境变量: export DEEPSEEK_API_KEY=sk-xxx"),
  );
  console.log(
    chalk.dim("    · 配置文件: ~/.dskcode/settings.json"),
  );
  console.log(
    chalk.dim("    · 下面直接输入，自动保存到全局配置\n"),
  );

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise<string | null>((resolve) => {
    const cleanup = () => {
      rl.close();
    };

    process.stdin.on("keypress", (_, key) => {
      if (key.ctrl && key.name === "c") {
        cleanup();
        resolve(null);
      }
    });

    rl.question(
      `  ${chalk.cyan("🔑")} ${chalk.bold("请输入你的 DeepSeek API Key:")} `,
      (answer) => {
        cleanup();
        const trimmed = answer.trim();
        if (!trimmed) {
          console.log(chalk.red("  ✖ API Key 不能为空"));
          resolve(null);
          return;
        }
        if (trimmed.length < 10) {
          console.log(chalk.red("  ✖ API Key 格式不正确，长度至少 10 位"));
          resolve(null);
          return;
        }
        resolve(trimmed);
      },
    );
  });
}
