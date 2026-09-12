// 右键菜单 items 构造 —— 与 task-list.js 共用的纯函数层。
//
// 动机：test 脚本（check-completed-context-menu.mjs / check-trash-context-menu.mjs）
// 需要验证右键菜单的判定逻辑（已完成任务视图隐藏「移到分类…」/ 回收站里已完成
// 任务的默认恢复项 label 等），但 Node ESM 锁定 module named-export，无法在测试
// 代码里 monkey-patch feedback.js.showContextMenu 来拦截 _showTaskContextMenu 调用。
// 最小可测化路径：把 items 构造抽出来变成纯函数，task-list 与 check 脚本共享一份
// 判定逻辑 —— 既保证测试覆盖的是真实代码，也防止 UI 与 check 脚本后续发散。
//
// 覆盖范围：两分支 —— buildStandardContextMenuItems（普通分类 / 智能视图） +
// buildTrashContextMenuItems（回收站）。回收站分支的 action 回调
// （restore-default / restore:<name> / toggle 等）依旧留在那里 —— 它们依赖
// pickRestoreTargetForCompletedTask / pickRestoreTargetForTrashTask 等私有
// picker 路径，与 items 数组构造（纯判定）解耦更直接。

import { CategoryKind } from '../markdown-parser.js';
import { COMPLETED_NAME, UNCATEGORIZED_NAME } from '../task-store.js';

/**
 * 构造「普通分类」右键菜单的 items 数组。
 *
 * @param {object} cat   - 当前选中的 category 或 smart-list 视图
 * @param {object} task  - 右键选中的任务（cat.tasks 里的某条；智能视图下带 _fromCategory）
 * @param {object} store - TaskStore 实例（用于枚举 otherCategories）
 * @returns {Array<{label?:string, action?:string, separator?:boolean, indent?:boolean, disabled?:boolean}>}
 */
export function buildStandardContextMenuItems(cat, task, store) {
  // 智能列表视图：操作真实分类（_fromCategory），否则 cat.name 是聚合名
  const realCatName = task._fromCategory || cat.name;

  // 「已完成任务」智能视图下不渲染「移到分类…」分组 —— v3.4 数据归属不变量
  // （task-store.js:950）规定 completed=true 任务只能活在 kind=COMPLETED 里，
  // 点了之后 store 会硬路由回「已完成任务」分类，等于死按钮。统一在这里短路掉，
  // 让菜单里看不到这个无效入口，也避免用户点了再收到「已移到 X」但实际没动。
  const isCompletedView = cat.isSmartList && cat.smartKey === 'completed';

  const otherCategories = store.categories
    .filter(c => c.name !== realCatName
      && c.kind !== CategoryKind.OTHER_TASKS
      && c.kind !== CategoryKind.TRASH
      // 防御性过滤：理论上同名「已完成任务」分类只有一个，但保留名分类重名会让
      // _consolidateCompleted 兜底删除副本（parser 层保留名去重），极端情况列表
      // 里能短暂存在多个 kind=COMPLETED —— 不能让它们出现在 move 目标里。
      && c.kind !== CategoryKind.COMPLETED)
    .map(c => ({
      label: c.name,
      action: `move:${c.name}`,
      indent: true
    }));

  // 多个分类时一次性全展开 —— 用滚动而不是 slice。
  // slice(0, 6) 是历史欠账：分类多时（用户可能建十几个）后半段被静默截掉，
  // 用户在右键菜单里根本看不到，找不到 = 「这个功能不存在」。
  // 菜单顶部有 max-height 滚动 + 视口边距防溢出，落点太多时滚动到目标即可。
  const items = [
    { label: task.completed ? '标记为未完成' : '标记为已完成', action: 'toggle' },
    { label: '编辑', action: 'edit' },
    { separator: true },
    { label: task.current ? '取消当前' : '标记为当前', action: 'current' },
    { label: task.important ? '取消星标' : '标记为重要', action: 'important' },
  ];

  // 「移到分类…」分组仅在确实存在其它分类时才显示 —— 没有候选目标时，
  // 整个「移到分类…」section 都不该出现。否则菜单里只剩一个禁用的占位 header，
  // 加上一个孤零零的 separator，比「啥也没有」更让人困惑。
  //
  // 「已完成任务」视图（见上）也不显示：此时所有候选都是死按钮，整组直接消失。
  if (!isCompletedView && otherCategories.length > 0) {
    items.push(
      { separator: true },
      { label: '移到分类…', action: 'move-header', disabled: true },
      ...otherCategories.map(c => ({ label: c.label, action: c.action, indent: true }))
    );
  }

  items.push(
    { separator: true },
    // 不再标 danger：删除是可逆的（任务移到回收站，Markdown 里仍在）
    { label: '移到回收站', action: 'delete' }
  );

  return items;
}

/**
 * 构造「回收站」右键菜单的 items 数组。
 *
 * 与 buildStandardContextMenuItems 对称：把 task-list.js 里 TRASH 分支的
 * items 构造抽出来，方便 check 脚本（check-trash-context-menu.mjs）在 Node
 * 里直接验证判定逻辑，不必起 DOM/feedback.js。
 *
 * 唯一被 filter 过的 targets 是其他 NORMAL 子分类；OTHER_TASKS / TRASH /
 * COMPLETED 都不在菜单里（OTHER_TASKS / TRASH 是容器自身，COMPLETED 已完成
 * 任务的归宿 —— 见下面 isCompletedTask 分支）。
 *
 * @param {object} task  - 当前右键选中的回收站任务（含 completed/originalCategory/current/important）
 * @param {Array}  targets - 候选目标分类（已过滤 OTHER_TASKS / TRASH / COMPLETED）
 * @returns {Array<{label?:string, action?:string, separator?:boolean, indent?:boolean, disabled?:boolean}>}
 */
export function buildTrashContextMenuItems(task, targets) {
  // v3.6.4+：已完成任务（completed=true）的默认恢复项 label 改为「已完成任务」。
  // store.restoreTask 在 completed 时强制路由到「已完成任务」分类
  // （task-store.js:1481），无视 toCategoryName；用 originalCategory 提示会误导用户。
  // task.originalCategory 在这种情况下仍保留 —— 留给将来"取消勾选"按它归位。
  const isCompletedTask = task.completed;
  const defaultTargetName = isCompletedTask
    ? COMPLETED_NAME
    : (task.originalCategory || UNCATEGORIZED_NAME);
  const defaultLabel = `恢复到「${defaultTargetName}」`;

  // 已完成任务的「恢复到分类…」子菜单同样隐藏 —— store.restoreTask 对
  // completed 任务的强制路由（task-store.js:1481）会让所有"restore:*"项
  // 也被短路到「已完成任务」，菜单里看起来能选具体分类，点完还是落到
  // 已完成任务，与 buildStandardContextMenuItems 对「已完成任务」智能视图
  // 隐藏「移到分类…」的处理对称。
  const showRestorePicker = !isCompletedTask && targets.length > 1;

  return [
    { label: defaultLabel, action: 'restore-default' },
    { separator: true },
    { label: task.completed ? '标记为未完成' : '标记为已完成', action: 'toggle' },
    { label: '编辑', action: 'edit' },
    { separator: true },
    { label: task.current ? '取消当前' : '标记为当前', action: 'current' },
    { label: task.important ? '取消星标' : '标记为重要', action: 'important' },
    ...(showRestorePicker ? [
      { separator: true },
      { label: '恢复到分类…', action: 'restore-header', disabled: true },
      ...targets.map(c => ({
        label: c.name,
        action: `restore:${c.name}`,
        indent: true
      }))
    ] : [])
  ];
}
