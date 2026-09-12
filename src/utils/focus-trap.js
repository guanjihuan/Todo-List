// UI 焦点陷阱：Tab 在 modal 内首尾循环，不让焦点飘到背景。
//
// 为什么必须做：
//   modal 是「模态」的核心承诺是「键盘焦点也只能在它内部」。如果 Tab 能跑到背后的
//   任务列表/侧边栏，按下去就是「我在对话框里按 Tab，怎么删掉了一条任务？」——
//   这种 bug 复现链路非常隐蔽，且不会被任何单元测试抓到。
//
// 实现：监听 modal 内 keydown，找到所有「应当被聚焦」的元素（按钮、输入框等），
// 在最后一个按 Tab → 跳到第一个；Shift+Tab 在第一个 → 跳到最后一个。
//
// 注意：把 disabled 元素排除 —— focus() 会忽略它们，不能拿它当锚点。
//
// 之前散落在 feedback.js / conflict-dialog.js / import-dialog.js 三处，
// 各自复制一份 ~20 行实现。conflict-dialog 的注释还特别写「不重复实现就这里复制
// 一份，避免 import 循环」—— 实际上根本不存在 import 循环（dialog 都引了 utils），
// 复制是当年没核实的借口。

/**
 * 找出容器内所有「可被聚焦」的元素（按 Tab 顺序）。
 * 仅 trapFocus 内部用 —— 之前导出过但全项目无人 import，
 * 收成内部函数缩小公共 API。
 *
 * 历史踩坑：旧实现用 `el.offsetParent !== null` 判定可见性 —— 但标准 CSS 下
 * `offsetParent` 对 `position: fixed` 元素恒为 null。本项目所有 modal 容器
 * （.modal-overlay / .modal / .command-palette-overlay）都用 position: fixed，
 * 结果 modal 内每个可聚焦元素都被误判成「不可见」过滤掉，trapFocus 在 focusable
 * 为空时直接 preventDefault + return，吞掉用户的 Tab。修法：用 `getClientRects()`
 * 判定布局可见性（fixed / transform 后的元素都算可见），并兼容 display:none /
 * visibility:hidden。
 *
 * @param {HTMLElement} container
 * @returns {HTMLElement[]}
 */
function getFocusable(container) {
  return Array.from(container.querySelectorAll(
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  )).filter((el) => {
    // 已经在 container 里（querySelectorAll 已经保证）→ 可见性靠自身
    if (el === document.activeElement) return true;
    // display:none / visibility:hidden / 零尺寸 / 完全脱离视口的视为不可聚焦
    if (el.getClientRects().length === 0) return false;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    return true;
  });
}

/**
 * 在容器内拦截 Tab/Shift+Tab，让焦点在首尾循环。
 *
 * 用法（典型 modal 渲染后）：
 *   overlay.addEventListener('keydown', (e) => trapFocus(e, overlay, signal));
 *
 * 如果容器里没有任何可聚焦元素，Tab 也会被拦截 —— 否则焦点会被偷到 body 上。
 *
 * @param {KeyboardEvent} e
 * @param {HTMLElement} container
 * @param {AbortSignal} [signal]
 */
export function trapFocus(e, container, signal) {
  if (e.key !== 'Tab') return;
  const focusable = getFocusable(container);
  if (focusable.length === 0) {
    e.preventDefault();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}
