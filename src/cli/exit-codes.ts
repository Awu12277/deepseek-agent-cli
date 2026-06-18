/** dskcode 退出码规范 */
export const ExitCode = {
  /** 正常执行完成 */
  SUCCESS: 0,
  /** 通用错误 */
  GENERAL_ERROR: 1,
  /** 配置错误 */
  CONFIG_ERROR: 2,
  /** 用户通过 Ctrl+C 中断 */
  SIGINT: 130,
} as const;
