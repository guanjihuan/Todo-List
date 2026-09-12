// 任务粒度冲突解决对话框
//
// 当「磁盘上的 todo.md」与「内存里的 store.categories」不一致（且 store 有未保存改动）
// 时弹出。让用户按任务粒度逐条选择保留哪边，而不是传统的「整盘重载 or 整盘保留」二选一。
//
// 设计要点：
//   1. **任务粒度而非整盘**：用户在 UI 里改 A 任务、外部编辑器改 B 任务 —— 不该因为 A
//      改了就让 B 的外部编辑丢失。这是 v3.4 重构的核心修复（旧 confirmDialog 只能整盘二选一）。
//   2. **三列布局**：左 = 文件版本、中 = 选择器、右 = 本地版本。每行都是一个独立决策点。
//   3. **默认智能**：仅一边有的默认保留；两边都改的默认「两边都保留」（合并标记）。
//   4. **永远有兜底**：点「全部用文件」会先在主进程落一份带时间戳的快照(.discard-*.bak)，
//      选「全部用本地」会走 saveNow 把本地写回磁盘，「取消」则什么都不做。
//   5. **对话期间继续改** 用户可继续操作 UI —— dialog 关闭时基于「打开时拿到的快照」应用
//      选择，调用方需要在打开前 snapshot() 一份，关闭后比对 dirty 数。
//   6. **焦点陷阱 + AbortController** 沿用 feedback.js 的模式，键盘流顺畅。
//   7. **行级 diff 入口**：header 加"查看完整行级 diff"按钮，让好奇的 / 高级用户看到
//      任务粒度之外的纯文本差异 —— 用 LCS 算法逐行红绿着色（LCS 实现见 diff-preview-dialog.js）。

import { escapeHtml } from '../utils/dom.js';
import { trapFocus } from '../utils/focus-trap.js';
import { isImeComposing, isCmdEnter } from '../utils/keymap.js';
import { openDiffPreview } from './diff-preview-dialog.js';
import { runBeforeModalShow } from './feedback.js';

/**
 * 把 task 对象渲染成可视的「一行」HTML。
 * 标识：[✓] / [▶] / [⭐] / [原分类：xxx] 都按视觉权重排好（与 markdown-writer 一致：
 * [▶] 当前在前，[⭐] 重要在中，[原分类] 在最后）。完成状态用 ✓ 而不是 ×。
 *
 * 原分类标记：用 `.conflict-task-orig` 类做灰色小字 —— 与 markdown 文件里的位置一致
 * （COMPLETED / TRASH 分类里才有意义，普通子分类的 task.originalCategory 通常为 null）。
 * 这里的渲染是**纯展示**——是否真输出 [原分类：xxx] 仍由 markdown-writer 决定
 * （见 markdown-writer.js:formatTaskLine 中的 showOriginalCategory 判断）。
 *
 * @param {object} task
 * @param {string} className - 附加到行容器的 class（如 conflict-task-side-file）
 */
function renderTaskRow(task, className = '') {
  if (!task) return '';
  const cb = task.completed ? '[✓]' : '[ ]';
  // 原分类标记：仅当 task.originalCategory 存在时显示。task.text 会被 escapeHtml 转义
  // —— originalCategory 来源是磁盘 markdown 解析产物，理论上安全，但仍然走 escapeHtml
  // 保持一致（防御用户故意在原分类名里塞 <script>）。
  const orig = task.originalCategory
    ? `<span class="conflict-task-orig">[原分类：${escapeHtml(task.originalCategory)}]</span> `
    : '';
  const markers = [
    task.current ? '[▶]' : '',
    task.important ? '[⭐]' : '',
  ].filter(Boolean).join(' ');
  // 不要在这里手动 replace —— 下面的 escapeHtml 会再次转义 & → &amp;，
  // 导致 `&lt;` 变成 `&amp;lt;`（双重编码），用户看到字面 `&amp;lt;script&amp;gt;`。
  // 单次 escapeHtml 已覆盖 < > & " ' 全部危险字符。
  const text = task.text || '';
  const classAttr = className ? ` class="${escapeHtml(className)}"` : '';
  return `<div${classAttr}>${escapeHtml(cb)} ${markers ? escapeHtml(markers) + ' ' : ''}${orig}${escapeHtml(text)}</div>`;
}

/**
 * 把 diff 里的一条 (onlyInDisk / onlyInMemory / modified) 渲染成三列中一行。
 *
 * modified 类型左右两侧都有；onlyIn* 只有一侧。
 *
 * @param {object} item - diff item
 * @param {'onlyInDisk'|'onlyInMemory'|'modified'} kind
 * @param {string} diffKey - 用于 select 识别是哪一行
 * @param {string} currentChoice - 当前选择 ('a'|'b'|'both'|'skip')
 */
function renderDiffRow(item, kind, diffKey, currentChoice) {
  const selectId = `conflict-choice-${diffKey}`;
  // modified: 两侧都展示；onlyIn*: 仅一边展示
  let leftCell = '';
  let rightCell = '';
  if (kind === 'onlyInDisk') {
    leftCell = renderTaskRow(item.task, 'conflict-task-side-file');
    rightCell = '<div class="conflict-task-empty">（本地没有）</div>';
  } else if (kind === 'onlyInMemory') {
    leftCell = '<div class="conflict-task-empty">（文件没有）</div>';
    rightCell = renderTaskRow(item.task, 'conflict-task-side-mine');
  } else if (kind === 'modified') {
    leftCell = renderTaskRow(item.taskA, 'conflict-task-side-file');
    rightCell = renderTaskRow(item.taskB, 'conflict-task-side-mine');
  }

  // 操作选项：每种 kind 可用的选择集合不一样
  // - onlyInDisk: 'a'(用文件) / 'skip'(丢) / 'both'(等价 'a'，保留)
  // - onlyInMemory: 'b'(用本地) / 'skip'(丢)
  // - modified: 'a'(用文件) / 'b'(用本地) / 'both'(合并) / 'skip'(丢)
  let options;
  if (kind === 'onlyInDisk') {
    options = [
      { value: 'a', label: '保留（用文件版）' },
      { value: 'skip', label: '丢弃（本地无）' },
    ];
  } else if (kind === 'onlyInMemory') {
    options = [
      { value: 'b', label: '保留（用本地版）' },
      { value: 'skip', label: '丢弃（文件无）' },
    ];
  } else {
    options = [
      { value: 'a', label: '用文件版' },
      { value: 'b', label: '用本地版' },
      { value: 'both', label: '两边都保留（合并标记）' },
      { value: 'skip', label: '不要（两边都丢）' },
    ];
  }

  const optionsHtml = options.map(opt =>
    `<option value="${escapeHtml(opt.value)}"${opt.value === currentChoice ? ' selected' : ''}>${escapeHtml(opt.label)}</option>`
  ).join('');

  return `
    <div class="conflict-row" data-diff-key="${escapeHtml(diffKey)}">
      <div class="conflict-cell conflict-cell-file">${leftCell}</div>
      <div class="conflict-cell conflict-cell-chooser">
        <select class="conflict-choice" id="${selectId}" data-diff-key="${escapeHtml(diffKey)}">
          ${optionsHtml}
        </select>
      </div>
      <div class="conflict-cell conflict-cell-mine">${rightCell}</div>
    </div>
  `;
}

/**
 * 打开冲突解决对话框。
 *
 * @param {object} options
 * @param {object} options.diff - store.diffWithDisk() 输出
 * @param {object} options.defaultResolutions - 初始选择映射（key → 'a'|'b'|'both'|'skip'）
 * @param {object} options.summary - { total, addedByFile, addedByMine, conflicting }
 * @param {string} [options.diskContent] - 磁盘当前内容（用于"查看完整行级 diff"按钮）
 * @param {string} [options.memoryText] - 本地 serialize() 输出（同上）
 * @returns {Promise<{
 *   action: 'apply'|'keep-file'|'keep-mine'|'cancel',
 *   resolutions?: object,
 * }>}
 */
export function openConflictDialog({ diff, defaultResolutions, summary, diskContent, memoryText }) {
  return new Promise((resolve) => {
    // M8：挂载 overlay 之前清掉瞬态状态（拖拽 / 进行中的菜单 / 等）
    runBeforeModalShow();
    const previouslyFocused = document.activeElement;

    // 行顺序：先 onlyInDisk（文件新加的）→ 再 onlyInMemory（本地新加的）→ 最后 modified（两边都有但不同）。
    // 把「两边都改」放最后 —— 用户最关心的「我刚刚在 UI 里改的东西」会最先看到。
    const rows = [];
    for (const item of diff.onlyInDisk) {
      rows.push({ kind: 'onlyInDisk', item, key: item.key });
    }
    for (const item of diff.onlyInMemory) {
      rows.push({ kind: 'onlyInMemory', item, key: item.key });
    }
    for (const item of diff.modified) {
      rows.push({ kind: 'modified', item, key: item.key });
    }

    const rowsHtml = rows.map(row =>
      renderDiffRow(
        row.item,
        row.kind,
        row.key,
        // H7 同步：modified 默认 'both'（OR 合并状态，与 markdown-diff.defaultResolutions 对齐）
        defaultResolutions[row.key] || (row.kind === 'onlyInDisk' ? 'a' : row.kind === 'onlyInMemory' ? 'b' : 'both')
      )
    ).join('');

    const summaryHtml = `
      <div class="conflict-summary">
        <span class="conflict-stat conflict-stat-total">共 ${summary.total} 处差异</span>
        ${summary.addedByFile > 0 ? `<span class="conflict-stat">文件新加 ${summary.addedByFile}</span>` : ''}
        ${summary.addedByMine > 0 ? `<span class="conflict-stat">本地新加 ${summary.addedByMine}</span>` : ''}
        ${summary.conflicting > 0 ? `<span class="conflict-stat conflict-stat-conflict">两边都改 ${summary.conflicting}</span>` : ''}
      </div>
    `;

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay conflict-dialog-overlay';
    overlay.innerHTML = `
      <div class="modal conflict-dialog-modal" role="dialog" aria-modal="true"
           aria-labelledby="conflict-dialog-title" aria-describedby="conflict-dialog-summary">
        <div class="modal-header conflict-dialog-header" id="conflict-dialog-title">
          <span class="conflict-dialog-title-text">文件与本地不一致 —— 请选择保留哪边</span>
          <button class="conflict-diff-preview-btn"
                  data-action="open-diff-preview"
                  title="按行对比文件版与本地版的纯文本差异（LCS 红绿着色）"
                  aria-label="查看完整行级 diff">
            查看完整行级 diff
          </button>
        </div>
        <div class="conflict-dialog-summary" id="conflict-dialog-summary">
          ${summaryHtml}
        </div>
        <div class="conflict-dialog-grid-header">
          <div class="conflict-cell-header">📄 文件版本（磁盘）</div>
          <div class="conflict-cell-header">选择</div>
          <div class="conflict-cell-header">💻 本地版本（软件）</div>
        </div>
        <div class="conflict-dialog-body">
          ${rowsHtml || '<div class="conflict-empty">没有差异</div>'}
        </div>
        <div class="modal-footer conflict-dialog-footer">
          <button class="btn" data-action="cancel">取消</button>
          <button class="btn" data-action="keep-mine">全部用本地</button>
          <button class="btn btn-danger" data-action="keep-file">全部用文件（丢弃本地，会保存快照）</button>
          <button class="btn btn-primary" data-action="apply" autofocus>应用合并</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const ac = new AbortController();
    const { signal } = ac;

    let resolved = false;
    const close = (result) => {
      if (resolved) return;
      resolved = true;
      // 清理「全部用本地」二次确认定时器 —— close 时还在 4s 武装态的话，
      // 定时器不 clear 会延迟到点才 fire，闭包挂着 keepMineBtn / originalText
      // 等引用（虽然 `if (!resolved)` 守卫让副作用落空，但 GC 被推迟到 timer fire）。
      clearTimeout(keepMineArmTimer);
      keepMineArmTimer = null;
      ac.abort();
      // 缩放淡出 + focus 恢复挪到 animationend 内（焦点元素不能先于 destroy）
      const inner = overlay.querySelector('.modal');
      // focus() 必须在 overlay.remove() 之前；animationend 与 250ms 兜底共享
      // finalize —— 否则 animationend 漏触发（display:none / 元素被提前 detach）
      // 时 setTimeout 仅 remove 不 restoreFocus+resolve，Promise 永久挂起，
      // 调用方 await conflict-dialog → 后续 saveNow / toast 永远不执行。
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

    // 收集当前所有 select 的值 → resolutions 对象
    const collectResolutions = () => {
      const res = {};
      overlay.querySelectorAll('.conflict-choice').forEach((sel) => {
        const key = sel.dataset.diffKey;
        if (key) res[key] = sel.value;
      });
      return res;
    };

    overlay.addEventListener('click', (e) => {
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (action === 'apply') {
        close({ action: 'apply', resolutions: collectResolutions() });
      } else if (action === 'keep-mine') {
        close({ action: 'keep-mine' });
      } else if (action === 'keep-file') {
        close({ action: 'keep-file' });
      } else if (action === 'open-diff-preview') {
        // 行级 diff 预览：开第二个 modal 浮在第一个上面，关闭后焦点回到这个按钮。
        // openDiffPreview 自带 openDiffPreview 自带 previouslyFocused.focus()，
        // 用户体验：点查看 → 看到红绿行级 diff → 关 → 自动回到 conflict-dialog。
        // 两个 modal 不嵌套（diff-overlay 是 document.body 的 sibling，不是 conflict-overlay 的 child），
        // 事件不会互相冒泡，conflict-overlay 的 click 监听器不会被 diff-overlay 误触发。
        if (typeof diskContent === 'string' && typeof memoryText === 'string') {
          openDiffPreview({
            oldText: diskContent,
            newText: memoryText,
            title: '文件 vs 本地 —— 完整行级 diff',
          });
        } else {
          // 兜底：调用方忘了传 diskContent / memoryText，给一个可观察的反馈而不是静默失败
          console.warn('[conflict-dialog] diskContent / memoryText 未传入，行级 diff 按钮不可用');
        }
      } else if (action === 'cancel' || e.target === overlay) {
        close({ action: 'cancel' });
      }
    }, { signal });

    // 「应用合并」快捷键：Cmd/Ctrl+Enter
    // Escape 取消。IME 组合期间不响应。
    //
    // 关键：只对**本 overlay 内部**的键盘事件响应。
    // conflict-overlay 与 diff-preview-overlay 是 document.body 的 sibling，
    // 我们用 capture: true 是为了在事件冒泡前先抓到 Tab（焦点陷阱需要），
    // 但副作用是 sibling 上的事件也会经过 capture 阶段跑一遍。
    // 如果不检查事件源，用户在 diff 预览里按 Escape 会顺带关掉 conflict-dialog。
    // （v4 audit 实测发现的回归 —— 早期没有 sibling modal，没暴露这个问题）
    const onKey = (e) => {
      // 事件必须源自本 overlay 内部 —— 避免 sibling overlay 的按键被误处理
      if (!overlay.contains(e.target)) return;
      if (e.key === 'Escape') {
        // IME 守卫：CJK/JP/KR 用户在选词中按 Esc 是「取消 IME 组合」，
        // 不是「放弃冲突合并」。让 IME 先消化掉 Esc，关掉弹窗太重。
        if (isImeComposing(e)) return;
        e.preventDefault();
        close({ action: 'cancel' });
      } else if (isCmdEnter(e) && !isImeComposing(e)) {
        // Cmd/Ctrl+Enter → 应用合并
        e.preventDefault();
        close({ action: 'apply', resolutions: collectResolutions() });
      } else if (e.key === 'Tab') {
        // 焦点陷阱
        trapFocus(e, overlay, signal);
      }
    };
    overlay.addEventListener('keydown', onKey, { signal, capture: true });

    // 「全部用本地」按钮做二次确认 —— 容易误点
    // 第一次点击：按钮变红 + 文案改「再次点击确认丢弃外部编辑」
    // 第二次点击：才真正提交 keep-mine
    // 4 秒内没二次点击则自动复位
    const keepMineBtn = overlay.querySelector('[data-action="keep-mine"]');
    let keepMineArmed = false;
    let keepMineArmTimer = null;
    if (keepMineBtn) {
      const originalText = keepMineBtn.textContent;
      // 武装态同步给屏幕阅读器：aria-pressed=true 让辅助技术知道当前状态。
      // 视觉上的红边框 + 文案变化对 sighted 用户明确，对屏幕阅读器则需要 aria 反馈。
      keepMineBtn.addEventListener('click', (e) => {
        if (!keepMineArmed) {
          // 第一次点击 —— 武装按钮,不冒泡到 overlay 的处理
          e.stopPropagation();
          e.preventDefault();
          keepMineArmed = true;
          keepMineBtn.classList.add('btn-danger');
          keepMineBtn.dataset.armed = '1';
          keepMineBtn.textContent = '再次点击：丢弃外部编辑';
          keepMineBtn.setAttribute('aria-pressed', 'true');
          // 4 秒没再点 → 自动复位
          clearTimeout(keepMineArmTimer);
          keepMineArmTimer = setTimeout(() => {
            if (!resolved) {
              keepMineArmed = false;
              keepMineBtn.classList.remove('btn-danger');
              delete keepMineBtn.dataset.armed;
              keepMineBtn.textContent = originalText;
              keepMineBtn.setAttribute('aria-pressed', 'false');
            }
          }, 4000);
        }
        // 第二次点击 —— 不 stopPropagation,让 overlay 走 keep-mine 路径
      }, { signal });
    }

    // 初始聚焦到「应用合并」按钮（已通过 autofocus）
    setTimeout(() => {
      overlay.querySelector('[data-action="apply"]')?.focus();
    }, 50);
  });
}

// 焦点陷阱：trapFocus 从 src/utils/focus-trap.js 导入（与 feedback.js / import-dialog.js 共享）