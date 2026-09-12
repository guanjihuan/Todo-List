// 行级 diff 预览对话框
//
// 把「磁盘当前内容」与「本地 serialize() 输出」按行对比，给用户一个直观的可视化。
// 用于冲突对话框之外需要看「具体哪里变了」的场景（例如开发者诊断、设置面板里手动触发 reload）。
//
// 实现：朴素 LCS / Myers 算法对 50KB 以内文件足够快（通常 < 50ms）。不做复杂的块级 diff，
// 用户看到「红/绿」就够 —— 任务级合并对话框已经覆盖了「按任务粒度选」的核心需求，这里只是
// 给好奇的 / 高级用户一个文字级视图。

import { escapeHtml } from '../utils/dom.js';
import { runBeforeModalShow } from './feedback.js';
import { trapFocus } from '../utils/focus-trap.js';
import { isImeComposing } from '../utils/keymap.js';

/**
 * 计算两个文本的行级 diff（朴素 LCS）。
 *
 * 行尾换行符规范化：split('\n') 仍保留 '\r'（仅去掉 \n），所以 Windows 编辑器
 * 写的 CRLF 与应用自身写的 LF 在比较时会被判为「每行都不同」—— 一整篇文档
 * 看起来全是 add/remove，用户看不出真正的差异。
 *
 * @param {string} oldText
 * @param {string} newText
 * @returns {Array<{kind: 'equal'|'add'|'remove', text: string}>}
 */
function computeLineDiff(oldText, newText) {
  // split('\n') 后保留可能的 '\r'，统一 trimEnd 去掉。
  // trimEnd 而不是 replace(/\r$/, '')：连续空行不会被误吞，且空行末尾本来就不该有 \r。
  const oldLines = (oldText || '').split('\n').map(l => l.replace(/\r$/, ''));
  const newLines = (newText || '').split('\n').map(l => l.replace(/\r$/, ''));
  const m = oldLines.length;
  const n = newLines.length;

  // LCS 长度表
  // 性能保护：行数超过 4000 退化为「只比对总行数 + 显示前 200 行」，
  // 避免卡死主线程（Electron 主进程阻塞会让 UI 卡顿）。
  const MAX_LINES = 4000;
  if (m > MAX_LINES || n > MAX_LINES) {
    return [
      { kind: 'remove', text: `--- 文件过大（${m} 行），已截断。完整差异请打开外部 diff 工具。` },
    ];
  }

  // 动态规划
  const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // 回溯生成 diff
  const result = [];
  let i = m, j = n;
  while (i > 0 && j > 0) {
    if (oldLines[i - 1] === newLines[j - 1]) {
      result.unshift({ kind: 'equal', text: oldLines[i - 1] });
      i--; j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      result.unshift({ kind: 'remove', text: oldLines[i - 1] });
      i--;
    } else {
      result.unshift({ kind: 'add', text: newLines[j - 1] });
      j--;
    }
  }
  while (i > 0) { result.unshift({ kind: 'remove', text: oldLines[i - 1] }); i--; }
  while (j > 0) { result.unshift({ kind: 'add', text: newLines[j - 1] }); j--; }

  return result;
}

/**
 * 打开行级 diff 预览。
 *
 * @param {object} options
 * @param {string} options.oldText - 旧文本（磁盘）
 * @param {string} options.newText - 新文本（本地）
 * @param {string} options.title - 标题
 * @returns {Promise<void>}
 */
export function openDiffPreview({ oldText, newText, title = '行级 diff 预览' }) {
  return new Promise((resolve) => {
    // M8：挂载 overlay 之前清掉瞬态状态（拖拽 / 进行中的菜单 / 等）
    runBeforeModalShow();
    const previouslyFocused = document.activeElement;
    const diff = computeLineDiff(oldText, newText);

    const linesHtml = diff.map((line) => {
      const cls = `diff-line diff-line-${line.kind}`;
      const prefix = line.kind === 'add' ? '+ ' : line.kind === 'remove' ? '- ' : '  ';
      return `<div class="${cls}"><span class="diff-line-prefix">${prefix}</span><span class="diff-line-text">${escapeHtml(line.text || '')}</span></div>`;
    }).join('');

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay diff-preview-overlay';
    overlay.innerHTML = `
      <div class="modal diff-preview-modal" role="dialog" aria-modal="true"
           aria-labelledby="diff-preview-title">
        <div class="modal-header diff-preview-header" id="diff-preview-title">
          ${escapeHtml(title)}
        </div>
        <div class="diff-preview-legend">
          <span class="diff-line-add-legend">+ 新增</span>
          <span class="diff-line-remove-legend">- 删除</span>
        </div>
        <div class="diff-preview-body">${linesHtml || '<div class="diff-empty">无差异</div>'}</div>
        <div class="modal-footer">
          <button class="btn btn-primary" data-action="close" autofocus>关闭</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const ac = new AbortController();
    const { signal } = ac;

    // 关闭守卫：连点「关闭」按钮 + Esc / overlay 多次触发时只生效一次。
    // 缺这个守卫：第二次 close() 会再挂一份 animationend 监听 + 再排一份 setTimeout，
    // 动画结束时 finalize 跑两次 → resolve 调两次（无 crash 但污染 Promise 状态 +
    // 多余的 overlay.remove / focus 调用）。与 conflict-dialog / feedback / settings-dialog
    // 等所有其他 modal 的 `resolved`/`closed` 守卫对齐。
    let resolved = false;
    const close = () => {
      if (resolved) return;
      resolved = true;
      ac.abort();
      // 缩放淡出后 remove —— 与 confirmDialog 同款，焦点恢复必须在 animationend 内
      const inner = overlay.querySelector('.modal');
      // animationend 与 250ms 兜底共享 finalize —— 避免 animationend 漏触发时
      // setTimeout 只 remove 不 restoreFocus+resolve，Promise 永久挂起。
      const finalize = () => {
        if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
          previouslyFocused.focus();
        }
        overlay.remove();
        resolve();
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
      if (action === 'close' || e.target === overlay) close();
    }, { signal });

    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        // IME 守卫：sibling 弹窗可能有 IME 组合中（冲突对话框 → diff 预览对话框的场景），
        // 让 IME 先消化 Esc，不要在这里拦截把它当成「关闭 diff 预览」。
        if (isImeComposing(e)) return;
        e.preventDefault();
        close();
      } else if (e.key === 'Tab') {
        // 与 feedback / conflict-dialog / import-dialog 对齐：modal 必须把 Tab
        // 焦点锁在内部，否则按 Tab 会跑进背景元素，破坏模态承诺。
        trapFocus(e, overlay, signal);
      }
    }, { signal });
  });
}