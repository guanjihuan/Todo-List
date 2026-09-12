// 命令面板 (Cmd/Ctrl+K) - 极简命令中心
// 支持：搜索列表、跳转列表、视图操作、主题切换等

import { escapeHtml } from '../utils/dom.js';
import { isImeComposing } from '../utils/keymap.js';
import { runBeforeModalShow } from './feedback.js';

let _active = false;

/**
 * 打开命令面板
 *
 * 返回的 Promise 在面板关闭（Esc / 点击外部 / 执行命令 / 异常）时 resolve，
 * 这样 `_active` 才能正确覆盖面板的整个生命周期，避免「面板永远关不掉」。
 *
 * 旧实现把整个流程放在 `async` 函数里却没有 `await`，导致 Promise 在面板
 * 渲染完之前就 resolve，`_active` 立刻被 finally 还原；后续 `close()` 里的
 * `if (!_active) return` 永远短路 → 面板僵死在屏幕上且无法再次打开。
 *
 * @param {TaskStore} store
 * @param {object} handlers 自定义动作钩子
 * @returns {Promise<void>}
 */
export function openCommandPalette(store, handlers = {}) {
  if (_active) return Promise.resolve();
  _active = true;
  // 任何中途抛错都要释放 _active，否则面板就再也打不开了
  return _openCommandPaletteInner(store, handlers).finally(() => {
    _active = false;
  });
}

function _openCommandPaletteInner(store, handlers) {
  return new Promise((resolve) => {
  // M8：command-palette 也走同一个 modal 打开前 hook 体系 —— 即便它用
  // .command-palette-overlay（不是 .modal-overlay），拖拽的 pointerup 同样
  // 会在面板挂载后才派发，导致任务被偷偷重排。
  runBeforeModalShow();
  // 记下打开前的焦点，关闭时还原 —— 否则用户按 Ctrl+K、跳到列表、回车后
  // 焦点就漂在 overlay 上 / document.body 上，键盘流断掉。
  const previouslyFocused = document.activeElement;

  const overlay = document.createElement('div');
  overlay.className = 'command-palette-overlay';
  overlay.innerHTML = `
    <div class="command-palette">
      <div class="command-palette-input-row">
        <span class="search-icon" aria-hidden="true">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="6.5" cy="6.5" r="4.5"/>
            <line x1="10" y1="10" x2="14" y2="14"/>
          </svg>
        </span>
        <input type="text" class="command-palette-input"
               placeholder="输入命令或搜索列表…"
               spellcheck="false" autocomplete="off"
               role="combobox" aria-controls="command-palette-listbox"
               aria-expanded="true" aria-autocomplete="list">
      </div>
      <ul class="command-palette-list" id="command-palette-listbox" role="listbox"></ul>
    </div>
  `;
  document.body.appendChild(overlay);

  const input = overlay.querySelector('input');
  const listEl = overlay.querySelector('.command-palette-list');

  // 命令源
  const commands = buildCommands(store, handlers);
  let activeIdx = 0;
  // 记住用户**实际选中过的最后一项**，仅在搜索导致列表彻底变空
  // （无任何匹配）时回退到此；清空搜索回到全列表时也用它 —— 否则
  // 用户键入 → 高亮 0 → 跳到 5 → 清空搜索 → 高亮仍停在 5，UX 不直观。
  let lastNonEmptyIdx = 0;

  const render = () => {
    const q = input.value.trim().toLowerCase();
    let filtered;
    if (!q) {
      filtered = commands;
    } else {
      // M-S9: 改成 fuzzy subsequence —— 用户输入「主图」能匹配到「切换主题」，
      // 不再要求连续子串。中文按 codePoint 拆（Array.from 而非 split('')），
      // 避免 surrogate pair 把 emoji/生僻字拆成两半导致匹配错位。
      const qChars = Array.from(q);
      filtered = commands.filter(c => {
        const labelChars = Array.from(c.label.toLowerCase());
        if (isSubsequence(qChars, labelChars)) return true;
        if (c.keywords) {
          const kwChars = Array.from(c.keywords.toLowerCase());
          if (isSubsequence(qChars, kwChars)) return true;
        }
        return false;
      });
    }
    if (filtered.length === 0) {
      listEl.innerHTML = `<div class="command-palette-empty">没有匹配的命令</div>`;
      // 让屏幕阅读器知道当前没有可用选项
      input.setAttribute('aria-activedescendant', '');
      activeIdx = -1;
      return;
    }
    if (activeIdx === -1 || activeIdx >= filtered.length) {
      // 从无匹配回到有匹配：粘住用户上次选中的位置（多数情况下仍是其意图所在），
      // 越界则回退到 0。避免「键入 5 字再清空 → 高亮跳回第一项」的视觉跳动。
      activeIdx = Math.min(lastNonEmptyIdx, filtered.length - 1);
    }
    lastNonEmptyIdx = activeIdx;
    listEl.innerHTML = filtered.map((c, i) => {
      const isActive = i === activeIdx;
      return `
      <li class="command-palette-item ${isActive ? 'active' : ''}"
          data-idx="${i}" data-id="${escapeHtml(c.id)}"
          id="cmd-item-${i}"
          role="option" ${isActive ? 'aria-selected="true"' : ''}>
        <span class="command-palette-item-icon">${c.icon || ''}</span>
        <span class="command-palette-item-label">${escapeHtml(c.label)}</span>
        ${c.hint ? `<span class="command-palette-item-hint">${escapeHtml(c.hint)}</span>` : ''}
      </li>
    `;
    }).join('');
    // input 不离开焦点，aria-activedescendant 指向当前选项 —— ARIA combobox 推荐做法，
    // 这样键盘焦点在 input、视觉焦点（高亮行 + 滚动）在 listbox 上
    input.setAttribute('aria-activedescendant', `cmd-item-${activeIdx}`);
  };

  // 用 AbortController 一次性回收所有 document 级监听器，避免与其它面板叠加
  const ac = new AbortController();
  const { signal } = ac;

  // 本地关闭守卫：闭包内多次 close（Esc + 点击外部 + 执行命令）只生效一次
  // （不能再依赖模块级 `_active`，它在 finally 里会被同步翻转）
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    ac.abort();
    // 缩放淡出后再 remove —— 命令面板入场用 palette-in，对应退出用 palette-out。
    // focus 恢复放在 animationend 内（被销毁的祖先元素上 focus 会跳到 body）
    const inner = overlay.querySelector('.command-palette');
    // focus() 必须在 overlay.remove() 之前 —— 见 feedback.js 同款注释
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
      // 兜底必须 resolve：否则 animationend 不触发时 .finally 不跑、_active 永不清、
      // Ctrl+K 永久失效（致命）。250ms 已经超过 0.18s 动画时长，足以作为保险
      setTimeout(finalize, 250);
    } else {
      finalize();
    }
  };

  const execute = (cmd) => {
    if (!cmd) return;
    close();
    // v4+ 修复：handlers 里有 async 函数（典型 onNewList —— 它会 await 弹窗），
    // run() 返回的 Promise 若 reject，旧 try/catch 只挡同步异常，Promise 冒
    // unhandled rejection 给 window.onerror。补一行：
    //   - 如果 run() 返回 Promise（async / thenable）→ 链 .catch 兜底；
    //   - 否则保持原行为（同步执行抛错走 catch）。
    try {
      const result = cmd.run();
      if (result && typeof result.then === 'function') {
        result.catch((e) => console.warn('[cmd] 异步执行失败:', e?.message || e));
      }
    } catch (e) {
      console.warn('[cmd] 执行失败:', e?.message || e);
    }
  };

  const onKey = (e) => {
    if (e.key === 'Escape') {
      // IME 守卫：CJK/JP/KR 用户在搜索框里按 Esc 优先是「取消 IME 组合」，
      // 不应误关整个命令面板。
      if (isImeComposing(e)) return;
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const items = listEl.querySelectorAll('.command-palette-item');
      if (!items.length) return;
      activeIdx = (activeIdx + 1) % items.length;
      updateActive(items);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      const items = listEl.querySelectorAll('.command-palette-item');
      if (!items.length) return;
      activeIdx = (activeIdx - 1 + items.length) % items.length;
      updateActive(items);
      return;
    }
    if (e.key === 'Enter') {
      // IME 组合输入期间按 Enter 是「上屏候选词」，不是「确认命令」——
      // 漏掉这个判断，CJK 用户每次选候选词都会意外触发高亮项的命令。
      if (isImeComposing(e)) return;
      e.preventDefault();
      const items = listEl.querySelectorAll('.command-palette-item');
      const targetId = items[activeIdx]?.dataset.id;
      if (!targetId) return;
      const cmd = commands.find(c => c.id === targetId);
      execute(cmd);
      return;
    }
    if (e.key === 'Tab') {
      // 面板内只有 input 一个可聚焦元素 —— 拦下 Tab 别让它把焦点偷到底下的任务列表
      e.preventDefault();
    }
  };

  const updateActive = (items) => {
    items.forEach((it, i) => it.classList.toggle('active', i === activeIdx));
    const active = items[activeIdx];
    if (active) active.scrollIntoView({ block: 'nearest' });
  };

  input.addEventListener('input', () => {
    activeIdx = 0;
    render();
  });

  listEl.addEventListener('click', (e) => {
    const item = e.target.closest('.command-palette-item');
    if (!item) return;
    const targetId = item.dataset.id;
    const cmd = commands.find(c => c.id === targetId);
    execute(cmd);
  });

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  document.addEventListener('keydown', onKey, { signal, capture: true });

  // 初始渲染放在 try 里：万一构建命令列表 / 渲染时抛错，也必须把 overlay 和
  // 监听器清掉再往外抛。否则屏幕上会留下一个关不掉的空面板，而 app.js 里
  // 「已有 .command-palette-overlay 就不再触发」的判断会让 Ctrl+K 从此彻底失效。
  try {
    render();
    setTimeout(() => input.focus(), 30);
  } catch (e) {
    // 不走 close()：它会 resolve，从而把异常吞掉。这里手动清理后把错误抛出去，
    // 让 Promise reject —— app.js 的 catch 会记录日志，_active 也由 finally 释放。
    //
    // focus() 必须在 overlay.remove() 之前：与 close() 的 finalize 同源 —— 一旦
    // overlay 销毁，再 focus 它的后代节点会跳到 body；render() 抛错之前 30ms 的
    // setTimeout(input.focus) 已把焦点挪到 input，所以必须把焦点还回调用方
    // 之前停留的元素（避免 catch 之后用户键盘失焦）。
    closed = true;
    ac.abort();
    if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
      previouslyFocused.focus();
    }
    overlay.remove();
    throw e;
  }
  });
}

/**
 * 命令面板图标（返回 SVG HTML 字符串）
 * 与侧边栏 / 任务列表的图标设计语言保持一致。
 * 未知名称返回空字符串，由调用方的 `c.icon || ''` 安全兜底。
 */
function icon(name) {
  switch (name) {
    case '+':
    case 'plus':
      return '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
    case 'settings':
      return '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>';
    case 'moon':
      return '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
    case 'sun':
      return '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>';
    case 'star':
      return '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"/></svg>';
    case 'folder':
      return '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>';
    case '✓':
    case 'check':
      return '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
    default:
      return '';
  }
}

/**
 * 构建命令列表
 */
function buildCommands(store, handlers) {
  const cmds = [];

  // 顶部：直接动作
  cmds.push(
    cmd('add-task', '添加任务到当前列表', icon('+'), '', () => {
      const inp = document.getElementById('task-input');
      if (inp) inp.focus();
    }),
    cmd('cmd:new-list', '新建列表', icon('plus'), 'Ctrl+Shift+N', () => handlers.onNewList?.()),
    cmd('cmd:settings', '设置', icon('settings'), 'Ctrl+,', () => handlers.onOpenSettings?.())
  );

  // 视图
  cmds.push(
    cmd('view:theme', '切换主题', icon('moon'), 'Ctrl+Shift+T', () => handlers.onToggleTheme?.())
  );

  // 视图 → 智能列表
  //
  // v3：当前任务已从「分类」升级为「智能列表」（聚合任意子分类下打了 @当前 标识的任务）
  // 所以它和重要/全部/已完成 一并作为聚合视图呈现 —— 用户能直接跳转，无需先选具体子分类。
  cmds.push(
    cmd('view:my-day', '当前任务', icon('sun'), 'Alt+1', () => handlers.onSwitchSmartList?.('current')),
    cmd('view:important', '重要任务', icon('star'), 'Alt+2', () => handlers.onSwitchSmartList?.('important')),
    cmd('view:all-tasks', '全部任务', icon('folder'), 'Alt+3', () => handlers.onSwitchSmartList?.('allTasks')),
    cmd('view:completed', '已完成任务', icon('✓'), 'Alt+4', () => handlers.onSwitchSmartList?.('completed'))
  );

  // 跳转到列表（仅子分类 —— 「当前任务」已是上方聚合视图，不再重复列出）
  const cats = store.categories.filter(c => c.parentOtherTasks);
  for (const cat of cats) {
    cmds.push(cmd(
      `cat:${cat.name}`,
      cat.name,
      icon('folder'),
      '',
      () => handlers.onSwitchCategory?.(cat.name)
    ));
  }

  return cmds;
}

function cmd(id, label, icon, hint, run) {
  return { id, label, icon, hint, run };
}

/**
 * 判断 needle 是否是 haystack 的子序列（按 codePoint 比较，顺序保持，相对位置不必连续）。
 *
 * 用法：「主图」能匹配「切换主题」（主 → 主匹配，切 → 切匹配，图 → 主题里没有，
 * 但若 needle 只 1 字就直接看 haystack 是否包含）。这里特指 fuzzy 路径：
 * 「主题」匹配「切换主题」直接命中（主、题按序在「切换主题」里都能找到）。
 *
 * 注意：空 needle 视为「匹配所有」 —— render() 已用 if (!q) 短路，这里只
 * 是防御性返回 true。
 *
 * @param {string[]} needle
 * @param {string[]} haystack
 * @returns {boolean}
 */
function isSubsequence(needle, haystack) {
  if (!needle || needle.length === 0) return true;
  if (!haystack || haystack.length === 0) return false;
  let hi = 0;
  for (let ni = 0; ni < needle.length; ni++) {
    const target = needle[ni];
    let found = false;
    while (hi < haystack.length) {
      if (haystack[hi] === target) { found = true; hi++; break; }
      hi++;
    }
    if (!found) return false;
  }
  return true;
}

// 注意：原本有 closeCommandPalette 导出，但从未被使用且依赖 _overlay.click() 这种 hack，
// 改由调用方直接管理生命周期（openCommandPalette 的 close 已为内部函数）
