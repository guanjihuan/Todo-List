// 任务列表组件

import { CategoryKind } from '../markdown-parser.js';
import { Filter, SortBy, UNCATEGORIZED_NAME, TRASH_NAME } from '../task-store.js';
import { confirmDialog, toast, showContextMenu, hideContextMenu, registerBeforeModalShow } from './feedback.js';
import { openImportDialog } from './import-dialog.js';
import { buildStandardContextMenuItems, buildTrashContextMenuItems } from './task-context-menu.js';
import { escapeHtml, escapeAttr, escapeHtmlAutospace, needsCjkGap, CJK_GAP_HTML } from '../utils/dom.js';
import { DRAG_THRESHOLD } from '../utils/drag.js';
import { isImeComposing } from '../utils/keymap.js';

// 选择模式圆形选择器里的勾（SVG 字符串） —— 提到顶层常量，
// 让 _renderTaskItem 和 _refreshSelectionVisuals 共享一份源码，
// 改图标只需改一处。
const CHECK_SVG = '<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="white" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 8.5 6.5 11.5 12.5 4.5"/></svg>';

// _renderTaskItem 输出的 ⭐ / ▶ / 编辑 / 删除 / 恢复 SVG —— 全部 hoist 到模块顶层，
// 否则 500 任务 × 5 SVG × 每次 render = 2500 次模板字符串评估（H4 修复）。
// 三个图标都依赖 task.completed / / important / / current 的布尔状态，
// 通过构造器函数生成两个变体（实心 / 空心），避免在热路径里重新拼字符串。
const STAR_SVG_FILLED = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.123 2.123 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.123 2.123 0 0 0 1.597-1.16z"/></svg>';
const STAR_SVG_OUTLINE = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.123 2.123 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.123 2.123 0 0 0 1.597-1.16z"/></svg>';
function starSvgFor(active) {
  return active ? STAR_SVG_FILLED : STAR_SVG_OUTLINE;
}
const CURRENT_SVG_FILLED = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="6"/></svg>';
const CURRENT_SVG_OUTLINE = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="6"/></svg>';
function currentSvgFor(active) {
  return active ? CURRENT_SVG_FILLED : CURRENT_SVG_OUTLINE;
}
const EDIT_PENCIL_SVG = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/></svg>';
const DELETE_X_SVG = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
const RESTORE_SVG = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 9-9"/><polyline points="3 4 3 9 8 9"/></svg>';

// 过滤 chip 与过滤菜单共用的图标 —— 提到模块顶层，避免两处分别维护
// 一旦发散，chip 上的图标和菜单里的就不一致了
// 统一用 Lucide 24×24 viewBox + stroke-width 2.2，与工具栏图标同款描边规格
const FILTER_ICONS = Object.freeze({
  [Filter.ALL]:       '<svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor" aria-hidden="true"><circle cx="12" cy="12" r="6"/></svg>',
  [Filter.CURRENT]:   '<svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>',
  [Filter.COMPLETED]: '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>',
  [Filter.IMPORTANT]: '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"/></svg>'
});

const FILTER_LABELS = Object.freeze({
  [Filter.ALL]:       '全部',
  [Filter.CURRENT]:   '当前',
  [Filter.COMPLETED]: '已完成',
  [Filter.IMPORTANT]: '重要'
});

export class TaskList {
  constructor(store, options = {}) {
    this.store = store;
    // settingsStore 透传给 openImportDialog —— 让导入对话框里的「排序方式」
    // 选项能持久化到 settingsStore.importPosition（不再依赖全局 newTaskPosition）。
    // 缺省时对话框使用本次会话内默认值 'order'（按输入顺序、前面的内容在前），
    // 选择不会跨会话保留。
    this.settingsStore = options.settingsStore || null;
    this.titleEl = document.getElementById('category-title');
    this.titleProgressEl = document.getElementById('task-progress-text');
    this.listEl = document.getElementById('task-list');
    this.emptyEl = document.getElementById('empty-state');
    this.inputEl = document.getElementById('task-input');
    this.filterBtn = document.getElementById('btn-filter');
    this.filterChipEl = document.getElementById('filter-chip');
    this.sortBtn = document.getElementById('btn-sort');
    this.sortChipEl = document.getElementById('sort-chip');

    this.selectedTaskId = null;
    this.submitTaskBtn = document.getElementById('btn-submit-task');
    this.importBtn = document.getElementById('btn-import');
    // 跟踪「这次会话里见过的」所有任务 id（grow-only；'load' 事件清空）。
    // render() 重建 innerHTML 时只对不在集合里的打 .is-new，避免整列表 fade-in 闪烁。
    // 关键：必须是 grow-only —— 如果 reset 到「当前可见」集合，filter 切换 / 跨分类
    // 跳转后旧任务会被当成"新任务"再次 fade-in，反而比旧版闪烁更糟（按"新旧"判定
    // 而不是"出现/可见"，前提是"旧"真的指上次见到过）。文件 reload 会让所有 id 失效，
    // 此时清空整个集合是必要的。
    this._knownTaskIds = new Set();
    this.batchBtn = document.getElementById('btn-batch');

    // ========================
    //  选择模式（Selection Mode）
    // ========================
    // 进入方式：点头部「批量」chip；或在外部有选中时按 Cmd/Ctrl+A 进入并全选
    // 状态语义：
    //   - selectionMode === true：每行 task 可点切换选中；header 区隐藏 import/filter/sort；
    //     底部出现 .batch-action-bar 浮栏。
    //   - selectionMode === false：行为完全等同旧版（单条点击 / 拖拽 / 编辑）。
    // 已选用 Set<复合 key>：
    //   - 复合 key = `${categoryName}|${taskId}`
    //   - 智能列表下 _fromCategory 不同的任务 id 可能撞名，必须按 (分类, id) 复合定位。
    //   - 任务 id 由 _createTask 生成（t_<时间戳>_<5位字母数字>），不含 '|' 字符，
    //     所以直接拼字符串做 Set key 安全且性能足够（O(1) 查找）。
    this.selectionMode = false;
    this.selectedTaskIds = new Set();
    // 区间选锚点：Shift+Click 时从 anchor 到 click 之间的所有 task 切换选中。
    this.selectionAnchor = null;
    // 浮栏根元素（懒创建，第一次进入选择模式时挂到 body）
    this.batchBarEl = null;

    // 跟踪当前正在编辑的输入框，使 cancelEdit 能在隐藏输入前移除 blur 监听，
    // 避免隐藏操作触发 blur → finish(true) → 意外提交编辑内容
    this._editInput = null;
    // 编辑态对应的任务 id 与真实分类名 —— _commitActiveEdit 走同步提交路径时需要
    // （不能依赖 input.blur() 异步触发 onBlur，因为 render() 同步销毁节点会让
    // blur 异步派发时 input 已不在 DOM，finish(true) 永不执行 → 编辑丢失）。
    this._editTaskId = null;
    this._editRealCatName = null;
    // 编辑框"已被用户实际改动过"标记。input 事件触发时设为 true，commit / cancel
    // 时清回 false。`_commitActiveEdit` / `finish(true)` 在 value 为空且本标志为 true
    // 且原始文本非空时，原本会**静默 noop**（任务文本保持不变）—— 这条路径发生在
    // 「用户清空整段文本 → render() 被 store change 同步触发 → input 被销毁」场景，
    // 用户会以为任务文本已被清空，刷新回来却还在。这条路径至少发一条 toast，让用户
    // 知道"刚才编辑空了，原文本已保留"，避免他们以为丢失。
    this._editDirty = false;

    // 必须先初始化：_setupEvents() 里会调 _setupDrag()，后者要 push 进 _docUnbinds。
    // 如果留到 _setupEvents() 内部才声明，第一次 _setupDrag() 走到 push 就在 undefined 上调 push —— crash。
    this._docUnbinds = [];

    this._setupEvents();
    // 统一渲染：'change' 在任何状态变更后都会触发，无需对 tasks/filter/sort 单独监听。
    // select 事件需要重置 selectedTaskId + 退出选择模式（防止跨分类残留选择）。
    // 通过标志位合并到同一次 render() 中，避免 selectCategory 先后 emit('select') + emit('change') 导致的双渲染。
    let pendingSelectReset = false;
    this._storeUnsubs = [
      this.store.on('select', () => {
        pendingSelectReset = true;
        // 切分类/选智能视图时清空选择模式 —— 已选的任务在新视图里没有意义，
        // 留着会让「移到分类」按钮跑去按旧 cat 名解析目标，搞乱状态。
        this._exitSelectionMode({ clear: true });
      }),
      // v3.7+：moveTask 在「已完成 → 普通子分类」时强制 completed=false 是隐式
      // 副作用 —— 用户可能没意识到拖过去勾选也被翻了。store emit 这个事件后，
      // 我们补一条更直白的 toast，避免用户疑惑「我拖过去怎么变成未完成了」。
      // 必须在 _setupEvents() 之前订阅：_setupEvents 里的拖拽 handler 触发
      // moveTask → emit 事件 → 这里接到 → toast 增补「（同时取消完成状态）」。
      this.store.on('task:completed-flipped', () => {
        toast('已自动取消完成状态（移动到普通分类的副作用）', 'info', 2000);
      }),
      this.store.on('load', () => {
        // 文件加载（含外部重载）→ 清空选择模式 —— task.id 全部失效，已选无意义
        this._exitSelectionMode({ clear: true });
        // 同样原因清空 _knownTaskIds：所有 task id 已变更（旧文件里的 id 不再有效），
        // 下次 render 应当全 fade-in（这是合理的"打开文件"动画）
        this._knownTaskIds = new Set();
      }),
      this.store.on('change', () => {
        if (pendingSelectReset) {
          this.selectedTaskId = null;
          pendingSelectReset = false;
        }
        this.render();
      })
    ];
    this.render();
  }

  _setupEvents() {
    // 添加任务
    if (this.inputEl) {
      this.inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !isImeComposing(e)) {
          e.preventDefault();
          this._submitNewTask();
        }
      });

      // 输入框内容变化 → 控制「提交」按钮可见性
      this.inputEl.addEventListener('input', () => {
        this._syncSubmitButton();
      });
    }

    // 「添加」提交按钮（在输入框右侧）
    if (this.submitTaskBtn) {
      this.submitTaskBtn.addEventListener('click', () => {
        // 智能列表下点击也提示 —— 与按 Enter 的兜底行为一致
        const cat = this.store.getSelectedCategory();
        if (!cat || cat.isSmartList) {
          toast('请先选择具体子分类，再添加任务', 'info', 1800);
          if (this.inputEl) this.inputEl.focus();
          return;
        }
        this._submitNewTask();
      });
    }

    if (!this.listEl) return;

    // 任务列表点击
    this.listEl.addEventListener('click', (e) => {
      // 拖拽刚结束 → 浏览器仍在派发的合成 click 一律吞掉，避免在松手位置触发
      // 选择变更或意外进入编辑模式。下一轮 pointerdown 会清掉这个标志。
      if (this._dragJustEnded) return;

      const item = e.target.closest('.task-item');
      if (!item) return;
      const taskId = item.dataset.id;

      // 选择模式下：所有点击行为都走 toggle 选中（不再触发编辑 / 删除 / star / current）
      // 智能列表下从 enriched 副本读 _fromCategory；普通视图直接用 cat.name
      if (this.selectionMode) {
        const cat = this.store.getSelectedCategory();
        if (!cat) return;
        const task = cat.tasks.find(t => t.id === taskId);
        if (!task) return;
        const fromCategory = task._fromCategory || cat.name;
        this._toggleSelection(fromCategory, taskId, {
          shift: e.shiftKey,
          ctrl: e.ctrlKey || e.metaKey
        });
        return;
      }
      this.selectedTaskId = taskId;

      // 解析任务所属的真实分类（兼容智能列表视图）
      const cat = this.store.getSelectedCategory();
      if (!cat) return;
      const task = cat.tasks.find(t => t.id === taskId);
      if (!task) return;
      const realCatName = task._fromCategory || cat.name;

      // 恢复按钮（回收站内）
      // 必须 stopPropagation：restoreTaskFromTrash 在多个分类时调 showContextMenu，
      // 而 document 上的全局 click handler 会把刚弹出的菜单当成「点外面」立刻关掉。
      // 右键菜单走的是 contextmenu 事件不会踩这个坑，左键的 restore 按钮必须手动挡。
      if (e.target.closest('.task-action-restore')) {
        e.stopPropagation();
        // 把点击位置传过去 —— 弹出分类选择菜单时直接落在按钮附近，
        // 而不是被无意义的屏幕中心 fallback 拽到窗口正中。
        this.restoreTaskFromTrash(taskId, e.clientX, e.clientY);
        return;
      }

      // 勾选（回收站也允许切换 —— 恢复前常想先把勾清掉或勾上）
      //
      // H2 修复：checkbox 的 DOM 是
      //   <label class="task-checkbox-wrapper">
        //     <input type="checkbox" class="task-checkbox">
        //     <span class="task-checkbox-custom"></span>
        //   </label>
      // 用户点 label / span 时，浏览器原生派发两个 click：一个在 label 上（被
      // 下面第一个分支命中）、一个转发到内部 input（被第二个分支命中）。两次都
      // 调 toggleTask，状态被翻两次回到原点 —— 用户感受「点了没反应」。
      // 修法：若 e.target 是真正的 <input>（被转发的合成 click），直接吞掉；
      // label 的那次 click 已经处理过 toggleTask。
      if (e.target.classList.contains('task-checkbox') ||
          e.target.classList.contains('task-checkbox-custom') ||
          e.target.closest('.task-checkbox-wrapper')) {
        // 浏览器把 click 转发给内部 input 时，target 就是那个 <input>，跳过。
        // span / label 自身的 click 仍正常处理。
        if (e.target.tagName === 'INPUT' && e.target.classList.contains('task-checkbox')) {
          return;
        }
        const result = this.store.toggleTask(realCatName, taskId);
        // v3.5+：取消勾选已完成任务时，若原分类丢失（被删除 / 改名），
        // store 返回 'picker' hint → 弹分类选择器让用户决定去向。
        if (result && result.restoreHint && result.restoreHint.kind === 'picker') {
          this.pickRestoreTargetForCompletedTask(taskId, result.restoreHint.missing, e.clientX, e.clientY);
        }
        return;
      }

      // 编辑按钮（回收站也允许编辑文字 —— 方便恢复前修个错别字）
      if (e.target.classList.contains('task-action-edit') || e.target.closest('.task-action-edit')) {
        this.startEdit(item);
        return;
      }

      // 删除按钮
      if (e.target.classList.contains('task-action-delete') || e.target.closest('.task-action-delete')) {
        this.deleteTaskWithConfirm(taskId);
        return;
      }

      // ⭐ Star 切换
      if (e.target.closest('.task-star-btn')) {
        this.store.updateTaskMeta(realCatName, taskId, { important: !task.important });
        return;
      }

      // ⚪ 「当前」标记切换（与 ⭐ 同模式，路径独立）
      if (e.target.closest('.task-current-btn')) {
        this.store.updateTaskMeta(realCatName, taskId, { current: !task.current });
        return;
      }

      // 单击任务文本/内容区 → 直接进入编辑
      // （已经过滤掉 checkbox / star / action 按钮，避免误触发）
      if (e.target.closest('.task-text') || e.target.closest('.task-content')) {
        this.startEdit(item);
        return;
      }

      this.render();
    });

    // 双击编辑
    this.listEl.addEventListener('dblclick', (e) => {
      // 同 click：拖拽刚结束就吞掉这次 dblclick，否则双击 ⭐ 会同时切换星标 + 进编辑
      if (this._dragJustEnded) return;

      const item = e.target.closest('.task-item');
      if (!item) return;
      // 选择模式下：双击不应该进入编辑（整行已变成「切换选中」语义）。
      // 否则用户连点 2 下某条任务会被「选中 → 取消选中 → 进编辑」搞得莫名其妙。
      if (this.selectionMode) return;
      // 排除集合与 pointerdown 对齐 —— 否则双击 checkbox / ⭐ / 当前 会先触发对应切换、
      // 再触发 dblclick 进入编辑，出现「点了星又进编辑」的奇怪行为。
      if (e.target.closest(
        '.task-checkbox-wrapper, .task-current-btn, .task-star-btn, ' +
        '.task-action-btn, .task-edit-input'
      )) return;
      this.startEdit(item);
    });

    // 右键菜单
    this.listEl.addEventListener('contextmenu', (e) => {
      const item = e.target.closest('.task-item');
      if (!item) return;
      e.preventDefault();
      // 选择模式：右键与左键一致 = 切换选中（保留 ctrl 不动 anchor，
      // 这样可以接着 shift-click 做精细区间选）。右键菜单在批量语境下没意义，
      // 浮栏已经把「移到分类 / 置顶 / 重要…」全部暴露出来。
      if (this.selectionMode) {
        const taskId = item.dataset.id;
        const cat = this.store.getSelectedCategory();
        if (!cat) return;
        const task = cat.tasks.find(t => t.id === taskId);
        if (!task) return;
        const fromCategory = task._fromCategory || cat.name;
        this._toggleSelection(fromCategory, taskId, { ctrl: true });
        return;
      }
      const taskId = item.dataset.id;
      this.selectedTaskId = taskId;
      this._showTaskContextMenu(e.clientX, e.clientY, taskId);
    });

    // 拖拽排序（Pointer Events - 全权控制 ghost / 指示线 / 自动滚动）
    this._setupDrag();

    // 重命名 / 删除分类（仅在按钮存在时绑定）
    // 注：当前 UI 改用 sidebar 的右键菜单，重命名/删除按钮已下线

    // 过滤器
    if (this.filterBtn) {
      this.filterBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._showFilterMenu();
      });
    }

    // 空状态里的"清空搜索"按钮（_renderEmptyState 动态注入）
    if (this.emptyEl) {
      this.emptyEl.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action="clear-search"]');
        if (!btn) return;
        const input = document.getElementById('search-input');
        if (input) {
          input.value = '';
          input.focus();
        }
        const clearBtn = document.getElementById('search-clear');
        if (clearBtn) clearBtn.hidden = true;
        this.store.setSearchQuery('');
      });
    }

    // 排序
    if (this.sortBtn) {
      this.sortBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._showSortMenu();
      });
    }

    // 批量导入（任务面板标题区）
    // 智能列表 / 容器 / 回收站下与过滤按钮同款隐藏（hideOnSmart 策略）。
    // 与 filterBtn 一致：在 _syncImportButton() 里按当前分类切换 hidden。
    if (this.importBtn) {
      this.importBtn.addEventListener('click', () => this._openImport());
    }

    // 批量操作入口：点击切换选择模式
    if (this.batchBtn) {
      this.batchBtn.addEventListener('click', () => {
        if (this.selectionMode) {
          this._exitSelectionMode({ clear: true });
        } else {
          this._enterSelectionMode();
        }
      });
    }

    // 点击其他地方或 Esc 关闭排序 / 过滤菜单
    // 与主键盘快捷键合并为单一 keydown 监听器（同一 document 注册两次会让每次按键
    // 走两遍相同的 isComposing / activeElement 检查 —— 单个 dispatcher 同样的语义、
    // 更少的开销、更易回收）。
    // _docUnbinds 数组已在构造函数里初始化（必须在 _setupEvents 之前，否则
    // _setupDrag 内的 push 会撞到 undefined）—— 这里直接 push。
    const docClick = (e) => {
      if (!e.target.closest('#sort-menu') && !e.target.closest('#btn-sort')) {
        document.getElementById('sort-menu')?.remove();
      }
      if (!e.target.closest('#filter-menu') && !e.target.closest('#btn-filter')) {
        document.getElementById('filter-menu')?.remove();
      }
    };
    document.addEventListener('click', docClick);
    this._docUnbinds.push(() => document.removeEventListener('click', docClick));

    const docKeydown = (e) => {
      // ---- 关闭排序 / 过滤菜单（优先级最高，不与其他分支耦合） ----
      if (e.key === 'Escape') {
        // IME 守卫：CJK/JP/KR 用户在搜索 / 重命名输入框里按 Esc 通常是「取消 IME 组合」，
        // 不应误关排序菜单（sort-menu 是 doc 级菜单，覆盖到任何焦点元素上）。
        if (isImeComposing(e)) return;
        if (document.getElementById('sort-menu')) {
          document.getElementById('sort-menu').remove();
          return;
        }
        if (document.getElementById('filter-menu')) {
          document.getElementById('filter-menu').remove();
          return;
        }
        // 选择模式优先于拖拽取消：有 batchBar 浮起来时用户按 Esc 通常是「不要选了」，
        // 直接退出选择模式比吞掉拖拽更符合直觉。
        if (this.selectionMode) {
          this._exitSelectionMode({ clear: true });
          return;
        }
        // 拖拽取消：必须在 modal 检查之前 —— 拖拽进行时不会有 modal（modal 会拦截指针），
        // 但拖拽 state 仍可能在 _drags Map 里挂着。Esc 是用户明确表达的「取消」信号。
        if (this._drags && this._drags.size > 0) {
          this._cancelAllDragsViaEscape();
          return;
        }
      }

      // 模态对话框 / 命令面板 / 右键菜单打开时，不要抢键
      if (document.querySelector('.modal-overlay, .command-palette-overlay, .context-menu:not([hidden])')) {
        return;
      }

      // 忽略输入框中的快捷键
      const isInInput = ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName);
      if (isInInput) {
        // ESC 退出编辑
        // IME 守卫：CJK/JP/KR 用户在拼音 / IME 组合中按 Esc 通常是「取消 IME 组合」，
        // 不是「取消编辑」。不挡掉会让用户每按一次 Esc 都把未完成的编辑一起关掉，
        // 选候选词中途的 Esc 也会被误判 —— 体验和 Enter 上屏候选词被误判为提交同源。
        if (e.key === 'Escape' && !isImeComposing(e)
            && this.listEl.querySelector('.task-edit-input:not([hidden])')) {
          this.cancelEdit();
        }
        return;
      }

      // ---- Cmd/Ctrl + A：选择模式下「全选 / 取消全选」toggle ----
      // 仅在选择模式 + 非输入态触发；普通模式下不拦截（让浏览器全选文本）。
      // M9: button focus 时也跳过 —— 用户 Tab 到 close 按钮后再按 Cmd+A，
      // 大概率是想全选按钮文字而不是任务列表。
      // 行为与浮栏「全选/取消全选」按钮保持一致：已全选 → 取消全选，否则 → 全选。
      // 之前是「无条件全选」，导致按两次 Cmd+A 没反应；现在跟按钮同步。
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && (e.key === 'a' || e.key === 'A') && this.selectionMode) {
        const activeTag = document.activeElement?.tagName;
        if (activeTag !== 'INPUT' && activeTag !== 'TEXTAREA' && activeTag !== 'BUTTON') {
          e.preventDefault();
          if (this._isAllVisibleSelected()) {
            this._deselectAll();
          } else {
            this._selectAllVisible();
          }
          return;
        }
      }

      // C2: 选择模式 → 屏蔽单条任务的快捷键（Space / F2 / Delete /
      // Ctrl+I / Ctrl+T / Shift+Arrow / Arrow / N）。
      // Backspace 不在列 —— M-U5 后只响应 Delete，Backspace 不再作为「删任务」入口。
      // 用户应通过浮栏批量操作，避免「批量模式下还能单条改」的迷惑。
      // 上面已保留的：Esc 退出 / Cmd+A 全选 / 搜索/编辑输入框打字 —— 都不受影响。
      if (this.selectionMode) return;

      const cat = this.store.getSelectedCategory();
      if (!cat) return;

      // N - 聚焦输入框（大小写都触发，与 F 键处理一致）
      if ((e.key === 'n' || e.key === 'N') && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        this.inputEl.focus();
        return;
      }

      // Shift+↑/↓ - 调整顺序（必须先匹配，否则会被下面通用 ↑/↓ 拦截）
      // v4+ 修复：旧实现用 cat.tasks.findIndex（原始数组）算 idx，filter/搜索态下
      // 相邻位置可能是被隐藏的任务——用户按一次 ↓，选中的任务在视图里"跳过了
      // 隐藏项直接到下下一个可见位"，甚至落到一个看不见的位置上。
      // 改成「在 visible 数组里算位移、再用 rest 语义回写到 store」，
      // 与同文件 2900+ 的拖拽处理保持一致。
      if (e.shiftKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp') && this.selectedTaskId) {
        e.preventDefault();
        if (cat.isSmartList) return; // 智能列表不允许重排
        const visible = this.store.getVisibleTasks(cat);
        const visIdx = visible.findIndex(t => t.id === this.selectedTaskId);
        if (visIdx < 0) return;
        const dir = e.key === 'ArrowDown' ? 1 : -1;
        const newVisIdx = visIdx + dir;
        if (newVisIdx < 0 || newVisIdx >= visible.length) return;
        // fromIndex 必须是 cat.tasks（原始数组）里的下标，不是 visible 下标
        const fromIdx = cat.tasks.findIndex(t => t.id === this.selectedTaskId);
        if (fromIdx < 0) return;
        // rest 语义：先移除源，再算 toIndex（参见 task-store.js:1754 注释）
        const rest = cat.tasks.filter(t => t.id !== this.selectedTaskId);
        let toIndex;
        if (newVisIdx < visible.length - 1) {
          // 移动到下一个可见项之前
          const refId = visible[dir > 0 ? visIdx + 2 : visIdx - 1].id;
          toIndex = rest.findIndex(t => t.id === refId);
          if (toIndex < 0) return;
        } else {
          // 落到末尾：直接用 rest.length 即可，无需在意中间是否夹着隐藏项——
          // 它们在当前视图里不可见，splice 到末尾等价于「紧贴最后一个可见项之后」。
          toIndex = rest.length;
        }
        this.store.reorderTask(cat.name, fromIdx, toIndex);
        return;
      }

      // M-U4: Ctrl/Cmd/Alt + 方向键 / Home / End / PageUp / PageDown 让浏览器/OS
      // 处理（Cmd+↓ 跳文档尾 / Alt+← 浏览器后退 / Ctrl+Home 滚动到顶等），
      // 不由本组件拦截。否则 Cmd+↓ 在 macOS 上不再跳到文档末尾，体验割裂。
      const hasNavModifier = e.metaKey || e.ctrlKey || e.altKey;
      if (hasNavModifier) return;

      // ↑/↓ - 切换选中任务
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        this.navigateTask(e.key === 'ArrowDown' ? 1 : -1);
        return;
      }

      // Home/End - 跳到列表首/尾（常见列表控件快捷键）
      if (e.key === 'Home') {
        e.preventDefault();
        this.jumpToTask(0);
        return;
      }
      if (e.key === 'End') {
        e.preventDefault();
        const tasks = this.store.getVisibleTasks(this.store.getSelectedCategory());
        if (tasks && tasks.length > 0) this.jumpToTask(tasks.length - 1);
        return;
      }

      // PageUp/PageDown - 按当前可见窗口高度翻页（避免固定 N 行的窗口大小不一致问题）
      if (e.key === 'PageDown' || e.key === 'PageUp') {
        e.preventDefault();
        const tasks = this.store.getVisibleTasks(this.store.getSelectedCategory());
        if (!tasks || tasks.length === 0) return;
        const dir = e.key === 'PageDown' ? 1 : -1;
        // 取列表容器可见任务行数作为翻页步长（最贴近用户实际"翻一页"的语义）。
        // 容器高度/单行高度估算在任务元素布局变化时容易失真，直接用可见行数更可靠。
        const visibleRows = this.listEl ? this._countVisibleRows() : 10;
        const step = Math.max(1, visibleRows - 1); // 留 1 行重叠避免丢失位置感
        const idx = tasks.findIndex(t => t.id === this.selectedTaskId);
        const cur = idx < 0 ? (dir > 0 ? -1 : tasks.length) : idx;
        const next = Math.max(0, Math.min(tasks.length - 1, cur + dir * step));
        this.jumpToTask(next);
        return;
      }

      // 回收站内：Space=切换勾选、Enter=恢复、F2=编辑（恢复前常想修个错别字 / 改完成状态）。
      // v3.6+：⭐ / ▶ 在回收站里也能改（store 已放开 updateTaskMeta 对 TRASH 的守卫），
      // 所以 Ctrl+I / Ctrl+T 在这里也响应 —— 选中任务打了 ⭐ / ▶ 之后恢复出来就是带标记的，
      // 避免「先恢复再回到子分类去打标记」的两步往返。Delete 仍不适用（彻底删除只能手工编辑 Markdown）。
      if (cat.kind === CategoryKind.TRASH) {
        // Space 在回收站中 = 切换勾选
        // IME 守卫：CJK 用户在拼音上屏时按 Space 也可能处于 isComposing=true，
        // 无守卫会把「上屏空格」误判为「切换勾选」，任务状态被静默翻转。
        if (e.key === ' ' && !isImeComposing(e) && this.selectedTaskId) {
          e.preventDefault();
          const result = this.store.toggleTask(cat.name, this.selectedTaskId);
          // 回收站 toggle 不会触发 picker hint（不经过 _resolveRestoreTarget），
          // 但仍走统一的 hint 检查，防御性 / 一致性更好。
          if (result && result.restoreHint && result.restoreHint.kind === 'picker') {
            this.pickRestoreTargetForCompletedTask(this.selectedTaskId, result.restoreHint.missing);
          }
          return;
        }
        // Enter 在回收站中 = 恢复任务
        // IME 守卫：CJK 用户用拼音/日文 IME 上屏候选词时按 Enter 仍处于
        // isComposing=true，若无守卫会把「上屏候选」误判为「恢复任务」，
        // 任务会被悄悄搬出回收站（v3.4 数据归属不变量被无声破坏）。
        if (e.key === 'Enter' && !isImeComposing(e) && this.selectedTaskId) {
          e.preventDefault();
          this.restoreTaskFromTrash(this.selectedTaskId);
          return;
        }
        // F2 在回收站中 = 编辑文字
        // IME 守卫：IME 组合期间按 F2 不应进入编辑模式（与普通子分类对齐）。
        if (e.key === 'F2' && !isImeComposing(e) && this.selectedTaskId) {
          e.preventDefault();
          const item = this.listEl.querySelector(`[data-id="${this.selectedTaskId}"]`);
          if (item) this.startEdit(item);
          return;
        }
        // Ctrl/Cmd + I 在回收站中 = 切换重要（与普通子分类同款语义，restore 之前顺手打标）
        if (ctrl && (e.key === 'i' || e.key === 'I') && this.selectedTaskId) {
          e.preventDefault();
          const t = cat.tasks.find(t => t.id === this.selectedTaskId);
          if (!t) return;
          this.store.updateTaskMeta(cat.name, this.selectedTaskId, { important: !t.important });
          return;
        }
        // Ctrl/Cmd + T 在回收站中 = 切换当前
        if (ctrl && (e.key === 't' || e.key === 'T') && this.selectedTaskId) {
          e.preventDefault();
          const t = cat.tasks.find(t => t.id === this.selectedTaskId);
          if (!t) return;
          this.store.updateTaskMeta(cat.name, this.selectedTaskId, { current: !t.current });
          return;
        }
        return;
      }

      // Space - 切换勾选
      // IME 守卫：与回收站分支对称 —— CJK 用户拼音上屏按 Space 不应被误判为
      // 切换勾选。task-list 的 keydown 是 document 级监听，IME 状态在 keydown
      // 阶段不一定被浏览器独占，需要自己挡。
      if (e.key === ' ' && !isImeComposing(e) && this.selectedTaskId) {
        e.preventDefault();
        const t = cat.tasks.find(t => t.id === this.selectedTaskId);
        const targetCat = t?._fromCategory || cat.name;
        const result = this.store.toggleTask(targetCat, this.selectedTaskId);
        if (result && result.restoreHint && result.restoreHint.kind === 'picker') {
          this.pickRestoreTargetForCompletedTask(this.selectedTaskId, result.restoreHint.missing);
        }
        return;
      }

      // F2 - 编辑
      // IME 守卫：IME 组合中按 F2 不应进入编辑模式。
      if (e.key === 'F2' && !isImeComposing(e) && this.selectedTaskId) {
        e.preventDefault();
        const item = this.listEl.querySelector(`[data-id="${this.selectedTaskId}"]`);
        if (item) this.startEdit(item);
        return;
      }

      // Ctrl/Cmd + I - 切换重要
      // 注：ctrl 已在 keydown 函数顶部「Cmd/Ctrl + A」分支声明过，这里直接复用
      if (ctrl && (e.key === 'i' || e.key === 'I') && this.selectedTaskId) {
        e.preventDefault();
        const task = cat.tasks.find(t => t.id === this.selectedTaskId);
        if (!task) return;
        const targetCat = task._fromCategory || cat.name;
        this.store.updateTaskMeta(targetCat, this.selectedTaskId, { important: !task.important });
        return;
      }

      // Ctrl/Cmd + T - 切换「当前」标记（与 ⭐ 同形快捷键；T = today）
      if (ctrl && (e.key === 't' || e.key === 'T') && this.selectedTaskId) {
        e.preventDefault();
        const task = cat.tasks.find(t => t.id === this.selectedTaskId);
        if (!task) return;
        const targetCat = task._fromCategory || cat.name;
        this.store.updateTaskMeta(targetCat, this.selectedTaskId, { current: !task.current });
        return;
      }

      // M-U5: 只匹配 Delete，不响应 Backspace。原因：
//   1) Backspace 在可编辑控件里是「删除光标前一个字符」，误命中会清空输入框
//   2) 浏览器里 Backspace 历史上默认「后退」已被各浏览器撤掉，但用户期待
//      仍是「删除字符」而非「删任务」，二者强耦合会把误触成本放得很大
//   3) Delete 与 Backspace 在桌面约定上分工明确：Delete=删除选中项、
//      Backspace=字符级编辑；任务列表语境下只该走 Delete
      // Delete - 删除任务
      // IME 守卫：IME 组合中按 Delete 不应删除任务（极端路径 —— 拼音上屏的 Delete
      // 几乎不可能，但保险起见与 Space / F2 对齐，免得未来某次重构拆掉一致性）。
      if (e.key === 'Delete' && !isImeComposing(e) && this.selectedTaskId) {
        e.preventDefault();
        this.deleteTaskWithConfirm(this.selectedTaskId);
        return;
      }
    };
    document.addEventListener('keydown', docKeydown);
    this._docUnbinds.push(() => document.removeEventListener('keydown', docKeydown));

    // 窗口失焦 / 标签页隐藏时丢失 pointercancel —— 兜底清掉所有拖拽状态
    const winBlur = () => this._cancelAllDrags();
    window.addEventListener('blur', winBlur);
    this._docUnbinds.push(() => window.removeEventListener('blur', winBlur));
    const visChange = () => {
      if (document.hidden) this._cancelAllDrags();
    };
    document.addEventListener('visibilitychange', visChange);
    this._docUnbinds.push(() => document.removeEventListener('visibilitychange', visChange));
  }

  /**
   * 释放构造时挂到 document / window 上的所有监听器。
   * 在生产单例生命周期里不会被调用（TaskList 与窗口同生死），
   * 但保留入口供将来 hot-reload / 单元测试按需清理，避免监听器随多次实例化叠加。
   */
  destroy() {
    // v3.7+：必须先提交/取消正在进行的编辑 —— 否则 destroy 时 input 节点被
    // 卸载，blur 监听也已被本函数接下来的 _storeUnsubs 清空，commit 路径
    // 走不到，编辑内容会"卡在已卸载的 input"里没人接收，下次重建 TaskList
    // 会从 store 里读到旧 text —— 用户以为编辑丢了。commit(true) 与 cancel()
    // 都是同步路径，无需 await。
    if (this._editInput) {
      this._commitActiveEdit();
    }
    // 清掉兜底定时器 —— 防止 destroy 之后定时器还在跑、操作已销毁的字段。
    if (this._dragJustEndedTimer) {
      clearTimeout(this._dragJustEndedTimer);
      this._dragJustEndedTimer = null;
    }
    // M8：注销「modal 打开前清拖拽」hook —— 否则下次新建 TaskList 时 hook 累加，
    // 单次 open 调用多次 _cancelAllDrags（轻量无害，但语义上不干净）。
    if (this._unregisterModalHook) {
      try { this._unregisterModalHook(); } catch {}
      this._unregisterModalHook = null;
    }
    for (const off of this._docUnbinds || []) off();
    this._docUnbinds = [];
    for (const off of this._storeUnsubs || []) off();
    this._storeUnsubs = [];
  }

  render() {
    // 重渲染会替换 listEl.innerHTML，正在拖的 item 节点随之消失 → 先丢弃拖拽状态
    this._cancelAllDrags();
    // H12 + M1 修复：render() 会整体替换 listEl.innerHTML，连同 _editInput 节点。
    // 如果用户在编辑中触发 store change（比如外部文件 reload、外部快捷键、
    // 兄弟组件 emit('change') 等），编辑草稿会随 DOM 销毁而消失。
    // 这里同步 commit 一次：把当前输入框内容写到 store（无变更则 noop），
    // 让用户再次看到任务时保留他的修改意图。
    //
    // M1 守卫：仅在 _editInput 仍在 DOM 里时才 commit。isConnected 锁定「这个
    // input 节点当前是不是活的」—— 若 input 已被销毁（比如上一轮 render 已经
    // 走完但 commit 因异常没调用），重复 commit 会让 _editInput.value 抛错。
    if (this._editInput && this._editInput.isConnected) {
      this._commitActiveEdit();
    }

    // v3.4 不变量：普通分类里没有 completed=true 任务。若用户在「已完成任务」智能
    // 列表下选了 filter=COMPLETED，再切到普通分类（NORMAL / 容器 / 回收站之外），
    // filter chip 会显示「已完成」但菜单里已隐藏该选项 → 视觉与可达性不一致。
    // 这里在 render 入口兜底：如果当前分类下 COMPLETED 过滤无意义，自动回退到 ALL。
    //
    // 实现细节：必须用 queueMicrotask 而非同步 setFilter(Filter.ALL) —— 同步调用会
    // emit('change')，触发订阅者（比如 Toolbar 的 filter chip）再次同步调用 render，
    // 形成 render-in-render。setFilter 内部会去重（filter === ALL 时 return），
    // 不会无限循环，但 emit 的副作用（settingsStore.update、订阅者 render）会执行
    // 一遍不必要的重活。queueMicrotask 把修复推迟到本帧 render 完成后，只 emit 一次。
    const _catForFilterSync = this.store.getSelectedCategory();
    if (_catForFilterSync && !_catForFilterSync.isSmartList &&
        _catForFilterSync.kind !== CategoryKind.TRASH &&
        this.store.filter === Filter.COMPLETED) {
      queueMicrotask(() => {
        // 二次校验：等到微任务时分类可能已切走（用户操作快的话），再判一次更稳。
        const cat = this.store.getSelectedCategory();
        if (cat && !cat.isSmartList && cat.kind !== CategoryKind.TRASH &&
            this.store.filter === Filter.COMPLETED) {
          this.store.setFilter(Filter.ALL);
        }
      });
    }

    const cat = this.store.getSelectedCategory();
    if (!cat) {
      this.titleEl.textContent = '';
      this.listEl.innerHTML = '';
      this.emptyEl.hidden = true;
      if (this.titleProgressEl) this.titleProgressEl.textContent = '';
      return;
    }

    // 标题与图标：用 SVG 而不是文本字符，保持与侧边栏同一设计语言
    this.titleEl.innerHTML = this._renderTitleIcon(cat) + escapeHtml(cat.name);

    // 获取可见任务（应用过滤+排序+搜索）—— 只算一次，后面进度显示和列表渲染都用它
    const visibleTasks = this.store.getVisibleTasks(cat);

    // 计数：标题进度反映「过滤后」的可见数，与列表实际呈现保持一致
    //   - 默认/ALL：显示 「已完成 / 总数」（用户最关心的进度）
    //   - 过滤后（CURRENT/COMPLETED/IMPORTANT）：显示「可见数 / 总数 · 标签」
    //     让用户知道过滤掉了多少、当前看到的是什么
    const total = cat.tasks.length;
    const completed = cat.tasks.filter(t => t.completed).length;
    const visible = visibleTasks.length;
    const isFiltered = this.store.filter !== Filter.ALL;
    const isSearching = !!this.store.searchQuery;
    if (this.titleProgressEl) {
      let progressText;
      // 搜索态优先：用户当下的意图是「找东西」，告诉匹配数比告诉进度更有用
      if (isSearching) {
        progressText = `${visible} 个匹配`;
      } else if (total === 0) {
        progressText = '0 项';
      } else if (isFiltered) {
        const labelMap = {
          [Filter.CURRENT]: '当前',
          [Filter.COMPLETED]: '已完成',
          [Filter.IMPORTANT]: '重要'
        };
        const label = labelMap[this.store.filter];
        progressText = `${visible} / ${total} · ${label}`;
      } else if (cat.isSmartList && cat.smartKey === 'completed') {
        progressText = `${total} 项已完成`;
      } else if (completed > 0) {
        progressText = `${completed}/${total} 已完成`;
      } else {
        progressText = `${total} 项`;
      }
      this.titleProgressEl.textContent = progressText;
      // 已完成视图下进度文字着色：让"全绿"的语义更直观
      this.titleProgressEl.classList.toggle('completed', !isFiltered && total > 0 && completed === total);
    }

    // 输入框占位：智能列表 / 回收站 给出友好提示
    const isTrash = cat.kind === CategoryKind.TRASH;
    if (this.inputEl) {
      // 先清空 title：只有回收站分支会设置它，切换分类后不该残留
      this.inputEl.title = '';
      if (isTrash) {
        // 回收站：不允许直接添加任务。
        // 这里也是唯一常驻可见的位置，用来告诉用户「彻底删除」怎么做 ——
        // 软件刻意不提供清空入口，若界面完全不提示，用户会以为回收站只增不减。
        this.inputEl.placeholder = '回收站的任务只能恢复；要彻底删除请打开 Markdown 文件删掉对应行';
        this.inputEl.title = '为了数据安全，软件不提供「清空回收站」。彻底删除请直接编辑 Markdown 文件。';
        this.inputEl.disabled = true;
      } else if (cat.isSmartList && cat.smartKey === 'allTasks') {
        // 「全部任务」容器：聚合视图，禁用输入
        this.inputEl.placeholder = '请先选择下方一个具体子分类，再添加任务';
        this.inputEl.disabled = true;
      } else if (cat.smartKey === 'current') {
        // 「当前任务」智能视图：禁用输入（任务必须归属到具体子分类，再打 [▶] 标记）
        this.inputEl.placeholder = '「当前任务」是聚合视图，请在具体子分类中给任务加 [▶]';
        this.inputEl.disabled = true;
      } else if (cat.smartKey === 'important') {
        // 「重要任务」智能视图：禁用输入（任务必须归属到具体子分类）
        this.inputEl.placeholder = '「重要任务」是聚合视图，请在具体分类中给任务加 [⭐]';
        this.inputEl.disabled = true;
      } else if (cat.smartKey === 'completed') {
        // 「已完成任务」智能视图：禁用输入（任务通过勾选自动进入这里）
        this.inputEl.placeholder = '「已完成任务」是聚合视图，勾选任务即可自动收纳到这里';
        this.inputEl.disabled = true;
      } else {
        this.inputEl.disabled = false;
        this.inputEl.placeholder = `添加到「${cat.name}」，回车确认`;
      }
    }

    // 同步底部提交按钮状态
    this._syncSubmitButton();

    // 过滤器状态
    this._renderFilterChip();
    this._renderSortChip();

    // 排序 / 过滤状态写入 body，供 CSS 做全局视觉反馈
    // （如：按字母排序时灰化整行拖拽光标）
    document.body.dataset.sortMode = this.store.sortBy;
    document.body.dataset.filterMode = this.store.filter;
    // 智能列表下隐藏过滤器（语义重叠）：已完成/重要/当前 智能列表本身已带过滤
    // 选择模式下也隐藏 —— 过滤变化导致选中行被隐藏会让「已选 N 项」与可见项不一致，
    // 用户会困惑「我明明选了 3 条为什么只剩 1 条可见」；批量操作期间关掉过滤入口。
    if (this.filterBtn) {
      const hideOnSmart = cat.isSmartList &&
        (cat.smartKey === 'completed' || cat.smartKey === 'important' || cat.smartKey === 'current');
      this.filterBtn.hidden = hideOnSmart || this.selectionMode;
    }
    // 排序按钮同上：选择模式下隐藏 —— 切字母序会让置顶/置底禁用，
    // 用户批量选完后看到按钮灰掉会很奇怪；批量模式期间保持手动排序不变。
    if (this.sortBtn) {
      this.sortBtn.hidden = this.selectionMode;
    }
    // 导入按钮：智能列表 + 容器 + 回收站都禁用（导入必须落到具体子分类）。
    // 智能列表下与过滤按钮同款隐藏；其他不可导入分类下显示但 click 时给提示。
    // 选择模式下也隐藏 —— 与新增任务语义冲突。
    if (this.importBtn) {
      const hideImport =
        cat.isSmartList ||
        cat.kind === CategoryKind.OTHER_TASKS ||
        cat.kind === CategoryKind.TRASH ||
        this.selectionMode;
      this.importBtn.hidden = hideImport;
    }

    // 批量入口按钮：在「当前任务 / 重要任务 / 全部任务 / 已完成任务」四个智能视图
    // + 「回收站」都放开，其它普通子分类 / 容器也放开。
    //   - 当前任务 / 重要任务 / 全部任务：批量移到分类 / 标⭐▶ / 切完成 / 移到回收站
    //     都是有用的聚合操作（任务来自多个子分类，逐条改太慢）
    //   - 已完成任务：批量取消完成 / 移到回收站 / 标⭐▶ —— 清整动作
    //   - 回收站：批量恢复 + 标⭐▶ + 切完成 —— store 侧 API 都已支持
    // 注意：智能列表下「置顶/置底」按钮会被 _updateBatchBarState 自动禁用
    // （!cat.isSmartList 条件），因为跨子分类聚合视图下重排无意义。
    // 当前条下与 importBtn 的隐藏策略还有一点差异：importBtn 在智能列表 / 容器
    // 都隐藏（导入需要落到具体子分类），但 batchBtn 展示入口、按钮级禁用由
    // _updateBatchBarState 接管。
    // 另外：visibleTasks 为空时也隐藏 —— 没东西可选，进入批量模式没意义。
    if (this.batchBtn) {
      const hideBatch =
        (cat.isSmartList &&
          cat.smartKey !== 'current' &&
          cat.smartKey !== 'important' &&
          cat.smartKey !== 'allTasks' &&
          cat.smartKey !== 'completed') ||
        (cat.kind === CategoryKind.OTHER_TASKS && cat.smartKey !== 'allTasks') ||
        visibleTasks.length === 0;
      this.batchBtn.hidden = hideBatch;
      this.batchBtn.setAttribute('aria-pressed', this.selectionMode ? 'true' : 'false');
      // 激活态切换标签 + title，让「再点一下退出」的意图直接写在按钮上
      const chipText = this.batchBtn.querySelector('.chip-text');
      if (chipText) chipText.textContent = this.selectionMode ? '退出批量' : '批量';
      this.batchBtn.title = this.selectionMode ? '退出批量操作 (Esc)' : '批量操作';
    }

    // 选择模式开关写到 body 上，供 CSS 做全局视觉反馈：
    //   - 隐藏输入框（避免遮挡浮栏）
    //   - 整行 cursor: pointer（暗示「点这里切换」）
    //   - .task-item.select-mode 的视觉（隐藏 ⭐/▶/actions，复用为选中勾）
    document.body.dataset.selectionMode = this.selectionMode ? 'true' : 'false';

    // M7: 选择模式 + 0 可见任务 → 自动退出，避免浮栏悬在空列表上方
    // （batchBtn 此时已 hidden，但 batchBar 还挂着，UI 不一致）
    // 注意：只能等这一次 render 走完所有按钮同步后才退出，
    // _exitSelectionMode 内部会调 render() 再走一次 —— 两次渲染。
    if (this.selectionMode && visibleTasks.length === 0) {
      this._exitSelectionMode({ clear: true });
      return;
    }

    if (visibleTasks.length === 0) {
      this.listEl.innerHTML = '';
      // 空状态信息根据过滤状态变化
      this._renderEmptyState(cat);
      return;
    }
    this.emptyEl.hidden = true;

    // 把"这次新出现的"任务打上 .is-new —— _knownTaskIds 累积本次会话所有见过的 id，
    // 第一次渲染时为空、全是 new；之后只对"会话里首次出现"的任务打 .is-new。
    // grow-only（不重置回 seenIds）：filter 切换 / 跨分类跳转 / 搜索 都属于
    // "已知任务再次可见"，不应再 fade-in，否则会重蹈 v3.x 的整列表闪烁。
    const isFirstRender = this._knownTaskIds.size === 0;
    const newIds = isFirstRender
      ? new Set(visibleTasks.map(t => t.id))
      : new Set(visibleTasks.filter(t => !this._knownTaskIds.has(t.id)).map(t => t.id));
    for (const id of newIds) this._knownTaskIds.add(id);

    // 重新生成 HTML：把新任务的开头 class="task-item 替换成 class="task-item is-new
    // 注意 _renderTaskItem 的输出里第一个 class 名一定是 "task-item"，所以
    // 第一次出现即锚点 —— 用 indexOf 而不是 replaceAll（避免误改 .task-item-related）
    const itemsHtml = visibleTasks.map((task) => {
      let itemHtml = this._renderTaskItem(task, cat);
      if (newIds.has(task.id)) {
        const idx = itemHtml.indexOf('class="task-item');
        // -1 不可能出现（每个 row 至少有一个 class）；但兜底一下避免静默坏掉
        if (idx !== -1) {
          itemHtml = itemHtml.slice(0, idx) + 'class="task-item is-new' + itemHtml.slice(idx + 'class="task-item'.length);
        }
      }
      return itemHtml;
    }).join('');
    this.listEl.innerHTML = itemsHtml;

    // M-U3: render() 不再自动 scrollIntoView。原因：render() 触发场景里
    // 多数是「数据变了 → 列表重建」（如勾选、批量、过滤变化等），用户此时
    // 的视线焦点就在刚操作的那一行，强制滚动会跳到 selectedTaskId 的位置，
    // 与用户视觉中心错位造成「页面乱跳」的错觉。仅在 navigateTask /
    // jumpToTask / startEdit / deleteTaskWithConfirm 等用户显式入口
    // 调用 scrollIntoViewSelected()，行为可预期。
    // （保留 hook：选中项存在时把它的 selected 视觉打上，DOM 查询留给调用方按需滚动）
  }

  _submitNewTask() {
    const text = this.inputEl.value.trim();
    if (!text) {
      this.inputEl.focus();
      return;
    }
    const cat = this.store.getSelectedCategory();
    if (!cat) return;
    // 智能列表视图：聚合分类不允许直接添加，回退到「未分类」子分类并提示
    let target = cat.name;
    let didFallback = false;
    if (cat.isSmartList) {
      // v3 起没有「当前任务」真实分类 —— 回退目标改为「未分类」子分类
      const fallback = this.store.categories.find(
        c => c.parentOtherTasks && c.name === UNCATEGORIZED_NAME
      ) || this.store.categories.find(c => c.parentOtherTasks);
      if (!fallback) return; // 极端兜底：没有任何子分类就放弃添加
      target = fallback.name;
      didFallback = true;
    }

    const task = this.store.addTask(target, text);
    if (task) {
      this.inputEl.value = '';
      this.selectedTaskId = task.id;
      this._syncSubmitButton();
      if (didFallback) {
        toast(`已添加到「${target}」（智能视图无法直接添加）`, 'info', 1800);
      }
    } else {
      // H1 修复：addTask 返回 null 通常意味着内容为空 / 分类不可写。旧实现 silent noop，
      // 用户敲回车后输入框看似清空（其实没有）、任务却没添加——典型「点了没反应」。
      // 这里显式 toast 告知失败原因。input.value 不动（让用户看到自己的输入还在）。
      toast('添加失败：内容不能为空或目标分类不可写', 'info', 2000);
      this.inputEl?.focus();
    }
  }

  /**
   * 打开导入对话框，把粘贴文本批量落地到当前子分类。
   *
   * 与 _submitNewTask 不同：这里不做智能列表回退。
   * 原因：批量导入 N 条时把任务搬到「未分类」+ 显示「已添加到 X」会让用户
   * 找不到刚才导的内容；直接要求切到具体子分类更直白。
   * 按钮的 hidden 状态已经把大多数情况挡掉了，剩余漏网情况给明确提示。
   */
  async _openImport() {
    const cat = this.store.getSelectedCategory();
    if (!cat) return;
    // 智能列表 / 容器 / 回收站都不允许导入 —— importBtn 在 render() 里已对这些分类
    // hidden，这里是兜底守卫（理论上不会触发，但语义要一致）。
    if (cat.isSmartList ||
        cat.kind === CategoryKind.OTHER_TASKS ||
        cat.kind === CategoryKind.TRASH) {
      toast('请先选择具体子分类，再导入任务', 'info', 1800);
      return;
    }

    const result = await openImportDialog(this.store, cat.name, { settingsStore: this.settingsStore });
    if (!result) return; // 用户取消
    // 「导入成功」反馈 —— 避免静默成功让用户怀疑到底有没有生效
    toast(`已导入 ${result.added} 条到「${result.categoryName}」`, 'success', 1800);
  }

  _syncSubmitButton() {
    if (!this.submitTaskBtn) return;
    const hasText = !!this.inputEl.value.trim();
    const cat = this.store.getSelectedCategory();
    const inValidCat = !!cat && !cat.isSmartList;
    // 始终可见（作为输入框旁的常驻添加按钮），仅在无文本或非法分类时禁用
    this.submitTaskBtn.hidden = false;
    this.submitTaskBtn.disabled = !hasText || !inValidCat;
  }

  _renderFilterChip() {
    if (!this.filterChipEl) return;
    const filter = this.store.filter;
    const icon = FILTER_ICONS[filter] || FILTER_ICONS[Filter.ALL];
    const label = FILTER_LABELS[filter] || FILTER_LABELS[Filter.ALL];
    this.filterChipEl.dataset.filter = filter;
    this.filterChipEl.innerHTML = `<span class="chip-icon">${icon}</span><span class="chip-text">${label}</span>`;
  }

  /**
   * 排序 chip 渲染：图标随当前模式变化，让 chip 自身就能传达"现在是什么排序"
   * - MANUAL：原始图标（三条递减横线，暗示「原始顺序」）
   * - ALPHABET：A↓ 图标，暗示「字母序」
   */
  _renderSortChip() {
    if (!this.sortChipEl) return;
    const map = {
      [SortBy.MANUAL]: {
        label: '手动',
        icon: '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M7 12h10M10 18h4"/></svg>'
      },
      [SortBy.ALPHABET]: {
        label: '字母',
        icon: '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 4v16M3 16l2 2 2-2"/><path d="M19 4v16M17 8l2-4 2 4M17.5 6h3"/></svg>'
      }
    };
    const info = map[this.store.sortBy] || map[SortBy.MANUAL];
    this.sortChipEl.dataset.sort = this.store.sortBy;
    this.sortChipEl.innerHTML = `<span class="chip-icon">${info.icon}</span><span class="chip-text">${info.label}</span>`;
  }

  /**
   * 渲染标题前缀图标（与侧边栏一致使用 SVG）
   * 返回带图标的 HTML 片段；外层调用方负责对 cat.name 做 escapeHtml
   */
  _renderTitleIcon(cat) {
    let svg = '';
    let cls = 'title-icon';
    if (cat.isSmartList) {
      if (cat.smartKey === 'current') {
        // 「当前任务」标题：播放三角 —— 与 todo.md 的 [▶]（U+25B6）当前标记视觉一致
        cls += ' title-icon-current';
        svg = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><polygon points="7 4 20 12 7 20"/></svg>';
      } else if (cat.smartKey === 'important') {
        cls += ' title-icon-important';
        svg = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"/></svg>';
      } else if (cat.smartKey === 'completed') {
        cls += ' title-icon-completed';
        svg = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M8 12.5l3 3L17 9"/></svg>';
      } else if (cat.smartKey === 'allTasks') {
        cls += ' title-icon-folder';
        svg = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>';
      }
    } else if (cat.kind === CategoryKind.TRASH) {
      cls += ' title-icon-trash';
      svg = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';
    } else if (cat.parentOtherTasks) {
      // 子分类：缩进 + 小文件柜图标
      cls += ' title-icon-sub';
      svg = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>';
    }
    // 普通分类（非子分类）：无图标
    return svg ? `<span class="${cls}">${svg}</span>` : '';
  }

  _renderEmptyState(cat) {
    let title = '此分类暂无任务';
    let hint = '按 <kbd>N</kbd> 快速聚焦输入框，添加第一个任务';

    // 搜索态优先：不管分类本身空不空，用户当下在找东西，告诉「没匹配 + 怎么退出」最有帮助
    if (this.store.searchQuery) {
      title = '没有匹配的任务';
      // hint 会以 innerHTML 注入（其它分支里含有意为之的 <kbd>），
      // 所以这里必须单独转义用户输入的搜索词，否则输入 <img onerror=...> 会被当标签执行
      hint = `没有任务包含 "<b>${escapeHtml(this.store.searchQuery)}</b>"<br>试试其他关键词，或 <button class="empty-action-btn" data-action="clear-search">清空搜索</button>`;
    } else if (this.store.filter === Filter.CURRENT && cat.tasks.length > 0) {
      title = '没有标记为「当前」的任务';
      hint = '点击任务右侧的 ▶ 标记为当前（文件里写为 [▶]）';
    } else if (this.store.filter === Filter.COMPLETED && cat.tasks.length > 0) {
      // v3.4 起 completed=true 任务只能活在一个地方 —— kind=COMPLETED 的「# 已完成任务」
      // 分类（task-store.js:481 collectSmartListTasks 的 v3.4 注释）。普通分类下
      // 选「已完成」过滤永远空 —— 因为 completed 任务早已被搬走。原 hint「勾选任务后会
      // 出现在这里」会让用户去勾选任务、然后看到任务从当前分类消失到「已完成任务」分类，
      // 反而更困惑。改成解释实际语义，并把下一步指向真实归宿分类。
      title = '当前分类下没有已完成任务';
      hint = 'v3.4 起已勾选的任务会自动归入「已完成任务」分类，去那里看完成项，或切换到「全部」过滤';
    } else if (this.store.filter === Filter.IMPORTANT && cat.tasks.length > 0) {
      title = '没有标记为重要的任务';
      hint = '点击任务右侧的 ⭐ 标记为重要（文件里写为 [⭐]）';
    } else if (cat.isSmartList) {
      // 智能列表的空状态
      if (cat.smartKey === 'current') {
        title = '当前任务 为空';
        hint = '在子分类中给任务打 [▶] 标记，或右键菜单 → 标记为当前';
      } else if (cat.smartKey === 'important') {
        title = '重要任务 为空';
        hint = '点击任务右侧的 ⭐ 标记重要任务（文件里写为 [⭐]）';
      } else if (cat.smartKey === 'allTasks') {
        title = '全部任务 为空';
        hint = '在子分类中添加任务';
      } else if (cat.smartKey === 'completed') {
        title = '还没有已完成任务';
        hint = '勾选任意任务后会自动出现在这里';
      }
    } else if (cat.kind === CategoryKind.TRASH) {
      title = '回收站是空的';
      hint = '删除的任务会出现在这里，可随时恢复';
    }

    this.emptyEl.innerHTML = `
      <div class="empty-icon" aria-hidden="true">
        <svg viewBox="0 0 64 64" width="44" height="44" fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="14" y="10" width="36" height="46" rx="4" stroke-opacity="0.4"/>
          <line x1="22" y1="22" x2="42" y2="22" stroke-opacity="0.3"/>
          <line x1="22" y1="32" x2="42" y2="32" stroke-opacity="0.3"/>
          <line x1="22" y1="42" x2="34" y2="42" stroke-opacity="0.3"/>
        </svg>
      </div>
      <p class="empty-title">${escapeHtml(title)}</p>
      <p class="empty-hint">${hint}</p>
    `;
    this.emptyEl.hidden = false;
  }

  _renderTaskItem(task, cat) {
    const isSelected = task.id === this.selectedTaskId;
    const isTrash = cat.kind === CategoryKind.TRASH;
    // 「已完成任务」是智能视图（cat.kind === NORMAL，cat.smartKey === 'completed'），
    // 渲染分支走普通子分类那条，所以这里要单独识别。
    const isCompletedView = cat.isSmartList && cat.smartKey === 'completed';
    // 选择模式下：用「是否在 selectedTaskIds 集合里」覆盖单条 selected 语义。
    // 复合 key 必须用真实 fromCategory，智能列表下 cat.tasks 是 enriched 副本。
    const fromCatForSel = task._fromCategory || cat.name;
    const isSelectionChecked = this.selectionMode && this.selectedTaskIds.has(
      TaskList._selKey(fromCatForSel, task.id)
    );
    const segments = this.store.highlightTaskText(task.text);
    // 中西文之间补上视觉间隙（盘古之白）。间隙元素必须画在 <mark> 外面，
    // 否则跨段边界的那个间隙会被高亮背景染成一小块色。
    let prevChar = '';
    const textHtml = segments.map(s => {
      const t = String(s.text ?? '');
      let html = '';
      if (needsCjkGap(prevChar, t[0] || '')) html += CJK_GAP_HTML;
      const inner = escapeHtmlAutospace(t);
      html += s.highlight ? `<mark>${inner}</mark>` : inner;
      if (t) prevChar = t[t.length - 1];
      return html;
    }).join('');
    // 「原分类」徽章：仅在已完成/回收站视图下，且任务确实记录了原分类时显示。
    // 普通子分类里 originalCategory 总是 null（store 归位时已清空），不会走到这里。
    // 与 markdown 中 [原分类：xxx] 一一对应，方便用户确认这条任务来自哪里。
    const originalBadgeHtml = (task.originalCategory && (isCompletedView || isTrash))
      ? `<span class="task-original-category" title="原分类：${escapeAttr(task.originalCategory)}">原分类：${escapeHtml(task.originalCategory)}</span>`
      : '';

    // 选择器：选择模式下用「圆形选中勾」（与完成 checkbox 视觉完全独立，避免混淆）；
    // 普通模式下保留方形的完成 checkbox，已完成 = 实心填充。
    // 用 SVG 画勾而不是 ::after 伪元素 —— 便于 _refreshSelectionVisuals 也能更新。
    const selectorHtml = this.selectionMode
      ? `<label class="task-selection-wrapper" title="${isSelectionChecked ? '取消选中' : '选中'}" aria-label="${isSelectionChecked ? '取消选中' : '选中'}">
           <span class="task-selection-circle ${isSelectionChecked ? 'selected' : ''}" data-selection-circle>${isSelectionChecked ? CHECK_SVG : ''}</span>
         </label>`
      : `<label class="task-checkbox-wrapper">
           <input type="checkbox" class="task-checkbox" ${task.completed ? 'checked' : ''}>
           <span class="task-checkbox-custom"></span>
         </label>`;

    const starSvg = starSvgFor(task.important);
    // 「当前」标识按钮：与 ⭐ 同尺寸、同按钮容器；激活时填充实心圆，未激活空心
    const currentSvg = currentSvgFor(task.current);

    // 回收站中的任务：简化渲染 —— 删除按钮换成恢复按钮，但 ⭐ / ▶ 与普通子分类同款显示 + 可操作。
    // 用户可在回收站里自由重排（整行可拖），恢复/删除都按 id 查找，不受顺序影响
    // 文字仍允许编辑（点 / 双击 / F2 都进 startEdit），方便恢复前先修个错别字
    //
    // ⭐ / ▶ 标记在回收站里也能改的原因：这些是任务级状态（与 completed 这种
    // "勾选即移动" 的归属语义不同），用户场景包括"恢复前先批量打个当前"。
    // store.updateTaskMeta 已放开 TRASH 守卫，writer / parser 也已对称支持
    // trash 行输出 [⭐]/[▶] —— 这里只是补上 UI 入口。
    if (isTrash) {
      // 恢复按钮图标（左弯箭头）
      const restoreSvg = RESTORE_SVG;
      return `
        <li class="task-item task-trash ${task.completed ? 'completed' : ''} ${(isSelected || isSelectionChecked) ? 'selected' : ''} ${task.important ? 'important' : ''} ${task.current ? 'current' : ''} ${this.selectionMode ? 'select-mode' : ''}"
            data-id="${escapeAttr(task.id)}">
          ${selectorHtml}
          <div class="task-content">
            <span class="task-text">${textHtml}</span>
            ${originalBadgeHtml}
            <input type="text" class="task-edit-input" hidden>
          </div>
          <button class="task-current-btn ${this.selectionMode ? 'task-readonly-indicator' : ''}" title="${task.current ? '取消当前 (Ctrl+T)' : '标记为当前 (Ctrl+T)'}" aria-label="${task.current ? '取消当前' : '标记为当前'}">
            ${currentSvg}
          </button>
          <button class="task-star-btn ${this.selectionMode ? 'task-readonly-indicator' : ''}" title="${task.important ? '取消星标 (Ctrl+I)' : '标记为重要 (Ctrl+I)'}" aria-label="${task.important ? '取消星标' : '标记为重要'}">
            ${starSvg}
          </button>
          <div class="task-actions">
            <button class="task-action-btn task-action-edit" title="编辑 (F2)" aria-label="编辑">
              ${EDIT_PENCIL_SVG}
            </button>
            <button class="task-action-btn task-action-restore" title="恢复到分类…" aria-label="恢复">
              ${restoreSvg}
            </button>
          </div>
        </li>
      `;
    }

    const deleteXSvg = DELETE_X_SVG;
    // 选择模式（批量）下，⭐/▶ 由 CSS display:none 隐藏，不需要换成 <span>。
    // 渲染仍是普通按钮（避免不必要的分支），点击无效果因为 _setupEvents 的
    // click 委托在 selectionMode 下直接返回，不进入 star/current 分支。
    return `
      <li class="task-item ${task.completed ? 'completed' : ''} ${(isSelected || isSelectionChecked) ? 'selected' : ''} ${task.important ? 'important' : ''} ${task.current ? 'current' : ''} ${this.selectionMode ? 'select-mode' : ''}"
          data-id="${escapeAttr(task.id)}">
        ${selectorHtml}
        <div class="task-content">
          <span class="task-text">${textHtml}</span>
          ${originalBadgeHtml}
          <input type="text" class="task-edit-input" hidden>
        </div>
        <button class="task-current-btn ${this.selectionMode ? 'task-readonly-indicator' : ''}" title="${task.current ? '取消当前 (Ctrl+T)' : '标记为当前 (Ctrl+T)'}" aria-label="${task.current ? '取消当前' : '标记为当前'}">
          ${currentSvg}
        </button>
        <button class="task-star-btn ${this.selectionMode ? 'task-readonly-indicator' : ''}" title="${task.important ? '取消星标 (Ctrl+I)' : '标记为重要 (Ctrl+I)'}" aria-label="${task.important ? '取消星标' : '标记为重要'}">
          ${starSvg}
        </button>
        <div class="task-actions">
          <button class="task-action-btn task-action-edit" title="编辑 (F2)" aria-label="编辑">
            ${EDIT_PENCIL_SVG}
          </button>
          <button class="task-action-btn task-action-delete" title="移到回收站 (Delete)" aria-label="移到回收站">
            ${deleteXSvg}
          </button>
        </div>
      </li>
    `;
  }

  navigateTask(direction) {
    const tasks = this.store.getVisibleTasks(this.store.getSelectedCategory());
    if (!tasks || tasks.length === 0) return;

    const idx = tasks.findIndex(t => t.id === this.selectedTaskId);
    let nextIdx;
    if (idx < 0) {
      nextIdx = direction > 0 ? 0 : tasks.length - 1;
    } else {
      nextIdx = Math.max(0, Math.min(tasks.length - 1, idx + direction));
    }
    this.selectedTaskId = tasks[nextIdx].id;
    this.render();
  }

  /**
   * 估算 listEl 当前可见的任务行数 —— PageUp/PageDown 用作翻页步长。
   * 直接数已渲染的 .task-item 节点，比 getBoundingClientRect 除以单行高度更稳：
   *   - 容器内有滚动条时，部分行不在视口里但仍占布局 —— 真实的"翻一页"应该按
   *     视口能容纳的行数算，否则会跳过头或跳不到位。
   *   - 任务行高度受 description / 多行内容影响不固定，按节点数取下限更稳。
   *
   * @returns {number} 至少 1，避免翻页 step=0 卡死
   */
  _countVisibleRows() {
    if (!this.listEl) return 1;
    const totalRows = this.listEl.querySelectorAll('.task-item').length;
    if (totalRows === 0) return 1;
    // 用容器可见高度除以首个任务行的高度估算可见行数。
    const firstRow = this.listEl.querySelector('.task-item');
    if (!firstRow) return 1;
    const rowHeight = firstRow.getBoundingClientRect().height || 32;
    const visibleHeight = this.listEl.clientHeight || 0;
    if (visibleHeight <= 0 || rowHeight <= 0) return Math.max(1, totalRows);
    return Math.max(1, Math.floor(visibleHeight / rowHeight));
  }

  /**
   * PageUp/PageDown/Home/End 的共同实现：跳转到指定绝对位置。
   * 与 navigateTask 不同点是：参数是「目标索引」而不是「方向偏移」，
   * 因为 PageUp/Down 是相对当前可见高度跳，不是固定 N 行（固定 N 容易让用户
   * 在大小不一的窗口里失去位置感）。
   *
   * @param {number} targetIdx - 目标索引（0 或 tasks.length-1 表示边界）
   */
  jumpToTask(targetIdx) {
    const tasks = this.store.getVisibleTasks(this.store.getSelectedCategory());
    if (!tasks || tasks.length === 0) return;
    const idx = Math.max(0, Math.min(tasks.length - 1, targetIdx));
    this.selectedTaskId = tasks[idx].id;
    this.render();
  }

  startEdit(item) {
    const taskId = item.dataset.id;
    const textEl = item.querySelector('.task-text');
    const inputEl = item.querySelector('.task-edit-input');
    if (!textEl || !inputEl) return;

    // 智能列表视图：编辑真实分类
    const cat = this.store.getSelectedCategory();
    const task = cat?.tasks.find(t => t.id === taskId);
    const realCatName = task?._fromCategory || cat?.name;
    if (!cat || !realCatName) return;

    // 防止重复触发：若已处于编辑态，直接 focus 现有输入框
    if (!inputEl.hidden) {
      inputEl.focus();
      // 不 select()：光标停在末尾，符合"修改和补充"的编辑直觉
      return;
    }

    // 如果正在编辑另一个任务，先清理（隐藏旧输入，移除旧监听器）
    this._cancelCurrentEdit();

    textEl.hidden = true;
    inputEl.hidden = false;
    inputEl.value = textEl.textContent;
    inputEl.focus();
    // 不调用 select() —— 用户期望的编辑语义是"修改和补充"：
    //   - 键入 → 在末尾补充文字
    //   - 鼠标选中某段 → 修改那一段
    //   - 想全选重写：Ctrl/Cmd+A → Delete，或三击全选
    // 全选（覆盖）会让每次键入都清空原文，对只想改个错别字或加几个字的场景很别扭。

    const finish = (commit) => {
      // 移除监听并清除跟踪引用（必须在隐藏输入前完成，
      // 否则隐藏触发 blur → onBlur 再次进入 finish）
      this._removeEditListeners(inputEl, onKey, onBlur, onInput);
      this._editInput = null;
      inputEl.hidden = true;
      textEl.hidden = false;

      if (commit) {
        const newText = inputEl.value.trim();
        if (newText) {
          this.store.updateTaskText(realCatName, taskId, newText);
        } else if (this._editDirty && originalText) {
          // 边界场景：用户**主动清空了非空文本**（input 事件触发过 + 原文本非空 + 现在空）
          // —— 旧实现这条路径会静默 noop，任务文本保留不变；但用户的"清空"意图被吞掉，
          // 会以为任务文本已被删除。提示一下，让用户知道"原文本还在，你没有真的删"。
          // 这里**不**自动删除任务（自动转回收站太激进，按 ESC / 重选分类才走那条路）。
          toast('编辑文本为空 —— 已保留原文本', 'info', 2500);
        }
      } else {
        this.render();
      }
      // 编辑态临时字段同步清零，避免下次 startEdit 拿到的 originalText 还是上次残留。
      this._editDirty = false;
      this._editOriginalText = null;
      this._editOnInput = null;
    };

    const onKey = (e) => {
      if (e.key === 'Enter' && !isImeComposing(e)) {
        e.preventDefault();
        finish(true);
      } else if (e.key === 'Escape' && !isImeComposing(e)) {
        // IME 守卫：CJK/JP/KR 用户按 Esc 通常是「取消 IME 组合」（结束选词），
        // 不是「取消编辑」。不挡掉会让 Esc 同时关掉 IME 和未完成的编辑。
        e.preventDefault();
        finish(false);
      }
    };
    const onBlur = () => {
      // 若编辑已被 cancelEdit / startEdit(另一个) 清理，忽略此 blur
      if (!this._editInput) return;
      finish(true);
    };
    // 记录编辑前原文 —— 用来在 commit 阶段判断"用户清空整段 vs 进来没动"两种语义：
    //   - 原文非空 + value 空 + _editDirty=true → 用户清空了文本但被静默 noop，提示用户
    //   - 原文就空 + value 空（手写 - [x] 这种合法空任务）→ 无需提示
    // input 事件触发即把 _editDirty 置 true，从这一刻起任何 commit 都按"用户主动编辑过"处理。
    const originalText = textEl.textContent;
    const onInput = () => {
      this._editDirty = true;
    };
    inputEl.addEventListener('input', onInput);

    inputEl.addEventListener('keydown', onKey);
    inputEl.addEventListener('blur', onBlur);

    // 跟踪当前编辑状态，供 cancelEdit / startEdit(切换目标) 使用
    this._editInput = inputEl;
    this._editOnKey = onKey;
    this._editOnBlur = onBlur;
    this._editOnInput = onInput;
    this._editOriginalText = originalText;
    // _editDirty 在 onInput 第一次触发前保持 false —— 用户只是点进去看了但没改。
    this._editDirty = false;
    // 同步提交路径需要：记录当前编辑对应的 task id 和真实分类名。
    this._editTaskId = taskId;
    this._editRealCatName = realCatName;
  }

  /** 移除编辑输入框上的 keydown / blur / input 监听器 */
  _removeEditListeners(inputEl, onKey, onBlur, onInput) {
    inputEl.removeEventListener('keydown', onKey);
    inputEl.removeEventListener('blur', onBlur);
    if (onInput) inputEl.removeEventListener('input', onInput);
  }

  /**
   * 清理当前正在进行的编辑（不提交）：
   * 移除监听器、恢复文本显示。不触发 render()，由调用方决定何时渲染。
   */
  _cancelCurrentEdit() {
    if (!this._editInput) return;
    const input = this._editInput;
    this._removeEditListeners(input, this._editOnKey, this._editOnBlur, this._editOnInput);
    this._editInput = null;
    // 同步清掉 _editTaskId / _editRealCatName —— 与 _commitActiveEdit (line ~1424) 清理路径一致，
    // 避免「_cancelCurrentEdit 走一次、_editTaskId 残留 → 后续 render 期间被错误引用」的潜在隐患。
    // 当前实现靠 _commitActiveEdit 入口 `if (!this._editInput) return` 兜底不会翻车，但清理不彻底
    // 的状态字段是隐式耦合，未来若有人改 _commitActiveEdit 守卫就会立刻踩坑。
    this._editTaskId = null;
    this._editRealCatName = null;
    // 清掉编辑态临时字段 —— 与 _commitActiveEdit 同步提交路径保持清理一致性，
    // 避免跨次编辑残留 dirty 标志误判（"上次的 dirty=true 在下次 startEdit 前还活着"）。
    this._editDirty = false;
    this._editOriginalText = null;
    this._editOnInput = null;
    // 恢复文本显示（先于隐藏输入，避免隐藏触发 blur 后 finish 重新操作 DOM）
    const item = input.closest('.task-item');
    const textEl = item?.querySelector('.task-text');
    input.hidden = true;
    if (textEl) textEl.hidden = false;
  }

  cancelEdit() {
    if (this._editInput) {
      // 先移除监听器再隐藏输入：隐藏会触发 blur，
      // 若 blur 监听仍在，onBlur 会调用 finish(true) 提交编辑 —— 违背「取消」语义
      this._cancelCurrentEdit();
      this.render();
    }
  }

  async deleteTaskWithConfirm(taskId) {
    const cat = this.store.getSelectedCategory();
    if (!cat) return;
    const task = cat.tasks.find(t => t.id === taskId);
    if (!task) return;

    // 智能列表视图：操作真实分类
    const realCatName = task._fromCategory || cat.name;

    // 措辞要讲清「删除是可逆的」—— 任务只是移到回收站，Markdown 里仍在。
    // 也因此不标 danger：这不是一个危险的不可逆操作。
    const ok = await confirmDialog({
      title: '移到回收站',
      message: `将任务 "${task.text.length > 40 ? task.text.slice(0, 40) + '...' : task.text}" 移到回收站？\n\n任务不会消失，之后可以从回收站恢复。`,
      confirmText: '移到回收站',
      cancelText: '取消',
      danger: false
    });
    if (!ok) return;

    // 下一个选中项要按「用户实际看到的顺序」来挑，所以用 getVisibleTasks
    // （cat.tasks 是未过滤/未排序的全量，且在智能列表下是一份副本）。
    //
    // 关键：nextId 必须**在删除之前**算 —— 删除后 cat.tasks 已经变了（智能列表
    // 下是新建的副本），再算就是「在旧快照里挑下一个」。但删除本身又同步触发
    // render()，所以这里算完后存进 nextId，删完再赋值。
    const visible = this.store.getVisibleTasks(cat);
    const idx = visible.findIndex(t => t.id === taskId);
    const nextId = idx >= 0
      ? (visible[idx + 1]?.id || visible[idx - 1]?.id || null)
      : null;

    this.store.deleteTask(realCatName, taskId);

    // deleteTask 已经触发 render() 并把 this.selectedTaskId 用旧值画了一次。
    // 现在安全地修改 selectedTaskId 并再渲染一次 —— 不必担心 render 顺序，
    // 因为 selectedTaskId 只在下次键盘事件 / render 中起作用。
    this.selectedTaskId = nextId;
    this.render();
  }

  // ============================================
  //  选择模式（Selection Mode）+ 批量操作浮栏
  // ============================================
  //
  // 设计要点：
  //   1. 进入/退出完全独立于 selectedTaskId —— 后者仍走单条键盘交互的逻辑，
  //      选择模式只接管「点击 task」和「底部浮栏」两块入口。
  //   2. 选中集合用 (categoryName, taskId) 复合 key 串接成单一字符串，
  //      智能列表下 _fromCategory 不同的任务 id 撞名也能正确区分。
  //   3. 批量调用 store 时统一用 { categoryName, taskId } 形式，store 端
  //      的 _resolveTaskRefs 直接消费这个结构，不需要再走一次反查。

  /** 复合 key：把 (catName, id) 串成单一字符串做 Set key / 锚点 */
  static _selKey(catName, taskId) {
    return `${catName}|${taskId}`;
  }

  _enterSelectionMode() {
    if (this.selectionMode) return;
    // 入场守卫：0 项可批量时不进入选择模式。
    // 之前依赖 render() 里 visibleTasks.length === 0 → _exitSelectionMode 的兜底，
    // 但 render() 是 _enterSelectionMode **之后**调用，途中 _ensureBatchBar /
    // _updateBatchBarState 已先一步把浮栏画上去，再被 render() 内部 _exitSelectionMode
    // 立刻撤掉——视觉上还是一闪空浮栏，且 selectionMode 短暂为 true 再变 false 留痕迹。
    // 这里在源头挡住：visibleTasks=0 直接不发车。
    const cat = this.store.getSelectedCategory();
    if (cat && this.store.getVisibleTasks(cat).length === 0) {
      return;
    }
    // 清理正在进行的拖拽 —— 拖拽进行中进入批量模式会让 ghost / indicator 残留
    // （_setupDrag 的 pointerdown 已在选择模式下早退，但中途切换状态时旧拖拽还在）
    this._cancelAllDrags();
    // 清理正在进行的编辑 —— 进入批量模式后整行变成切换选中语义，
    // 编辑输入框和新任务 DOM 会冲突；显式提交当前编辑内容再切状态
    this._commitActiveEdit();
    this.selectionMode = true;
    // 清掉单条高亮的 selectedTaskId —— 选择模式下点击走批量语义，不应该再有
    // 「上次点过的那一条」被键盘快捷键作用；保留会让用户按 Space 改了不该改的。
    // 与切分类时 pendingSelectReset 行为对齐。
    this.selectedTaskId = null;
    // 不清空 selectedTaskIds —— 允许从「当前选中」延伸出批量上下文，
    // 比如用户先点了 A，再进入批量模式想从 A 开始连续多选。
    this.render();
    this._ensureBatchBar();
    this._updateBatchBarState();
  }

  /** 提交正在进行的编辑（如果有）。与 cancelEdit 不同 —— 这里保留用户的输入，
   *  只清理编辑态、不丢弃未保存的修改。进入选择模式应该「保留用户的劳动」。
   *
   * 关键：必须**同步**提交文本到 store，不能依赖 input.blur() → onBlur → finish(true)
   * 异步路径 —— 接下来如果立刻 render()，listEl.innerHTML 被替换、input 节点销毁，
   * blur 异步派发时 input 已不在 DOM，onBlur 不再触发（或触发了但 finish 闭包操作已
   * 销毁的节点），编辑内容永久丢失。
   *
   * 做法：直接读 input.value.trim() 同步调 store.updateTaskText，再清状态。
   */
  _commitActiveEdit() {
    if (!this._editInput) return;
    const input = this._editInput;
    const taskId = this._editTaskId;
    const realCatName = this._editRealCatName;
    const originalText = this._editOriginalText;
    const wasDirty = this._editDirty;
    // 同步清理跟踪状态（避免 render() 替换 innerHTML 时还引用已销毁节点）
    if (this._editOnKey) input.removeEventListener('keydown', this._editOnKey);
    if (this._editOnBlur) input.removeEventListener('blur', this._editOnBlur);
    if (this._editOnInput) input.removeEventListener('input', this._editOnInput);
    this._editInput = null;
    this._editOnKey = null;
    this._editOnBlur = null;
    this._editOnInput = null;
    this._editTaskId = null;
    this._editRealCatName = null;
    this._editDirty = false;
    this._editOriginalText = null;

    if (!input.hidden && taskId && realCatName) {
      const newText = input.value.trim();
      if (newText) {
        // 同步落盘 —— 不依赖 blur 异步路径
        this.store.updateTaskText(realCatName, taskId, newText);
      } else if (wasDirty && originalText) {
        // 与 finish(true) 同款路径：render() 被 store change 同步触发时，input 销毁前
        // 先同步提交。这次提交若 value 为空 + 用户已编辑过 + 原文非空 → 静默 noop 会
        // 让用户以为"任务文本被清空了"，刷新回来却还在。这里 toast 提示，不强行删任务。
        // toast 调用在这里是**安全的**：_commitActiveEdit 是同步路径，toast 内部
        // append DOM，不依赖 render() 顺序。
        toast('编辑文本为空 —— 已保留原文本', 'info', 2500);
      }
    }
    // 不在这里 render() —— 调用方（render 入口自己 / _enterSelectionMode 等）
    // 会负责重新渲染；这里只负责「不丢编辑内容」。
  }

  /**
   * 退出选择模式。
   * @param {{ clear?: boolean }} opts
   *   - clear: 是否清空已选集合。true 用于「取消」、「切分类」、「加载文件」；
   *     false 用于「操作完成后保留模式、清理临时选中」。
   *
   * H2: 同步清掉 selectedTaskId —— 切分类时虽然 pendingSelectReset 也会清，
   * 但 0 项自动退出 / 外部清空等场景下 select 事件不一定先于 change 到达，
   * 在 _exitSelectionMode 显式清更稳。
   */
  _exitSelectionMode({ clear = true } = {}) {
    if (!this.selectionMode && !this.batchBarEl) {
      // 双重兜底：selectionMode 已关且浮栏已清掉，什么都不用做
      return;
    }
    this.selectionMode = false;
    this.selectionAnchor = null;
    this.selectedTaskId = null;
    if (clear) this.selectedTaskIds.clear();
    // L4 修复：必须**立即**同步 body[data-selection-mode] = 'false'。
    // 之前依赖 render() 里 _syncBatchBar 内部去设，render 是异步的（render 内部
    // 还要走 filter 兜底、queueMicrotask 等），期间 CSS 还把任务行当 selection-mode
    // 渲染（点击时批量态圆圈还在、指针交互错位）。同步在这里设掉，杜绝这一帧的
    // 中间态。
    document.body.dataset.selectionMode = 'false';
    // 退出选择模式时也关掉可能残留的菜单（典型场景：打开了 move 菜单后按 Esc 退出）。
    // 之前靠 document click handler 兜底，现在 stopPropagation 后必须显式调用。
    hideContextMenu();
    if (this.batchBarEl) {
      this.batchBarEl.remove();
      this.batchBarEl = null;
    }
    this.render();
  }

  /**
   * 切换单条选中。三种交互路径：
   *   - 普通 click：toggle + 把 anchor 移到这里
   *   - ctrl/cmd + click：toggle 但不移动 anchor（适合「想再多选一条不打断区间」）
   *   - shift + click：区间选 —— 从 anchor 到当前 task 的所有行被选中
   *     （没有 anchor 时退化成普通 click）
   *
   * 智能列表下：每条 task 传进来的 fromCategory 都是真实的（enriched 副本自带）。
   * 普通子分类下：传进来的是 cat.name。
   */
  _toggleSelection(fromCategory, taskId, { shift = false, ctrl = false } = {}) {
    const key = TaskList._selKey(fromCategory, taskId);

    if (shift) {
      // 区间选：先校验 anchor 仍指向一个可见任务，再算 [min, max] 索引区间
      const cat = this.store.getSelectedCategory();
      const visible = this.store.getVisibleTasks(cat);
      if (visible.length === 0) return;

      const currentIdx = visible.findIndex(t => t.id === taskId);
      if (currentIdx < 0) return;

      // anchor lookup：用复合 key 直接匹配，比逐字段比 _fromCategory 更稳。
      // anchor 格式 = `${fromCategory}|${taskId}`，visible 任务用同样规则生成 key。
      let anchorIdx = -1;
      if (this.selectionAnchor) {
        // 把可见任务转成 key 后用 indexOf 一次定位 —— 避免 _fromCategory 在普通子分类
        // 下为 undefined、anchor 锚 cat.name 时还要回退的繁琐比对。
        const visibleKeys = visible.map(t =>
          TaskList._selKey(t._fromCategory || cat.name, t.id)
        );
        anchorIdx = visibleKeys.indexOf(this.selectionAnchor);
      }
      // 锚点失效（切分类 / 搜索过滤掉 / anchor 任务被删）→ 退化为「只选当前」
      // H6/M8: 同时清掉 anchor —— 否则它会一直挂着影响下次判断。
      if (anchorIdx < 0) {
        anchorIdx = currentIdx;
        this.selectionAnchor = null;
      }

      // 支持反向区间：用户从下往上 shift-click 应选 [click, anchor] 整段
      const lo = Math.min(anchorIdx, currentIdx);
      const hi = Math.max(anchorIdx, currentIdx);

      // 区间选语义：「累加」，不清空 anchor 之外的已选项。
      // 这跟 Finder / macOS 选择器一致 —— 否则点 3 次 shift 会越选越少。
      for (let i = lo; i <= hi; i++) {
        const t = visible[i];
        const fromCat = t._fromCategory || cat.name;
        this.selectedTaskIds.add(TaskList._selKey(fromCat, t.id));
      }
      // 反向区间后 anchor 仍在原位 —— 用户继续 shift-click 应该继续从原 anchor 算，
      // 这也是 Finder 的语义。如果想让 anchor 跟随 latest click，注释掉下面一行。
      // （保留原 anchor 是「区间起点」的常见期望，所以这里不动它）
    } else {
      // 普通 / ctrl-click：toggle 该条
      if (this.selectedTaskIds.has(key)) {
        this.selectedTaskIds.delete(key);
      } else {
        this.selectedTaskIds.add(key);
      }
      if (!ctrl) {
        // ctrl-click 保留 anchor 不动（允许接着 shift 区间选）；普通 click 移动 anchor
        this.selectionAnchor = key;
      }
    }

    this._refreshSelectionVisuals();
    this._updateBatchBarState();
  }

  /** 当前视图所有可见任务全选（Cmd/Ctrl+A 入口）
   *
   * H1 修复：设 anchor 到最后一个可见项 —— 否则下一次 Shift+Click 会因 anchor=null
   * 退化成「只 toggle 点击的那一项」，其它全选项瞬间丢失，违背用户直觉。
   */
  _selectAllVisible() {
    const cat = this.store.getSelectedCategory();
    if (!cat) return;
    const visible = this.store.getVisibleTasks(cat);
    if (visible.length === 0) return;
    for (const t of visible) {
      const fromCat = t._fromCategory || cat.name;
      this.selectedTaskIds.add(TaskList._selKey(fromCat, t.id));
    }
    // 设 anchor 到最后一项 —— Shift+Click 中间任意位置 = 选中「点击 → anchor」整段。
    // 这与用户「全选后想再扩展一段」的常见操作流一致。
    const last = visible[visible.length - 1];
    this.selectionAnchor = TaskList._selKey(
      last._fromCategory || cat.name,
      last.id
    );
    this._refreshSelectionVisuals();
    this._updateBatchBarState();
  }

  /** 清空当前已选集合 —— 「取消全选」按钮入口。
   *
   * 注意：清的是 selectedTaskIds 全集，不仅是可见项。理由：浮栏按钮文案是
   * 「取消全选」，用户期待「重置选择」语义；若智能列表下选了多个子分类的任务、
   * 切到「全部」后再点取消全选，部分选自其他子分类的项也应一起清掉。
   *
   * 同时清掉 selectionAnchor —— 否则下次 Shift+Click 会以一个用户已不在意的
   * 位置为起点，区间选结果难预测。
   */
  _deselectAll() {
    if (this.selectedTaskIds.size === 0) return;
    this.selectedTaskIds.clear();
    this.selectionAnchor = null;
    this._refreshSelectionVisuals();
    this._updateBatchBarState();
  }

  /** 当前可见任务是否全部已选 —— 浮栏「全选/取消全选」toggle 按钮状态判断。
   *
   * 抽出来给 _updateBatchBarState（决定按钮文案）+ _handleBatchAction
   * （决定点下去是 select 还是 deselect）共用，保证两边判断逻辑一致。
   *
   * 边界：
   *   - 0 可见项 → 返回 false（按钮走「全选」态，点击为 no-op）
   *   - 任何一项不在 selectedTaskIds → false
   *   - 全部在 → true
   */
  _isAllVisibleSelected() {
    const cat = this.store.getSelectedCategory();
    if (!cat) return false;
    const visible = this.store.getVisibleTasks(cat);
    if (visible.length === 0) return false;
    for (const t of visible) {
      const fromCat = t._fromCategory || cat.name;
      if (!this.selectedTaskIds.has(TaskList._selKey(fromCat, t.id))) {
        return false;
      }
    }
    return true;
  }

  /**
   * 不走 render() 的轻量刷新：仅切换 .selected class + 更新圆形选择器视觉，
   * 避免一次 toggle 操作触发整列表 innerHTML 重建（用户连点多条时会闪烁）。
   * 真正需要全量重渲染的时机是 store.emit('change')，走统一 render 路径。
   *
   * 性能要点：把 getVisibleTasks 提到循环外建 Map 一次，循环里 O(1) 查。
   * 原版循环里反复调 getVisibleTasks，N 条任务做一次区间选就是 O(N²) ——
   * 1000 条任务会让 UI 顿 1-2 秒。修复后 N 条 = O(N)。
   */
  _refreshSelectionVisuals() {
    const items = this.listEl.querySelectorAll('.task-item');
    if (items.length === 0) return;
    const cat = this.store.getSelectedCategory();
    if (!cat) return;
    const visible = this.store.getVisibleTasks(cat);
    const visibleById = new Map(visible.map(t => [t.id, t]));
    items.forEach(el => {
      const id = el.dataset.id;
      const task = visibleById.get(id);
      if (!task) return;
      const fromCat = task._fromCategory || cat.name;
      const key = TaskList._selKey(fromCat, id);
      const selected = this.selectedTaskIds.has(key);
      el.classList.toggle('selected', selected);
      // 圆形选择器：class + SVG 子节点同步
      const circle = el.querySelector('[data-selection-circle]');
      if (circle) {
        circle.classList.toggle('selected', selected);
        circle.innerHTML = selected ? CHECK_SVG : '';
      }
      // 兼容：旧渲染路径如果还在用 input 也同步一下
      const input = el.querySelector('.task-checkbox');
      if (input) input.checked = selected;
    });
  }

  // =====================
  //  批量浮栏（.batch-action-bar）
  // =====================
  //
  // 视觉：固定底部居中，毛玻璃 + 阴影 + 圆角，与 .more-menu 同设计语言。
  // 按钮启用规则集中到 _updateBatchBarState()：
  //   - 移回分类：永远可点（只要 selectedTaskIds 非空 + 存在其它可写分类）
  //   - 置顶/置底：选中任务的 fromCategory 必须全部一致 + sortBy != ALPHABET + 当前不是容器
  //   - 重要/当前：v3.6+ 起 TRASH 内任务也允许 —— ⭐/▶ 是任务级状态，回收站里也能改
  //   - 完成：永远可点（TRASH 也允许切完成态）
  //   - 移到回收站：所有选中任务都不在 TRASH

  _ensureBatchBar() {
    if (this.batchBarEl) return;
    const bar = document.createElement('div');
    bar.className = 'batch-action-bar';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', '批量操作');
    // 横排分组：header (计数 + 关闭) + 「位置 / 分类」组 + 「标记」组 + 「删除 / 完成」组
    // 外层 .batch-action-bar 只负责横向居中（translateX），内层 .batch-action-bar-inner
    // 承载排版 + 入场动画 —— 避免 transform 冲突。
    // 每组用 .batch-bar-group 包起来，组间用 1px 竖线分隔。
    bar.innerHTML = `
      <div class="batch-action-bar-inner">
        <div class="batch-bar-header">
          <span class="batch-count" id="batch-count">已选 0 项</span>
          <button class="batch-action batch-action-select-all" data-action="select-all-toggle" type="button" title="全选当前可见任务 (Ctrl+A)">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="m3 17 2 2 4-4"/>
              <path d="m3 7 2 2 4-4"/>
              <path d="M13 6h8"/>
              <path d="M13 12h8"/>
              <path d="M13 18h8"/>
            </svg>
            <span class="batch-action-select-all-label">全选</span>
          </button>
          <button class="batch-action batch-action-close" data-action="cancel" type="button" title="退出选择模式 (Esc)" aria-label="退出选择模式">
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M18 6 6 18"/>
              <path d="m6 6 12 12"/>
            </svg>
          </button>
        </div>

        <div class="batch-bar-group">
          <button class="batch-action" data-action="move" type="button">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M3 7h7l2 2h9v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
            </svg>
            <span>移到分类</span>
          </button>
          <button class="batch-action" data-action="top" type="button" title="移到顶部">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="m18 15-6-6-6 6"/>
            </svg>
            <span>置顶</span>
          </button>
          <button class="batch-action" data-action="bottom" type="button" title="移到底部">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="m6 9 6 6 6-6"/>
            </svg>
            <span>置底</span>
          </button>
        </div>

        <div class="batch-bar-group">
          <button class="batch-action" data-action="important-set" type="button" title="标记为重要">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.123 2.123 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.123 0 0 0 1.597-1.16z"/>
            </svg>
            <span>标重要</span>
          </button>
          <button class="batch-action" data-action="important-unset" type="button" title="取消重要">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" aria-hidden="true">
              <path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.123 2.123 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.123 0 0 0 1.597-1.16z"/>
            </svg>
            <span>取消重要</span>
          </button>
          <button class="batch-action" data-action="current-set" type="button" title="标记为当前">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="9"/>
            </svg>
            <span>标当前</span>
          </button>
          <button class="batch-action" data-action="current-unset" type="button" title="取消当前">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="4" fill="currentColor"/>
              <circle cx="12" cy="12" r="9"/>
            </svg>
            <span>取消当前</span>
          </button>
        </div>

        <div class="batch-bar-group">
          <button class="batch-action" data-action="complete" type="button" title="切换完成状态（全部勾 → 全取消；其余 → 全勾）">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M20 6 9 17l-5-5"/>
            </svg>
            <span>完成</span>
          </button>
          <button class="batch-action batch-action-danger" data-action="delete" type="button" title="移到回收站">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M3 6h18"/>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>
              <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
            </svg>
            <span>移到回收站</span>
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(bar);
    this.batchBarEl = bar;
    this._bindBatchBarEvents(bar);
  }

  _bindBatchBarEvents(bar) {
    bar.addEventListener('click', (e) => {
      const btn = e.target.closest('.batch-action');
      if (!btn || btn.disabled) return;
      const action = btn.dataset.action;
      // 关键：阻断冒泡到 document —— feedback.js:312 的全局 click handler 会
      // 把"刚弹出的菜单"当成"点外面"立刻关掉（_showBatchMoveMenu 走的 showContextMenu
      // 是同一个 click 事件里弹的）。修复模式与 .task-action-restore（task-list.js:182）
      // 一致：触发弹层前必须 stopPropagation。
      //
      // 后续的菜单关闭由 _afterBatchComplete / _exitSelectionMode 显式调 hideContextMenu
      // 兜底，避免「点击 complete 时 move 菜单残留」的并发场景。
      e.stopPropagation();
      this._handleBatchAction(action);
    });
  }

  /**
   * 集中刷新浮栏按钮 enabled 状态和「已选 N 项」计数。
   * 每条规则都用 selectedTaskIds 里的复合 key 解出 fromCategory / id 后判断。
   */
  _updateBatchBarState() {
    const bar = this.batchBarEl;
    if (!bar) return;
    const countEl = bar.querySelector('#batch-count');
    const n = this.selectedTaskIds.size;
    // 「已选 0 项」会让刚进入批量模式的用户困惑 —— 明明没选任何东西，
    // 怎么提示我「已选 0 项」？区分两种状态：
    //   - 0 项 → 「点击任务开始选择」明确指引
    //   - N 项 → 「已选 N 项」正常计数
    if (countEl) countEl.textContent = n > 0 ? `已选 ${n} 项` : '点击任务开始选择';

    // 「全选 / 取消全选」toggle 按钮：根据当前是否已全选切换文案与 title。
    // 逻辑与 _handleBatchAction 共用 _isAllVisibleSelected，保证点下去与显示一致。
    const selectAllBtn = bar.querySelector('.batch-action-select-all');
    if (selectAllBtn) {
      const allSelected = this._isAllVisibleSelected();
      const labelEl = selectAllBtn.querySelector('.batch-action-select-all-label');
      if (labelEl) labelEl.textContent = allSelected ? '取消全选' : '全选';
      selectAllBtn.title = allSelected ? '取消全选 (Ctrl+A)' : '全选当前可见任务 (Ctrl+A)';
      selectAllBtn.setAttribute('aria-label', allSelected ? '取消全选' : '全选');
    }

    // 解析每个选中的 (fromCategory, taskId)
    const refs = [];
    for (const key of this.selectedTaskIds) {
      const [cat, id] = key.split('|');
      refs.push({ categoryName: cat, taskId: id });
    }

    const cat = this.store.getSelectedCategory();

    // 1. fromCategory 一致性：所有选中任务是否来自同一真实分类？
    const allSameCategory = refs.length > 0 && refs.every(r => r.categoryName === refs[0].categoryName);

    // 2. 是否包含 TRASH 内的任务
    // v3.6+：⭐ / ▶ 不再因为「包含 TRASH 任务」而禁用 —— updateTaskMeta 守卫已放开，
    // 这两个标识是任务级状态而非分类归属，回收站里也能批量改。
    // 仍被「包含 TRASH」影响：移到回收站（trash 里再删没意义）
    const anyInTrash = refs.some(r => r.categoryName === TRASH_NAME);

    // 视图感知：已完成智能视图 / 回收站视图需要差异化按钮可见性 + label。
    // 与 buildStandardContextMenuItems / buildTrashContextMenuItems 的「按视图短路」
    // 策略对齐 —— 右键菜单里能/不能做的事，浮栏里也应一致。
    const isCompletedView = cat?.isSmartList && cat.smartKey === 'completed';
    const isTrashView = cat?.kind === CategoryKind.TRASH;

    // 「移到分类」按钮：
    //   - 已完成视图：所有候选目标会被 store 硬路由回「已完成任务」分类，等于死按钮 → 整组隐藏
    //     （与 buildStandardContextMenuItems 的 isCompletedView 短路对齐）
    //   - 回收站视图：作为「恢复到分类…」入口，与单条恢复按钮的语义一致 → 显示并改名
    const moveBtn = bar.querySelector('.batch-action[data-action="move"]');
    if (moveBtn) {
      if (isCompletedView) {
        moveBtn.hidden = true;
      } else {
        moveBtn.hidden = false;
        const moveLabel = moveBtn.querySelector('span');
        if (moveLabel) moveLabel.textContent = isTrashView ? '恢复到分类…' : '移到分类';
        moveBtn.title = isTrashView
          ? '批量恢复选中的任务到指定分类'
          : '批量移动选中的任务到指定分类';
      }
    }

    // 「移到回收站」按钮：回收站里再删一次无意义 → 隐藏。
    // 与 _updateBatchBarState 的 `delete: n > 0 && !anyInTrash` 对齐：所有选中都在
    // TRASH 时本来也会灰掉，这里直接整组隐藏更干净。
    const deleteBtn = bar.querySelector('.batch-action[data-action="delete"]');
    if (deleteBtn) {
      deleteBtn.hidden = isTrashView;
    }

    // 「完成」按钮 label：已完成视图下所有任务都是已完成，唯一可能动作是「取消完成」
    // （= batchToggleCompleted(refs, false)，任务按各自 originalCategory 归位）。
    // 显式 label 比依赖 toast 反馈「未完成 N 项」更直观。
    const completeBtn = bar.querySelector('.batch-action[data-action="complete"]');
    if (completeBtn) {
      const completeLabel = completeBtn.querySelector('span');
      if (completeLabel) {
        if (isCompletedView) {
          completeLabel.textContent = '取消完成';
          completeBtn.title = '批量取消完成状态（任务按各自原分类归位）';
        } else {
          completeLabel.textContent = '完成';
          completeBtn.title = '切换完成状态';
        }
      }
    }

    // 3. 是否有可写目标分类（移到分类：排除 OTHER_TASKS / TRASH）
    // v4+ 修复：不再排除源分类 —— 与 _showBatchMoveMenu 的 targets 过滤对齐。
    // 智能列表下选中的任务来自多个子分类，旧逻辑按 refs[0] 排除源分类会误判
    // 「没有可写目标」导致按钮被灰掉。
    const movableTargets = this.store.categories.filter(c =>
      c.kind !== CategoryKind.OTHER_TASKS && c.kind !== CategoryKind.TRASH
    );
    const hasMoveTarget = movableTargets.length > 0;

    // 4. 置顶/置底：单分类 + sortBy != ALPHABET + 非容器
    const canReorder = allSameCategory &&
      this.store.sortBy !== SortBy.ALPHABET &&
      cat && !cat.isSmartList;

    // 5. 标 X / 取消 X 拆分后：「标 X」要求至少一条非目标态；
    //    「取消 X」要求至少一条是目标态。这样按钮不会因为「全是 true」还在那里可点。
    let anyNotImportant = false;
    let anyImportant = false;
    let anyNotCurrent = false;
    let anyCurrent = false;
    for (const r of refs) {
      const c = this.store.getCategory(r.categoryName);
      const t = c?.tasks.find(x => x.id === r.taskId);
      if (!t) continue;
      if (t.important) anyImportant = true; else anyNotImportant = true;
      if (t.current) anyCurrent = true; else anyNotCurrent = true;
    }

    this._setBatchActionEnabled(bar, 'move', n > 0 && hasMoveTarget);
    this._setBatchActionEnabled(bar, 'top', canReorder);
    this._setBatchActionEnabled(bar, 'bottom', canReorder);
    // 标重要：要求 (b) 至少一条非 important（v3.6+：TRASH 也允许）
    this._setBatchActionEnabled(bar, 'important-set', n > 0 && anyNotImportant);
    // 取消重要：要求 (b) 至少一条是 important（v3.6+：TRASH 也允许）
    this._setBatchActionEnabled(bar, 'important-unset', n > 0 && anyImportant);
    this._setBatchActionEnabled(bar, 'current-set', n > 0 && anyNotCurrent);
    this._setBatchActionEnabled(bar, 'current-unset', n > 0 && anyCurrent);
    this._setBatchActionEnabled(bar, 'complete', n > 0);
    this._setBatchActionEnabled(bar, 'delete', n > 0 && !anyInTrash);
  }

  _setBatchActionEnabled(bar, action, enabled) {
    const btn = bar.querySelector(`.batch-action[data-action="${action}"]`);
    if (!btn) return;
    btn.disabled = !enabled;
  }

  /**
   * 批量操作分发。所有操作完成后保留选择模式，但清空已选集合
   * —— 用户希望「再做一批」的话继续选，「做完」的话自己点取消。
   *
   * M4: in-flight 守卫：用户连点同一按钮会重复弹 confirmDialog / 重复提交。
   * 用 _batchInFlight 锁整个分发器，async 完成后 finally 释放。
   */
  async _handleBatchAction(action) {
    if (this._batchInFlight) return;

    // 「全选 / 取消全选」toggle 必须在 refs 校验之前处理 —— 它本身不依赖 refs，
    // 且「全选」语义要求在「已选 0 项」时也能触发（否则用户清空选择后点全选没反应）。
    // 同步执行，不进 async / 不锁 _batchInFlight。
    if (action === 'select-all-toggle') {
      // 共用 _isAllVisibleSelected 与 _updateBatchBarState 保证两边判断一致。
      if (this._isAllVisibleSelected()) {
        this._deselectAll();
      } else {
        this._selectAllVisible();
      }
      return;
    }

    const refs = [...this.selectedTaskIds].map(key => {
      const [cat, id] = key.split('|');
      return { categoryName: cat, taskId: id };
    });
    if (refs.length === 0) return;
    this._batchInFlight = true;
    try {
      switch (action) {
        case 'move':
          this._showBatchMoveMenu();
          break;
        case 'top':
        case 'bottom': {
          // 按 fromCategory 分组，每组内调 batchReorderInCategory
          // 不同 fromCategory 已经在 _updateBatchBarState 灰掉了按钮，理论上不会到这里
          const groupMap = new Map();
          for (const r of refs) {
            if (!groupMap.has(r.categoryName)) groupMap.set(r.categoryName, []);
            groupMap.get(r.categoryName).push(r.taskId);
          }
          let totalMoved = 0;
          for (const [catName, ids] of groupMap) {
            const result = this.store.batchReorderInCategory(catName, ids, action);
            totalMoved += result.moved || 0;
          }
          if (totalMoved > 0) {
            toast(action === 'top' ? `已置顶 ${totalMoved} 项` : `已置底 ${totalMoved} 项`, 'success', 1500);
            this._afterBatchComplete();
          }
          break;
        }
        case 'important-set':
        case 'important-unset':
        case 'current-set':
        case 'current-unset': {
          // 「重要」/「当前」批量改：拆成显式两按钮（标 X / 取消 X），
          // 不再做 toggle —— 用户能在选中状态参差时也能精准表达意图。
          const isImportant = action.startsWith('important');
          const isSet = action.endsWith('-set');
          const meta = isImportant
            ? { important: isSet }
            : { current: isSet };
          const verb = isSet
            ? (isImportant ? '标记重要' : '标记当前')
            : (isImportant ? '取消重要' : '取消当前');
          const result = this.store.batchUpdateMeta(refs, meta);
          if (result.changed > 0) {
            toast(`已${verb} ${result.changed} 项`, 'success', 1500);
            this._afterBatchComplete();
          } else {
            // 状态已经符合目标（全部已是 / 全部已不是），给出明确反馈而不是静默
            toast(`选中任务已${verb}`, 'info', 1200);
          }
          break;
        }
        case 'complete': {
          // 切到已完成。批量 toggle：如果一半已勾一半未勾，统一置为 true 更直观；
          // 再次点击会统一置为 false（与单击切换「未全勾则全勾，全勾则全取消」一致）
          //
          // 防御性过滤：refs 里的任务如果在确认 / 等待期间被外部删了（云同步、reload），
          // .find 会返回 undefined。`every` 第一个 undefined 就 false → target=true →
          // 已勾的任务会被一起 toggle 成未完成（与「已全勾则全取消」语义完全相反）。
          // 过滤 Boolean 后再用剩下的实任务算 allCompleted，避免「missing 一条就把方向算反」。
          const tasks = refs.map(r => {
            const c = this.store.getCategory(r.categoryName);
            return c?.tasks.find(t => t.id === r.taskId);
          }).filter(Boolean);
          const allCompleted = tasks.length > 0 && tasks.every(t => t.completed);
          const target = !allCompleted; // 全勾 → 取消勾；其余 → 勾
          const result = this.store.batchToggleCompleted(refs, target);
          if (result.changed > 0) {
            toast(`${target ? '已完成' : '未完成'} ${result.changed} 项`, 'success', 1500);
            this._afterBatchComplete();
          } else {
            // 状态已经符合目标 / 任务全部已被外部删除（tasks 为空）→ 给反馈不静默
            toast('选中任务状态已符合目标', 'info', 1200);
          }
          break;
        }
        case 'delete': {
          const ok = await confirmDialog({
            title: '移到回收站',
            message: `将选中的 ${refs.length} 项任务移到回收站？\n\n任务不会消失，之后可以从回收站恢复。`,
            confirmText: '移到回收站',
            cancelText: '取消',
            danger: false
          });
          if (!ok) return;
          // Esc race 守卫：用户在 confirmDialog 等待期间按 Esc 或点其他位置
          // 退出选择模式 → batchBar 已被销毁、selectedTaskIds 已清，但 await 之后的
          // batchDeleteTasks(refs) 仍会执行（旧 refs 是局部变量、指向确认前的快照）。
          // 表现：选择模式已退出、浮栏已消失，但任务被悄悄删除 + 「已移到回收站 N 项」toast，
          // 用户会以为是程序 bug。守卫住 selectionMode，避免静默删任务。
          if (!this.selectionMode) return;
          const result = this.store.batchDeleteTasks(refs);
          if (result.moved > 0) {
            toast(`已移到回收站 ${result.moved} 项`, 'success', 1500);
            this._afterBatchComplete();
          } else {
            // 任务全部已被外部删除（云同步 / reload 在 await 期间发生）→ 给反馈不静默
            toast('选中任务已全部不存在，跳过删除', 'info', 1500);
          }
          break;
        }
        case 'cancel':
          this._exitSelectionMode({ clear: true });
          break;
      }
    } finally {
      this._batchInFlight = false;
    }
  }

  /** 批量操作完成后的统一处理：清空已选、刷新浮栏状态、保留选择模式。
   *
   * C6: 同步清掉 selectedTaskId —— 之前只清 selectedTaskIds / selectionAnchor，
   * 但 selectedTaskId 是单条高亮 / 键盘目标（Space / F2 / Delete 作用于它）。
   * 批量改 / 删后该值指向已不存在的任务，下次键盘事件会撞空。
   *
   * M7: 0 项时自动退出 —— 已选 N 条全部移走后，浮栏会悬在空列表上方。
   * 之前 visibleTasks=0 在 render() 里会让 batchBtn 隐藏，但 selectionMode 没退，
   * 用户得手动按 X —— 体验断裂。
   */
  _afterBatchComplete() {
    this.selectedTaskIds.clear();
    this.selectionAnchor = null;
    this.selectedTaskId = null;
    this._refreshSelectionVisuals();
    // 关掉可能残留的右键/批量菜单 —— _bindBatchBarEvents 里加了 stopPropagation 后
    // document click handler 不再能关菜单，需要这里显式兜底。
    // 例如：用户先点 move 弹出分类选择菜单，又点了 complete —— 完成时把 move 菜单
    // 一并关掉，避免「任务已切完成，菜单却还挂在那」的状态错位。
    hideContextMenu();
    // 重新算一次 visibleTasks —— 操作后条数可能已变
    const cat = this.store.getSelectedCategory();
    const visibleCount = cat ? this.store.getVisibleTasks(cat).length : 0;
    if (visibleCount === 0) {
      // 0 项自动退出，避免浮栏悬空 + batchBtn 已 hidden 的不一致状态
      this._exitSelectionMode({ clear: true });
      return;
    }
    this._updateBatchBarState();
  }

  /**
   * 「移到分类」批量版 —— 复用右键菜单的 showContextMenu，列全部可写分类。
   * 与 _showTaskContextMenu 的「移到分类…」菜单同款选项，但点选后调 batchMoveTasks。
   *
   * 回收站视图下走不同路径：
   *   - 「移到分类」被 rename 成「恢复到分类…」（见 _updateBatchBarState 的 label 调整）
   *   - 点选目标后调 store.restoreTask 逐条恢复，而非 batchMoveTasks：
   *     batchMoveTasks 不接受 TRASH 作为源（allowTrash:false）；且每条任务的
   *     completed 状态需要按 restoreTask 的硬路由语义处理（completed=true → 已完成，
   *     completed=false → 用户指定的目标）。逐条调用让每条走自己的路径，结果合并到 toast。
   */
  _showBatchMoveMenu() {
    const cat = this.store.getSelectedCategory();
    if (!cat) return;
    const refs = [...this.selectedTaskIds].map(key => {
      const [c, id] = key.split('|');
      return { categoryName: c, taskId: id };
    });
    if (refs.length === 0) return;

    const isTrashView = cat.kind === CategoryKind.TRASH;
    // 候选 = 全部可写分类（排除容器 / 回收站，回收站视图下额外排除已完成任务）。
    //
    // v4+ 修复：不再排除源分类（旧逻辑 `!sources.has(c.name)` 把选中任务所在的
    // 全部分类都从候选里去掉）。智能列表视图（全部任务 / 当前任务 / 重要任务）下
    // 选中的任务往往来自多个子分类，旧逻辑会把它们全部排除 → 候选列表为空或
    // 只剩「已完成任务」，用户看到「没有可用的目标分类」或找不到刚新建的分类。
    // 与右键单条「移到分类…」保持一致：只排除当前任务自身所在的那一个分类
    // （batchMoveTasks 内部对 source==target 的任务会做 splice+push，等效于
    // 重新定位到目标分类的末尾/开头，不会丢数据，且多条任务跨分类批量移动时
    // 目标分类本身可能就是某些任务的源 —— 这是合理的「聚合」操作）。
    // 回收站视图下额外排除 COMPLETED：
    //   - store.restoreTask 对 completed 任务的硬路由会让 COMPLETED 永远是它们的归宿
    //   - 用户切完成态走「完成」按钮更直接（也会触发同样的硬路由）
    //   - 与 buildTrashContextMenuItems（task-context-menu.js:116）的 excludeCompleted 策略对齐
    const targets = this.store.categories.filter(c =>
      c.kind !== CategoryKind.OTHER_TASKS &&
      c.kind !== CategoryKind.TRASH &&
      !(isTrashView && c.kind === CategoryKind.COMPLETED)
    );

    if (targets.length === 0) {
      toast('没有可用的目标分类', 'info', 1500);
      return;
    }

    // header 文案区分：回收站下用「恢复」，普通视图保持「移动」
    const headerLabel = isTrashView
      ? `恢复 ${refs.length} 项到…`
      : `移动 ${refs.length} 项到…`;
    // 用一个简单的 prompt 弹窗做分类选择（不阻塞、放在右下角）
    // 复用 showContextMenu —— 它本来就是弹层，list + 回调的形式刚好对齐
    const items = [
      { label: headerLabel, action: 'header', disabled: true },
      ...targets.map(c => ({ label: c.name, action: `batch-move:${c.name}` }))
    ];

    // 弹层定位：浮在 batchBar 正上方，理想情况下右侧对齐浮栏右沿。
    // 给一个"靠近 batchBar 右沿"的初始 x 即可；showContextMenu 内部会
    // 临时 visibility:hidden 测量真实菜单宽高，再按真实尺寸 clamp 到视口内，
    // 所以这里不需要手算 approxMenuWidth（旧版硬编码 280，但 CSS max-width=340、
    // 长分类名时实际更宽，会被右边切）。
    const bar = this.batchBarEl;
    const barRect = bar?.getBoundingClientRect();
    // 初始 x 偏向 batchBar 右沿，让短分类名时菜单自然右对齐；
    // 真实宽高由 showContextMenu 测量后 clamp，超宽时往左让、右对齐让步。
    const x = barRect ? Math.max(8, barRect.right - 320) : window.innerWidth - 320;
    const y = barRect ? Math.max(8, barRect.top - 8) : window.innerHeight - 100;

    showContextMenu(x, y, items, (action) => {
      if (action.startsWith('batch-move:')) {
        const targetName = action.slice(11);
        if (isTrashView) {
          // 回收站：逐条走 restoreTask —— 每条按自身 completed 状态决定归宿，
          // 不能用 batchMoveTasks（拒绝 TRASH 源）。
          this._batchRestoreFromTrash(refs, targetName);
        } else {
          const result = this.store.batchMoveTasks(refs, targetName);
          if (result.moved > 0) {
            toast(`已移到「${targetName}」${result.moved} 项`, 'success', 1500);
            this._afterBatchComplete();
          } else {
            toast('移动失败（可能目标分类不存在）', 'error', 1500);
          }
        }
      }
    });
  }

  /**
   * 批量从回收站恢复 —— 复用 store.restoreTask 的逐条语义：
   *   - completed=true：无视用户选的目标，硬路由到「已完成任务」分类
   *   - completed=false：落到用户选的目标分类（store 还会再做合法性校验）
   *
   * 每条 restoreTask 各自发 markDirty + emit change；不能像 batchDeleteTasks 那样
   * 一次性 emit —— 因为每条可能去不同分类，硬合并不了。这与 _showTaskContextMenu 里
   * 单条恢复的语义完全对称（用户场景：多选 N 条垃圾 → 一键扔回工作）。
   *
   * 改投反馈：completed=true 的任务被硬路由到「已完成任务」，与用户选的目标不一致；
   * 通过 restoreHint.targetName 与用户选的目标名比对，统计改投数量并加到 toast。
   */
  _batchRestoreFromTrash(refs, targetName) {
    let restored = 0;
    let redirectedToCompleted = 0;
    for (const r of refs) {
      const result = this.store.restoreTask(r.taskId, targetName);
      if (result && result.ok && result.restored) {
        restored++;
        // restoreHint.targetName = 实际生效的目标分类名；completed 任务会被 store
        // 改投到「已完成任务」，与用户选的 targetName 不一致时计入改投数
        const actualTarget = result.restoreHint && result.restoreHint.targetName;
        if (actualTarget && actualTarget !== targetName) {
          redirectedToCompleted++;
        }
      }
    }
    if (restored > 0) {
      let msg = `已恢复 ${restored} 项到「${targetName}」`;
      if (redirectedToCompleted > 0) {
        // 「已完成任务」是 store 的硬路由终点（task-store.js:1481），用户没主动选这里，
        // 必须明确告诉他有 N 条被改投了，否则用户可能以为任务没动 / 没找到
        msg += `（${redirectedToCompleted} 项已完成任务已自动归位到「已完成任务」）`;
      }
      toast(msg, 'success', 2500);
      this._afterBatchComplete();
    } else {
      // 全部失败通常意味着分类被外部删了（用户在菜单停留期间云同步删了目标）
      toast('没有任务被恢复（目标分类可能已不存在）', 'error', 1500);
    }
  }

  /**
   * v3.5.2+：从回收站恢复任务 —— 默认走 store 的解析（按 originalCategory 归位；丢失则弹 picker）。
   *
   * 与 v3.5.1 前的行为对比：
   *   - v3.5.1：弹「恢复到…[所有分类]」菜单让用户选
   *   - v3.5.2：先调 store.restoreTask(taskId) 让 store 用原分类解析
   *       - 命中 category → 直接恢复（满足用户「默认回原来的地方」诉求）
   *       - 命中 picker    → 不动任务，弹本方法的 picker
   *       - 命中 fallback  → 落到「未分类」（兜底）
   *
   * 入口：左侧的「恢复」图标（task-item 里的 task-action-restore 按钮）、
   * 键盘 Enter（在回收站里选中一条任务）。两个入口都走"按记录自动归位"的语义。
   * 想手动选分类的入口走右击菜单（_showTaskContextMenu），那里仍保留全分类列表。
   *
   * @param {string} taskId
   * @param {number} [x] 触发点视口 X —— 鼠标点击恢复按钮的位置；省略则屏幕居中（键盘入口的兜底）
   * @param {number} [y] 触发点视口 Y
   */
  async restoreTaskFromTrash(taskId, x, y) {
    const trashCat = this.store.getTrashCategory();
    if (!trashCat) return;
    const task = trashCat.tasks.find(t => t.id === taskId);
    if (!task) return;

    // 默认走 store 的解析。completed=true 的任务会被 store 强制路由到「已完成任务」，
    // 不进 picker；completed=false 的任务若 originalCategory 丢了则进 picker。
    const result = this.store.restoreTask(taskId);

    if (result && result.restoreHint && result.restoreHint.kind === 'picker') {
      // 原分类丢失（被删 / 改名） —— 让用户决定新家
      this.pickRestoreTargetForTrashTask(taskId, result.restoreHint.missing, x, y);
      return;
    }

    // 已就位（category / fallback） —— 提示用户。
    // store 自己管 originalCategory 与数据归属，UI 只负责展示结果。
    if (result && result.ok) {
      const targetName = result.restoreHint && result.restoreHint.targetName;
      toast(targetName ? `已恢复到「${targetName}」` : '已恢复', 'success');
    }
  }

  /**
   * v3.5.2+：从回收站恢复时，原分类不在了 → 让用户选新分类。
   *
   * 触发链路：restoreTask → _resolveRestoreTarget → restoreHint.kind === 'picker' → 本方法。
   * 与 pickRestoreTargetForCompletedTask 同款 UI 形态，差别仅在目标 store API：
   *   - completed 数据来源：store.restoreCompletedTask
   *   - trash    数据来源：store.restoreTask（前者 picker 只看非 completed 任务，
   *     本 picker 同理 —— completed=true 的任务在 store 侧被强制路由到
   *     kind=COMPLETED，不会触发本 picker）
   *
   * @param {string} taskId
   * @param {string} missing - 任务上记的"原分类"名（用于菜单顶部提示："原分类「xxx」已不存在"）
   * @param {number} [x]
   * @param {number} [y]
   */
  pickRestoreTargetForTrashTask(taskId, missing, x, y) {
    // 目标过滤：NORMAL 子分类。COMPLETED 不进 picker —— 回收站里的 completed 任务
    // 已经被 store 路由到「已完成任务」不会触发本方法。
    const targets = this._restoreTargetCandidates(/* excludeCompleted */ true);
    this._showRestorePicker(taskId, missing, x, y, {
      targets,
      onPicked: (name) => {
        // 用户从 picker 选了具体的名字 —— 走 store 的显式 toCategoryName 路径，
        // 与 _resolveRestoreTarget 之后调 restoreCompletedTask 完全对称：
        // store 接到显式名字就直接落位，不再解析 originalCategory。
        this.store.restoreTask(taskId, name);
        toast(`已恢复到「${name}」`, 'success');
      },
      // 0 个候选：理论上 _ensureBaseStructure 建好之后至少有一个 NORMAL 子分类
      // （包括「未分类」兜底），但极端外部编辑 / 极端保留名漂移可能让列表为空。
      // 与 pickRestoreTargetForCompletedTask 同款 noTargetsFallback —— 直接走 store
      // 的 null 路径，让 _resolveRestoreTarget 用 fallback 落到「未分类」，避免
      // _showRestorePicker 在空 targets 上 no-op 后用户看不到反馈。
      noTargetsFallback: () => {
        this.store.restoreTask(taskId, null);
        toast('已恢复到「未分类」', 'success');
      }
    });
  }

  /**
   * v3.5+：取消勾选已完成任务时，若原分类已被删除 / 改名，弹分类选择器。
   *
   * 触发链路：toggleTask → _resolveRestoreTarget → restoreHint.kind === 'picker' → 本方法。
   * 复用了从回收站恢复的 showContextMenu 流程（同样的菜单形态、相近的确认弹层）。
   * 区别：本方法调 store.restoreCompletedTask（不是 restoreTask）—— 数据来源是「已完成任务」
   * 而不是「回收站」。
   *
   * @param {string} taskId
   * @param {string} missing - 任务上记的"原分类"名（用于菜单顶部提示："原分类「xxx」已不存在"）
   * @param {number} [x] - 触发点 X；省略则屏幕居中（键盘入口的兜底）
   * @param {number} [y] - 触发点 Y
   */
  pickRestoreTargetForCompletedTask(taskId, missing, x, y) {
    const targets = this._restoreTargetCandidates(true);
    this._showRestorePicker(taskId, missing, x, y, {
      targets,
      onPicked: (name) => {
        this.store.restoreCompletedTask(taskId, name);
        toast(`已恢复到「${name}」`, 'success');
      },
      // 一个都没有 → 不太可能（至少有「未分类」兜底），但防御性：直接走 store 的 fallback
      noTargetsFallback: () => {
        this.store.restoreCompletedTask(taskId, null);
        toast('已恢复到「未分类」', 'success');
      }
    });
  }

  /**
   * v3.5.2+：恢复 picker 的目标分类集合 —— 所有 NORMAL（parentOtherTasks=true）
   * 子分类。COMPLETED 不算恢复目标（completed 任务在 store 侧被强制路由；
   * 普通子分类任务即便用户希望自己去「已完成任务」也应走菜单里显式选项），
   * OTHER_TASKS / TRASH 是容器 / 回收站自身，也不能作为恢复目标。
   *
   * @param {boolean} [excludeCompleted] 默认 true（已完成 picker 与回收站 picker 都排除）
   * @returns {Array}
   */
  _restoreTargetCandidates(excludeCompleted = true) {
    return this.store.categories.filter(c => {
      if (c.kind === CategoryKind.OTHER_TASKS) return false;
      if (c.kind === CategoryKind.TRASH) return false;
      if (excludeCompleted && c.kind === CategoryKind.COMPLETED) return false;
      return true;
    });
  }

  /**
   * v3.5.2+：picker 公共渲染层 —— 包装 showContextMenu、提供「无候选 → fallback、
   * 1 个候选 → 直接确认、多候选 → 弹菜单」三档行为，被
   * pickRestoreTargetForCompletedTask / pickRestoreTargetForTrashTask 共用。
   *
   * @param {string} taskId - 透传给 onPicked
   * @param {string|undefined} missing - 顶部 hint（"原分类「xxx」不存在"）
   * @param {number|undefined} x
   * @param {number|undefined} y
   * @param {object} options
   * @param {Array} options.targets - 已过滤好的可选分类
   * @param {(name: string) => any} options.onPicked - 用户选定后的回调
   * @param {() => any} [options.noTargetsFallback] - 0 个候选时的兜底回调
   * @param {string} [options.header] - 自定义顶部文案，默认 "原分类「xxx」不存在，选择新分类："
   */
  _showRestorePicker(taskId, missing, x, y, { targets, onPicked, noTargetsFallback, header }) {
    if (targets.length === 0) {
      if (noTargetsFallback) noTargetsFallback();
      return;
    }

    if (targets.length === 1) {
      const only = targets[0];
      onPicked(only.name);
      return;
    }

    const safeMissing = (missing || '').slice(0, 30);
    const headerText = header || (safeMissing
      ? `原分类「${safeMissing}」不存在，选择新分类：`
      : '选择目标分类：');

    const items = targets.map(c => ({
      label: c.name,
      action: `restore:${c.name}`
    }));

    showContextMenu(
      x ?? window.innerWidth / 2 - 80,
      y ?? window.innerHeight / 2 - 40,
      [
        { label: headerText, action: 'header', disabled: true },
        ...items
      ],
      (action) => {
        if (action.startsWith('restore:')) {
          const targetName = action.slice(8);
          onPicked(targetName);
        }
      }
    );
  }

  _showTaskContextMenu(x, y, taskId) {
    const cat = this.store.getSelectedCategory();
    if (!cat) return;
    const task = cat.tasks.find(t => t.id === taskId);
    if (!task) return;

    // 回收站内：除了恢复相关选项外，也提供 ⭐ / ▶ 标记（v3.6+ 让回收站里能改任务级状态）。
    if (cat.kind === CategoryKind.TRASH) {
      // v3.5.2+：候选目标 = NORMAL 子分类。与 trash picker 同款过滤 —— COMPLETED 不进菜单，
      // 因为把 completed=false 的任务显式路由到「已完成任务」分类会破坏"已完成任务只活在
      // kind=COMPLETED"的不变量；completed=true 的任务由 store 侧硬路由已自动归位，
      // 这里只看到 non-completed 任务。把任务送进「已完成任务」分类的合规路径是勾选。
      const targets = this._restoreTargetCandidates(true);

      // items 构造抽到 ./task-context-menu.js 的 buildTrashContextMenuItems：
      //   - 默认项：completed=true 时 label 为「恢复到「已完成任务」」（store 强制
      //     路由对齐 —— task-store.js:1481），否则跟 originalCategory 走
      //   - 「恢复到分类…」子菜单：completed=true 时隐藏（死按钮防御），否则
      //     候选数 > 1 才显示
      // 共享判定逻辑让 check-trash-context-menu.mjs 能在 Node 里直接验证。
      const items = buildTrashContextMenuItems(task, targets);
      showContextMenu(x, y, items, (action) => {
        if (action === 'restore-default') {
          // 与左下角"恢复"图标走完全一致的逻辑：调 store 让它按 originalCategory 解析。
          // 命中 category → 直接归位；命中 picker → 让用户选；命中 fallback → 落「未分类」。
          const result = this.store.restoreTask(taskId);
          if (result && result.restoreHint && result.restoreHint.kind === 'picker') {
            this.pickRestoreTargetForTrashTask(taskId, result.restoreHint.missing, x, y);
            return;
          }
          if (result && result.ok) {
            const targetName = result.restoreHint && result.restoreHint.targetName;
            toast(targetName ? `已恢复到「${targetName}」` : '已恢复', 'success');
          }
        } else if (action.startsWith('restore:')) {
          const targetName = action.slice(8);
          const result = this.store.restoreTask(taskId, targetName);
          if (result && result.ok) {
            toast(`已恢复到「${targetName}」`, 'success');
          } else {
            // menu 项构造时已过滤掉非 NORMAL 分类，理论不该失败。但 buildTrashContextMenuItems
            // 拿到的是「menu 打开瞬间」的 targets —— 用户在菜单停留期间被外部修改（如云同步
            // 触发的 reload）删掉这个分类，store 此时会返回 { ok: false }。菜单已关闭，
            // 用户没收到任何反馈会以为恢复成功 —— 必须显式 toast 报错，且不假装任务
            // 还在原位（任务仍在 trash 里）。
            toast(`恢复失败：分类「${targetName}」已不存在，请刷新后重试`, 'error', 4000);
          }
        } else if (action === 'toggle') {
          // 回收站允许切勾选 —— restoreTask 之前的"先标完成再恢复"路径
          const result = this.store.toggleTask(cat.name, taskId);
          if (result && result.restoreHint && result.restoreHint.kind === 'picker') {
            this.pickRestoreTargetForCompletedTask(taskId, result.restoreHint.missing, x, y);
          }
        } else if (action === 'edit') {
          const item = this.listEl.querySelector(`[data-id="${taskId}"]`);
          if (item) this.startEdit(item);
        } else if (action === 'current') {
          this.store.updateTaskMeta(cat.name, taskId, { current: !task.current });
        } else if (action === 'important') {
          this.store.updateTaskMeta(cat.name, taskId, { important: !task.important });
        }
      });
      return;
    }

    // items 构造抽到 ./task-context-menu.js，让 task-list 与 check 脚本共享
    // 一份判定逻辑。TRASH 分支在前面 return 了，不会到这里。
    const realCatName = task._fromCategory || cat.name;
    const items = buildStandardContextMenuItems(cat, task, this.store);

    showContextMenu(x, y, items, (action) => {
      if (action === 'toggle') {
        const result = this.store.toggleTask(realCatName, taskId);
        // v3.5+：取消勾选已完成任务时，若原分类丢失（被删除 / 改名），
        // store 返回 'picker' hint → 弹分类选择器让用户决定去向。
        if (result && result.restoreHint && result.restoreHint.kind === 'picker') {
          this.pickRestoreTargetForCompletedTask(taskId, result.restoreHint.missing, x, y);
        }
      } else if (action === 'edit') {
        const item = this.listEl.querySelector(`[data-id="${taskId}"]`);
        if (item) this.startEdit(item);
      } else if (action === 'current') {
        this.store.updateTaskMeta(realCatName, taskId, { current: !task.current });
      } else if (action === 'important') {
        this.store.updateTaskMeta(realCatName, taskId, { important: !task.important });
      } else if (action.startsWith('move:')) {
        const targetName = action.slice(5);
        // moveTask 返回实际生效的目标分类名：极少数路径下（拖动 completed 任务从
        // 回收站到普通分类）会防御性改投「已完成任务」，返回值反映真实去向。
        // 当前调用点是普通分类 → 普通分类，不会触发改投，但保持对称写法便于排查
        const actualTarget = this.store.moveTask(realCatName, taskId, targetName);
        if (actualTarget) {
          toast(`已移到 "${actualTarget}"`, 'success');
        }
      } else if (action === 'delete') {
        this.deleteTaskWithConfirm(taskId);
      }
    });
  }

  /**
   * 过滤菜单（与排序菜单同款交互，避免模式割裂）
   * 选项：全部 / 当前 / 已完成 / 重要
   * 「重要」过滤为新增，作用范围是当前分类（区别于侧边栏跨分类的「重要任务」智能列表）
   *
   * v3.4 后普通分类下隐藏「已完成」选项 —— completed=true 任务只活在 kind=COMPLETED
   * 分类，普通分类下选这个过滤永远空（与该分类下根本没有 completed 任务的语义一致）。
   * 智能列表（「已完成任务」/「全部任务」/「重要任务」/「当前任务」）/ 容器 / 回收站
   * 下仍完整展示四项 —— 智能列表本身已带跨分类聚合，「已完成」对它们有意义。
   *
   * 图标统一用 SVG 而不是 Unicode 字符，确保跨平台基线/宽度一致，
   * 不受字体差异导致文字列错位
   */
  _showFilterMenu() {
    document.getElementById('filter-menu')?.remove();
    const menu = document.createElement('div');
    menu.id = 'filter-menu';
    menu.className = 'more-menu filter-menu';

    // 普通分类下「已完成」没意义 —— 过滤永远空，留着只会诱导用户点了发现空。
    // 智能列表（聚合视图）/ 容器 / 回收站 保留四项完整。
    const cat = this.store.getSelectedCategory();
    const hideCompleted = cat && !cat.isSmartList && cat.kind !== CategoryKind.TRASH;

    menu.innerHTML = `
      <div class="sort-menu-header">过滤方式</div>
      ${Object.entries(FILTER_LABELS).map(([k, label]) => {
        if (hideCompleted && k === Filter.COMPLETED) return '';
        return `
        <button class="more-menu-item ${this.store.filter === k ? 'active' : ''}" data-filter="${k}">
          ${FILTER_ICONS[k]}
          <span>${label}</span>
          ${this.store.filter === k ? '<span class="sort-check">✓</span>' : ''}
        </button>
      `;
      }).join('')}
    `;

    const btn = this.filterBtn;
    const rect = btn.getBoundingClientRect();
    menu.style.top = (rect.bottom + 6) + 'px';
    menu.style.right = (window.innerWidth - rect.right) + 'px';
    document.body.appendChild(menu);

    menu.addEventListener('click', (e) => {
      const item = e.target.closest('.more-menu-item');
      if (!item) return;
      this.store.setFilter(item.dataset.filter);
      menu.remove();
    });
  }

  _showSortMenu() {
    document.getElementById('sort-menu')?.remove();
    const menu = document.createElement('div');
    menu.id = 'sort-menu';
    menu.className = 'more-menu sort-menu';
    // 定位与 z-index 由 .more-menu 类控制（position: fixed; z-index: var(--z-menu)），无需 inline 覆盖

    const labels = {
      [SortBy.MANUAL]: '手动顺序',
      [SortBy.ALPHABET]: '按字母'
    };
    menu.innerHTML = `
      <div class="sort-menu-header">排序方式</div>
      ${Object.entries(labels).map(([k, v]) => `
        <button class="more-menu-item ${this.store.sortBy === k ? 'active' : ''}" data-sort="${k}">
          <span>${v}</span>
          ${this.store.sortBy === k ? '<span class="sort-check">✓</span>' : ''}
        </button>
      `).join('')}
    `;

    const btn = this.sortBtn;
    const rect = btn.getBoundingClientRect();
    menu.style.top = (rect.bottom + 6) + 'px';
    menu.style.right = (window.innerWidth - rect.right) + 'px';
    document.body.appendChild(menu);

    menu.addEventListener('click', (e) => {
      const item = e.target.closest('.more-menu-item');
      if (!item) return;
      this.store.setSortBy(item.dataset.sort);
      menu.remove();
    });
  }

  // ============================================
  //  拖拽排序 / 跨分类转移（Pointer Events 实现）
  // ============================================
  //
  // 为什么不用 HTML5 drag API：
  //   1) 系统级 ghost 跟设计语言脱节；
  //   2) 整行 draggable 会劫持文本选择和复选框点击；
  //   3) 落点指示不灵活（只有 border-color 变化）；
  //   4) 接近边缘的自动滚动受限。
  //
  // 流程：
  //   pointerdown 在整行任意位置（除交互控件外） → 进入「待激活」状态，记录起点
  //   pointermove 越过阈值 → 创建 ghost / indicator，正式激活拖拽
  //   pointermove 移动 → 更新 ghost 位置、定位 indicator、命中目标行 / 侧边栏子分类
  //   pointerup → 计算落点：
  //     · 命中侧边栏子分类 → store.moveTask 转移到目标分类
  //     · 命中当前列表内行 → store.reorderTask 重排
  //   Esc / pointercancel → 取消，清理
  //
  // 起点选择：整行（.task-item）任意位置都可以拖动，但 checkbox / ⭐ / 当前 / 编辑删除按钮
  // 等交互控件保留原有点击语义。取消了之前的 .task-drag-handle —— 整行本身就是拖拽手柄。
  //
  // 智能列表（当前任务 / 重要任务 / 全部任务 / 已完成任务）允许拖拽：
//   - 「当前任务 / 重要任务 / 全部任务」仅用于跨分类转移 —— 它们的 cat.tasks 是
//     enriched 副本（含 _fromCategory），跨 _fromCategory 的副本改底层没意义，
//     所以 _updateDrag 里会跳过 _findDropTarget，仅保留侧边栏命中检测。
//   - 「已完成任务」是例外：enriched 副本里所有任务 _fromCategory 都指向同一个
//     真实分类（kind=COMPLETED），所以 in-list reorder 等价于直接 reorderTask
//     那个分类，落点会持久化到磁盘 `## 已完成任务` 段。
//
// 排序 = 按字母时禁用 in-list 拖拽（reorderTask 会被渲染时排序覆盖），
// 但仍允许拖到侧边栏 —— 分类转移与排序无关，强行禁掉会变成另一种「藏起来的功能」。

  _setupDrag() {
    // 阈值与 sidebar.js 共用 —— 集中常量避免两边漂移
    // 用 Map 而不是单个 _drag， 避免多指 / 多鼠标时上一次的状态被下一次覆盖
    this._drags = new Map(); // pointerId -> drag state
    // M8 修复：用户拖拽过程中触发 confirmDialog / inputDialog 等 modal 时，
    // modal 立刻拦截指针，但 pointerup 仍会派发到 document 级监听器，最终走
    // _finishDrag 重排任务 —— 用户以为在关弹窗，结果任务被偷偷换了位置。
    // 注册一个 hook：modal 打开前主动清掉所有 _drags 状态。destroy 时注销，
    // 避免热重载 / 多实例化场景下的 hook 累加。
    if (this._unregisterModalHook) {
      try { this._unregisterModalHook(); } catch {}
    }
    this._unregisterModalHook = registerBeforeModalShow(() => this._cancelAllDrags());
    // 拖拽激活后松手 → 浏览器仍会派发合成 click/dblclick。
    // 用这个标志位告诉 click/dblclick 处理器「刚拖过，吞掉这次点击」，
    // 否则松手位置若在 .task-text/.task-content 上就会意外触发 startEdit。
    this._dragJustEnded = false;
    // 兜底定时器：拖拽结束时设个 250ms 后强制清掉 _dragJustEnded，避免任何
    // 「pointerdown 没机会重置标志」的特殊路径（Tab 切焦点 / 程序触发 click /
    // 浏览器漏派合成事件等）让标志位永久卡住。
    this._dragJustEndedTimer = null;

    this.listEl.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return; // 仅左键

      // vNEXT 修复：必须**最先**无条件消费 _dragJustEnded ——
      // 上一轮拖拽刚结束时如果用户立刻点 checkbox / ⭐ / ▶ / 编辑 / 删除按钮，
      // pointerdown 会落在这些 wrapper 上被早退，原来的实现让 _dragJustEnded
      // 一直挂着，下一次 click 被静默吞掉（间歇性「按钮没反应」现象）。
      // 提到最顶端之前：不管点什么都先把标志位清掉，下一 click 永远不会踩到。
      this._dragJustEnded = false;
      if (this._dragJustEndedTimer) {
        clearTimeout(this._dragJustEndedTimer);
        this._dragJustEndedTimer = null;
      }

      const item = e.target.closest('.task-item');
      if (!item) return;

      // 选择模式下整行作为「切换选中」的点击区，拖拽手势会让两种交互意图互相打架
      // （半途启动拖拽会丢 anchor、半途切选又会跳 ghost）。直接早退最干净。
      if (this.selectionMode) return;

      // 排除交互控件 —— 这些元素保留原有的点击语义（勾选 / ⭐ / 当前 / 编辑删除按钮），
      // 不能被拖拽手势抢走。其余整行（包括手柄、文字、空白 padding）都可以作为拖拽起点。
      // 注意：.more-menu（filter / sort 弹层）挂在 body 上、不在 task-item 里，这里本来也匹配不上，
      // 故不列入 —— 避免误导未来的维护者。
      if (e.target.closest(
        '.task-checkbox-wrapper, .task-current-btn, .task-star-btn, ' +
        '.task-action-btn, .task-edit-input'
      )) return;

      const cat = this.store.getSelectedCategory();
      if (!cat) return;
      // 不在这里过滤 ALPHABET + 非智能列表：in-list 重排的禁用在 _updateDrag 里按 sortBy 单独判断，
      // 这样仍允许拖到侧边栏做跨分类转移（用户改用字母序后整理分类时仍有转移需求）。
      // 智能列表本就没 in-list 落点（见 _updateDrag），任何 sortBy 都自然支持 sidebar drop。

      // 关键：不调 setPointerCapture。
      // 原因：把指针捕获到 item 会让浏览器把后续的合成 click 也 redirect 到 item，
      // 然后 e.target.closest('.task-text') 从 <li> 往上找不到 .task-text（它不是祖先），
      // 单击正文就不再触发 startEdit —— 一个隐蔽的回归。
      // 改用 document 级 move/up 监听，pointer 飞出元素也能稳定追踪。

      this._drags.set(e.pointerId, {
        pointerId: e.pointerId,
        taskId: item.dataset.id,
        item,
        cat,
        startX: e.clientX,
        startY: e.clientY,
        active: false,
        ghost: null,
        indicator: null,
        dropTarget: null,
        dropAbove: false,
        // 跨分类转移：拖到侧边栏子分类时记录目标（_finishDrag 据此走 moveTask）
        sidebarTarget: null
      });
    });

    // move / up / cancel 都绑到 document —— 不依赖 setPointerCapture，
    // pointer 飞出任务行甚至飞出窗口也能继续追踪松手点。
    // 每个 handler 内部用 _drags.get(e.pointerId) 过滤，没在拖的指针直接 early-return。
    //
    // 性能修复：pointermove 在 120Hz 屏幕上以每秒 120 次派发，每次都跑
    // elementsFromPoint + 多个 getBoundingClientRect + style 写入。
    // rAF 节流：把每次 move 事件缓存到 d.pendingMove，下一次动画帧才真正
    // 跑 _updateDrag；同一帧内多次 move 只处理最后一个，落点指示器不抖。
    // - 没在拖 → 直接 return（不占 rAF 调度）
    // - 拖动激活前也走 rAF（beginDrag 也属于「第一次 move 的工作」）
    // - pointerup 会强制同步跑一次 pending move，避免松手瞬间落点空（已加 _flushPendingDrag）
    const onPointerMove = (e) => {
      const d = this._drags.get(e.pointerId);
      if (!d) return;

      if (!d.active) {
        const dx = e.clientX - d.startX;
        const dy = e.clientY - d.startY;
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        // 第一次激活也走 rAF 路径 —— 在动画帧内同时完成 beginDrag + 第一帧 update
        this._beginDrag(d);
      }

      d.pendingMove = e;
      if (!d.rafScheduled) {
        d.rafScheduled = true;
        requestAnimationFrame(() => {
          d.rafScheduled = false;
          const ev = d.pendingMove;
          d.pendingMove = null;
          // drag 可能已被 pointerup / cancel 提前结束（极短竞态）
          if (!this._drags.get(d.pointerId) || !d.active) return;
          if (ev) this._updateDrag(d, ev);
        });
      }
    };
    document.addEventListener('pointermove', onPointerMove);
    this._docUnbinds.push(() => document.removeEventListener('pointermove', onPointerMove));

    // 兜底：pointerup 触发时强制同步跑一次 pending move，确保 _finishDrag
    // 拿到的 dropTarget / dropAbove 是「用户松手那一瞬」的指针位置，
    // 而不是上一帧动画结束时的位置（120Hz 屏会有 ≤8ms 偏差，对短拖动体感明显）。
    // 见 _flushPendingDrag 的实现。
    this._flushPendingDrag = (d) => {
      if (!d) return;
      if (d.rafScheduled) {
        d.rafScheduled = false;
        // 取消正在排队的 rAF 回调，下次 callback 看到 rafScheduled=false 会直接 return
      }
      const ev = d.pendingMove;
      d.pendingMove = null;
      if (ev && d.active) this._updateDrag(d, ev);
    };

    // pointerup = 用户主动松手 → 提交重排
    const onPointerUp = (e) => {
      const d = this._drags.get(e.pointerId);
      if (!d) return;
      try {
        if (d.active) {
          this._finishDrag(d);
          // 拖拽激活过的松手 → 浏览器随后会派发合成 click，标记一下让 click/dblclick
          // 处理器吞掉这次合成事件，避免在松手处又触发选择变更或意外进编辑。
          this._dragJustEnded = true;
          // 兜底：即使没有 pointerdown 重置（极端路径：Tab 切焦点 / 程序触发 click /
          // 浏览器漏派合成事件等），250ms 后也强制清掉。浏览器合成 click 一般 < 50ms，
          // 250ms 已经是「绝对够用」的上限 —— 既能盖住所有正常路径，又不会让「拖完点别
          // 处」的合法点击被误吞。
          if (this._dragJustEndedTimer) clearTimeout(this._dragJustEndedTimer);
          this._dragJustEndedTimer = setTimeout(() => {
            this._dragJustEnded = false;
            this._dragJustEndedTimer = null;
          }, 250);
        }
      } finally {
        this._teardownDrag(d);
        this._drags.delete(e.pointerId);
      }
    };
    document.addEventListener('pointerup', onPointerUp);
    this._docUnbinds.push(() => document.removeEventListener('pointerup', onPointerUp));

    // pointercancel = 手势被系统中断（触屏手势接管、指针捕获丢失、设备拔出…）
    // 用户并没有「放下」，所以必须丢弃而不是提交 —— 不能和 pointerup 共用处理器
    const onPointerCancel = (e) => {
      const d = this._drags.get(e.pointerId);
      if (!d) return;
      this._teardownDrag(d);
      this._drags.delete(e.pointerId);
    };
    document.addEventListener('pointercancel', onPointerCancel);
    this._docUnbinds.push(() => document.removeEventListener('pointercancel', onPointerCancel));

    // 右键弹出菜单时取消进行中的拖拽，避免拖拽状态与菜单交互冲突
    // 绑到 listEl 而非 document：listEl 与 TaskList 同生死，无需追到 _docUnbinds
    this.listEl.addEventListener('contextmenu', () => {
      for (const d of this._drags.values()) {
        this._teardownDrag(d);
        this._drags.delete(d.pointerId);
      }
    });

    // 窗口失焦 / 系统级中断（Alt+Tab、DevTools 抢焦点、应用挂起…）不会派发
    // pointercancel，留在 _drags 里的状态会一直挂到下一次 Esc。这里兜底清掉，
    // 避免下次「接着拖」时拿到一帧陈旧的 startX/startY。
    // 实际监听器装在 _setupEvents() 里的统一位置（与 SortBy/MANUAL 等切换同处一个 hook），
    // 这里只是文档说明；不要在此重复绑定，否则 _cancelAllDrags 会被调用两次。
  }

  /**
   * Esc 取消当前所有进行中的拖拽（仅在已激活时清理 ghost / indicator）。
   * 由 _setupEvents 里统一的 keydown 监听器调用 —— 避免在 _setupDrag 里
   * 单独再开一个 document.keydown，让每次 Esc 走两遍同样的拦截链。
   */
  _cancelAllDragsViaEscape() {
    if (!this._drags) return;
    for (const d of this._drags.values()) {
      this._teardownDrag(d);
    }
    this._drags.clear();
  }

  /**
   * 切换分类 / 搜索 / 排序等导致列表重渲染时调用 —— 强制丢弃所有进行中的拖拽。
   * 因为渲染后旧 DOM 节点（item / ghost 父级）会被替换，留着拖拽状态只会留下游离的 ghost / indicator。
   */
  _cancelAllDrags() {
    if (!this._drags) return;
    for (const d of this._drags.values()) {
      this._teardownDrag(d);
    }
    this._drags.clear();
  }

  _beginDrag(d) {
    d.active = true;

    // 创建 ghost：克隆源任务项，定位 fixed，pointer-events:none 让 elementsFromPoint 透过它
    const rect = d.item.getBoundingClientRect();
    const ghost = d.item.cloneNode(true);
    ghost.classList.add('drag-ghost');
    ghost.style.width = rect.width + 'px';
    ghost.style.left = '0px';
    ghost.style.top = '0px';
    document.body.appendChild(ghost);
    d.ghost = ghost;
    d.ghostOffsetX = d.startX - rect.left;
    d.ghostOffsetY = d.startY - rect.top;

    // 创建落点指示线
    const indicator = document.createElement('div');
    indicator.className = 'drag-indicator';
    indicator.style.display = 'none';
    document.body.appendChild(indicator);
    d.indicator = indicator;

    // 源项降透明，作为「正在被拖」的视觉信号
    d.item.classList.add('drag-source');
  }

  _updateDrag(d, e) {
    // 1) ghost 跟随光标
    if (d.ghost) {
      d.ghost.style.transform = `translate(${e.clientX - d.ghostOffsetX}px, ${e.clientY - d.ghostOffsetY}px)`;
    }

    // 2) 跨分类转移：先看指针是否落在侧边栏子分类上 —— 优先级最高，
    //    命中后直接清空 in-list 落点，避免一个 ghost 同时拖出两条指示。
    const sidebarItem = this._findSidebarDropTarget(e.clientX, e.clientY);
    if (sidebarItem) {
      if (d.indicator) d.indicator.style.display = 'none';
      d.dropTarget = null;
      d.dropAbove = false;
      this._setSidebarDropHighlight(d, sidebarItem);
    } else {
      this._clearSidebarDropHighlight(d);

      // 3) in-list 落点行；命中后定位 indicator + 记录 dropTarget / dropAbove
      //    仅在「(非智能列表 或 已完成任务视图) 且 非字母序」下做：
      //    - 其他智能列表（当前/重要/全部任务）的 cat.tasks 是 enriched 副本，
      //      跨 _fromCategory 的副本改底层没意义
      //    - 「已完成任务」是例外豁免：collectSmartListTasks 里 completed 这条
      //      直接从 kind=COMPLETED 分类读，每条 enriched 任务的 _fromCategory
      //      都指向同一个真实分类，所以 in-list reorder 等价于
      //      reorderTask("已完成任务", from, to)，落点会被持久化到底层分类、
      //      再写到磁盘 `## 已完成任务` 段。其他智能列表做不到这一点。
      //    - 字母序下即使重排了也会被下次渲染覆盖，等于无效操作
      //    sidebar drop 在所有 (cat, sortBy) 组合下都允许 —— 见 pointerdown 注释
      let targetItem = null;
      const allowInListReorder =
        (!d.cat.isSmartList || d.cat.smartKey === 'completed') &&
        this.store.sortBy !== SortBy.ALPHABET;
      if (allowInListReorder) {
        targetItem = this._findDropTarget(d, e.clientX, e.clientY);
        // 兜底：自动滚动把最后一行往上推，cursor 可能停在所有行下方的空白处。
        // 这种情况用户的意图显然是「追加到末尾」，不能就此放弃显示 indicator。
        if (!targetItem) {
          const items = Array.from(this.listEl.querySelectorAll('.task-item'))
            .filter(el => el !== d.item);
          const last = items[items.length - 1];
          if (last) {
            const lastRect = last.getBoundingClientRect();
            // 判定区域：cursor 越过最后一行下沿（允许 6px 容差）就算追加
            if (e.clientY >= lastRect.bottom - 6) {
              targetItem = last;
            }
          }
        }
      }
      if (!targetItem) {
        d.indicator.style.display = 'none';
        d.dropTarget = null;
      } else {
        const rect = targetItem.getBoundingClientRect();
        const above = (e.clientY - rect.top) < rect.height / 2;
        d.indicator.style.display = 'block';
        d.indicator.style.top = (above ? rect.top - 1 : rect.bottom - 1) + 'px';
        d.indicator.style.left = (rect.left + 8) + 'px';
        d.indicator.style.width = (rect.width - 16) + 'px';
        d.dropTarget = targetItem;
        d.dropAbove = above;
      }
    }

    // 4) 接近顶部 / 底部边缘时自动滚动 —— 但只在指针还停在任务列表范围内时。
    // 拖到侧边栏时 cursor 早已离开 listEl，此时再让列表滚动会出现「鬼影」——
    // 列表继续向下走、目标 indicator 留在原位，松开手指落点判错。
    // 用 d.sidebarTarget 是否存在判断侧边栏命中：sidebar 命中时不滚列表。
    if (!d.sidebarTarget) {
      this._autoScroll(e.clientY);
    }
  }

  _findDropTarget(d, x, y) {
    // ghost / indicator 都设了 pointer-events:none，这里只是兜底
    const els = document.elementsFromPoint(x, y);
    for (const el of els) {
      if (el.classList?.contains('drag-ghost')) continue;
      if (el.classList?.contains('drag-indicator')) continue;
      const item = el.closest?.('.task-item');
      if (item && item !== d.item) return item;
    }
    return null;
  }

  _finishDrag(d) {
    // rAF 节流的兜底：松手前先把队列里最后一次 move 同步跑掉，确保 dropTarget / dropAbove
    // 是「用户松手那一瞬」的指针位置，而不是上一帧动画结束时的位置。
    // 120Hz 屏 rAF 间隔 8ms，用户短拖动「松手 → 落点判错」的体感差异主要来自这里。
    this._flushPendingDrag(d);

    // 跨分类转移：拖到侧边栏子分类 → moveTask 到目标分类
    // 必须先于 dropTarget 检查 —— dropTarget 与 sidebarTarget 互斥，
    // _updateDrag 已经保证了不会出现两者都有的情况
    if (d.sidebarTarget) {
      const targetCatName = d.sidebarTarget.dataset.category;
      if (!targetCatName) return;

      // 取任务的真实源分类：
      //   - 普通子分类 / 回收站：cat.name
      //   - 智能列表：cat.tasks[i]._fromCategory
      const visible = this.store.getVisibleTasks(d.cat);
      const sourceTask = visible.find(t => t.id === d.taskId);
      if (!sourceTask) return;
      const sourceCatName = sourceTask._fromCategory || d.cat.name;

      // 同分类无意义（任务已在该分类里），但仍允许用户看到高亮后释放 —— silent no-op
      if (sourceCatName === targetCatName) return;

      // 移动到目标分类 —— 落点由 moveTask 内部按 movePosition 设置处理（toIndex=-1）
      // moveTask 返回实际生效的目标分类名：拖动 completed 任务从回收站到普通分类时
      // 会防御性改投「已完成任务」，返回值才能反映真实去向（toast 文案才不会说谎）
      const actualTarget = this.store.moveTask(sourceCatName, d.taskId, targetCatName);
      if (actualTarget) {
        // 智能列表下原任务已转移，但当前选中仍是智能列表：自动切到目标分类更直观
        if (d.cat.isSmartList) {
          this.store.selectCategory(actualTarget);
        }
        toast(`已移到「${actualTarget}」`, 'success', 1500);
      }
      return;
    }

    if (!d.dropTarget) return;

    const cat = d.cat;
    const visible = this.store.getVisibleTasks(cat);
    if (visible.length === 0) return;

    // 把「屏幕上的任务」映射回「真实分类」：
    //   - 普通子分类 / 回收站：visible 里没有 _fromCategory，落到 cat.name（保持原行为）
    //   - 智能列表：visible 里每条都带 _fromCategory（task-store.js:251），
    //     落到真正的源分类 —— 同分类走 reorderTask，跨分类走 moveTask
    const sourceTask = visible.find(t => t.id === d.taskId);
    const targetTask = visible.find(t => t.id === d.dropTarget.dataset.id);
    if (!sourceTask || !targetTask) return;

    const sourceCatName = sourceTask._fromCategory || cat.name;
    const targetCatName = targetTask._fromCategory || cat.name;

    const sourceCat = this.store.getCategory(sourceCatName);
    const targetCat = this.store.getCategory(targetCatName);
    if (!sourceCat || !targetCat) return;

    const fromIdx = sourceCat.tasks.findIndex(t => t.id === d.taskId);
    if (fromIdx < 0) return;

    // ---- 同分类重排（普通子分类 / 回收站 / 智能列表内的同源拖拽） ----
    // 沿用现有 visible-aware 落点计算：drop 位置在 visible 上算，让隐藏任务不参与位移。
    if (sourceCatName === targetCatName) {
      const targetVisibleIdx = visible.findIndex(t => t.id === targetTask.id);
      const insertVisiblePos = d.dropAbove ? targetVisibleIdx : targetVisibleIdx + 1;

      // reorderTask 的语义是「先 splice(from,1) 再 splice(to,0)」，所以 toIndex 必须是
      // *移除源之后* 的下标。直接在 rest 上算，比事后打 ±1 补偿更难写错。
      const rest = sourceCat.tasks.filter(t => t.id !== d.taskId);

      let toIndex;
      if (insertVisiblePos < visible.length) {
        // 插到某个可见任务之前 → 就是它在 rest 中的下标。
        // 过滤态下若源数组里有被隐藏的任务夹在两个可见项之间，它们会留在落点之前 ——
        // 反正用户在当前视图看不见，任何一种归属渲染出来都一样，这里统一取「紧贴下一个可见项之前」。
        const refId = visible[insertVisiblePos].id;
        toIndex = rest.findIndex(t => t.id === refId);
        if (toIndex < 0) return; // refId 就是被拖的那项（拖到自己身上），无需重排
      } else {
        // 落在最后一个可见任务之后。
        //
        // 旧实现直接用 anchorIdx+1（紧贴锚点之后）—— 这在无过滤时是对的，
        // 但过滤/搜索态下，锚点之后可能还有隐藏任务（被过滤掉的）：
        //   cat.tasks = [A, C(hidden), B], filter → visible = [A, B]
        //   把 B 拖到「最后」→ anchor=B, anchorIdx=2, 旧 toIndex=3 → 插入到末尾
        //   结果: [A, C, B] → 可见 [A, B]（看起来一样）但 B 实际跑到了 C 之后
        //   用户清掉过滤后会发现 B 跳了位，与指示线画的位置不符。
        //
        // 修正：在 rest 中扫描，数到第 insertVisiblePos 个可见任务后停止，
        // 让被隐藏任务留在拖入项之后 —— 它们在当前视图里不可见，
        // 但内部顺序与用户看到的落点一致。
        const anchorId = visible[visible.length - 1].id;
        if (anchorId === d.taskId) return; // 已经是最后一个可见项

        const searchQuery = this.store.searchQuery.toLowerCase();
        const filter = this.store.filter;
        const isVisible = (t) => {
          if (filter === Filter.CURRENT && !t.current) return false;
          if (filter === Filter.COMPLETED && !t.completed) return false;
          if (filter === Filter.IMPORTANT && !t.important) return false;
          if (searchQuery && !t.text.toLowerCase().includes(searchQuery)) return false;
          return true;
        };

        let visibleCount = 0;
        toIndex = rest.length; // 兜底：插到末尾
        for (let i = 0; i < rest.length; i++) {
          if (isVisible(rest[i])) {
            if (visibleCount === insertVisiblePos) {
              toIndex = i;
              break;
            }
            visibleCount++;
          }
        }
      }

      // reorderTask 内部会自动把 sortBy 切回 MANUAL，避免下次渲染按字母重排覆盖本次结果
      this.store.reorderTask(sourceCatName, fromIdx, toIndex);
      return;
    }

    // ---- 跨分类移动（智能列表特有） ----
    // 落点语义：插到「target 在它真实分类里的位置」的 dropAbove 一侧。
    // 与同分类重排一致 —— 屏幕上 target 在哪，任务就落在它身边。
    const targetIdx = targetCat.tasks.findIndex(t => t.id === targetTask.id);
    if (targetIdx < 0) return;
    const toIndex = d.dropAbove ? targetIdx : targetIdx + 1;
    this.store.moveTask(sourceCatName, d.taskId, targetCatName, toIndex);
  }

  _teardownDrag(d) {
    // 清理 rAF 节流相关的状态：已经排队的 callback 醒来时发现 d 不在 _drags 里会自己
    // early-return（见 pointermove handler）；手动清字段避免闭包长期持有 event 引用。
    d.pendingMove = null;
    d.rafScheduled = false;
    if (!d.active) {
      // 还没越过 4px 阈值就松手 —— 没创建 ghost/indicator/source class，纯空跑。
      // pointerup 也走这条路径，清掉指针记录即可。
      this._clearSidebarDropHighlight(d);
      return;
    }
    if (d.ghost) d.ghost.remove();
    if (d.indicator) d.indicator.remove();
    if (d.item) {
      // 多指 / 多鼠标场景：另一个 pointer 仍可能在同一行上拖。
      // 它那边的 drag 状态还指着 d.item，并依赖 .drag-source 维持视觉提示，
      // 所以这里只在「没有别的活跃拖拽还在用这个 item」时才移除 class。
      const stillDraggingSameItem = [...this._drags.values()].some(
        other => other !== d && other.item === d.item && other.active
      );
      if (!stillDraggingSameItem) {
        d.item.classList.remove('drag-source');
      }
    }
    // 兜底清理：万一某次没正确移除（异常路径 / 重渲染后旧节点残留）
    this.listEl.querySelectorAll('.task-item.drag-source').forEach(el => el.classList.remove('drag-source'));
    // 清理侧边栏高亮（防 ghost 移除后残留 class）
    this._clearSidebarDropHighlight(d);
    // 把节点引用清空 —— 防止 _finishDrag 触发 render→_cancelAllDrags 之后再
    // 调一次 _teardownDrag(d) 时拿着已脱离 DOM 的旧节点瞎操作（classList.remove
    // 在游离节点上是 no-op，但 ghost/indicator 也可能重 remove，引发报错）。
    d.ghost = null;
    d.indicator = null;
    d.item = null;
  }

  /**
   * 在指针坐标处查找侧边栏子分类项 —— 用于「拖任务 → 侧边栏子分类」的跨分类转移。
   *
   * 只命中 `.category-item.subcategory`：容器（allTasks）/ 智能列表（current/important/completed）/
   * 回收站都不是任务的家 —— 它们要么不存任务、要么不接受 moveTask。
   *
   * elementsFromPoint 会按 z-order 倒序返回，先到先得。ghost / indicator 已设 pointer-events:none，
   * 不出现在结果里 —— 同 _findDropTarget 的兜底逻辑。
   */
  _findSidebarDropTarget(x, y) {
    const els = document.elementsFromPoint(x, y);
    for (const el of els) {
      if (el.classList?.contains('drag-ghost')) continue;
      if (el.classList?.contains('drag-indicator')) continue;
      const item = el.closest?.('.category-item.subcategory');
      if (item) return item;
    }
    return null;
  }

  /**
   * 给侧边栏子分类加 task-drop-target 高亮。复用 d.sidebarTarget 跟踪当前项，
   * 跨多次 pointermove 时只换 class、不留残留。
   */
  _setSidebarDropHighlight(d, item) {
    if (d.sidebarTarget === item) return;
    if (d.sidebarTarget) d.sidebarTarget.classList.remove('task-drop-target');
    item.classList.add('task-drop-target');
    d.sidebarTarget = item;
  }

  /** 清掉当前高亮的侧边栏项。无当前项时调用也安全。 */
  _clearSidebarDropHighlight(d) {
    if (!d.sidebarTarget) return;
    d.sidebarTarget.classList.remove('task-drop-target');
    d.sidebarTarget = null;
  }

  _autoScroll(y) {
    // body 是 overflow:hidden，window 不会滚动；任务列表本身才有滚动条
    const scroller = this.listEl;
    const margin = 50;
    const maxStep = 10;
    const rect = scroller.getBoundingClientRect();
    if (y < rect.top + margin) {
      const step = Math.min(maxStep, Math.round((rect.top + margin - y) / 4));
      scroller.scrollTop -= step;
    } else if (y > rect.bottom - margin) {
      const step = Math.min(maxStep, Math.round((y - (rect.bottom - margin)) / 4));
      scroller.scrollTop += step;
    }
  }
}
