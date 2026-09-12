// 回归测试：writer 把 `# 已完成任务` 排到「全部任务」及其 `##` 子分类之后、`# 回收站` 之前
//
// 背景：v3.4 把 `# 已完成任务` 升级为真实分类（kind=COMPLETED），但 parser 按文件顺序
//       累积 categories，外部手工编辑 / 老文件会让它夹在「全部任务」容器和 `##` 子分类之间。
// v3.5 修复：writer 分三遍写出，强制把 `# 已完成任务` 放到期望位置。
//
// 跑法：node scripts/check-completed-order.mjs

import { writeMarkdown } from '../src/markdown-writer.js';
import { check, ok, bad, summary, printSummary } from './_lib/check.mjs';
import { makeStore } from './_lib/store-fixture.mjs';

console.log('\n[1] 故意错序的 categories 数组，writer 强制按期望顺序写出');

// 模拟用户文件里的乱序：COMPLETED 排在 ## 子分类之前（v3.4 老文件 / 外部编辑后的产物）。
// writer 必须按 `全部任务 > ## 子分类 > 已完成任务 > 回收站` 的视觉顺序输出。
const categories = [
  { name: '全部任务', kind: 'other_tasks', parentOtherTasks: false, tasks: [] },
  { name: '已完成任务', kind: 'completed', parentOtherTasks: false, tasks: [
    { text: '买牛奶', completed: true, important: false, current: false }
  ] },
  { name: '工作', kind: 'normal', parentOtherTasks: true, tasks: [
    { text: '写周报', completed: false, important: false, current: false }
  ] },
  { name: '未分类', kind: 'normal', parentOtherTasks: true, tasks: [
    { text: '看牙医', completed: false, important: false, current: false }
  ] },
  { name: '回收站', kind: 'trash', parentOtherTasks: false, tasks: [
    { text: '误删的任务', completed: false, important: false, current: false }
  ] }
];

const md = writeMarkdown(categories);

const idxAllTasks = md.indexOf('# 全部任务');
const idxCompleted = md.indexOf('# 已完成任务');
const idxSubWork = md.indexOf('## 工作');
const idxSubUncat = md.indexOf('## 未分类');
const idxTrash = md.indexOf('# 回收站');

check('# 全部任务 出现在 # 已完成任务 之前',
  idxAllTasks >= 0 && idxCompleted >= 0 && idxAllTasks < idxCompleted,
  `全部任务=${idxAllTasks}, 已完成=${idxCompleted}`);

check('## 工作 子分类 出现在 # 已完成任务 之前',
  idxSubWork >= 0 && idxCompleted >= 0 && idxSubWork < idxCompleted,
  `工作=${idxSubWork}, 已完成=${idxCompleted}`);

check('## 未分类 子分类 出现在 # 已完成任务 之前',
  idxSubUncat >= 0 && idxCompleted >= 0 && idxSubUncat < idxCompleted,
  `未分类=${idxSubUncat}, 已完成=${idxCompleted}`);

check('# 已完成任务 出现在 # 回收站 之前',
  idxCompleted >= 0 && idxTrash >= 0 && idxCompleted < idxTrash,
  `已完成=${idxCompleted}, 回收站=${idxTrash}`);

console.log('\n[2] 子分类相对顺序保留（不被 sort 打乱）');

// 用户手工调整过 ## 子分类顺序：未分类 → 工作 → 学习 → 111
// 即使 writer 重排了 COMPLETED / TRASH 的位置，## 子分类之间的顺序必须原样保留。
const ordered = [
  { name: '全部任务', kind: 'other_tasks', parentOtherTasks: false, tasks: [] },
  { name: '已完成任务', kind: 'completed', parentOtherTasks: false, tasks: [
    { text: '买牛奶', completed: true }
  ] },
  { name: '未分类', kind: 'normal', parentOtherTasks: true, tasks: [] },
  { name: '工作', kind: 'normal', parentOtherTasks: true, tasks: [] },
  { name: '学习', kind: 'normal', parentOtherTasks: true, tasks: [] },
  { name: '111', kind: 'normal', parentOtherTasks: true, tasks: [] },
  { name: '回收站', kind: 'trash', parentOtherTasks: false, tasks: [] }
];
const md2 = writeMarkdown(ordered);
const iUncat = md2.indexOf('## 未分类');
const iWork = md2.indexOf('## 工作');
const iStudy = md2.indexOf('## 学习');
const i111 = md2.indexOf('## 111');
check('## 子分类相对顺序：未分类 < 工作 < 学习 < 111',
  iUncat >= 0 && iWork > iUncat && iStudy > iWork && i111 > iStudy,
  `未分类=${iUncat}, 工作=${iWork}, 学习=${iStudy}, 111=${i111}`);

console.log('\n[3] 空 COMPLETED 分类不写出（与原行为一致）');

// 没有已完成任务时，整个 `# 已完成任务` 段应该消失（避免空标题噪音）。
// 但 `# 全部任务` 和 `## 工作` 仍然存在。
const noCompleted = [
  { name: '全部任务', kind: 'other_tasks', parentOtherTasks: false, tasks: [] },
  { name: '已完成任务', kind: 'completed', parentOtherTasks: false, tasks: [] },
  { name: '工作', kind: 'normal', parentOtherTasks: true, tasks: [
    { text: '写周报', completed: false }
  ] },
  { name: '回收站', kind: 'trash', parentOtherTasks: false, tasks: [] }
];
const md3 = writeMarkdown(noCompleted);
check('空 # 已完成任务 不写出',
  md3.indexOf('# 已完成任务') === -1);
check('# 全部任务 仍然写出',
  md3.indexOf('# 全部任务') >= 0);
check('## 工作 仍然写出',
  md3.indexOf('## 工作') >= 0);

console.log('\n[4] 复杂场景：重复 ## 未分类 / 多个已完成分类 / TODAY 兜底');

// 模拟用户 todo.md 的复杂场景：两个 `## 未分类`、多个 kind=COMPLETED 分类、TODAY 兜底
const complex = [
  { name: '全部任务', kind: 'other_tasks', parentOtherTasks: false, tasks: [] },
  { name: '已完成任务', kind: 'completed', parentOtherTasks: false, tasks: [
    { text: 'task1', completed: true }
  ] },
  { name: '未分类', kind: 'normal', parentOtherTasks: true, tasks: [
    { text: 'orphan1', completed: false }
  ] },
  { name: '学习', kind: 'normal', parentOtherTasks: true, tasks: [] },
  { name: '未分类', kind: 'normal', parentOtherTasks: true, tasks: [
    { text: 'orphan2', completed: false }
  ] },
  { name: '我的一天', kind: 'today', parentOtherTasks: false, tasks: [
    { text: 'today1', completed: false }
  ] },
  { name: '回收站', kind: 'trash', parentOtherTasks: false, tasks: [
    { text: 'trashed', completed: false }
  ] }
];
const md4 = writeMarkdown(complex);
const lastCompleted = md4.lastIndexOf('# 已完成任务');
const firstTrash = md4.indexOf('# 回收站');
check('复杂场景下 # 已完成任务 仍在 # 回收站 之前',
  lastCompleted >= 0 && firstTrash >= 0 && lastCompleted < firstTrash,
  `最后一个#已完成=${lastCompleted}, 第一个#回收站=${firstTrash}`);

const allTrash = md4.match(/^# 回收站/gm) || [];
check('复杂场景下 # 回收站 仍是文件最后一段（不被多个已完成分类挤到中间）',
  allTrash.length === 1 && md4.trimEnd().endsWith('trashed'),
  `trash 行数=${allTrash.length}, 末尾=${md4.trimEnd().slice(-30)}`);

console.log(`\n结果：通过 ${summary.pass} / 失败 ${summary.fail}`);
process.exit(summary.fail === 0 ? 0 : 1);
