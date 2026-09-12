// 任务粒度 diff / merge 工具测试
//
// 覆盖 markdown-diff.js 的核心行为：categoriesToMap、diffCategories、applyResolutions、
// defaultResolutions、mergeTaskStates、summarizeDiff。在纯函数层验证 —— 不需要 DOM / Electron。
//
// 关键覆盖场景：
//   1) 仅 A 侧有的任务 → onlyInA
//   2) 仅 B 侧有的任务 → onlyInB
//   3) 两边都有但状态不同 → modified
//   4) 两边完全相同 → unchanged
//   5) 文本被改 → 视为不同任务（key 是 catName::text，text 变 → 新 key）
//   6) 容器 / TODAY 不参与 diff；COMPLETED / TRASH 按 originalCategory 入 key（v4）
//   7) applyResolutions 的每个选项（a/b/both/skip）
//   8) defaultResolutions 智能默认
//   9) summarizeDiff 计数
//  10) v4 H1 修复：移除 idxInCat 后，跨 idx 漂移（用户加任务）不产生重复
//  11) v4 H4 修复：用户勾选（NORMAL → COMPLETED）默认合并保留动作
//  12) v4 H5 修复：用户回收 / 恢复 默认合并保留动作
//  13) v4 H3 修复：current 仅一边 true 时 OR 保留，不丢 [▶] 标记
//
// 用法：node scripts/check-conflict-merge.mjs

import {
  categoriesToMap,
  diffCategories,
  applyResolutions,
  defaultResolutions,
  mergeTaskStates,
  summarizeDiff,
  makeTaskKey,
  tasksStateEqual,
  tasksTextuallyEqual,
} from '../src/utils/markdown-diff.js';
import { check, ok, bad, summary, printSummary } from './_lib/check.mjs';

function truthy(value, name) {
  if (value) ok(name);
  else bad(name, `expected truthy, got ${value}`);
}

// 直接 === 比较两个值（用 JSON.stringify 处理对象 / 数组）
function eq(actual, expected, name) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) ok(name);
  else bad(name, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ── 测试数据 ──
function makeCat(name, kind = 'normal', parentOtherTasks = true, tasks = []) {
  return { name, kind, isSpecial: false, meta: null, parentOtherTasks, tasks };
}

const container = { name: '全部任务', kind: 'other_tasks', isSpecial: true, meta: null, parentOtherTasks: false, tasks: [] };
const trash = { name: '回收站', kind: 'trash', isSpecial: true, meta: null, parentOtherTasks: false, tasks: [] };

const catsA = [
  container,
  makeCat('工作', 'normal', true, [
    { text: 'A1', completed: false, important: true, current: false },
    { text: 'A2', completed: false, important: true, current: false }, // 与 B 文本同但 important 不同
  ]),
  makeCat('学习', 'normal', true, [
    { text: 'shared', completed: false, important: false, current: false },
  ]),
  trash,
];

const catsB = [
  container,
  makeCat('工作', 'normal', true, [
    { text: 'B1', completed: false, important: false, current: false }, // 仅 B 有（idx=0）
    { text: 'A2', completed: false, important: false, current: false }, // 与 A 同 idx=1 但状态不同
  ]),
  makeCat('学习', 'normal', true, [
    { text: 'shared', completed: false, important: false, current: false }, // 与 A 完全相同
  ]),
  trash,
];

// ── 1) makeTaskKey ──
//
// 注：v4 起 key 不含 idxInCat —— 详见 src/utils/markdown-diff.js 的历史注。
// 「同 cat 内位置漂移」用 text 区分（text 变 = 不同任务），idx 不进 key。
console.log('\n[makeTaskKey]');
eq(makeTaskKey('工作', 'A1'), '2:工作::2:A1', '基本键值');
eq(makeTaskKey('工作', 'A1', 2), '2:工作::2:A1', 'idxInCat 参数被忽略（v4 设计：key 不含 idx）');
eq(makeTaskKey('工作', '特殊 | 字符'), '2:工作::7:特殊 | 字符', '特殊字符保留');
eq(makeTaskKey('工作', '  hello  '), '2:工作::5:hello', '文本前后空白被 trim（H6 修复）');

// ── 2) categoriesToMap ──
console.log('\n[categoriesToMap]');
{
  const map = categoriesToMap(catsA);
  truthy(map.has('2:工作::2:A1'), '工作::A1 存在');
  truthy(map.has('2:工作::2:A2'), '工作::A2 存在');
  truthy(map.has('2:学习::6:shared'), '学习::shared 存在');
  truthy(!map.has('4:全部任务::'), '容器不参与');
  truthy(!map.has('3:回收站::'), '回收站不参与');
}

// ── 3) tasksStateEqual ──
console.log('\n[tasksStateEqual]');
truthy(tasksStateEqual(
  { completed: true, important: false, current: false },
  { completed: true, important: false, current: false }
), '同状态 = true');
truthy(!tasksStateEqual(
  { completed: true, important: false, current: false },
  { completed: false, important: false, current: false }
), 'completed 不同 = false');
truthy(!tasksStateEqual(
  { completed: false, important: false, current: false },
  { completed: false, important: true, current: false }
), 'important 不同 = false');

// ── 4) tasksTextuallyEqual ──
console.log('\n[tasksTextuallyEqual]');
truthy(tasksTextuallyEqual({ text: 'hello' }, { text: 'hello' }), '相同文本');
truthy(!tasksTextuallyEqual({ text: 'hello' }, { text: 'world' }), '不同文本');
truthy(tasksTextuallyEqual({ text: '  hello  ' }, { text: 'hello' }), '前后空白 trim 后相等');

// ── 5) diffCategories 核心 ──
console.log('\n[diffCategories]');
const diff = diffCategories(catsA, catsB);

// onlyInA：A 里有 B 里没有的（A1）
eq(diff.onlyInA.length, 1, 'onlyInA 数量 = 1');
eq(diff.onlyInA[0].key, '2:工作::2:A1', 'onlyInA 是 A1');

// onlyInB：B 里有 A 里没有的（B1）
eq(diff.onlyInB.length, 1, 'onlyInB 数量 = 1');
eq(diff.onlyInB[0].key, '2:工作::2:B1', 'onlyInB 是 B1');

// modified：A2 文本相同但状态不同
eq(diff.modified.length, 1, 'modified 数量 = 1');
eq(diff.modified[0].key, '2:工作::2:A2', 'modified 是 A2');
truthy(diff.modified[0].stateOnly, 'A2 是 stateOnly modified');
truthy(!diff.modified[0].stateContainerMove, 'A2 不是 state container move（同 cat 同 kind）');

// unchanged：shared 完全相同
eq(diff.unchanged.length, 1, 'unchanged 数量 = 1');
eq(diff.unchanged[0].key, '2:学习::6:shared', 'unchanged 是 shared');

// ── 6) TODAY 容器不参与 diff ──
console.log('\n[excluded categories]');
{
  const withToday = [
    container,
    makeCat('我的一天', 'today', false, [
      { text: 'todayTask', completed: false, important: false, current: false },
    ]),
  ];
  const m = categoriesToMap(withToday);
  truthy(!m.has('4:我的一天::9:todayTask'), 'TODAY 分类任务不参与 diff');

  // v4 修复：COMPLETED 任务按 originalCategory 入 key —— 没 originalCategory 时
  // 走 __anon_{catIdx}_{taskIdx} 复合 key，避免同 cat 内多条 orphan 任务撞 key 被
  // 静默吞掉（v3.7+ HIGH data-loss vector，见 markdown-diff.js 注释）。旧版用单一
  // '__anon__' 字符串会让第二条同 text 的 orphan 任务被 `if (!map.has(key))` 丢掉。
  const withCompleted = [
    makeCat('已完成任务', 'completed', false, [
      // 有 originalCategory 时按工作入 key —— 与 NORMAL 「工作」同文本 [ ] 任务撞 key
      { text: 'done1', completed: true, important: false, current: false, originalCategory: '工作' },
      // 无 originalCategory 时落 '__anon_<catIdx>_<taskIdx>'（orphan 兜底 + 唯一身份）
      { text: 'orphanDone', completed: true, important: false, current: false },
    ]),
    makeCat('普通', 'normal', true, [
      { text: 'normal1', completed: false, important: false, current: false },
    ]),
  ];
  const m2 = categoriesToMap(withCompleted);
  truthy(m2.has('2:工作::5:done1'), 'COMPLETED 任务按 originalCategory 入 key（v4 修复）');
  // orphanDone 是 COMPLETED cat 的第 2 条任务 → taskIdx=1（在 filtered 数组里
  // catIdx=0，因为只有这条 COMPLETED cat 进第一遍）。key 前缀 '__anon_0_1'。
  truthy(m2.has('10:__anon_0_1::10:orphanDone'), '无 originalCategory 的 COMPLETED 任务走唯一 anon key（v3.7+ 修复 H 数据丢失）');
  truthy(m2.has('2:普通::7:normal1'), '普通分类正常参与 diff');

  // v4 起：completed=true 任务也参与 diff —— 否则用户在内存里勾选的任务，磁盘
  // 侧同文本 [ ] 版本会被当成「onlyInDisk」→ 默认 a → 用户的勾选被静默撤销。
  // 这是 H4 历史 bug 的修复方向：勾选动作必须能在冲突 UI 里被保留（走 both/OR 合并）。
  const withLeaked = [
    makeCat('普通', 'normal', true, [
      { text: 'leaked', completed: true, important: false, current: false },
      { text: 'normal', completed: false, important: false, current: false },
    ]),
  ];
  const m3 = categoriesToMap(withLeaked);
  truthy(m3.has('2:普通::6:leaked'), 'completed=true 任务也参与 diff（v4 保留勾选动作）');
  truthy(m3.has('2:普通::6:normal'), '同 cat 内非完成态任务正常入 key');
}

// ── 7) applyResolutions —— 各种选项 ──
console.log('\n[applyResolutions]');
{
  // 'a' (onlyInA) → 把 A1 加进去
  const merged = applyResolutions(catsA, diff, { '2:工作::2:A1': 'a' });
  const workCat = merged.find(c => c.name === '工作');
  truthy(workCat.tasks.some(t => t.text === 'A1'), 'onlyInA 用 a → A1 进入合并结果');

  // 'b' (onlyInB) → 把 B1 加进去
  const merged2 = applyResolutions(catsA, diff, { '2:工作::2:B1': 'b' });
  const workCat2 = merged2.find(c => c.name === '工作');
  truthy(workCat2.tasks.some(t => t.text === 'B1'), 'onlyInB 用 b → B1 进入合并结果');

  // 'a' (modified) → 用 A 侧的任务状态（important=true）
  const merged3 = applyResolutions(catsA, diff, { '2:工作::2:A2': 'a' });
  const workCat3 = merged3.find(c => c.name === '工作');
  const a2 = workCat3.tasks.find(t => t.text === 'A2');
  truthy(a2.important === true, 'modified 用 a → A 侧状态（important=true）');

  // 'b' (modified) → 用 B 侧的任务状态（important=false）
  const merged4 = applyResolutions(catsA, diff, { '2:工作::2:A2': 'b' });
  const workCat4 = merged4.find(c => c.name === '工作');
  const a2b = workCat4.tasks.find(t => t.text === 'A2');
  truthy(a2b.important === false, 'modified 用 b → B 侧状态（important=false）');

  // 'both' (modified) → OR 合并状态
  // A 侧 important=true，B 侧 important=false → 合完后 important=true
  const merged5 = applyResolutions(catsA, diff, { '2:工作::2:A2': 'both' });
  const workCat5 = merged5.find(c => c.name === '工作');
  const a2both = workCat5.tasks.find(t => t.text === 'A2');
  truthy(a2both.important === true, 'modified 用 both → OR 合并（A=true B=false → true）');

  // 'skip' (onlyInA) → 不写入
  const merged6 = applyResolutions(catsA, diff, { '2:工作::2:A1': 'skip' });
  const workCat6 = merged6.find(c => c.name === '工作');
  const a1InBase = catsA.find(c => c.name === '工作').tasks.find(t => t.text === 'A1');
  const a1InMerged = workCat6.tasks.find(t => t.text === 'A1');
  truthy(a1InMerged === a1InBase, 'onlyInA 用 skip → A1 引用未被额外创建（保留 base 里的同一对象）');
}

// ── 7.5) v4 H1 修复：移除 idxInCat 后，跨 idx 漂移不产生重复 ──
console.log('\n[v4 H1 修复：idx 漂移不重复]');
{
  // 模拟「用户在 B 侧（新内存）于工作分类前端插入了新任务」——
  // 同样两个老任务 idx 在 B 侧都比 A 侧 +1。
  const sideA = [
    container,
    makeCat('工作', 'normal', true, [
      { text: 'T', completed: false, important: false, current: false },
      { text: 'U', completed: false, important: false, current: false },
    ]),
    trash,
  ];
  const sideB = [
    container,
    makeCat('工作', 'normal', true, [
      { text: 'NEW', completed: false, important: false, current: false }, // 新插入
      { text: 'T', completed: false, important: false, current: false },   // idx 漂移
      { text: 'U', completed: false, important: false, current: false },   // idx 漂移
    ]),
    trash,
  ];
  const d = diffCategories(sideA, sideB);
  // T 和 U 应该 unchanged（key 用 cat+text，不受 idx 影响）
  eq(d.unchanged.length, 2, 'idx 漂移后 T 和 U 仍判定为 unchanged');
  eq(d.onlyInA.length, 0, 'idx 漂移不会让 A 侧误报 onlyInA');
  eq(d.onlyInB.length, 1, '仅 NEW 是 onlyInB');
  eq(d.modified.length, 0, 'idx 漂移不会触发 modified');

  // 默认合并后不会出现 T/U 重复
  const merged = applyResolutions(sideA, d, {});
  const workCat = merged.find(c => c.name === '工作');
  const tCount = workCat.tasks.filter(t => t.text === 'T').length;
  const uCount = workCat.tasks.filter(t => t.text === 'U').length;
  truthy(tCount === 1, 'T 只出现一次（无重复）');
  truthy(uCount === 1, 'U 只出现一次（无重复）');
}

// ── 7.6) v4 H4 修复：用户勾选（NORMAL → COMPLETED）默认合并保留动作 ──
console.log('\n[v4 H4 修复：勾选状态默认合并保留]');
{
  const sideA = [
    container,
    makeCat('工作', 'normal', true, [
      { text: 'X', completed: false, important: false, current: false }, // 磁盘 [ ]
    ]),
    trash,
  ];
  // 内存：B 侧已把 X 勾选并迁到 COMPLETED（v3.4 行为）；同时 NORMAL 里还残留旧副本（migrate 过渡期）
  const sideB = [
    container,
    makeCat('工作', 'normal', true, [
      { text: 'X', completed: false, important: false, current: false }, // 残留 NORMAL 副本
    ]),
    { name: '已完成任务', kind: 'completed', isSpecial: true, meta: null, parentOtherTasks: false,
      tasks: [
        { text: 'X', completed: true, important: false, current: false, originalCategory: '工作' },
      ],
    },
    trash,
  ];
  const d = diffCategories(sideA, sideB);
  // 勾选场景：X 在 disk NORMAL 和 memory COMPLETED，按 effective 名匹配 → modified (stateContainerMove)
  truthy(d.modified.length === 1 && d.modified[0].stateContainerMove === true,
    '勾选产生 stateContainerMove modified');
  // 默认 'both' 合并后：X 在 COMPLETED 且 completed=true，工作分类里不再有 X
  const merged = applyResolutions(sideA, d, {});
  const workCat = merged.find(c => c.name === '工作');
  const completedCat = merged.find(c => c.name === '已完成任务');
  truthy(!workCat.tasks.some(t => t.text === 'X'), '工作分类不再有 X（用户已勾选）');
  const xInCompleted = completedCat && completedCat.tasks.find(t => t.text === 'X');
  truthy(xInCompleted && xInCompleted.completed === true,
    'COMPLETED 里有 X 且 completed=true（用户勾选保留）');
}

// ── 7.7) v4 H5 修复：用户回收（NORMAL → TRASH）默认合并保留动作 ──
console.log('\n[v4 H5 修复：回收动作默认合并保留]');
{
  const sideA = [
    container,
    makeCat('工作', 'normal', true, [
      { text: 'Y', completed: false, important: false, current: false },
    ]),
    trash,
  ];
  // 内存：B 侧已把 Y 迁到回收站
  const sideB = [
    container,
    makeCat('工作', 'normal', true, [
      { text: 'Y', completed: false, important: false, current: false }, // 残留 NORMAL 副本
    ]),
    { name: '回收站', kind: 'trash', isSpecial: true, meta: null, parentOtherTasks: false,
      tasks: [
        { text: 'Y', completed: false, important: false, current: false, originalCategory: '工作' },
      ],
    },
  ];
  const d = diffCategories(sideA, sideB);
  truthy(d.modified.length === 1 && d.modified[0].stateContainerMove === true,
    '回收产生 stateContainerMove modified');
  const merged = applyResolutions(sideA, d, {});
  const workCat = merged.find(c => c.name === '工作');
  const trashCat = merged.find(c => c.name === '回收站');
  truthy(!workCat.tasks.some(t => t.text === 'Y'), '工作分类不再有 Y（用户已回收）');
  truthy(trashCat && trashCat.tasks.some(t => t.text === 'Y'),
    '回收站里有 Y（用户回收动作保留）');
}

// ── 7.8) v4 H5 修复：从回收站恢复 ──
console.log('\n[v4 H5 修复：恢复动作默认合并保留]');
{
  // 磁盘有 Z 在 TRASH（originalCategory='工作'），内存里用户把它恢复到工作
  const sideA = [
    container,
    makeCat('工作', 'normal', true, [
      { text: 'Z', completed: false, important: false, current: false }, // 工作分类里也有同名任务（用户已恢复）
    ]),
    { name: '回收站', kind: 'trash', isSpecial: true, meta: null, parentOtherTasks: false,
      tasks: [
        { text: 'Z', completed: false, important: false, current: false, originalCategory: '工作' },
      ],
    },
  ];
  const sideB = [
    container,
    makeCat('工作', 'normal', true, [
      { text: 'Z', completed: false, important: false, current: false },
    ]),
    { name: '回收站', kind: 'trash', isSpecial: true, meta: null, parentOtherTasks: false, tasks: [] },
  ];
  const d = diffCategories(sideA, sideB);
  truthy(d.modified.length === 1 && d.modified[0].stateContainerMove === true,
    '恢复产生 stateContainerMove modified（disk 在 TRASH，memory 在 NORMAL）');
  // 默认 'both' 应把 Z 放到 NORMAL（用户当前位置）
  const merged = applyResolutions(sideA, d, {});
  const workCat = merged.find(c => c.name === '工作');
  const trashCat = merged.find(c => c.name === '回收站');
  const zInWork = workCat.tasks.filter(t => t.text === 'Z').length;
  truthy(zInWork === 1, '工作分类里有且仅有 1 个 Z（恢复后）');
  truthy(!trashCat.tasks.some(t => t.text === 'Z'), '回收站里没有 Z（用户已恢复）');
}

// ── 7.9) v4 修复：stateContainerMove 'a' 必须用 taskA 不应用 mergedTask ──
// 旧实现下，'a' 分支会用 mergeTaskStates(item.taskA, item.taskB) 把 taskB.completed
// 回写成 true，等于「选 'a' = 保留文件版本」却把用户的勾选偷偷带回 —— 违反语义。
console.log('\n[v4 修复：stateContainerMove choice=\'a\' 必须用 taskA 不应用 mergedTask]');
{
  const sideA = [
    container,
    makeCat('工作', 'normal', true, [
      { text: 'Q', completed: false, important: false, current: false }, // 磁盘 [ ]
    ]),
  ];
  const sideB = [
    container,
    { name: '已完成任务', kind: 'completed', isSpecial: true, meta: null, parentOtherTasks: false,
      tasks: [
        { text: 'Q', completed: true, important: false, current: false, originalCategory: '工作' },
      ],
    },
  ];
  const d = diffCategories(sideA, sideB);
  truthy(d.modified.length === 1 && d.modified[0].stateContainerMove === true,
    'Q 在 disk NORMAL / memory COMPLETED → stateContainerMove modified');
  // 用户选 'a' = 「保留磁盘 [ ]」 → 应该撤销勾选，回到工作分类且 completed=false
  const merged = applyResolutions(sideA, d, { [d.modified[0].key]: 'a' });
  const workCat = merged.find(c => c.name === '工作');
  const completedCat = merged.find(c => c.name === '已完成任务');
  const qInWork = workCat.tasks.filter(t => t.text.trim() === 'Q');
  truthy(qInWork.length === 1, '工作分类里有 Q（撤销勾选后）');
  truthy(qInWork[0].completed === false, 'Q 在工作分类里 completed=false（撤销勾选）');
  truthy(!completedCat || !completedCat.tasks.some(t => t.text.trim() === 'Q'),
    'COMPLETED 里没有 Q（撤销勾选后）');
}

// ── 7.10) v4 修复：findOrCreateCat trim 两边 ──
// 旧实现只 trim c.name 不 trim catName。若 item.cat.name 带空白而 out 里的 cat 已 trim，
// 匹配漏过 → 静默创建重复分类。
console.log('\n[v4 修复：findOrCreateCat trim 两边防止重复 cat]');
{
  const sideA = [
    container,
    makeCat('学习', 'normal', true, [
      { text: 'L1', completed: false, important: false, current: false },
    ]),
  ];
  const sideB = [
    container,
    makeCat('学习', 'normal', true, [
      { text: 'L1', completed: false, important: false, current: false },
      { text: 'L2', completed: false, important: false, current: false },
    ]),
  ];
  // 人为把 sideB 的 cat.name 加前后空白（模拟上游 cat.name 没 trim 透传过来）
  sideB[1].name = '  学习  ';
  const d = diffCategories(sideA, sideB);
  // 注入一个 onlyInB：强制走 findOrCreateCat 分支
  const merged = applyResolutions(sideA, d, {});
  const learnCats = merged.filter(c => (c.name || '').trim() === '学习');
  truthy(learnCats.length === 1, '只有一个「学习」分类（无重复 cat 创建）');
  truthy(learnCats[0].name === '学习', '新建 cat 的 name 是 trim 后的版本（不留空白）');
}

// ── 7.11) v4 修复：findIndex 用 trim 后比较（防止 text 前后空白产生重复副本）──
console.log('\n[v4 修复：findIndex 用 trim 后比较，防止 text 空白导致重复副本]');
{
  const sideA = [
    container,
    makeCat('工作', 'normal', true, [
      { text: 'T1', completed: false, important: false, current: false },
    ]),
  ];
  // B 侧同名任务 text 带前导/尾部空格 —— categoriesToMap 用 text.trim() 入 key，
  // 所以会与 A 侧匹配成 modified；旧 findIndex 用 === text 找不到，push 重复副本。
  const sideB = [
    container,
    makeCat('工作', 'normal', true, [
      { text: '  T1  ', completed: false, important: false, current: false },
    ]),
  ];
  const d = diffCategories(sideA, sideB);
  // 用 'a' 让 applyResolutions 走 findIndex 路径
  const merged = applyResolutions(sideA, d, {});
  const workCat = merged.find(c => c.name === '工作');
  const t1Count = workCat.tasks.filter(t => t.text.trim() === 'T1').length;
  truthy(t1Count === 1, '工作分类里有且仅有 1 个 T1（trim 匹配，无重复副本）');
}

// ── 8) defaultResolutions ──
console.log('\n[defaultResolutions]');
{
  const res = defaultResolutions(diff);
  eq(res['2:工作::2:A1'], 'a', 'onlyInA 默认 = a');
  eq(res['2:工作::2:B1'], 'b', 'onlyInB 默认 = b');
  eq(res['2:工作::2:A2'], 'both', 'modified 默认 = both（OR 合并，不自动选边丢标记）');
}

// ── 9) mergeTaskStates ──
console.log('\n[mergeTaskStates]');
{
  const a = { text: 'X', completed: true, important: false, current: false };
  const b = { text: 'X', completed: false, important: true, current: false };
  const merged = mergeTaskStates(a, b);
  truthy(merged.completed === true, 'OR completed');
  truthy(merged.important === true, 'OR important');
  eq(merged.text, 'X', 'text 保留');

  // v4 H3 修复：current 仅一边 true → OR 保留（之前无条件置 false 会丢 [▶] 标记）
  const ca = { text: 'Y', completed: false, important: false, current: true };
  const cb = { text: 'Y', completed: false, important: false, current: false };
  const mergedSingle = mergeTaskStates(ca, cb);
  truthy(mergedSingle.current === true, 'current 单边 true → OR 保留（H3 修复）');

  // current 是单值指针 —— 两边都 true 时强制置 false（M-Diff2 历史兜底）
  const cA = { text: 'Y2', completed: false, important: false, current: true };
  const cB = { text: 'Y2', completed: false, important: false, current: true };
  const mergedC = mergeTaskStates(cA, cB);
  truthy(mergedC.current === false, 'current 两边都 true → 合并后强制 false');

  // 字段白名单：H9 — 不透传 id / _skipReload / createdAt
  const withInternal = {
    text: 'Z', completed: false, important: false, current: false,
    id: 42, _skipReload: true, createdAt: '2024-01-01',
  };
  const mergedFields = mergeTaskStates(withInternal, withInternal);
  truthy(mergedFields.id === undefined, '不泄漏 task.id');
  truthy(mergedFields._skipReload === undefined, '不泄漏 _skipReload');
  truthy(mergedFields.createdAt === undefined, '不泄漏 createdAt');
  truthy('text' in mergedFields, 'text 字段保留');
  truthy('important' in mergedFields, 'important 字段保留');
}

// ── 10) summarizeDiff ──
console.log('\n[summarizeDiff]');
{
  const s = summarizeDiff(diff);
  eq(s.total, 3, 'total = 3');
  eq(s.addedByFile, 1, 'addedByFile = 1');
  eq(s.addedByMine, 1, 'addedByMine = 1');
  eq(s.conflicting, 1, 'conflicting = 1');
}

// ── 总结 ──
console.log('');
if (summary.fail === 0) {
  console.log(`✓ 全部通过`);
  process.exit(0);
} else {
  console.log(`✗ ${summary.fail} 处失败`);
  process.exit(1);
}