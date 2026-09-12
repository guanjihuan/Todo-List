// 侧边栏组件 - 三层结构（v3 标识驱动）：
//
//   当前任务（智能视图，跨子分类聚合 current=true 的任务；旧 TODAY 分类已下沉为 @当前 标识）
//   重要任务（智能视图，跨子分类聚合 important=true 的任务）
//   全部任务（kind=OTHER_TASKS 容器；点击进入聚合视图，h2 为子分类）
//     ├── 工作（sub-category, parentOtherTasks=true）
//     ├── 学习
//     ├── 生活
//     ├── 未分类（默认兜底）
//     └── 用户自定义子分类
//   已完成任务（智能视图，跨子分类聚合 completed=true 的任务，放最底部）
//   回收站（删除的任务落点；为空时整条隐藏）
//
// 侧边栏顶部 + 按钮：新增子分类
// 子分类的「重命名/删除」入口：hover 显示按钮 + 右键菜单

import { TaskStore, UNCATEGORIZED_NAME } from '../task-store.js';
import {
  TODAY_KEYS,
  OTHER_TASKS_KEYS,
  TRASH_KEYS
} from '../markdown-parser.js';
import { inputDialog, confirmDialog, toast, hideContextMenu, registerBeforeModalShow } from './feedback.js';
import { escapeHtml, escapeAttr } from '../utils/dom.js';
import { DRAG_THRESHOLD } from '../utils/drag.js';
import { isImeComposing } from '../utils/keymap.js';

// 与 store.addSubCategory / renameCategory 同款的保留名集合。放到侧边栏
// validate 里立即提示，避免「Enter 提交后才知道」；store 仍保留兜底防御。
const RESERVED_NAMES = new Set([
  UNCATEGORIZED_NAME,
  ...TODAY_KEYS,
  ...OTHER_TASKS_KEYS,
  ...TRASH_KEYS
]);
function checkReservedName(value) {
  if (!value) return null;
  if (value.includes('|')) return '分类名不能包含 "|" 字符（用于选中键分隔）';
  if (RESERVED_NAMES.has(value) || RESERVED_NAMES.has(value.toLowerCase().trim())) {
    return `"${value}" 是保留名称，请换一个`;
  }
  return null;
}

export class Sidebar {
  constructor(store) {
    this.store = store;
    this.root = document.getElementById('sidebar');
    this.listEl = document.getElementById('category-list');
    this.contextMenu = document.getElementById('category-context-menu');

    // 跟踪所有 store 订阅的取消函数 —— 让 destroy() 能彻底断开 store 引用，
    // 避免热重载 / 单页测试 / 未来多窗口等场景下出现「store 还活着、UI 已经
    // 换掉了」的悬挂渲染。
    this._storeUnsubs = [];
    // M-U1: 跟踪挂在 document / window 上的 listener —— destroy() 一并清理，
    // 避免热重载 / 单测里反复挂同样的 listener 造成点击一次触发多份 handler
    this._docUnbinds = [];

    this._setupEvents();
    // 统一渲染：'change' 在任何状态变更后都会触发（含分类增删改名等操作），
    // 无需对 'categories' 单独监听 —— 避免双重 render()。
    this._storeUnsubs.push(this.store.on('change', () => this.render()));
    this.render();
  }

  /**
   * 释放所有 store 订阅。生产单例生命周期里不会被调用（Sidebar 与窗口同生死），
   * 但保留入口供热重载 / 单元测试按需清理 —— 否则旧的 listener 仍会触发 render，
   * 而 render 内部读 this.listEl 等 DOM 引用，可能撞上已被替换的 DOM。
   */
  destroy() {
    for (const off of this._storeUnsubs) off();
    this._storeUnsubs = [];
    // M-U1: 同步清理挂在 document/window 上的全局 listener
    for (const off of this._docUnbinds) off();
    this._docUnbinds = [];
    // M8：注销「modal 打开前清拖拽」hook
    if (this._unregisterModalHook) {
      try { this._unregisterModalHook(); } catch {}
      this._unregisterModalHook = null;
    }
  }

  /**
   * v4+ 修复：async 方法从同步事件 listener 里 fire-and-forget 调用时，
   * 一旦内部 reject（inputDialog / confirmDialog 内部异常、store 抛错等）
   * 就是 unhandled rejection —— 冒到 window.onerror，用户只看到「点了没反应」。
   *
   * 这里统一收口：所有 onAddSubCategory / onRenameSubCategory / onDeleteSubCategory
   * 的调用都走这个包装，失败时打日志 + toast，让用户知道操作没生效。
   */
  _runAsync(promise, label) {
    if (!promise || typeof promise.catch !== 'function') return;
    promise.catch((e) => {
      console.error(`[sidebar] ${label} 失败:`, e);
      toast(`${label}失败：${e?.message || e}`, 'error', 3000);
    });
  }

  _setupEvents() {
    if (!this.listEl) return;

    // 委托：点击「+ 新建子分类」按钮（动态渲染在子分类列表末尾）
    this.listEl.addEventListener('click', (e) => {
      if (e.target.closest('#btn-add-category')) {
        e.stopPropagation();
        this._runAsync(this.onAddSubCategory(), '新建子分类');
        return;
      }
    });

    // 点击分类 / 智能列表
    this.listEl.addEventListener('click', (e) => {
      // 子分类的操作按钮（重命名/删除）—— 优先响应，避免被父级 click 抢占
      const actionBtn = e.target.closest('.subcategory-action-btn');
      if (actionBtn) {
        e.stopPropagation();
        const name = actionBtn.dataset.name;
        if (!name) return;
        if (actionBtn.dataset.action === 'rename') {
          this._runAsync(this.onRenameSubCategory(name), '重命名');
        } else if (actionBtn.dataset.action === 'delete') {
          this._runAsync(this.onDeleteSubCategory(name), '删除分类');
        }
        return;
      }
      const item = e.target.closest('.category-item');
      if (!item) return;
      const type = item.dataset.type; // 'smart' | 'subcategory' | 'trash'
      if (type === 'smart') {
        const key = item.dataset.smartKey;
        this.store.selectSmartList(key);
      } else if (type === 'subcategory' || type === 'trash') {
        const name = item.dataset.category;
        if (name) this.store.selectCategory(name);
      }
    });

    // 双击重命名（仅子分类可重命名）
    this.listEl.addEventListener('dblclick', (e) => {
      const item = e.target.closest('.category-item');
      if (!item) return;
      if (item.dataset.type !== 'subcategory') return;
      // 「未分类」是任务兜底，名称是魔法标识符 —— 双击也不应进入重命名。
      if (item.dataset.category === UNCATEGORIZED_NAME) return;
      const name = item.dataset.category;
      if (name) this._runAsync(this.onRenameSubCategory(name), '重命名');
    });

    // 右键子分类 → 显示重命名/删除菜单
    this.listEl.addEventListener('contextmenu', (e) => {
      const item = e.target.closest('.category-item');
      if (!item || item.dataset.type !== 'subcategory') return;
      e.preventDefault();
      const name = item.dataset.category;
      if (!name) return;
      this._showCategoryContextMenu(e.clientX, e.clientY, name);
    });

    // 点击分类右键菜单项
    if (this.contextMenu) {
      this.contextMenu.addEventListener('click', (e) => {
        const item = e.target.closest('.context-menu-item');
        if (!item) return;
        const action = item.dataset.action;
        const name = this.contextMenu.dataset.target;
        this.hideContextMenu();
        if (!name) return;
        if (action === 'rename') this._runAsync(this.onRenameSubCategory(name), '重命名');
        else if (action === 'delete') this._runAsync(this.onDeleteSubCategory(name), '删除分类');
      });
    }

    // 点击其它位置关闭右键菜单
    // M-U1: 推入 _docUnbinds 让 destroy() 一并清理
    const onDocClick = (e) => {
      if (this.contextMenu && !this.contextMenu.hidden &&
          !this.contextMenu.contains(e.target)) {
        this.hideContextMenu();
      }
    };
    document.addEventListener('click', onDocClick);
    this._docUnbinds.push(() => document.removeEventListener('click', onDocClick));
    const onDocKeydown = (e) => {
      if (e.key === 'Escape') {
        // IME 守卫：doc 级监听覆盖整个窗口（包括正在 IME 输入的输入框），
        // CJK/JP/KR 用户按 Esc 优先是「取消 IME 组合」，不要在这里拦截。
        if (isImeComposing(e)) return;
        this.hideContextMenu();
        // Esc 取消正在进行的侧边栏拖拽（任意指针）
        if (this._sidebarDrags?.size) {
          for (const d of this._sidebarDrags.values()) {
            this._teardownSidebarDrag(d);
          }
        }
      }
    };
    document.addEventListener('keydown', onDocKeydown);
    this._docUnbinds.push(() => document.removeEventListener('keydown', onDocKeydown));

    // M-U2: 窗口失焦 / 页面切到后台时，主动清掉所有进行中的拖拽状态
    // —— 否则：用户在侧边栏按住开始拖，切到别的窗口（或浏览器失焦），
    // pointerup 在切走期间触发不到，pointer 状态 + .dragging 类永远残留，
    // 回到页面会看到「鼠标按住拖不动 / 类名残留」等怪现象。
    // 注意：复用 M8 新增的 _abortAllSidebarDrags 方法 —— 之前这里有个一模一样的
    // 局部函数，逻辑双份维护容易漂移。注册 modal 打开前 hook 也调它。
    const onBlur = () => this._abortAllSidebarDrags();
    window.addEventListener('blur', onBlur);
    this._docUnbinds.push(() => window.removeEventListener('blur', onBlur));
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') this._abortAllSidebarDrags();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    this._docUnbinds.push(() => document.removeEventListener('visibilitychange', onVisibilityChange));

    // 子分类拖拽排序（Pointer Events 实现，与 task-list.js 保持一致）
    // Today / 智能列表 / 全部任务 容器 / 回收站 不可拖动
    this._setupSidebarDrag();

    // M8 修复：用户在拖拽子分类过程中触发 confirmDialog / inputDialog 等
    // modal 时，主动清掉 _sidebarDrags 状态。否则 pointerup 在 modal 挂载后
    // 派发到 document 级监听器，调 reorderSubCategory，意外把子分类换了位。
    if (this._unregisterModalHook) {
      try { this._unregisterModalHook(); } catch {}
    }
    this._unregisterModalHook = registerBeforeModalShow(() => this._abortAllSidebarDrags());
  }

  _setupSidebarDrag() {
    // 阈值与 task-list.js _setupDrag 共用 —— 集中常量避免两边漂移
    // 按指针位置判断插到目标之前还是之后
    const dropAboveFor = (item, clientY) => {
      const rect = item.getBoundingClientRect();
      return clientY < rect.top + rect.height / 2;
    };

    // 用 Map 而不是单个 this._sidebarDrag：多指 / 多鼠标设备上同时按两下，
    // 第二次 pointerdown 会把第一次的状态覆盖掉，导致第一次的 pointerup
    // 找不到状态、teardown 失败，DOM 上残留 .dragging / .drag-over 类。
    this._sidebarDrags = new Map(); // pointerId -> drag state

    // 监听 categories 变化以中止进行中的拖拽：render() 会把 DOM 整个重建，
    // d.item / d.targetItem 等引用会指向被 detach 的节点。若不显式 teardown，
    // pointerup 提交时拿到的是旧节点的 dataset（仍能读到 category，但视觉上
    // 指示器、ghost 已经没了），给用户「拖完了但没反应」的错觉。
    //
    // v3.7+：只对「categories」事件作废拖拽 —— 拖动只关心子分类顺序。任务层
    // 操作（toggleTask / addTask / 文本编辑等）也 emit 'change'，但跟子分类
    // 列表没关系，之前无条件 cancel 会让用户在拖分类时碰巧别人改了某条任务
    // 就被静默放弃，体验割裂。
    // 不再保留 'change' 兜底：load/save-error 等极端路径如果不发 'categories'
    // 就不会破坏 sidebar DOM（sidebar 本身用 'change' 触发 render 兜底渲染），
    // 但即便用户丢一次拖拽视觉，pointerup 时 stale 引用走 dataset 仍然安全
    // （dataset 不依赖 DOM 节点存活）；所以让拖拽走完比硬 cancel 更友好。
    this._storeUnsubs.push(this.store.on('categories', () => {
      if (!this._sidebarDrags || this._sidebarDrags.size === 0) return;
      for (const d of this._sidebarDrags.values()) {
        // 子分类列表变化（重命名/新建/删除等）一律作废，避免提交到错位数据。
        this._teardownSidebarDrag(d);
      }
    }));

    // pointerdown：记录起点（仅在子分类项上生效）
    this.listEl.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return; // 仅左键
      const item = e.target.closest('.category-item');
      if (!item || item.dataset.type !== 'subcategory') return;
      // 点在操作按钮上（重命名/删除）时不启动拖拽
      if (e.target.closest('.subcategory-action-btn')) return;
      // 「未分类」始终在最下方（兜底语义 + _normalizeOrder 也按这个顺序排）——
      // 禁掉它的拖拽起点，避免用户拖到中间造成看起来"消失"或归属分裂
      // （拖动撤销顺序后其它兜底逻辑又把它拉回底部，结果会很迷惑）。
      if (item.dataset.category === UNCATEGORIZED_NAME) return;

      try { item.setPointerCapture(e.pointerId); } catch {}

      this._sidebarDrags.set(e.pointerId, {
        pointerId: e.pointerId,
        name: item.dataset.category,
        item,
        startX: e.clientX,
        startY: e.clientY,
        active: false,
        indicator: null,
        targetItem: null,
        dropAbove: false
      });
    });

    // pointermove：超过阈值后激活拖拽，持续更新指示器
    this.listEl.addEventListener('pointermove', (e) => {
      const d = this._sidebarDrags?.get(e.pointerId);
      if (!d) return;

      if (!d.active) {
        const dx = e.clientX - d.startX;
        const dy = e.clientY - d.startY;
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        d.active = true;
        d.item.classList.add('dragging');
      }

      // 找到指针下方的子分类项（排除拖动项自身）
      const targetItem = this._findDropTarget(e.clientX, e.clientY, d.item);
      // 清理旧的指示器
      this.listEl.querySelectorAll('.drag-over, .drag-over-below').forEach(el => {
        el.classList.remove('drag-over', 'drag-over-below');
      });

      if (targetItem) {
        d.targetItem = targetItem;
        d.dropAbove = dropAboveFor(targetItem, e.clientY);
        targetItem.classList.add(d.dropAbove ? 'drag-over' : 'drag-over-below');
      } else {
        d.targetItem = null;
      }
    });

    // pointerup：提交重排
    this.listEl.addEventListener('pointerup', (e) => {
      const d = this._sidebarDrags?.get(e.pointerId);
      if (!d) return;
      try {
        if (d.active && d.targetItem) {
          const fromName = d.name;
          const toName = d.targetItem.dataset.category;
          const subs = this.store.getSubCategories();
          const fromIdx = subs.findIndex(c => c.name === fromName);
          const toIdx = subs.findIndex(c => c.name === toName);
          if (fromIdx >= 0 && toIdx >= 0) {
            this.store.reorderSubCategory(fromIdx, toIdx, d.dropAbove);
          }
        }
      } finally {
        this._teardownSidebarDrag(d);
      }
    });

    // pointercancel：丢弃
    this.listEl.addEventListener('pointercancel', (e) => {
      const d = this._sidebarDrags?.get(e.pointerId);
      if (!d) return;
      this._teardownSidebarDrag(d);
    });
  }

  _findDropTarget(clientX, clientY, excludeItem) {
    // 用 document.elementFromPoint 找指针下的元素，向上找 .category-item
    const el = document.elementFromPoint(clientX, clientY);
    if (!el) return null;
    const item = el.closest('.category-item');
    if (!item || item === excludeItem) return null;
    if (item.dataset.type !== 'subcategory') return null;
    // 「未分类」是固定兜底，不能作为插入点（与 pointerdown 处拒绝拖它对称）——
    // 否则拖「副业」越过「未分类」时会显示一个看起来像允许的落点指示器，
    // 最终却没反应，体验不一致。
    if (item.dataset.category === UNCATEGORIZED_NAME) return null;
    return item;
  }

  _teardownSidebarDrag(d) {
    if (!d) return;
    this.listEl.querySelectorAll('.category-item').forEach(el => {
      el.classList.remove('dragging', 'drag-over', 'drag-over-below');
    });
    try { d.item?.releasePointerCapture(d.pointerId); } catch {}
    this._sidebarDrags?.delete(d.pointerId);
  }

  /**
   * 兜底：清掉所有进行中的侧边栏拖拽。
   *
   * 之前 _setupEvents 内部局部声明的 abortAllDrags 只服务于 blur/visibilitychange，
   * M8 修复后这个清理逻辑也要被 modal 打开前 hook 复用 —— 提到类方法上。
   */
  _abortAllSidebarDrags() {
    if (this._sidebarDrags?.size) {
      for (const d of this._sidebarDrags.values()) {
        this._teardownSidebarDrag(d);
      }
    }
  }

  _showCategoryContextMenu(x, y, name) {
    if (!this.contextMenu) return;
    // 关键：先清理 feedback.js 的活动菜单状态，避免上一次任务右键菜单的回调误触发
    hideContextMenu();
    this.contextMenu.dataset.target = name;
    const isUncategorized = name === UNCATEGORIZED_NAME;
    // 动态构建菜单项（之前在 HTML 中静态写，但已与 feedback.js 的 showContextMenu 统一改为动态生成）。
    // 「未分类」连「重命名」也屏蔽（理由见上）—— 把两个动作整体替换成一条说明，避免点击空菜单误触底层通用 handler。
    this.contextMenu.innerHTML = isUncategorized
      ? `
      <div class="context-menu-item context-menu-disabled" aria-disabled="true">「${UNCATEGORIZED_NAME}」是兜底分类，名称不可改</div>
    `
      : `
      <div class="context-menu-item" data-action="rename">重命名</div>
      <div class="context-menu-separator"></div>
      <div class="context-menu-item context-menu-danger" data-action="delete">删除</div>
    `;
    this.contextMenu.hidden = false;
    // 先显示以测量尺寸
    const rect = this.contextMenu.getBoundingClientRect();
    const maxX = window.innerWidth - rect.width - 4;
    const maxY = window.innerHeight - rect.height - 4;
    this.contextMenu.style.left = Math.min(x, maxX) + 'px';
    this.contextMenu.style.top = Math.min(y, maxY) + 'px';
  }

  hideContextMenu() {
    if (this.contextMenu) {
      this.contextMenu.hidden = true;
      delete this.contextMenu.dataset.target;
    }
  }

  render() {
    const selected = this.store.selectedCategoryName;
    const selectedSmart = this.store.selectedSmartList;
    const subs = this.store.getSubCategories();
    const otherTasksContainer = this.store.getOtherTasksContainer();

    // 一次遍历拿到所有智能列表的聚合任务，避免 O(n×m) 渲染
    const smartTasks = this.store.collectSmartListTasks();

    // ============ 智能列表（当前 / 重要 —— 已完成放到最底部单独渲染） ============
    //
    // 顺序按用户使用频率：当前任务（聚焦今日）→ 重要任务（聚焦关键项）。
    // 「全部任务」是容器（在下方单独渲染为父级 + 子分类列表），
    // 「已完成任务」按设计放在分隔线之后单独渲染。
    const smartEntries = TaskStore.SMART_LISTS.filter(
      s => s.key !== 'allTasks' && s.key !== 'completed'
    );
    const smartHtml = smartEntries.map((s) => {
      const view = smartTasks[s.key] || [];
      const isActive = selectedSmart === s.key;
      const icon = this._smartListIcon(s.key);
      // 当前=标了 ▶ 的数量；重要=标了 ⭐ 的数量。直接 view.length 即可。
      const count = view.length;
      return `
        <div class="category-item smart-list ${isActive ? 'active' : ''}"
             data-type="smart"
             data-smart-key="${escapeAttr(s.key)}"
             ${isActive ? 'aria-current="true"' : ''}
             title="${escapeAttr(s.desc)} · 共 ${count} 项">
          <span class="category-icon smart-icon smart-${s.key}">${icon}</span>
          <span class="category-name">${escapeHtml(s.name)}</span>
          ${this._renderCountBadge(count)}
        </div>
      `;
    }).join('');

    // ============ 全部任务容器（在列表区作为父级标题，点击进入聚合视图） ============
    let allTasksHtml = '';
    if (otherTasksContainer) {
      const isActive = selectedSmart === 'allTasks';
      const folderIcon = this._smartListIcon('allTasks');
      // 全部任务 = 全部子分类下的任务总和（已完成任务单独走 COMPLETED 分类，
      // 不会出现在子分类里，所以这里直接用 allTasks smart list 的长度即可）
      const allTasksCount = (smartTasks.allTasks || []).length;
      allTasksHtml = `
        <div class="category-item smart-list ${isActive ? 'active' : ''} category-other-tasks"
             data-type="smart"
             data-smart-key="allTasks"
             ${isActive ? 'aria-current="true"' : ''}
             title="聚合显示所有任务（含全部子分类） · 共 ${allTasksCount} 项">
          <span class="category-icon smart-icon smart-allTasks">${folderIcon}</span>
          <span class="category-name">${escapeHtml(otherTasksContainer.name)}</span>
          ${this._renderCountBadge(allTasksCount)}
        </div>
      `;
    }

    // ============ 已完成任务（智能视图，跨分类聚合 completed=true） ============
    let completedHtml = '';
    const completedIsActive = selectedSmart === 'completed';
    const completedIcon = this._smartListIcon('completed');
    const completedCount = (smartTasks.completed || []).length;
    completedHtml = `
      <div class="category-item smart-list category-completed ${completedIsActive ? 'active' : ''}"
           data-type="smart"
           data-smart-key="completed"
           ${completedIsActive ? 'aria-current="true"' : ''}
           title="所有已勾选的任务 · 共 ${completedCount} 项">
        <span class="category-icon smart-icon smart-completed">${completedIcon}</span>
        <span class="category-name">已完成任务</span>
        ${this._renderCountBadge(completedCount)}
      </div>
    `;

    // ============ 回收站（kind=TRASH，删除的任务落点；为空时隐藏） ============
    let trashHtml = '';
    const trashCat = this.store.getTrashCategory();
    if (trashCat && trashCat.tasks.length > 0) {
      const isActive = !selectedSmart && trashCat.name === selected;
      const trashIcon = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>`;
      trashHtml = `
        <div class="category-item category-trash ${isActive ? 'active' : ''}"
             data-type="trash"
             data-category="${escapeAttr(trashCat.name)}"
             ${isActive ? 'aria-current="true"' : ''}
             title="${escapeAttr(trashCat.name)} · 共 ${trashCat.tasks.length} 项">
          <span class="category-icon">${trashIcon}</span>
          <span class="category-name">${escapeHtml(trashCat.name)}</span>
          ${this._renderCountBadge(trashCat.tasks.length)}
        </div>
      `;
    }

    // ============ 子分类（缩进显示） ============
    const subHtml = subs.map((cat) => {
      const isActive = !selectedSmart && cat.name === selected;
      const folderIcon = `<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>`;
      // 「未分类」是任务兜底，名称是 store/parser/writer 共用的魔法标识符 —— 重命名 + 删除全部屏蔽。
      // 这里把 hover 才出现的两个操作按钮一并隐藏，按钮区彻底不出现在「未分类」行上。
      const isUncategorized = cat.name === UNCATEGORIZED_NAME;
      // 子分类右侧的操作按钮（hover/选中时强调）
      const renameBtnHtml = isUncategorized ? '' : `
        <button class="subcategory-action-btn subcategory-action-rename" data-action="rename" data-name="${escapeAttr(cat.name)}" title="重命名" aria-label="重命名分类">
          <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/></svg>
        </button>`;
      const deleteBtnHtml = isUncategorized ? '' : `
        <button class="subcategory-action-btn subcategory-action-delete" data-action="delete" data-name="${escapeAttr(cat.name)}" title="删除" aria-label="删除分类">
          <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        </button>`;
      const subActionsHtml = isUncategorized ? '' : `
        <div class="subcategory-actions">
          ${renameBtnHtml}
          ${deleteBtnHtml}
        </div>
      `;
      return `
        <div class="category-item subcategory ${isActive ? 'active' : ''}"
             data-type="subcategory"
             data-category="${escapeAttr(cat.name)}"
             ${isActive ? 'aria-current="true"' : ''}
             title="${escapeAttr(cat.name)} · 共 ${cat.tasks.length} 项 · 右键菜单">
          <span class="category-icon">${folderIcon}</span>
          <span class="category-name">${escapeHtml(cat.name)}</span>
          ${this._renderCountBadge(cat.tasks.length)}
          ${subActionsHtml}
        </div>
      `;
    }).join('');

    // 无子分类时显示空提示
    const subListHtml = subs.length > 0
      ? subHtml
      : `<div class="subcategory-empty">暂无子分类</div>`;

    // 「+ 新建子分类」按钮：渲染在子分类列表末尾，
    // 紧跟最后一个子分类，让「这个按钮是给子分类用的」关系更直接。
    const addBtnHtml = `
      <button id="btn-add-category" class="btn-add-subcategory" title="新建子分类 (Ctrl+Shift+N)" aria-label="新建子分类">
        <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M8 2.5v11M2.5 8h11"/>
        </svg>
        <span class="btn-text">新建子分类</span>
      </button>
    `;

    this.listEl.innerHTML = `
      ${smartHtml}
      <div class="sidebar-divider"></div>
      ${allTasksHtml}
      <div class="subcategory-list">
        ${subListHtml}
        ${addBtnHtml}
      </div>
      <div class="sidebar-divider"></div>
      ${completedHtml}
      ${trashHtml}
    `;
  }

  _smartListIcon(key) {
    if (key === 'current') {
      // 播放三角：与 todo.md 的 [▶]（U+25B6）当前标记视觉一致 —— 软件图标 ↔ 文件标记 一一对应
      return `<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><polygon points="7 4 20 12 7 20"/></svg>`;
    }
    if (key === 'important') {
      return `<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"/></svg>`;
    }
    if (key === 'allTasks') {
      return `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>`;
    }
    if (key === 'completed') {
      return `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M8 12.5l3 3L17 9"/></svg>`;
    }
    return '';
  }

  /**
   * 渲染侧边栏条目右侧的数量徽章。
   *
   * - count = 0 时也展示「0」徽章，保持视觉占位一致；想改成"空分类不显示 0"
   *   把 ``return `<span ...>${n}</span>`;`` 改成 ``return n > 0 ? ... : ''`` 即可。
   * - aria-label 让屏幕阅读器在悬停图标时也能听到数量。
   * - 数字用 ``n`` 防 ``undefined / NaN`` 透传成字符串 "undefined"。
   */
  _renderCountBadge(count) {
    const n = Number.isFinite(count) ? count : 0;
    return `<span class="category-count" aria-label="共 ${n} 项">${n}</span>`;
  }

  async onAddSubCategory() {
    const name = await inputDialog({
      title: '新建子分类',
      placeholder: '例如：健身、阅读、副业…',
      confirmText: '创建',
      // 内联校验：保留名 / `|` / 重名全部在按下 Enter 前即时提示。
      // store 仍保留兜底（任何 UI 路径都可能被绕过），但用户不应被它的兜底 toast 触到。
      validate: (value) => {
        const reservedErr = checkReservedName(value);
        if (reservedErr) return reservedErr;
        if (this.store.categories.some(c => c.name === value)) {
          return `已存在分类 "${value}"`;
        }
        return null;
      }
    });
    if (!name) return;

    const cat = this.store.addSubCategory(name);
    if (cat) {
      this.store.selectCategory(name);
      toast(`已创建子分类 "${name}"`, 'success');
    } else if (name.includes('|')) {
      // store 拒绝含 `|` 的名字 —— 选中键 / 批量解析依赖 `|` 分隔，
      // 这里给出针对性反馈比通用「保留名」更清楚。
      toast('分类名不能包含 "|" 字符（用于选中键分隔）', 'error');
    } else {
      // 保留名兜底（validate 已经挡过，落到这里意味着 store 与 sidebar
      // 的保留名集合不一致 —— 保守起见仍提示，不要静默失败）。
      toast(`"${name}" 是保留名称，请换一个`, 'error');
    }
  }

  async onRenameSubCategory(oldName) {
    const cat = this.store.getCategory(oldName);
    if (!cat) return;
    if (!cat.parentOtherTasks) {
      toast('仅子分类可重命名', 'error');
      return;
    }
    // 「未分类」是任务兜底，名称是魔法标识符 —— 即便按钮被隐藏也不可重命名
    // （兜底防线，避免任何代码路径绕过 UI 直接调到这里）
    if (cat.name === UNCATEGORIZED_NAME) {
      toast(`「${UNCATEGORIZED_NAME}」是兜底分类，不可重命名`, 'error');
      return;
    }

    const newName = await inputDialog({
      title: '重命名子分类',
      message: `将 "${oldName}" 重命名为：`,
      defaultValue: oldName,
      // 与 addSubCategory 共享保留名/非法字符校验，让用户按键即可见反馈
      validate: (value) => {
        if (value === oldName) return null; // 未修改不算错
        const reservedErr = checkReservedName(value);
        if (reservedErr) return reservedErr;
        if (this.store.categories.some(c => c.name === value)) {
          return `已存在分类 "${value}"`;
        }
        return null;
      }
    });
    if (!newName || newName === oldName) return;

    if (this.store.categories.some(c => c.name === newName)) {
      toast(`已存在分类 "${newName}"`, 'error');
      return;
    }

    if (this.store.renameCategory(oldName, newName)) {
      toast(`已重命名`, 'success');
    } else if (newName.includes('|') || oldName.includes('|')) {
      // 同 addSubCategory：含 `|` 的旧/新名都被 store 拒绝
      toast('分类名不能包含 "|" 字符（用于选中键分隔）', 'error');
    } else {
      toast(`"${newName}" 是保留名称，请换一个`, 'error');
    }
  }

  async onDeleteSubCategory(name) {
    const cat = this.store.getCategory(name);
    if (!cat) return;
    if (!cat.parentOtherTasks) {
      toast('仅子分类可删除', 'error');
      return;
    }
    // 「未分类」是删除时的任务兜底，删除它会让释放出的任务无处归位 —— 禁止
    if (cat.name === UNCATEGORIZED_NAME) {
      toast(`「${UNCATEGORIZED_NAME}」是兜底分类，不可删除`, 'error');
      return;
    }

    const taskCount = cat.tasks.length;
    const taskLine = taskCount > 0
      ? `其下的 ${taskCount} 项任务将归到「${UNCATEGORIZED_NAME}」中。`
      : '此分类下没有任务。';
    const ok = await confirmDialog({
      title: '删除子分类',
      message: `确定删除子分类 "${name}"？\n${taskLine}`,
      confirmText: '删除',
      cancelText: '取消',
      danger: true
    });
    if (!ok) return;

    if (this.store.deleteCategory(name)) {
      const tail = taskCount > 0 ? `，${taskCount} 项任务已归到「${UNCATEGORIZED_NAME}」` : '';
      toast(`已删除 "${name}"${tail}`, 'success');
    }
  }
}
