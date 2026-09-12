// UI 反馈组件：Toast 通知 + Modal 对话框 + Context Menu

import { escapeHtml } from '../utils/dom.js';
import { trapFocus } from '../utils/focus-trap.js';
import { isImeComposing } from '../utils/keymap.js';

// ─────────────────────────────────────────────────────────────────────────────
// Modal 打开前 hook 列表
//
// 为什么需要：
//   M8 修复 —— 用户在拖拽任务过程中（_drags Map 非空）触发了 confirmDialog /
//   inputDialog / 等任意 modal。modal 立刻拦截了 document 的指针，但 pointerup
//   仍在 document 级监听上最终派发，调用 _finishDrag → reorderTask。此时用户
//   实际想表达的是「关掉弹窗」，却得到「任务被重排」的副作用，典型的「点了
//   没反应/反应错」体感。
//
// 解决：所有 modal 打开前调用一遍注册的 hooks，把外部需要清理的状态清掉。
// 单一注册口而非每个 modal 单独调用，保持调用方代码干净。
//
// 当前 task-list.js / sidebar.js 等组件在 _setupEvents 时注册清理函数，
// destroy 时注销。
// ─────────────────────────────────────────────────────────────────────────────
const beforeModalShowHooks = new Set();

/**
 * 注册「modal 打开前」清理 hook —— 由组件用来清理自身的瞬态状态（如进行中的
 * 拖拽、未关闭的菜单、正在闪烁的 ghost 等）。返回反注册函数。
 *
 * @param {() => void} hook
 * @returns {() => void}
 */
export function registerBeforeModalShow(hook) {
  if (typeof hook !== 'function') return () => {};
  beforeModalShowHooks.add(hook);
  return () => beforeModalShowHooks.delete(hook);
}

function runBeforeModalShow() {
  // 防御：单个 hook 抛错不能让 modal 打开失败 —— try/catch 隔离
  for (const hook of beforeModalShowHooks) {
    try { hook(); } catch (e) { console.error('[feedback] beforeModalShow hook 异常:', e); }
  }
}

/**
 * 公开 runBeforeModalShow 供其他 modal（如 import-dialog / settings-dialog /
 * conflict-dialog / diff-preview-dialog / command-palette）复用 —— 避免每个
 * dialog 单独维护自己的 hook 列表，也避免引入 import 循环。
 *
 * 所有 modal 在挂载 overlay 之前都必须调一次。
 */
export { runBeforeModalShow };

/**
 * Toast 通知
 * @param {string} message
 * @param {'info'|'success'|'error'} type
 * @param {number} duration 毫秒
 */
export function toast(message, type = 'info', duration = 2500) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = message;
  container.appendChild(el);

  setTimeout(() => {
    el.style.animation = 'toast-out 0.2s ease forwards';
    setTimeout(() => el.remove(), 200);
  }, duration);
}

/**
 * 模态对话框
 * @param {object} options
 * @returns {Promise<boolean>} 用户点击确认返回 true，取消返回 false
 */
export function confirmDialog({
  title = '确认',
  message = '',
  confirmText = '确定',
  cancelText = '取消',
  danger = false
} = {}) {
  return new Promise((resolve) => {
    // M8：在挂载 overlay 之前先清掉所有进行中的瞬态状态（拖拽 / 菜单 / 等）。
    // 否则用户在拖拽中触发 modal 时 pointerup 会在 modal 后才派发，导致任务
    // 被偷偷重排 —— 典型的「点了没反应/反应错」。
    runBeforeModalShow();
    // 记下打开前的焦点元素，关弹窗时还原 —— 屏幕阅读器用户会卡在无主的对话框
    // 上，键盘用户则要按 Tab 一路回到原位置。
    const previouslyFocused = document.activeElement;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    // 每次打开用稳定 id 即可（同一时刻只可能有一个 dialog/confirm 在屏）
    const titleId = 'modal-title';
    const bodyId = 'modal-body';
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true"
           aria-labelledby="${titleId}" aria-describedby="${bodyId}">
        <div class="modal-header" id="${titleId}">${escapeHtml(title)}</div>
        <div class="modal-body" id="${bodyId}">${escapeHtml(message)}</div>
        <div class="modal-footer">
          <button class="btn" data-action="cancel">${escapeHtml(cancelText)}</button>
          <button class="btn btn-primary ${danger ? 'btn-danger' : ''}" data-action="ok" autofocus>
            ${escapeHtml(confirmText)}
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    // 用 AbortController 一次性回收所有监听器，避免嵌套弹窗时残留
    const ac = new AbortController();
    const { signal } = ac;

    let resolved = false;
    const close = (result) => {
      if (resolved) return;
      resolved = true;
      ac.abort();
      // 关弹窗时先播 0.18s 缩放淡出动画再 remove —— 比同步 remove 多一层缓冲，
      // 视觉上"主动关掉"而非"硬切"。focus 恢复必须挪到 animationend 内：
      // 若在 remove 后立即 focus，原元素（或其祖先）会被销毁，导致焦点跳到 body。
      const inner = overlay.querySelector('.modal');
      // finalize: 真正销毁节点 + 还原焦点 + resolve。在 animationend / fallback 共享。
      // 注意 focus() 必须在 overlay.remove() 之前调用 —— 一旦 overlay 销毁，
      // 其下任何节点 focus 都可能跳到 body（被销毁的祖先）。
      const finalize = () => {
        if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
          previouslyFocused.focus();
        }
        overlay.remove();
        resolve(result);
      };
      if (inner) {
        inner.classList.add('is-closing');
        inner.addEventListener('animationend', finalize, { once: true });
        // 兜底：万一动画被打断（display:none / 元素被提前 detach / animationend
        // 不触发），250ms 后强删并 resolve —— 不 resolve 会让 await 永远挂住，
        // 对 command-palette 来说意味着 _active 永不清、Ctrl+K 永久失效（致命）。
        setTimeout(finalize, 250);
      } else {
        finalize();
      }
    };

    overlay.addEventListener('click', (e) => {
      // 用 closest 向上找带 data-action 的祖先，这样点击 modal 标题/消息体等
      // 非按钮区域也能正确识别"取消"语义（与 settings-dialog.js 实现对齐）。
      // e.target === overlay 仍然保留：点击遮罩空白处直接取消。
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (action === 'ok') close(true);
      else if (action === 'cancel' || e.target === overlay) close(false);
    }, { signal });

    // IME 组合输入期间不要让 Enter 提交对话（中文拼音 / 日文 IME 按 Enter 上屏时
    // 仍在 isComposing=true 状态，旧实现会把「上屏」当成「确认」，未写完的字串直接被吞）。
    // Escape 同样加 IME 守卫：CJK/JP/KR 用户在选词中按 Esc 通常是「取消 IME 组合」，
    // 不是「关闭对话框」。让 IME 先消化 Esc，避免误关。
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (isImeComposing(e)) return;
        e.preventDefault();
        close(false);
      } else if (e.key === 'Enter' && !isImeComposing(e)) {
        e.preventDefault();
        close(true);
      } else {
        // Tab / Shift+Tab 在 modal 内首尾循环，不让焦点跑到背景的任务列表上
        trapFocus(e, overlay, signal);
      }
    }, { signal });

    setTimeout(() => {
      overlay.querySelector('[data-action="ok"]')?.focus();
    }, 50);
  });
}

/**
 * 输入对话框
 * @param {object} options
 * @param {(value: string) => string|null} [options.validate] - 实时校验：
 *        返回 null 表示通过；返回字符串作为内联错误提示（输入框变红、确认按钮置灰）。
 *        空值视为「未填」，静默禁用确认按钮但不显示错误。
 * @returns {Promise<string|null>} 用户输入的文本，取消或未通过校验返回 null
 */
export function inputDialog({
  title = '输入',
  message = '',
  placeholder = '',
  defaultValue = '',
  confirmText = '确定',
  cancelText = '取消',
  validate = null
} = {}) {
  return new Promise((resolve) => {
    // M8：同 confirmDialog —— 打开前清掉瞬态状态（拖拽 / 进行中的菜单 / 等）
    runBeforeModalShow();
    // 同 confirmDialog：记下焦点并还回去，让键盘流顺畅
    const previouslyFocused = document.activeElement;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    // input-dialog-modal：紧凑版 modal。标题与输入框共用一个色块（去掉 header/body 分隔线），
    // 整体 padding 比通用 .modal 更小，让「新建子分类」这种纯输入场景更聚焦。
    const titleId = 'input-title';
    const bodyId = 'input-body';
    overlay.innerHTML = `
      <div class="modal input-dialog-modal" role="dialog" aria-modal="true"
           aria-labelledby="${titleId}" ${message ? `aria-describedby="${bodyId}"` : ''}>
        <div class="input-dialog-title" id="${titleId}">${escapeHtml(title)}</div>
        <div class="input-dialog-body">
          ${message ? `<p class="input-dialog-message" id="${bodyId}">${escapeHtml(message)}</p>` : ''}
          <input type="text" class="input-dialog-input"
                 placeholder="${escapeHtml(placeholder)}" value="${escapeHtml(defaultValue)}">
          <div class="input-dialog-error" hidden></div>
        </div>
        <div class="input-dialog-footer">
          <button class="btn" data-action="cancel">${escapeHtml(cancelText)}</button>
          <button class="btn btn-primary" data-action="ok">${escapeHtml(confirmText)}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const input = overlay.querySelector('input');
    const errorEl = overlay.querySelector('.input-dialog-error');
    const okBtn = overlay.querySelector('[data-action="ok"]');

    const ac = new AbortController();
    const { signal } = ac;

    let resolved = false;
    const close = (result) => {
      if (resolved) return;
      resolved = true;
      ac.abort();
      // 同 confirmDialog：缩放淡出后 remove，焦点恢复必须在 animationend 内
      // —— 提前调用会焦点跳到 body（被销毁的祖先元素上）
      const inner = overlay.querySelector('.modal');
      // focus() 必须在 overlay.remove() 之前 —— 否则 focus 到 overlay 内的节点会跳 body
      const finalize = () => {
        if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
          previouslyFocused.focus();
        }
        overlay.remove();
        resolve(result);
      };
      if (inner) {
        inner.classList.add('is-closing');
        inner.addEventListener('animationend', finalize, { once: true });
        // 兜底必须 resolve：参见 confirmDialog 注释，否则 await 永久挂起
        setTimeout(finalize, 250);
      } else {
        finalize();
      }
    };

    // 校验：返回 null 表示通过；'empty' 或错误字符串表示不通过
    const runValidation = () => {
      const value = input.value.trim();
      // 空值：静默禁用提交（不显示错误，等用户继续输入）
      if (!value) {
        errorEl.hidden = true;
        input.classList.remove('input-invalid');
        okBtn.disabled = true;
        return 'empty';
      }
      // 自定义校验（如重名、保留名）
      if (typeof validate === 'function') {
        const error = validate(value);
        if (error) {
          errorEl.textContent = error;
          errorEl.hidden = false;
          input.classList.add('input-invalid');
          okBtn.disabled = true;
          return error;
        }
      }
      errorEl.hidden = true;
      input.classList.remove('input-invalid');
      okBtn.disabled = false;
      return null;
    };

    // 仅在校验通过时关闭并返回值
    const closeIfValid = () => {
      if (runValidation() !== null) return;
      close(input.value.trim());
    };

    // 边输边校验
    input.addEventListener('input', runValidation, { signal });

    // 初始聚焦 + 初次校验（处理空值默认状态）
    setTimeout(() => {
      input.focus();
      input.select();
      runValidation();
    }, 50);

    overlay.addEventListener('click', (e) => {
      // 同样使用 closest：inputDialog 的内部 padding / 标题区域点击也能识别为「取消」，
      // 与 confirmDialog 行为一致。
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (action === 'ok') closeIfValid();
      else if (action === 'cancel' || e.target === overlay) close(null);
    }, { signal });

    // 捕获阶段监听：覆盖 overlay 内所有 keydown（含 input 自身），
    // 一次到位，避免双重 close()。
    //
    // IME 组合输入期间（isComposing=true 或 keyCode=229）按 Enter 是「上屏」不是「确认」，
    // 旧实现会在拼音半完成时把字串直接提交 —— 丢掉正在选的上屏候选。
    // Escape 同样加 IME 守卫：CJK/JP/KR 用户在选词中按 Esc 通常是「取消 IME 组合」，
    // 不是「关闭对话框」。让 IME 先消化 Esc，避免误关整个输入对话框。
    const onKey = (e) => {
      if (e.key === 'Escape') {
        if (isImeComposing(e)) return;
        e.preventDefault();
        close(null);
      } else if (e.key === 'Enter' && !isImeComposing(e)) {
        e.preventDefault();
        closeIfValid();
      } else {
        // Tab / Shift+Tab 在 modal 内首尾循环
        trapFocus(e, overlay, signal);
      }
    };
    overlay.addEventListener('keydown', onKey, { signal, capture: true });
  });
}

/**
 * 右键菜单（支持分隔符、危险项、回调函数）
 */
let activeContextMenu = null;
let contextMenuCallback = null;

/**
 * @param {number} x
 * @param {number} y
 * @param {Array<{label?: string, action?: string, separator?: boolean, danger?: boolean, disabled?: boolean, indent?: boolean}>} items
 * @param {(action: string) => void} [callback] - 点击菜单项时的回调
 */
export function showContextMenu(x, y, items, callback = null) {
  hideContextMenu();
  const menu = document.getElementById('context-menu');
  if (!menu) return;

  menu.innerHTML = '';
  menu.setAttribute('role', 'menu');
  contextMenuCallback = callback;
  for (const item of items) {
    if (item.separator) {
      const sep = document.createElement('div');
      sep.className = 'context-menu-separator';
      sep.setAttribute('role', 'separator');
      menu.appendChild(sep);
    } else {
      const el = document.createElement('div');
      let cls = 'context-menu-item';
      if (item.danger) cls += ' context-menu-danger';
      if (item.disabled) cls += ' context-menu-disabled';
      if (item.indent) cls += ' context-menu-indent';
      el.className = cls;
      el.textContent = item.label || '';
      el.setAttribute('role', 'menuitem');
      // 屏幕阅读器读「已禁用」比直接跳过更友好；视觉上的灰度已在 CSS 完成
      if (item.disabled) el.setAttribute('aria-disabled', 'true');
      if (item.action) el.dataset.action = item.action;
      menu.appendChild(el);
    }
  }

  // 防止菜单超出视口 —— 先把菜单放到屏幕外、visibility:hidden 测真实尺寸，
  // 再按真实宽高 clamp 到视口内，最后才取消隐藏 + 复位。
  // 旧版（硬编码 estimatedWidth=200 + 估算 height）在长分类名 / 多分类时右侧
  // 被切、底部被切；visibility:hidden 测真实尺寸后，仍会被 `.context-menu`
  // 上的 `menu-in` 动画（scale(0.97) → scale(1)）影响 —— 测量发生在动画未完成时，
  // `getBoundingClientRect()` 返回的是 transform 影响后的渲染尺寸（scale(0.97)
  // 让 height 比真实小 3%），clamp 算小 → 菜单右边/底边被切。
  // 解决：用 `offsetWidth/offsetHeight` 代替 `rect.width/height` —— offset 系列是
  // 布局尺寸，不受 CSS transform 影响。同时把 left 放到 -9999px 让动画跑在屏幕外，
  // 用户看不到 scale 0.97 的中间态。
  menu.style.visibility = 'hidden';
  menu.style.left = '-9999px';
  menu.style.top = '0px';
  menu.hidden = false;
  // 强制一次 reflow，让浏览器立刻计算布局（offset 字段依赖最新布局）
  void menu.offsetWidth;
  const menuWidth = menu.offsetWidth;
  const menuHeight = menu.offsetHeight;
  const finalX = Math.max(4, Math.min(x, window.innerWidth - menuWidth - 8));
  const finalY = Math.max(4, Math.min(y, window.innerHeight - menuHeight - 8));
  menu.style.left = finalX + 'px';
  menu.style.top = finalY + 'px';
  menu.style.visibility = '';
  activeContextMenu = menu;
}

export function hideContextMenu() {
  if (activeContextMenu) {
    activeContextMenu.hidden = true;
    activeContextMenu = null;
  }
  contextMenuCallback = null;
  // v4+ 修复：sidebar 维护一套独立的「分类右键菜单」（#category-context-menu），
  // 自己管 visible / click-to-close。旧实现只清 activeContextMenu，导致：
  //   1) 用户右击任务 → 弹任务菜单；再右击子分类 → 任务菜单残留 activeContextMenu
  //      已经被 hideContextMenu 清掉，但 sidebar 的菜单 DOM 是 hidden=false，
  //      两个菜单 DOM 同时存在；feedback 的 doc-click 监听器检查「点的是不是
  //      #context-menu 的内部」——分类菜单是另一个 DOM，自然走"点外面"分支，
  //      结果 sidebar 菜单弹出瞬间又被自己关了。
  //   2) 反之 sidebar._showCategoryContextMenu 已主动调过 feedback.hideContextMenu
  //      那个方向 OK，但单点隐藏仍不够。
  // 兜底：直接把所有 .context-menu DOM 都关掉。Sidebar 自己也有 hideContextMenu
  // 会再幂等地设 hidden=true，没有副作用。
  const otherMenus = document.querySelectorAll('.context-menu:not([hidden])');
  otherMenus.forEach((m) => { m.hidden = true; });
}

// 全局监听点击关闭菜单 —— 用 module-scope AbortController + 一次性安装标志避免
// HMR / 多实例化时累加（C-1 修复：旧版 module 顶层 addEventListener 永不释放，
// reload 后会多份监听器同时处理同一次点击，触发「点了 N 次菜单/关闭菜单闪一下」）。
const globalListenerAC = new AbortController();
let globalListenersInstalled = false;
function installGlobalListeners() {
  if (globalListenersInstalled) return;
  globalListenersInstalled = true;
  document.addEventListener('click', (e) => {
    if (!activeContextMenu && !e.target.closest('#context-menu')) return;
    const item = e.target.closest('.context-menu-item');
    if (item && activeContextMenu && !item.classList.contains('context-menu-disabled')) {
      const action = item.dataset.action || '';
      const cb = contextMenuCallback;
      hideContextMenu();
      if (cb) cb(action);
    } else if (activeContextMenu && !e.target.closest('#context-menu')) {
      hideContextMenu();
    }
  }, { signal: globalListenerAC.signal });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && activeContextMenu) {
      // IME 守卫：右键菜单是 doc 级，可能覆盖到任何焦点元素（包括正在 IME 输入的输入框），
      // 让 IME 先消化 Esc，不要在这里拦截把它当成「关闭右键菜单」。
      if (isImeComposing(e)) return;
      hideContextMenu();
    }
  }, { signal: globalListenerAC.signal });
}
installGlobalListeners();

// 仅供测试 / 极端热重载场景调用 —— 主动关掉 module-scope 监听器。
export function disposeFeedbackGlobals() {
  if (!globalListenersInstalled) return;
  globalListenerAC.abort();
  globalListenersInstalled = false;
}
