import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node18",
  clean: true,
  dts: true,
  sourcemap: true,
  minify: process.env.NODE_ENV === "production",
  shims: true,
  esbuildOptions(opts) {
    opts.loader = {
      ...opts.loader,
      ".hbs": "text",
    };
  },
});
