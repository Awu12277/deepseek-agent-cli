/** 允许直接 import .hbs 文件为字符串（由 esbuild text loader 处理） */
declare module "*.hbs" {
  const content: string;
  export default content;
}
