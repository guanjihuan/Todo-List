// 内容导入对话框 - 粘贴大段文本、解析成多条任务

import { parseImportLine } from '../task-store.js';
import { trapFocus } from '../utils/focus-trap.js';
import { isImeComposing, isCmdEnter } from '../utils/keymap.js';
import { runBeforeModalShow } from './feedback.js';

// 导入顺序偏好的合法值集合 —— 与 settings-store.VALID_VALUES.importPosition 对齐。
// 单独列在这里避免 dialog 文件反向依赖 settings-store（settingsStore 通过
// importTasksToCategory 间接触达），并把默认值 'order' 与文档集中在一处。
// 只有两种合法值：'order'（默认，正序 + 插到最前）/ 'front'（倒序 + 插到最前）。
const VALID_IMPORT_POSITION = new Set(['order', 'front']);

/**
 * 打开导入对话框
 * @param {import('../task-store.js').TaskStore} store
 * @param {string} defaultCategoryName - 默认选中的子分类
 * @param {object} [options] - 额外选项
 * @param {object} [options.settingsStore] - 设置存储。传入后对话框内的「排序方式」选项
 *   会持久化到 settingsStore.importPosition；不传则仅本次会话有效（默认 'order'）。
 * @returns {Promise<{ added: number, categoryName: string } | null>}
 *          取消返回 null；确认返回导入条数与目标分类
 */
export function openImportDialog(store, defaultCategoryName, options = {}) {
  return new Promise((resolve) => {
    // M8：在挂载 overlay 之前清掉所有进行中的瞬态状态（拖拽 / 菜单 / 等）。
    // 否则用户在拖拽中触发 modal 时 pointerup 会让任务被偷偷重排。
    runBeforeModalShow();
    // AbortController 模式：dialog / confirmDialog 一致的回收约定
    const ac = new AbortController();
    const { signal } = ac;

    // settingsStore 用于读写 importPosition（导入顺序偏好）。
    // 不传 / 字段缺失 / 值非法一律兜底为 'order'，保证对话框总能渲染一个合法默认。
    const settingsStore = options.settingsStore || null;
    const readImportPos = () => {
      if (!settingsStore || typeof settingsStore.get !== 'function') return 'order';
      const raw = settingsStore.get('importPosition');
      return VALID_IMPORT_POSITION.has(raw) ? raw : 'order';
    };
    let currentImportPos = readImportPos();

    const previouslyFocused = document.activeElement;

    // 收集当前所有可作为目标的子分类（NORMAL + parentOtherTasks）
    const targets = store.getSubCategories();
    if (targets.length === 0) {
      // 极端兜底：调用方应已保证有子分类；如果连一个都没有，
      // 不可能导入，告诉调用方别走这条路径。
      resolve(null);
      return;
    }

    // 默认选中调用方传入的分类 —— 不在列表里则退回第一个
    const defaultIdx = Math.max(0, targets.findIndex(c => c.name === defaultCategoryName));

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal import-dialog-modal" role="dialog" aria-modal="true" aria-labelledby="import-title">
        <div class="import-dialog-title" id="import-title">导入任务</div>
        <div class="import-dialog-body">
          <p class="import-dialog-hint">
            每行一条。包含 <code>- [ ]</code> / <code>- [✓]</code> 的行会保留勾选状态。
          </p>
          <textarea
            id="import-textarea"
            class="import-dialog-textarea"
            spellcheck="false"
            autocomplete="off"
            maxlength="1000000"
            placeholder="- [ ] 第一条任务
- [✓] 已完成的第二条
- 普通列表项
1. 有序列表
• 项目符号
普通文本行"></textarea>

          <div class="import-dialog-options">
            <label class="import-dialog-option">
              <input type="checkbox" id="import-strip-bullets" checked>
              <span>自动剥离前导列表符号（<code>-</code> / <code>*</code> / <code>+</code> / <code>•</code> / <code>1.</code> / <code>1)</code>）</span>
            </label>
            <label class="import-dialog-option import-dialog-target">
              <span>目标分类：</span>
              <select id="import-target" class="import-dialog-select"></select>
            </label>
            <div class="import-dialog-option import-dialog-order">
              <span class="import-dialog-order-label">排序方式：</span>
              <div class="import-dialog-segmented" id="import-order" role="radiogroup" aria-label="导入顺序">
                <button type="button" class="import-dialog-seg-btn" data-pos="order" role="radio" aria-checked="false">按输入顺序</button>
                <button type="button" class="import-dialog-seg-btn" data-pos="front" role="radio" aria-checked="false">倒序·最上</button>
              </div>
            </div>
          </div>

          <div class="import-dialog-count" id="import-count">将导入 0 条任务</div>
        </div>
        <div class="import-dialog-footer">
          <button class="btn" data-action="cancel">取消</button>
          <button class="btn btn-primary" data-action="ok" disabled>导入</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const textarea = overlay.querySelector('#import-textarea');
    const stripCheckbox = overlay.querySelector('#import-strip-bullets');
    const targetSelect = overlay.querySelector('#import-target');
    const countEl = overlay.querySelector('#import-count');
    const okBtn = overlay.querySelector('[data-action="ok"]');
    const orderSeg = overlay.querySelector('#import-order');

    // 填充分类下拉
    for (let i = 0; i < targets.length; i++) {
      const opt = document.createElement('option');
      opt.value = targets[i].name;
      opt.textContent = targets[i].name;
      if (i === defaultIdx) opt.selected = true;
      targetSelect.appendChild(opt);
    }

    // 排序方式 segmented —— 选中态用 .active，aria-checked 同步刷新以保证
    // 屏幕阅读器与视觉态一致（role="radiogroup" / role="radio" 模式）。
    const setOrderActive = (val) => {
      orderSeg.querySelectorAll('.import-dialog-seg-btn').forEach(b => {
        const isActive = b.dataset.pos === val;
        b.classList.toggle('active', isActive);
        b.setAttribute('aria-checked', String(isActive));
      });
    };
    setOrderActive(currentImportPos);
    orderSeg.addEventListener('click', (e) => {
      const btn = e.target.closest('.import-dialog-seg-btn');
      if (!btn) return;
      const newPos = btn.dataset.pos;
      if (!VALID_IMPORT_POSITION.has(newPos)) return;
      currentImportPos = newPos;
      setOrderActive(newPos);
      // 立刻把选择写回 settingsStore（fire-and-forget）：
      //   - 用户每次打开对话框都能延续上次的设置，无需每次重选
      //   - 不 await：写盘失败不影响本次对话框关闭流程（与 settings-dialog
      //     一样「内存优先、落盘兜底」的策略）
      if (settingsStore && typeof settingsStore.update === 'function') {
        settingsStore.update({ importPosition: newPos }).catch((err) => {
          // IPC 失败 console 出来便于排查，不打断 UI —— 用户这次的选择
          // 至少在当前会话有效，关掉对话框重开会回到上次成功的值。
          console.warn('[import-dialog] settingsStore.update 失败:', err?.message || err);
        });
      }
    }, { signal });

    /**
     * 把 textarea 内容按行解析，返回 { added, skipped, completedCount }。
     * 与 task-store.importTasksToCategory 共用 parseImportLine —— 实时预览
     * 必须与最终导入结果完全一致，避免「预览 X 条 → 确认后变 Y 条」。
     */
    const computeCount = () => {
      const strip = stripCheckbox.checked;
      const lines = textarea.value.split(/\r?\n/);
      let added = 0;
      let skipped = 0;
      let completedCount = 0;
      for (const line of lines) {
        const parsed = parseImportLine(line, { stripLeadingBullets: strip });
        if (!parsed) {
          // 只计入「非空但解析失败」的跳过行 —— 纯空白行不计入，
          // 否则"跳过 N 行"会被无意义的换行拉高，用户反而看不出来
          // 哪一行真的有问题。
          if (line.trim() !== '') skipped++;
          continue;
        }
        added++;
        if (parsed.completed) completedCount++;
      }
      return { added, skipped, completedCount };
    };

    /**
     * 把当前解析结果写回 UI：计数文字 + 提交按钮可用性。
     * added === 0 时禁用「导入」按钮 —— 空文本 / 全空行不应触发空事件、空 dirty。
     */
    const syncCount = () => {
      const { added, skipped, completedCount } = computeCount();
      const parts = [`将导入 ${added} 条任务`];
      if (completedCount > 0) parts.push(`含 ${completedCount} 条已完成`);
      if (skipped > 0) parts.push(`跳过 ${skipped} 行`);
      countEl.textContent = parts.join(' · ');
      countEl.classList.toggle('import-dialog-count-empty', added === 0);
      okBtn.disabled = added === 0;
    };

    // 输入变化 / 选项变化 → 实时更新计数
    // M-S11: rAF + 100ms debounce —— 大段粘贴（数千行）时，input 事件触发密集，
    // 每次同步都跑一遍 split + 解析会让 textarea 卡顿。先 debounce 100ms（够
    // 人眼感知不到延迟），再 requestAnimationFrame 把状态写回 DOM（避免 layout
    // 抖动）。stripCheckbox 变化是低频事件，直接同步即可。
    let syncRafId = 0;
    let syncTimerId = 0;
    const scheduleSync = () => {
      clearTimeout(syncTimerId);
      syncTimerId = setTimeout(() => {
        syncTimerId = 0;
        if (syncRafId) return;
        syncRafId = requestAnimationFrame(() => {
          syncRafId = 0;
          syncCount();
        });
      }, 100);
    };
    textarea.addEventListener('input', scheduleSync, { signal });
    stripCheckbox.addEventListener('change', syncCount, { signal });

    let resolved = false;
    const close = (result) => {
      if (resolved) return;
      resolved = true;
      // 清理 input 同步的 debounce / rAF —— close 后这些回调还会 fire 一次，
      // 调 syncCount() 触碰已 detach 的 countEl / okBtn（race log 噪音 + 浪费）。
      clearTimeout(syncTimerId);
      syncTimerId = 0;
      if (syncRafId) {
        cancelAnimationFrame(syncRafId);
        syncRafId = 0;
      }
      ac.abort();
      // 缩放淡出 + focus 恢复挪到 animationend 内
      const inner = overlay.querySelector('.modal');
      // animationend 与 250ms 兜底共享 finalize —— 避免 animationend 漏触发
      // （display:none / 元素被提前 detach）时 setTimeout 仅 remove、不 restoreFocus+resolve，
      // Promise 永久挂起，调用方 await 永远不返回。
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
        // 兜底必须 resolve：参见 finalize 注释
        setTimeout(finalize, 250);
      } else {
        finalize();
      }
    };

    overlay.addEventListener('click', (e) => {
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (action === 'ok') {
        if (okBtn.disabled) return;
        // 走到这里意味着 added > 0；guard 已闭合
        const categoryName = targetSelect.value;
        const lines = textarea.value.split(/\r?\n/);
        const strip = stripCheckbox.checked;
        // 真正导入 —— 直接调 task-store，共用 parseImportLine + 批量路径（仅一次 emit）。
        // importPosition 透传 —— 与 settingsStore 中的 importPosition 偏好完全解耦，
        // 用户在对话框内即时切换即生效（不再走 newTaskPosition / completedPosition）。
        const result = store.importTasksToCategory(categoryName, lines, {
          stripLeadingBullets: strip,
          importPosition: currentImportPos
        });
        if (result.ok) {
          close({ added: result.added, categoryName });
        } else {
          // 当前 UI 已经限制了只能选子分类，但防御性兜底：万一遇到无效分类，
          // 给用户明确反馈，不静默关闭。
          countEl.textContent = '导入失败：目标分类不可用';
          countEl.classList.add('import-dialog-count-error');
          okBtn.disabled = true;
        }
      } else if (action === 'cancel' || e.target === overlay) {
        close(null);
      }
    }, { signal });

    // IME-safe Enter + Esc + 焦点陷阱（与 inputDialog 对齐）
    const onKey = (e) => {
      if (e.key === 'Escape') {
        // IME 守卫：CJK/JP/KR 用户在选词中按 Esc 通常是「取消 IME 组合」，
        // 不是「关闭导入对话框」。textarea 上的 IME 取消要优先放行。
        if (isImeComposing(e)) return;
        e.preventDefault();
        close(null);
      } else if (isCmdEnter(e) && !isImeComposing(e)) {
        // Ctrl/Cmd+Enter 在 textarea 里提交（与很多编辑器习惯一致）；
        // 单 Enter 必须保留为换行 —— 否则粘贴多行后回车就意外提交了。
        e.preventDefault();
        if (!okBtn.disabled) okBtn.click();
      } else if (e.key === 'Tab') {
        // 焦点陷阱：textarea 内部 Tab 仍可缩进，但 textarea 自身不响应 Tab 键的
        // focus 跳转 —— 浏览器的默认行为是从 textarea 末尾跳到地址栏。
        // 这里仅在 textarea 之外拦截，textarea 内放行让浏览器默认处理（输入 Tab）。
        if (document.activeElement !== textarea) {
          trapFocus(e, overlay, signal);
        }
      }
    };
    overlay.addEventListener('keydown', onKey, { signal, capture: true });

    // 计数立即算一次（默认值「0 条」已经渲染了占位，但调用 computeCount
    // 不依赖 DOM 完成，sync 跑一次免去 setTimeout 内等待的闪烁感）。
    syncCount();
    // 聚焦 textarea 必须 setTimeout：避开弹窗动画期间的 IME 残留 isComposing，
    // 也避免 50ms 内的焦焦点漂移被浏览器自动 blur 弹窗外。
    setTimeout(() => textarea.focus(), 50);
  });
}

// 焦点陷阱：trapFocus 从 src/utils/focus-trap.js 导入（与 feedback.js / conflict-dialog.js 共享）