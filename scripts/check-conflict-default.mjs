// 回归测试：H7 — modified 默认选择是 'both'（OR 合并状态）
//
// 背景：旧版 defaultResolutions 把 modified 默认设为 'b'（用本地）。这导致
// 磁盘侧修改的标记（completed / important / current）被默默丢弃 ——
// 用户可能根本不知道，文件里的重要标记就消失了。
//
// 修复（v3.7+）：modified 默认 'both'（OR 合并）。current 在 v4 起改为：
//   - 仅一边 current=true → OR 保留（修复 H3：用户在 UI 标 [▶] 后，磁盘
//     还没同步，合并不丢标记）
//   - 两边都 current=true → 强制 false（仍是单值指针）

// 跑法：node scripts/check-conflict-default.mjs

import { defaultResolutions, diffCategories, applyResolutions } from '../src/utils/markdown-diff.js';
import { check, summary, printSummary } from './_lib/check.mjs';

const makeCat = (name, kind = 'normal', parentOtherTasks = true, tasks = []) =>
  ({ name, kind, isSpecial: false, meta: null, parentOtherTasks, tasks });

const container = { name: '全部任务', kind: 'other_tasks', isSpecial: true, meta: null, parentOtherTasks: false, tasks: [] };
const trash = { name: '回收站', kind: 'trash', isSpecial: true, meta: null, parentOtherTasks: false, tasks: [] };

// ── [1] defaultResolutions：modified 默认 'both' ──
console.log('\n[1] defaultResolutions：modified 默认 "both"');

{
  // v4 起：completed=true 任务也参与 diff（按 effective cat name），所以两侧都用
  // completed=false，important 字段不同即可触发 modified。
  const catsA = [
    container,
    makeCat('工作', 'normal', true, [
      { text: 'X', completed: false, important: true, current: false }, // 仅 A
    ]),
    makeCat('学习', 'normal', true, [
      { text: 'Y', completed: false, important: true, current: false }, // modified（两侧 important 不同）
    ]),
    trash,
  ];
  const catsB = [
    container,
    makeCat('工作', 'normal', true, [
      { text: 'Z', completed: false, important: false, current: false }, // 仅 B
    ]),
    makeCat('学习', 'normal', true, [
      { text: 'Y', completed: false, important: false, current: false }, // 与 A 文本同，important 不同
    ]),
    trash,
  ];

  const diff = diffCategories(catsA, catsB);
  const res = defaultResolutions(diff);

  check('diff 至少一条 modified', diff.modified.length >= 1,
    `modified=${JSON.stringify(diff.modified)}`);
  check('diff 有 onlyInA（X）', diff.onlyInA.length >= 1);
  check('diff 有 onlyInB（Z）', diff.onlyInB.length >= 1);
  // modified 默认值
  const modifiedKey = diff.modified[0].key;
  check(`modified 默认是 'both'`,
    res[modifiedKey] === 'both',
    `actual=${res[modifiedKey]}, key=${modifiedKey}`);
  check(`onlyInA 默认是 'a'`,
    res[diff.onlyInA[0].key] === 'a');
  check(`onlyInB 默认是 'b'`,
    res[diff.onlyInB[0].key] === 'b');
}

// ── [2] 仅 modified（无 onlyIn*） —— 默认仍 'both' ──
console.log('\n[2] 纯 modified 场景：默认值仍是 "both"');

{
  // v4：completed=false 两侧 + important 不同 —— 进入 modified 分支。
  const catsA = [container, makeCat('工作', 'normal', true, [
    { text: 'T', completed: false, important: true, current: false },
  ]), trash];
  const catsB = [container, makeCat('工作', 'normal', true, [
    { text: 'T', completed: false, important: false, current: false },
  ]), trash];
  const diff = diffCategories(catsA, catsB);
  const res = defaultResolutions(diff);
  check('纯 modified diff 的 default 是 both',
    diff.modified.length === 1 && res[diff.modified[0].key] === 'both',
    `modified.len=${diff.modified.length}, res=${JSON.stringify(res)}`);
}

// ── [3] applyResolutions：modified 默认 'both'（无显式 resolution 时） ──
console.log('\n[3] applyResolutions：modified 默认 "both"（OR 合并）');

{
  // 两侧 completed=false；important 不同 → 进 modified；
  // catsB 有 current=true，catsA 是 false —— v4 H3 修复：单边 true 保留 OR 结果。
  const catsA = [container, makeCat('工作', 'normal', true, [
    { text: 'T', completed: false, important: false, current: false },
  ]), trash];
  const catsB = [container, makeCat('工作', 'normal', true, [
    { text: 'T', completed: false, important: true, current: true },
  ]), trash];
  const diff = diffCategories(catsA, catsB);

  // 不传 resolutions（空对象）—— 验证 applyResolutions 内部的默认值
  const merged = applyResolutions(catsA, diff, {});
  const t = merged.find(c => c.name === '工作').tasks[0];
  check('默认合并后 completed = OR(false, false) = false（两边都没勾选）',
    t.completed === false,
    `t=${JSON.stringify(t)}`);
  check('默认合并后 important = OR(false, true) = true',
    t.important === true);
  check('默认合并后 current = OR(false, true) = true（H3 修复：单边 true 不再被吞）',
    t.current === true,
    `t.current=${t.current}, expected true`);
}

// ── [4] current 双边 true → 合并后强制 false（仍是单值指针） ──
console.log('\n[4] applyResolutions：current 双边 true → 强制 false');

{
  // 两侧都标了 [▶] —— 矛盾，强制 false 让用户手动重选。
  // 必须有其他状态字段不同（这里用 important）让两侧落到 modified 分支；
  // 完全相同的两侧会被 tasksStateEqual 判 unchanged，根本不走 mergeTaskStates。
  const catsA = [container, makeCat('工作', 'normal', true, [
    { text: 'T', completed: false, important: false, current: true },
  ]), trash];
  const catsB = [container, makeCat('工作', 'normal', true, [
    { text: 'T', completed: false, important: true, current: true },
  ]), trash];
  const diff = diffCategories(catsA, catsB);
  const merged = applyResolutions(catsA, diff, {});
  const t = merged.find(c => c.name === '工作').tasks[0];
  check('双边 current=true → 合并后 current=false',
    t.current === false,
    `t=${JSON.stringify(t)}`);
}

printSummary('check-conflict-default');
