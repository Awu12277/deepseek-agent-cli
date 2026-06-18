#!/usr/bin/env node

import { createCli } from "./cli/index.js";
import { ExitCode } from "./cli/exit-codes.js";

process.on("SIGINT", () => {
  process.exit(ExitCode.SIGINT);
});

const program = createCli();

try {
  await program.parseAsync(process.argv);
} catch (err: unknown) {
  const error = err as { exitCode?: number; code?: string };

  if (error.code === "commander.helpDisplayed" || error.code === "commander.version") {
    process.exit(error.exitCode ?? ExitCode.SUCCESS);
  }

  if (typeof error.exitCode === "number") {
    process.exit(error.exitCode);
  }

  console.error(String(err));
  process.exit(ExitCode.GENERAL_ERROR);
}
