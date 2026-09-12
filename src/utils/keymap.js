// 键位守卫：跨 dialog 复用的 IME / 修饰键判断 helper。
//
// 为什么要集中：
//   1. 中文 / 日文 IME 在组合输入期间按 Enter 是「上屏」，不是「确认」。
//      浏览器通过 isComposing=true 或 keyCode=229 标识这种状态。
//      现代浏览器两种都发，但旧 Safari 只发 keyCode=229。
//      漏掉任一检查 → 用户 IME 上屏时被误判为「确认」，未写完的字符串被吞。
//   2. Cmd/Ctrl+Enter 是「应用合并」「导入」等高权重操作的快捷键，
//      与 Enter 区分开 —— 普通 Enter 触发默认行为，Cmd/Ctrl+Enter 才提交。
//
// 之前 feedback.js / conflict-dialog.js 各自复制 `!e.isComposing && e.keyCode !== 229`，
// task-list.js 只检查 `!e.isComposing`（IME 上屏会被误当成提交，潜在 bug）。
// 这里统一一份，三个文件 + task-list 都引用。

/**
 * 事件是否发生在 IME 组合输入期间（中文 / 日文上屏中按 Enter 等场景）。
 * 用 `||` 而非 `&&` 因为部分浏览器只发其中一个。
 * @param {KeyboardEvent} e
 * @returns {boolean}
 */
export function isImeComposing(e) {
  return !!(e.isComposing || e.keyCode === 229);
}

/**
 * 事件是否是「Cmd+Enter / Ctrl+Enter」组合键。
 * 注意：不包含 IME 守卫 —— 调用方按需叠加 `!isImeComposing(e)`。
 * @param {KeyboardEvent} e
 * @returns {boolean}
 */
export function isCmdEnter(e) {
  return e.key === 'Enter' && (e.metaKey || e.ctrlKey);
}
