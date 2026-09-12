// 跨脚本共享：构造 TaskStore 测试 fixture。
//
// 之前 ~20 个脚本里复制粘贴 makeStore()，三套签名（必填 md / 可选 md / 无参）
// 实质等价：建 store → loadDefault 或 loadFromContent → 禁掉 autoSave。
//
// 统一为 makeStore(markdown = null, options = {})：
//   - markdown = null/不传 = 走 loadDefault()（默认文档）
//   - markdown = 字符串    = 走 loadFromContent(markdown, null)（自定义内容）
//   - options.settingsStore = 一个 settingsStore 实例（桩或真），注入后 TaskStore
//     才能读到 *Position 偏好；不传等价于未注入 → TaskStore 走 'front' 默认值。
//
// autoSave 必须禁掉：脚本里没有真实的 preload/IPC 环境，让 autoSave 跑会触发
// 找不到 window.api 而抛错。所有脚本都做了相同的事——集中到 helper 里确保新人
// 不用手动记得这一步。

import { TaskStore } from '../../src/task-store.js';

/**
 * 构造一个 TaskStore fixture。
 *
 * @param {string|null} [markdown=null] - 自定义 markdown；null = 用默认文档
 * @param {{ settingsStore?: object }} [options={}] - 注入的 settingsStore（可选）
 * @returns {TaskStore}
 */
export function makeStore(markdown = null, options = {}) {
  const store = new TaskStore(options);
  if (markdown !== null) {
    store.loadFromContent(markdown, null);
  } else {
    store.loadDefault(null);
  }
  // 关掉 autoSave 的副作用（避免污染测试环境 / 触发 IPC）。
  // 保留 .cancel() / .flush() 接口，调用方代码不需要做 null 检查。
  store._autoSave = Object.assign(() => {}, { cancel() {}, flush() {} });
  return store;
}
