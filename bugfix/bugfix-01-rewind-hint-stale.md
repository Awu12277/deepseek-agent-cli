# Rewind 提示在无可回退检查点后仍然显示

- **状态**：🔴 待修复
- **相关模块**：`src/ui/ChatSession.tsx`
- **引入版本**：检查点特性上线时（V 轮 Chat 阶段）

## TL;DR

`/rewind 1` 成功回退后，如果已经没有可用的检查点，页面底部的「↩ /rewind 1 可撤回本次修改」提示仍然显示，用户以为还能再撤回，实际已经没有检查点了。

## 复现步骤

1. 在一轮修改了文件的对话结束后，等待 2s 出现「↩ /rewind 1 可撤回本次修改」
2. 输入 `/rewind 1` 执行回退
3. 观察：提示「↩ /rewind 1 可撤回本次修改」仍然显示
4. 再输入 `/rewind 1`，得到错误「无效的序号…」

## 根因分析

`rewindHintPhase` 有三个阶段：`idle` → `pending` → `visible`。其清除逻辑在 `handleSubmit` 函数顶部的常规提交路径：

```ts
// src/ui/ChatSession.tsx 第 1184-1190 行
// 新一轮对话开始：清除上轮可能残留的 rewind 提示
currentRoundModifiedRef.current = false;
setRewindHintPhase("idle");
if (rewindHintTimerRef.current) {
  clearTimeout(rewindHintTimerRef.current);
  rewindHintTimerRef.current = null;
}
```

但 `/rewind` 命令的处理（第 887-960 行）在 `handleSubmit` 中属于**早出路径**——判断到输入以 `/rewind` 开头就 `return` 了，**不会**执行上述清除逻辑。

而 `doRewind` 函数（第 458-501 行）执行成功后也没有重置 `rewindHintPhase` 或 `currentRoundModifiedRef`，导致：

- `currentRoundModifiedRef.current` 仍为 `true`
- `rewindHintPhase` 仍为 `"visible"`
- 提示「↩ /rewind 1 可撤回本次修改」继续显示

## 影响范围

- 在最后一次可用检查点被 `/rewind 1` 消耗后，提示未及时消失
- `/rewind` 选择模式（不带参数）同样受影响——选择并回退后提示不会清除
- 但不是每次都能复现：如果 rewind 后紧接着开始新一轮对话（正常提交），清除逻辑会触发，提示消失

## 建议修复方向

在 `doRewind` 的 `try` 块中 `r.ok` 为 `true` 的分支内，加上：

```ts
currentRoundModifiedRef.current = false;
setRewindHintPhase("idle");
```

或者统一在 `doRewind` 的 `finally` 块中做清理（但需要考虑 `r.ok` 为 `false` 时是否也要清除——建议不清除，因为失败时提示仍有参考价值）。

## 关联文件

| 文件 | 说明 |
|------|------|
| `src/ui/ChatSession.tsx` L458-L501 | `doRewind` 函数，缺少 hint 清理 |
| `src/ui/ChatSession.tsx` L887-L960 | `/rewind` 命令处理早出路径 |
| `src/ui/ChatSession.tsx` L1184-L1190 | 常规提交路径的 hint 清除（/rewind 路径未覆盖） |
| `src/ui/ChatSession.tsx` L1372-L1378 | hint 显示触发条件 |
| `src/ui/ChatSession.tsx` L1687-L1692 | hint UI 渲染点 |
