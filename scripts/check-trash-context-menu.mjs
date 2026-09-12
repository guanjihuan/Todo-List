// 回收站右键菜单判定逻辑回归 —— 验证：
//   [1] 已完成任务在回收站 → 默认项 = 「恢复到「已完成任务」」（行为对齐）
//   [2] 未完成任务在回收站 + originalCategory='X' → 默认项 = 「恢复到「X」」
//   [3] 未完成任务在回收站 + 无 originalCategory → 默认项 = 「恢复到「未分类」」
//   [4] 已完成任务的「恢复到分类…」子菜单被隐藏（死按钮防御）
//   [5] 未完成任务的「恢复到分类…」子菜单按候选数 > 1 才出现
//   [6] important=true 时 label 是「取消星标」（反向）
//   [7] current=true 时 label 是「取消当前」（反向）
//   [8] restore 目标里不含保留名分类（回收站/已完成任务/全部任务）
//   [边界] 单候选 / 零候选时不显示「恢复到分类…」子菜单
//
// 测试路径：通过 src/ui/task-context-menu.js 的 buildTrashContextMenuItems
// 直接构造 items 数组（helper 是 pure function，不碰 DOM）。helper 同时被
// task-list.js 调，与 UI 共用一份判定逻辑——产品与测试不会发散。
//
// 用法：node scripts/check-trash-context-menu.mjs

import { installApiStub } from './_lib/api-stub.mjs';
import { check, summary, printSummary } from './_lib/check.mjs';
import { CategoryKind } from '../src/markdown-parser.js';

// 让 TaskStore 不真去写文件（构造 store 时不会触发，但 toggleTask 等会调 window.api）
installApiStub();

const { TaskStore } = await import('../src/task-store.js');
const { buildTrashContextMenuItems } = await import('../src/ui/task-context-menu.js');

// ============================================================
//   构造一个最小文档：工作分类里两条任务（其中一条 ⭐▶），未分类占位
// ============================================================
const seedDoc = [
  '# 全部任务', '',
  '## 工作', '',
  '- [ ] 写周报', '',
  '- [ ] 学习项目[⭐][▶]', '',
  '## 未分类', ''
].join('\n');

const store = new TaskStore();
store.loadFromContent(seedDoc, null);
store._autoSave = Object.assign(() => {}, { cancel() {}, flush() {} });

const workCat = store.getCategory('工作');
const workActive = workCat.tasks.find(t => t.text === '写周报');
const workImp = workCat.tasks.find(t => t.text === '学习项目');

// 1) 把 workActive 直接删到回收站 —— 未完成 + originalCategory='工作'
store.deleteTask('工作', workActive.id);
const trash = store.getTrashCategory();
const trashActive = trash.tasks.find(t => t.text === '写周报');

// 2) 把 workImp 勾选完成（completed=true，originalCategory='工作' 保留）→
//    任务自动搬到「已完成任务」分类，再删到回收站
store.toggleTask('工作', workImp.id);
const completedCat = store.categories.find(c => c.kind === 'completed');
const completedTask = completedCat.tasks.find(t => t.text === '学习项目');
store.deleteTask('已完成任务', completedTask.id);
const trashCompleted = trash.tasks.find(t => t.text === '学习项目');

// 候选目标过滤（与 task-list._restoreTargetCandidates(true) 同款语义）
const realTargets = store.categories.filter(c =>
  c.kind !== CategoryKind.OTHER_TASKS &&
  c.kind !== CategoryKind.TRASH &&
  c.kind !== CategoryKind.COMPLETED);

// ============================================================
// [1] 已完成任务在回收站 → 默认项 = 「恢复到「已完成任务」」
// ============================================================
console.log('\n[1] 已完成任务的默认恢复项 label 是「已完成任务」');

const itemsB = buildTrashContextMenuItems(trashCompleted, []);
const firstItem = itemsB[0];
check('已完成任务默认项 label 是「恢复到「已完成任务」」',
  firstItem.label === '恢复到「已完成任务」',
  `actual: ${JSON.stringify(firstItem)}`);
check('已完成任务默认项 action 仍是 restore-default',
  firstItem.action === 'restore-default');
check('已完成任务的 toggle 项 label 是「标记为未完成」',
  itemsB.find(i => i.action === 'toggle').label === '标记为未完成');

// ============================================================
// [2] 未完成任务 + originalCategory='工作' → 默认项 = 「恢复到「工作」」
// ============================================================
console.log('\n[2] 未完成任务的默认恢复项跟 originalCategory 走');

const itemsA = buildTrashContextMenuItems(trashActive, []);
check('未完成任务默认项 label 是「恢复到「工作」」',
  itemsA[0].label === '恢复到「工作」',
  `actual: ${JSON.stringify(itemsA[0])}`);

// ============================================================
// [3] 未完成任务 + 无 originalCategory → 默认项 = 「恢复到「未分类」」
// ============================================================
console.log('\n[3] 无 originalCategory 退到「未分类」');

// 模拟"老格式 / 未登过的任务"场景：构造一个孤儿任务对象，绕过 store 直接喂给 helper
const orphan = { id: 'orphan', text: '老格式任务', completed: false, originalCategory: null };
const itemsC = buildTrashContextMenuItems(orphan, []);
check('无 originalCategory 默认项 label 是「恢复到「未分类」」',
  itemsC[0].label === '恢复到「未分类」',
  `actual: ${JSON.stringify(itemsC[0])}`);

// ============================================================
// [4] 已完成任务 → 「恢复到分类…」子菜单被隐藏（死按钮防御）
// ============================================================
console.log('\n[4] 已完成任务隐藏「恢复到分类…」子菜单');

const itemsD = buildTrashContextMenuItems(trashCompleted, realTargets);
check('已完成任务菜单不含 restore-header',
  !itemsD.some(i => i.action === 'restore-header'));
check('已完成任务菜单不含任何 restore:* 项',
  !itemsD.some(i => typeof i.action === 'string' && i.action.startsWith('restore:')));

// ============================================================
// [5] 未完成任务 + 多候选 → 「恢复到分类…」子菜单出现
// ============================================================
console.log('\n[5] 未完成任务多候选时显示「恢复到分类…」');

const itemsE = buildTrashContextMenuItems(trashActive, realTargets);
check('未完成 + 多候选时显示 restore-header',
  itemsE.some(i => i.action === 'restore-header'));
const restoreActions = itemsE
  .filter(i => typeof i.action === 'string' && i.action.startsWith('restore:'))
  .map(i => i.action);
check('未完成 + 多候选时显示 restore:* 目标项',
  restoreActions.length > 0,
  `actions: ${restoreActions.join(',') || '(无)'}`);
check('restore 目标里不含保留名（回收站/已完成任务/全部任务）',
  itemsE.filter(i => i.action?.startsWith('restore:'))
    .every(i => i.label !== '回收站' && i.label !== '已完成任务' && i.label !== '全部任务'));

// ============================================================
// [6/7] important=true / current=true 时 label 是「取消星标/取消当前」
// ============================================================
console.log('\n[6/7] important/current 反向 label');

check('completed + important=true 时 important label 是「取消星标」',
  itemsD.find(i => i.action === 'important').label === '取消星标');

// v4.1 起 store.toggleTask 勾选时**保留** current 标记（[▶] 与 completed 正交），
// 所以 current=true && completed=true 是正常数据形态。这里仍直接构造任务对象
// 验证 helper 的 label 判定（与 [3] 同款，不依赖 store 路径）。
const completedAndCurrent = {
  id: 'completed-current',
  text: '已勾选且仍标当前',
  completed: true,
  current: true,
  important: false,
  originalCategory: '工作'
};
const itemsCurrent = buildTrashContextMenuItems(completedAndCurrent, []);
check('completed + current=true 时 current label 是「取消当前」',
  itemsCurrent.find(i => i.action === 'current').label === '取消当前',
  `actual: ${JSON.stringify(itemsCurrent.find(i => i.action === 'current'))}`);

// ============================================================
// [边界] 单候选 / 零候选时不显示「恢复到分类…」子菜单
// ============================================================
console.log('\n[边界] 候选数 ≤ 1 不显示子菜单');

const singleTarget = realTargets.slice(0, 1);
const itemsF = buildTrashContextMenuItems(trashActive, singleTarget);
check('未完成 + 单候选时菜单不含 restore-header',
  !itemsF.some(i => i.action === 'restore-header'));

const itemsG = buildTrashContextMenuItems(trashActive, []);
check('未完成 + 零候选时菜单不含 restore-header',
  !itemsG.some(i => i.action === 'restore-header'));

printSummary('check-trash-context-menu');