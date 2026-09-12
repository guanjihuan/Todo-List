// 一次性验证脚本：批量操作（task-store.batchDeleteTasks / batchMoveTasks /
// batchToggleCompleted / batchUpdateMeta / batchReorderInCategory）
//
// 覆盖：
//   1. 批量删除：跨分类、TRASH 拒绝、空集合、顺序保留、单次 emit
//   2. 批量移到分类：跨源分类、顺序保留、目标守卫、单次 emit
//   3. 批量重排序：top / bottom、跨分类拒绝、顺序保留
//   4. 批量改 meta：important / current、TRASH 拒绝、已为 true 不重复改
//   5. 批量切勾选：TRASH 允许、已为目标态不重复改
//   6. 往返保真：所有批量操作后 serialize → parseMarkdown 任务多重集不变
//
// 用法：node scripts/check-batch-ops.mjs

import { TaskStore } from '../src/task-store.js';
import { check, ok, bad, summary, printSummary } from './_lib/check.mjs';
import { makeStore } from './_lib/store-fixture.mjs';
import { parseMarkdown, CategoryKind } from '../src/markdown-parser.js';
import { OTHER_TASKS_NAME, TRASH_NAME } from '../src/markdown-parser.js';

// 构造跨分类测试场景：3 个子分类 + 已完成任务分类 + 6 条任务
//
// 注意（v3.4）：fixture 里不能再用 `- [✓]` 写在普通子分类下 —— 加载时会被
// 迁移到「# 已完成任务」分类，原本所在分类会少一条，进而打挂所有断言。
// 正确做法：把已完成任务直接放在 `# 已完成任务` 段。
function setupCrossCategoryStore() {
  const md = `# ${OTHER_TASKS_NAME}

## 工作

- [ ] 工作任务 A
- [ ] 工作任务 A2

## 学习

- [ ] 学习任务 A

## 生活

- [ ] 生活任务 A
- [ ] 生活任务 B

# 已完成任务

- [✓] 工作任务 B（已完成）

# ${TRASH_NAME}
`;
  // 注入 back-mode settings：让 batchDeleteTasks / batchReorderInCategory / batchMoveTasks 的断言
  // （顺序保留 = push 顺序）保持原语义。默认 'front' 模式（最新在最上）由
  // check-insert-position.mjs 覆盖。
  const backSettings = {
    _values: { newTaskPosition: 'back', completedPosition: 'back', trashPosition: 'back', movePosition: 'back' },
    get(k) { return this._values[k]; }
  };
  const store = makeStore(md, { settingsStore: backSettings });
  return store;
}

// ============================================================
//  [1] batchDeleteTasks —— 基本跨分类删除
// ============================================================
console.log('\n[1] batchDeleteTasks 跨分类删除');

{
  const store = setupCrossCategoryStore();
  const work = store.getCategory('工作');
  const study = store.getCategory('学习');
  const life = store.getCategory('生活');

  // 选 3 条来自 3 个不同分类
  const refs = [
    { categoryName: '工作', taskId: work.tasks[0].id },
    { categoryName: '学习', taskId: study.tasks[0].id },
    { categoryName: '生活', taskId: life.tasks[0].id }
  ];

  let changeCount = 0;
  const onChange = () => { changeCount++; };
  store.on('change', onChange);

  const result = store.batchDeleteTasks(refs);
  store.off('change', onChange);

  check('返回 moved=3, skipped=0', result.moved === 3 && result.skipped === 0,
    JSON.stringify(result));
  check('change 事件只触发 1 次（不是 3 次）', changeCount === 1,
    `实际 ${changeCount} 次`);
  check('工作分类剩 1 条（剩 A2）', work.tasks.length === 1);
  check('学习分类剩 0 条', study.tasks.length === 0);
  check('生活分类剩 1 条（剩 B）', life.tasks.length === 1);
  check('回收站创建出来 + 3 条', store.getTrashCategory()?.tasks.length === 3);
  check('dirty 已被标脏', store.dirty === true);

  // 顺序：回收站里 3 条按入参顺序 reverse 后 unshift。
  // refs = [工作 A, 学习 A, 生活 A] → reverse → [生活 A, 学习 A, 工作 A]
  // 每次 unshift 加到数组前端，所以最终顺序从上到下：工作 A、学习 A、生活 A
  // 直观理解：refs 中越靠前的越先 unshift，所以越靠后的元素越先被加到前面 → 反转了 refs
  const trash = store.getTrashCategory();
  check('回收站顺序：上→下 = refs 倒序（最后删的排在最上）',
    trash.tasks[0].text === '工作任务 A' &&
    trash.tasks[1].text === '学习任务 A' &&
    trash.tasks[2].text === '生活任务 A');
}

// ============================================================
//  [2] batchDeleteTasks —— 守卫 / 边界
// ============================================================
console.log('\n[2] batchDeleteTasks 守卫');

{
  const store = setupCrossCategoryStore();
  const work = store.getCategory('工作');

  // 2.1 TRASH 内的任务被拒绝（彻底删除只能手工编辑 Markdown）
  const beforeTrashLen = store.getTrashCategory()?.tasks.length || 0;
  // 先删一条进回收站
  store.deleteTask('工作', work.tasks[0].id);
  const trash = store.getTrashCategory();
  const trashedId = trash.tasks[0].id;

  const r1 = store.batchDeleteTasks([{ categoryName: TRASH_NAME, taskId: trashedId }]);
  check('TRASH 内任务被拒绝（moved=0, skipped=1）',
    r1.moved === 0 && r1.skipped === 1, JSON.stringify(r1));
  check('TRASH 内的任务没被二次删', trash.tasks.find(t => t.id === trashedId) !== undefined);
  check('回收站长度不变', trash.tasks.length === beforeTrashLen + 1);

  // 2.2 不存在的 id
  const r2 = store.batchDeleteTasks([{ categoryName: '工作', taskId: '不存在' }]);
  check('不存在 id → moved=0, skipped=1', r2.moved === 0 && r2.skipped === 1);

  // 2.3 不存在的分类
  const r3 = store.batchDeleteTasks([{ categoryName: '不存在的分类', taskId: 'x' }]);
  check('不存在分类 → moved=0, skipped=1', r3.moved === 0 && r3.skipped === 1);

  // 2.4 空入参
  let changeCount = 0;
  store.on('change', () => changeCount++);
  const r4 = store.batchDeleteTasks([]);
  store.off('change', () => {});
  check('空数组 → moved=0, skipped=0', r4.moved === 0 && r4.skipped === 0);
  check('空数组 → change 触发 0 次', changeCount === 0,
    `实际 ${changeCount} 次`);

  // 2.5 null 入参
  const r5 = store.batchDeleteTasks(null);
  check('null 入参 → 安全返回', r5.moved === 0);

  // 2.6 混合：3 条里 1 条是 TRASH 内（拒绝），1 条不存在（跳过），1 条合法
  const r6 = store.batchDeleteTasks([
    { categoryName: TRASH_NAME, taskId: trashedId },
    { categoryName: '工作', taskId: '不存在' },
    { categoryName: '工作', taskId: work.tasks[0].id }
  ]);
  check('混合入参 → moved=1, skipped=2', r6.moved === 1 && r6.skipped === 2, JSON.stringify(r6));
}

// ============================================================
//  [3] batchDeleteTasks —— 往返保真
// ============================================================
console.log('\n[3] batchDeleteTasks 序列化往返');

{
  const store = setupCrossCategoryStore();
  const work = store.getCategory('工作');
  const study = store.getCategory('学习');

  const refs = [
    { categoryName: '工作', taskId: work.tasks[0].id },
    { categoryName: '学习', taskId: study.tasks[0].id }
  ];
  store.batchDeleteTasks(refs);

  const md = store.serialize();
  const reloaded = parseMarkdown(md);

  const reloadedWork = reloaded.find(c => c.name === '工作');
  const reloadedStudy = reloaded.find(c => c.name === '学习');
  const reloadedTrash = reloaded.find(c => c.name === TRASH_NAME && c.kind === CategoryKind.TRASH);

  check('往返后「工作」剩 1 条', reloadedWork?.tasks?.length === 1);
  check('往返后「学习」剩 0 条', reloadedStudy?.tasks?.length === 0);
  check('往返后回收站有 2 条', reloadedTrash?.tasks?.length === 2,
    `实际 ${reloadedTrash?.tasks?.length} 条`);

  // 任务多重集（文本 + completed）应不变 —— 包含所有 6 条（删的 2 条在 trash 里）
  // v3.4 fixture 已完成任务分类有 B，工作分类有 A + A2；多重集按文本 + 勾选状态统计
  const origSet = new Set([
    '工作任务 A|false',
    '工作任务 A2|false',
    '工作任务 B（已完成）|true',
    '学习任务 A|false',
    '生活任务 A|false',
    '生活任务 B|false'
  ]);
  const reloadSet = new Set();
  for (const cat of reloaded) {
    if (cat.name === OTHER_TASKS_NAME || cat.name === TRASH_NAME) continue;
    for (const t of cat.tasks) reloadSet.add(t.text + '|' + t.completed);
  }
  for (const t of reloadedTrash?.tasks || []) reloadSet.add(t.text + '|' + t.completed);
  check('往返后任务多重集不变',
    reloadSet.size === origSet.size && [...origSet].every(x => reloadSet.has(x)),
    `orig=${[...origSet]}, reload=${[...reloadSet]}`);
}

// ============================================================
//  [4] batchMoveTasks —— 跨源分类移动 + 顺序保留
// ============================================================
console.log('\n[4] batchMoveTasks 跨源分类移动');

{
  const store = setupCrossCategoryStore();
  const work = store.getCategory('工作');
  const study = store.getCategory('学习');
  const life = store.getCategory('生活');

  // 选 2 条来自工作 + 1 条来自学习 → 都到「生活」
  const refs = [
    { categoryName: '工作', taskId: work.tasks[0].id },
    { categoryName: '工作', taskId: work.tasks[1].id },
    { categoryName: '学习', taskId: study.tasks[0].id }
  ];

  let changeCount = 0;
  store.on('change', () => changeCount++);
  const result = store.batchMoveTasks(refs, '生活');
  store.off('change', () => {});

  check('返回 moved=3', result.moved === 3, JSON.stringify(result));
  check('change 触发 1 次', changeCount === 1);
  check('工作分类剩 0 条', work.tasks.length === 0);
  check('学习分类剩 0 条', study.tasks.length === 0);
  check('生活分类原来 2 + 新增 3 = 5 条', life.tasks.length === 5);

  // 顺序保留：refs[0], refs[1], refs[2] 顺序 → 追加到生活末尾
  // （原生活有 [生活任务 A, 生活任务 B]）
  check('顺序保留：生活分类末尾 3 条 = 入参顺序',
    life.tasks.slice(2).map(t => t.text).join('|') ===
      '工作任务 A|工作任务 A2|学习任务 A',
    life.tasks.slice(2).map(t => t.text).join('|'));
}

// ============================================================
//  [5] batchMoveTasks —— 目标守卫
// ============================================================
console.log('\n[5] batchMoveTasks 目标守卫');

{
  const store = setupCrossCategoryStore();
  const work = store.getCategory('工作');
  const refs = [{ categoryName: '工作', taskId: work.tasks[0].id }];

  // 5.1 目标 = 容器（OTHER_TASKS）→ 拒绝
  const r1 = store.batchMoveTasks(refs, OTHER_TASKS_NAME);
  check('目标=容器 → moved=0, skipped=1', r1.moved === 0 && r1.skipped === 1);
  check('工作分类未受影响', work.tasks.length === 2);

  // 5.2 用全新 store 验证「目标=TRASH → 不允许绕过 deleteTask 专属流程」
  // 注意：setupCrossCategoryStore 的 markdown 已含 `# ${TRASH_NAME}` 段，
  // 所以加载后回收站分类已存在 —— 这里验的是「moveTask 拒绝向 TRASH 移」，
  // 而不是「TRASH 没被动创建」（后者需要更特殊的初始 markdown）。
  const freshStore = setupCrossCategoryStore();
  const freshTrashBefore = freshStore.getTrashCategory()?.tasks.length || 0;
  const freshWork = freshStore.getCategory('工作');
  const r2 = freshStore.batchMoveTasks(
    [{ categoryName: '工作', taskId: freshWork.tasks[0].id }],
    TRASH_NAME
  );
  check('目标=回收站 → moved=0, skipped=1', r2.moved === 0 && r2.skipped === 1);
  check('拒绝后回收站任务数不变（绕过路径被堵）',
    freshStore.getTrashCategory()?.tasks.length === freshTrashBefore);
  check('拒绝后工作分类未受影响', freshWork.tasks.length === 2);

  // 5.3 目标 = 不存在的分类 → 拒绝
  const r3 = store.batchMoveTasks(refs, '不存在的分类');
  check('目标=不存在 → moved=0, skipped=1', r3.moved === 0 && r3.skipped === 1);
}

// ============================================================
//  [6] batchMoveTasks —— toIndex 插入位置
// ============================================================
console.log('\n[6] batchMoveTasks toIndex 插入位置');

{
  const store = setupCrossCategoryStore();
  const work = store.getCategory('工作');
  const life = store.getCategory('生活');
  // 生活：[生活任务 A, 生活任务 B]
  // 选工作第 1 条 → 插入到生活下标 1（A 之后、B 之前）
  const refs = [{ categoryName: '工作', taskId: work.tasks[0].id }];
  store.batchMoveTasks(refs, '生活', 1);

  check('生活分类长度 = 3', life.tasks.length === 3);
  check('插入到下标 1：A、工作任务 A、生活任务 B',
    life.tasks[0].text === '生活任务 A' &&
    life.tasks[1].text === '工作任务 A' &&
    life.tasks[2].text === '生活任务 B',
    life.tasks.map(t => t.text).join('|'));
}

// ============================================================
//  [7] batchMoveTasks —— 切回 MANUAL 排序
// ============================================================
console.log('\n[7] batchMoveTasks 切回 MANUAL');

{
  const store = setupCrossCategoryStore();
  store.setSortBy('alphabet'); // 切到字母序
  check('当前是字母序', store.sortBy === 'alphabet');

  const work = store.getCategory('工作');
  store.batchMoveTasks(
    [{ categoryName: '工作', taskId: work.tasks[0].id }],
    '生活'
  );
  check('批量移动后自动切回 MANUAL', store.sortBy === 'manual',
    `实际 ${store.sortBy}`);
}

// ============================================================
//  [8] batchReorderInCategory —— top / bottom
// ============================================================
console.log('\n[8] batchReorderInCategory top / bottom');

{
  const store = setupCrossCategoryStore();
  // 工作：[工作任务 A, 工作任务 A2]（v3.4 fixture：B 已迁到「# 已完成任务」分类）
  const work = store.getCategory('工作');
  const aId = work.tasks[0].id;
  const a2Id = work.tasks[1].id;

  // 8.1 只有 1 个任务 → 置顶 / 置底都是 no-op（顺序不变）
  const r1 = store.batchReorderInCategory('工作', [aId], 'top');
  check('单条置顶 → moved=0（顺序未变）',
    r1.moved === 0 || work.tasks[0].id === aId);

  // 8.2 现在加 2 条任务，让 reorder 真正有效
  store.addTask('工作', '新任务 1');
  store.addTask('工作', '新任务 2');
  // 工作：[工作任务 A, 工作任务 A2, 新任务 1, 新任务 2]

  // 选 [工作任务 A2, 新任务 2] → 移到顶部
  const idsToTop = [a2Id, work.tasks[3].id];
  store.batchReorderInCategory('工作', idsToTop, 'top');
  // 期望：[工作任务 A2, 新任务 2, 工作任务 A, 新任务 1]
  check('top 重排后顺序正确',
    work.tasks.map(t => t.text).join('|') ===
      '工作任务 A2|新任务 2|工作任务 A|新任务 1',
    work.tasks.map(t => t.text).join('|'));

  // 8.3 选 [工作任务 A2, 新任务 2] → 移到底部
  const idsToBottom = [work.tasks[0].id, work.tasks[1].id];
  store.batchReorderInCategory('工作', idsToBottom, 'bottom');
  // 期望：[工作任务 A, 新任务 1, 工作任务 A2, 新任务 2]
  check('bottom 重排后顺序正确',
    work.tasks.map(t => t.text).join('|') ===
      '工作任务 A|新任务 1|工作任务 A2|新任务 2',
    work.tasks.map(t => t.text).join('|'));

  // 8.4 选不存在的 id → 跳过
  const r2 = store.batchReorderInCategory('工作', ['不存在', aId], 'top');
  check('包含不存在 id → skipped=1, moved=1',
    r2.moved === 1 && r2.skipped === 1, JSON.stringify(r2));

  // 8.5 不在目标分类里的 id → 跳过
  const study = store.getCategory('学习');
  const studyId = study.tasks[0].id;
  const r3 = store.batchReorderInCategory('工作', [studyId, aId], 'top');
  check('跨分类 id 跳过 → skipped=1, moved=1',
    r3.moved === 1 && r3.skipped === 1, JSON.stringify(r3));

  // 8.6 目标分类是 TRASH → 拒绝
  const r4 = store.batchReorderInCategory(TRASH_NAME, [aId], 'top');
  check('目标=TRASH → moved=0', r4.moved === 0);

  // 8.7 目标分类是 OTHER_TASKS → 拒绝
  const r5 = store.batchReorderInCategory(OTHER_TASKS_NAME, [aId], 'top');
  check('目标=OTHER_TASKS → moved=0', r5.moved === 0);

  // 8.8 position 非法 → 拒绝
  const r6 = store.batchReorderInCategory('工作', [aId], 'middle');
  check('position=middle → moved=0', r6.moved === 0);
}

// ============================================================
//  [9] batchToggleCompleted —— 批量勾选状态切换
// ============================================================
console.log('\n[9] batchToggleCompleted 批量切勾选');

{
  const store = setupCrossCategoryStore();
  const work = store.getCategory('工作');
  const study = store.getCategory('学习');

  // v3.4 fixture：
  //   工作：[工作任务 A (未完成), 工作任务 A2 (未完成)]
  //   学习：[学习任务 A (未完成)]
  //   已完成任务：[工作任务 B（已完成）]（B 不参与本次 toggle，本来就是 true）
  // 全部置为已完成：3 条都是 false → 全部需要改 + 自动搬到 # 已完成任务
  const refs = [
    { categoryName: '工作', taskId: work.tasks[0].id },
    { categoryName: '工作', taskId: work.tasks[1].id },
    { categoryName: '学习', taskId: study.tasks[0].id }
  ];

  let changeCount = 0;
  store.on('change', () => changeCount++);
  const r1 = store.batchToggleCompleted(refs, true);
  store.off('change', () => {});

  check('返回 changed=3（3 条都是 false → 全部切到 true）',
    r1.changed === 3, JSON.stringify(r1));
  check('change 触发 1 次', changeCount === 1);

  // v3.4：toggle true 触发自动搬迁 —— 这 3 条应被搬到 # 已完成任务
  const completedCat = store.getCompletedCategory();
  check('3 条任务自动搬到已完成任务分类',
    completedCat?.tasks?.length === 4 &&  // 原有 B + 新增 3 条
    completedCat.tasks.some(t => t.text === '工作任务 A') &&
    completedCat.tasks.some(t => t.text === '工作任务 A2') &&
    completedCat.tasks.some(t => t.text === '学习任务 A'));
  check('工作分类被搬空', work.tasks.length === 0);
  check('学习分类被搬空', study.tasks.length === 0);

  // 9.2 再切回未完成：3 条都是 true → changed=3
  // v3.5+：批量取消勾选走 _resolveRestoreTarget，按各自 originalCategory 归位
  //   - 工作任务 A / A2：originalCategory = "工作" → 回到「工作」
  //   - 学习任务 A：  originalCategory = "学习" → 回到「学习」
  // 这正是本批恢复的"按原分类归位"语义 —— 旧版一律回「未分类」的行为已废弃。
  const r2 = store.batchToggleCompleted(refs, false);
  check('全部为目标态的反值 → changed=3', r2.changed === 3, JSON.stringify(r2));

  const workAfter = store.getCategory('工作');
  const studyAfter = store.getCategory('学习');
  const uncategorizedAfter = store.getCategory('未分类');
  check('2 条工作任务回到「工作」',
    workAfter?.tasks?.length === 2 &&
    workAfter.tasks.some(t => t.text === '工作任务 A') &&
    workAfter.tasks.some(t => t.text === '工作任务 A2'));
  check('1 条学习任务回到「学习」',
    studyAfter?.tasks?.length === 1 &&
    studyAfter.tasks.some(t => t.text === '学习任务 A'));
  check('「未分类」保持为空（无任务落进来）',
    !uncategorizedAfter || uncategorizedAfter.tasks.length === 0);
  check('已完成任务只剩原本的 B',
    completedCat?.tasks?.length === 1 &&
    completedCat.tasks[0].text === '工作任务 B（已完成）');

  // 9.3 TRASH 允许切勾选（恢复前常想清勾或勾上）
  // 工作 / 学习 / 未分类 里的任务刚刚经过搬迁，需要一个全新的源 —— 用「生活」分类
  const life = store.getCategory('生活');
  store.deleteTask('生活', life.tasks[0].id);
  const trash = store.getTrashCategory();
  const trashedId = trash.tasks[0].id;
  // 此时该任务 completed=false，切到 true 应该 changed=1
  const r3 = store.batchToggleCompleted(
    [{ categoryName: TRASH_NAME, taskId: trashedId }],
    true
  );
  check('TRASH 内任务允许切勾选（true）', r3.changed === 1, JSON.stringify(r3));

  // v3.4：勾选触发自动搬迁 —— TRASH 任务 [✓] 后从回收站搬到 # 已完成任务
  // （与 toggleTask 单条路径同款语义：completed=true 必须活在与状态一致的分类里）
  check('TRASH 任务勾上后自动搬到已完成任务分类',
    completedCat?.tasks?.some(t => t.id === trashedId && t.completed === true));
  check('TRASH 中已无此任务（已搬迁）',
    !trash.tasks.some(t => t.id === trashedId));

  // 9.4 batchToggleCompleted(true) 遵守 completedPosition：
  //   - front（默认）：批量打勾 → 「最新在最上」（入参里最后一条在「已完成」最前）
  //   - back         ：按入参顺序追加到「已完成」末尾（与 setupCrossCategoryStore 同款 back 语义）
  // wantCompleted=false（批量取消勾选）属于恢复路径，与 restoreTask 同款 —— 不读 *Position，
  // 任务归位一律按 push 末尾，已在 9.2 验证过。
}

// 9.4 单独用 front-mode settingsStore 验证批量打勾走 completedPosition
console.log('\n[9.4] batchToggleCompleted(true) 遵守 completedPosition');

{
  // front 模式：默认行为
  const frontSettings = {
    _values: { newTaskPosition: 'front', completedPosition: 'front', trashPosition: 'front' },
    get(k) { return this._values[k]; }
  };
  const md = `# ${OTHER_TASKS_NAME}

## 工作

- [ ] 工作任务 A
- [ ] 工作任务 A2
- [ ] 工作任务 A3

## 学习

- [ ] 学习任务 A

# ${TRASH_NAME}
`;
  const store = makeStore(md, { settingsStore: frontSettings });
  const work = store.getCategory('工作');
  const study = store.getCategory('学习');

  // 入参顺序：A, A2, A3（来自工作）, 学习 A。批量打勾 → 入参里最后一条（学习 A）
  // 在 completedPosition='front' 时应落在「已完成任务」最前面。
  const refs = [
    { categoryName: '工作', taskId: work.tasks[0].id },
    { categoryName: '工作', taskId: work.tasks[1].id },
    { categoryName: '工作', taskId: work.tasks[2].id },
    { categoryName: '学习', taskId: study.tasks[0].id }
  ];
  store.batchToggleCompleted(refs, true);

  const completedCat = store.getCompletedCategory();
  check('front 模式：completed 里有 4 条', completedCat.tasks.length === 4);
  check('front 模式：入参里最后一条（学习 A）排在最前（最新在最上）',
    completedCat.tasks[0].text === '学习任务 A',
    completedCat.tasks.map(t => t.text).join('|'));
  // front 模式：依次 unshift 入参 → 入参里最后一条最先 unshift 到 [0]，其余按入参倒序填位。
  // 入参顺序 = [工作 A, 工作 A2, 工作 A3, 学习 A]，依次 unshift 后 = [学习 A, 工作 A3, 工作 A2, 工作 A]
  // （同源内 idx=0/1/2 的顺序与入参一致，因为 parseOrder 自然等于 sourceIndex 顺序）
  check('front 模式：completed 顺序 = 入参倒序（同源按 sourceIndex 倒序保留）',
    completedCat.tasks.map(t => t.text).join('|') === '学习任务 A|工作任务 A3|工作任务 A2|工作任务 A',
    completedCat.tasks.map(t => t.text).join('|'));
}

{
  // back 模式：按入参顺序追加到末尾
  const backSettings = {
    _values: { newTaskPosition: 'back', completedPosition: 'back', trashPosition: 'back' },
    get(k) { return this._values[k]; }
  };
  const md = `# ${OTHER_TASKS_NAME}

## 工作

- [ ] 工作任务 A
- [ ] 工作任务 A2

## 学习

- [ ] 学习任务 A

# 已完成任务

- [✓] 已有 B

# ${TRASH_NAME}
`;
  const store = makeStore(md, { settingsStore: backSettings });
  const work = store.getCategory('工作');
  const study = store.getCategory('学习');

  const refs = [
    { categoryName: '工作', taskId: work.tasks[0].id },
    { categoryName: '工作', taskId: work.tasks[1].id },
    { categoryName: '学习', taskId: study.tasks[0].id }
  ];
  store.batchToggleCompleted(refs, true);

  const completedCat = store.getCompletedCategory();
  check('back 模式：completed 里有 4 条（已有 B + 新增 3 条）',
    completedCat.tasks.length === 4);
  // back 模式：原有 B 在前，新增 3 条按入参顺序追加
  check('back 模式：completed 顺序 = 原顺序 + 入参顺序',
    completedCat.tasks.map(t => t.text).join('|') ===
      '已有 B|工作任务 A|工作任务 A2|学习任务 A',
    completedCat.tasks.map(t => t.text).join('|'));
}

// ============================================================
//  [10] batchUpdateMeta —— 批量改 important / current
// ============================================================
console.log('\n[10] batchUpdateMeta 批量改 meta');

{
  const store = setupCrossCategoryStore();
  const work = store.getCategory('工作');
  const study = store.getCategory('学习');

  // 10.1 全部置为 important=true
  const refs = [
    { categoryName: '工作', taskId: work.tasks[0].id },
    { categoryName: '工作', taskId: work.tasks[1].id },
    { categoryName: '学习', taskId: study.tasks[0].id }
  ];
  const r1 = store.batchUpdateMeta(refs, { important: true });
  check('全部置重要 → changed=3', r1.changed === 3);
  check('collectSmartListTasks().important 长度 = 3',
    store.collectSmartListTasks().important.length === 3);

  // 10.2 v3.6 起不再写顶部「# 重要任务」镜像段：[⭐] 由 inline 标识承载，
  // 智能视图直接按 task.important=true 聚合。序列化结果不含镜像段，
  // 但源任务行的 [⭐] 标记必须原样保留（带 [⭐] 的行 ≥ 3）。
  const md = store.serialize();
  check('序列化结果不含「# 重要任务」镜像段', !md.includes('# 重要任务'),
    md.split('\n').slice(0, 8).join('\n'));
  check('源任务 [⭐] 标记至少 3 条', (md.match(/\[⭐\]/g) || []).length >= 3);

  // 10.3 混合：传 current=true，B 已经是 current=false → changed=3
  store.batchUpdateMeta(refs, { current: false }); // 先全部设为 false（changed=3）
  // 此时再设 current=false，changed=0（无变化）
  const r2 = store.batchUpdateMeta(refs, { current: false });
  check('全部已经是目标值 → changed=0', r2.changed === 0, JSON.stringify(r2));

  // 10.4 partial meta：只传 important，不传 current → current 不被改
  store.batchUpdateMeta(refs, { current: true });
  store.batchUpdateMeta([refs[0]], { important: true }); // 仅改 important
  check('partial meta → 仅 important 字段变',
    work.tasks[0].important === true && work.tasks[0].current === true);

  // 10.5 空 meta → 0 changed
  const r3 = store.batchUpdateMeta(refs, {});
  check('空 meta → changed=0', r3.changed === 0);

  // 10.6 null meta → 0 changed
  const r4 = store.batchUpdateMeta(refs, null);
  check('null meta → changed=0', r4.changed === 0);
}

// ============================================================
//  [11] batchUpdateMeta —— TRASH 也允许改 ⭐/▶（v3.6+）
//
// 旧行为：TRASH 内的任务被批量改 meta 时整批跳过（守卫一刀切）。
// 新行为：⭐ / ▶ 是任务级状态，回收站里也能改。其它破坏性跨分类操作
// （删除 / 移动 / 完成态切换）仍按各自守卫走，不在这里放松。
// ============================================================
console.log('\n[11] batchUpdateMeta —— TRASH 也允许改 ⭐/▶（v3.6+）');

{
  const store = setupCrossCategoryStore();
  const work = store.getCategory('工作');
  store.deleteTask('工作', work.tasks[0].id);
  const trash = store.getTrashCategory();
  const trashedId = trash.tasks[0].id;

  const r = store.batchUpdateMeta(
    [{ categoryName: TRASH_NAME, taskId: trashedId }],
    { important: true }
  );
  check('TRASH 内任务改 important → changed=1, skipped=0',
    r.changed === 1 && r.skipped === 0, JSON.stringify(r));
  check('回收站任务已被修改为 important=true',
    trash.tasks[0].important === true);

  // 反向：批量改 current 也是同样的对称行为
  const r2 = store.batchUpdateMeta(
    [{ categoryName: TRASH_NAME, taskId: trashedId }],
    { current: true }
  );
  check('TRASH 内任务改 current → changed=1, skipped=0',
    r2.changed === 1 && r2.skipped === 0, JSON.stringify(r2));
  check('回收站任务已被修改为 current=true',
    trash.tasks[0].current === true);

  // markdown 往返：writer 应该写出 [⭐][▶] 给回收站里的这条任务
  const md = store.serialize();
  check('serialize 后回收站行带 [⭐][▶] 标记',
    /- \[ \] \[▶\] \[⭐\].*?工作任务 A/.test(md),
    md);
}

// ============================================================
//  [12] 综合场景：智能列表下的 _fromCategory 路径
//
//  这是 UI 层的常见调用方式：用户在「当前任务」智能视图里选 3 条
// （来自 3 个不同子分类）→ 一键移到「工作」。
// 测试模拟 UI 收集到的 taskRefs（含真实 fromCategory）。
// ============================================================
console.log('\n[12] 智能列表下的批量移动（按 _fromCategory）');

{
  const store = setupCrossCategoryStore();
  const work = store.getCategory('工作');
  const study = store.getCategory('学习');
  const life = store.getCategory('生活');

  // 给「学习任务 A」打 current 标记，模拟智能列表视图的 enriched 数据
  study.tasks[0].current = true;

  // UI 层在「当前任务」智能视图里看到这条任务时，cat.tasks 里有 _fromCategory
  // 这里直接用真实 fromCategory 构造 refs（实际 UI 会从 enriched 副本读）
  const refs = [
    { categoryName: '学习', taskId: study.tasks[0].id }
  ];

  store.batchMoveTasks(refs, '工作');
  check('从学习移动到工作后，学习剩 0 条', study.tasks.length === 0);
  check('从学习移动到工作后，工作含学习任务 A',
    work.tasks.find(t => t.text === '学习任务 A') !== undefined);
  check('移动后 current 标记保留',
    work.tasks.find(t => t.text === '学习任务 A').current === true);
}

// ============================================================
//  [13] 综合：批量删除 + 往返 + 回收站顺序
// ============================================================
console.log('\n[13] 综合往返：批量删除后 serialize → parse 保真');

{
  const store = setupCrossCategoryStore();
  const work = store.getCategory('工作');
  const life = store.getCategory('生活');

  // 删 2 条
  store.batchDeleteTasks([
    { categoryName: '工作', taskId: work.tasks[0].id },
    { categoryName: '生活', taskId: life.tasks[1].id }
  ]);

  const md = store.serialize();
  const reloaded = parseMarkdown(md);

  const reloadedWork = reloaded.find(c => c.name === '工作');
  const reloadedLife = reloaded.find(c => c.name === '生活');
  const reloadedTrash = reloaded.find(c => c.name === TRASH_NAME && c.kind === CategoryKind.TRASH);

  // 多重集比较
  const liveSet = new Set();
  for (const cat of reloaded) {
    if (cat.name === OTHER_TASKS_NAME || cat.name === TRASH_NAME) continue;
    for (const t of cat.tasks) liveSet.add(t.text + '|' + t.completed);
  }
  for (const t of reloadedTrash?.tasks || []) liveSet.add(t.text + '|' + t.completed);

  const expected = new Set([
    // v3.4 fixture：B 已迁到 # 已完成任务分类，A2 仍在工作分类
    '工作任务 B（已完成）|true',
    '工作任务 A2|false',
    '学习任务 A|false',
    '生活任务 A|false',
    '工作任务 A|false',
    '生活任务 B|false'
  ]);
  check('综合往返后任务多重集完全一致',
    liveSet.size === expected.size && [...expected].every(x => liveSet.has(x)),
    `live=${[...liveSet]}, expected=${[...expected]}`);

  // 关键不变量：task.id 不写文件
  check('文件里不包含 id 注释', !md.includes('<!-- id:'));
}

// ============================================================
//  总结
// ============================================================
console.log(`\n==========\n通过 ${summary.pass} / 失败 ${summary.fail}\n==========`);
process.exit(summary.fail === 0 ? 0 : 1);
