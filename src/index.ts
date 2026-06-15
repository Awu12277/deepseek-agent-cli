#!/usr/bin/env node

import { createCli } from "./cli/index.js";

const program = createCli();

try {
  await program.parseAsync(process.argv);
} catch (err: unknown) {
  const error = err as { exitCode?: number; code?: string };
  if (error.code === "commander.helpDisplayed" || error.code === "commander.version") {
    // Normal exit triggered by --help or --version
    process.exit(error.exitCode ?? 0);
  }
  // Unknown error — print and exit with failure
  console.error(String(err));
  process.exit(1);
}
