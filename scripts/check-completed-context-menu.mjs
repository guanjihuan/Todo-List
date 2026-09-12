// 回归测试：「已完成任务」智能视图下右键菜单不出现「移到分类…」分组。
//
// 用户反馈（2026-08-23）：在「已完成任务」分类里右键任务时，「移到分类…」
// 分组没有意义 —— 按 v3.4 数据归属不变量（task-store.js:950）completed=true
// 任务只能活在 kind=COMPLETED 里，选任何一个普通分类都会被 store 硬路由回
// 「已完成任务」分类，等于死按钮。
//
// 测试路径：通过 src/ui/task-context-menu.js 的 buildStandardContextMenuItems
// 直接构造 items 数组（helper 是 pure function，不碰 DOM，所以 Node 里能直接
// 跑；helper 同时被 task-list.js 调，与 UI 共用一份判定逻辑——产品与测试不会发散）。
//
//   [1] 「已完成任务」智能视图下菜单**不含** 'move-header' / 'move:*' 项
//       「标记为未完成」「移到回收站」必须仍在（防过度收紧）
//   [2] 普通子分类（这里用「工作」）下右键**仍含** 'move-header' + 'move:*'，
//       且 move 目标里不混进「已完成任务」/「回收站」/「全部任务」
//
// 用法：node scripts/check-completed-context-menu.mjs

import { installApiStub } from './_lib/api-stub.mjs';
import { check, summary, printSummary } from './_lib/check.mjs';

// 让 TaskStore 不真去写文件（构造 store 时不会触发，但 toggleTask 等会调 window.api）
installApiStub();

const { TaskStore } = await import('../src/task-store.js');
const { buildStandardContextMenuItems } = await import('../src/ui/task-context-menu.js');

// ============================================================
//   构造一个含「已完成任务」的最小 store
// ============================================================
const seedDoc = [
  '# 全部任务', '',
  '## 工作', '',
  '- [ ] 写周报', '',
  '## 未分类', ''
].join('\n');

const store = new TaskStore();
store.loadFromContent(seedDoc, null);
store._autoSave = Object.assign(() => {}, { cancel() {}, flush() {} });

const workTask = store.getCategory('工作').tasks[0];
check('seed 文档工作分类里有任务', !!workTask && workTask.completed === false);

// toggle → 自动搬到 kind=COMPLETED 分类
store.toggleTask('工作', workTask.id);
const completedCat = store.categories.find(c => c.kind === 'completed');
check('toggle 后产生「已完成任务」分类（kind=COMPLETED）',
  !!completedCat && completedCat.tasks.length === 1,
  completedCat ? `${completedCat.tasks.length} 条` : '分类不存在');
const completedTask = completedCat.tasks[0];
check('完成的那条任务在「已完成任务」里', completedTask && completedTask.completed === true);

// 「工作」分类里再加一条未完成任务（用来测普通分类分支）
store.addTask('工作', '已加测试任务');
const workActiveTask = store.getCategory('工作').tasks
  .find(t => !t.completed && t.text === '已加测试任务');
check('「工作」里有一条新的未完成任务', !!workActiveTask);

// ============================================================
//   [1] 「已完成任务」智能视图下右键 → 不应出现「移到分类…」
// ============================================================
console.log('\n[1] 「已完成任务」智能视图下右键不出现「移到分类…」');

store.selectSmartList('completed');
const completedView = store.getSelectedCategory();
check('getSelectedCategory() 是「已完成任务」智能视图',
  completedView.isSmartList === true && completedView.smartKey === 'completed',
  JSON.stringify({ isSmartList: completedView.isSmartList, smartKey: completedView.smartKey }));

const completedMenu = buildStandardContextMenuItems(completedView, completedTask, store);

const hasMoveHeader = completedMenu.some(i => i.action === 'move-header');
const hasMoveTargets = completedMenu.some(i =>
  typeof i.action === 'string' && i.action.startsWith('move:'));
const hasMoveLabel = completedMenu.some(i => i.label === '移到分类…');

check('已完成视图下菜单不含 move-header', hasMoveHeader === false);
check('已完成视图下菜单不含任何 move:* 目标项', hasMoveTargets === false);
check('已完成视图下菜单不含「移到分类…」label', hasMoveLabel === false);

// 但「移到回收站」「标记为未完成」「编辑」「标记为当前/重要」必须仍在
check('已完成视图下保留「移到回收站」',
  completedMenu.some(i => i.action === 'delete'));
check('已完成视图下保留「标记为未完成」',
  completedMenu.some(i => i.action === 'toggle'));
check('已完成视图下保留「编辑」',
  completedMenu.some(i => i.action === 'edit'));
check('已完成视图下保留「标记为当前/取消当前」',
  completedMenu.some(i => i.action === 'current'));
check('已完成视图下保留「标记为重要/取消星标」',
  completedMenu.some(i => i.action === 'important'));

// ============================================================
//   [2] 普通子分类下右键 → 「移到分类…」必须仍在（防过度收紧）
// ============================================================
console.log('\n[2] 普通子分类（工作）下右键「移到分类…」仍然存在');

store.selectCategory('工作');
const workView = store.getSelectedCategory();
check('getSelectedCategory() 切到了「工作」',
  workView.isSmartList !== true && workView.name === '工作');

const normalMenu = buildStandardContextMenuItems(workView, workActiveTask, store);

check('普通分类下菜单含 move-header',
  normalMenu.some(i => i.action === 'move-header'));
const moveActions = normalMenu
  .filter(i => typeof i.action === 'string' && i.action.startsWith('move:'))
  .map(i => i.action);
check('普通分类下菜单含至少一个 move:* 目标项',
  moveActions.length > 0,
  `actions: ${moveActions.join(',') || '(无)'}`);

// move 目标里绝对不能混进保留名分类
check('move 目标里不含「全部任务」（OTHERTASKS 已过滤）',
  !moveActions.includes('move:全部任务'));
check('move 目标里不含「回收站」（TRASH 已过滤）',
  !moveActions.includes('move:回收站'));
check('move 目标里不含「已完成任务」（COMPLETED 已过滤）',
  !moveActions.includes('move:已完成任务'));
check('move 目标里不含「工作」自身（与自身重命名等价，留着会让菜单很怪）',
  !moveActions.includes('move:工作'));

printSummary('check-completed-context-menu');
