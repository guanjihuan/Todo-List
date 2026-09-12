// 回归测试：moveTask 跨分类移动时必须维持"completed=true 只活在 kind=COMPLETED"不变量
//
// v3.4 起「已完成任务」升级为真实分类，配套的不变量：
//   - completed=true 任务只能活在 kind=COMPLETED 分类
//   - completed=false 任务只能活在 NORMAL 子分类
//   - 容器 (OTHER_TASKS) / 回收站 (TRASH) 跨在两侧之外（回收站可以同时有 true/false）
//
// 漏洞历史：moveTask 从回收站拖动 completed 任务到普通子分类时
//   - 旧实现：toCat.kind === NORMAL → 既不改 completed 也不改路由 → 任务落到普通子分类且 completed=true → 破坏不变量
//   - 修复：复用 restoreTask 同款规则 —— task.completed=true 且目标非 COMPLETED 时强制改投「已完成任务」
//
// 用法：node scripts/check-move-invariance.mjs

import { TaskStore, COMPLETED_NAME } from '../src/task-store.js';
import { check, summary } from './_lib/check.mjs';
import { makeStore } from './_lib/store-fixture.mjs';
import { parseMarkdown, CategoryKind } from '../src/markdown-parser.js';

function roundTrip(store) {
  return parseMarkdown(store.serialize());
}

function findCat(categories, name) {
  return categories.find(c => c.name === name) || null;
}

const BASE_DOC = `# 全部任务

## 工作

- [ ] 写周报

## 学习

- [ ] 看 Rust 入门

## 未分类

- [ ] 杂事
`;

// ============================================================
// [1] moveTask 从回收站拖 completed 任务到 NORMAL → 防御性改投「已完成任务」
// ============================================================
console.log('\n[1] moveTask 从回收站搬 completed 任务到普通子分类 → 改投「已完成任务」');

{
  const store = makeStore(BASE_DOC);
  // 制造一个 completed 任务在回收站：toggle → delete
  const workTask = store.getCategory('工作').tasks[0];
  store.toggleTask('工作', workTask.id);  // 进已完成（原分类="工作"）
  const completedTask = store.getCategory('已完成任务').tasks[0];
  store.deleteTask('已完成任务', completedTask.id);  // 进回收站

  const trashed = store.getTrashCategory().tasks[0];
  check('前置：任务在回收站且 completed=true',
    trashed && trashed.completed === true);

  // 用户从回收站拖动到「学习」（NORMAL 子分类）
  const result = store.moveTask('回收站', trashed.id, '学习');

  // 修复后：moveTask 把任务改投到「已完成任务」并返回实际目标名
  check('moveTask 返回的是实际生效的目标分类名（"已完成任务"）',
    result === COMPLETED_NAME, `actual=${result}`);

  const after = store.getCategory('已完成任务').tasks;
  const learning = store.getCategory('学习').tasks;
  check('任务落在「已完成任务」',
    after.some(t => t.text === '写周报'),
    `已完成任务: ${after.map(t => t.text).join(', ')}`);
  check('任务不在「学习」',
    !learning.some(t => t.text === '写周报'),
    `学习: ${learning.map(t => t.text).join(', ')}`);
  check('任务 completed 状态保持 true',
    after.find(t => t.text === '写周报').completed === true);
  check('任务 originalCategory 保持「工作」（改投不重写）',
    after.find(t => t.text === '写周报').originalCategory === '工作',
    `actual=${after.find(t => t.text === '写周报').originalCategory}`);
}

// ============================================================
// [2] moveTask 从回收站拖 uncompleted 任务到 NORMAL → 正常落到目标分类
// ============================================================
console.log('\n[2] moveTask 从回收站搬 uncompleted 任务到普通子分类 → 直接落目标分类');

{
  const store = makeStore(BASE_DOC);
  // 制造一个 uncompleted 任务在回收站：直接 deleteTask
  const workTask = store.getCategory('工作').tasks[0];
  store.deleteTask('工作', workTask.id);

  const trashed = store.getTrashCategory().tasks[0];
  check('前置：任务在回收站且 completed=false',
    trashed && trashed.completed === false);

  const result = store.moveTask('回收站', trashed.id, '学习');

  check('moveTask 返回的是用户指定的目标分类名（"学习"）',
    result === '学习', `actual=${result}`);
  check('任务落在「学习」',
    store.getCategory('学习').tasks.some(t => t.text === '写周报'));
  check('任务 completed === false（不变）',
    store.getCategory('学习').tasks.find(t => t.text === '写周报').completed === false);
}

// ============================================================
// [3] moveTask 从 NORMAL 拖动到 NORMAL：返回值是目标分类名
// ============================================================
console.log('\n[3] moveTask 从普通子分类到普通子分类：返回目标分类名');

{
  const store = makeStore(BASE_DOC);
  const workTask = store.getCategory('工作').tasks[0];
  const result = store.moveTask('工作', workTask.id, '学习');

  check('moveTask 返回「学习」',
    result === '学习', `actual=${result}`);
  check('任务在「学习」',
    store.getCategory('学习').tasks.some(t => t.text === '写周报'));
  check('任务不在「工作」',
    !store.getCategory('工作').tasks.some(t => t.text === '写周报'));
}

// ============================================================
// [4] moveTask 跨完整往返：serialize → parseMarkdown 后不变量仍然成立
// ============================================================
console.log('\n[4] moveTask 改投后往返到磁盘，磁盘层不变量也成立');

{
  const store = makeStore(BASE_DOC);
  const workTask = store.getCategory('工作').tasks[0];
  store.toggleTask('工作', workTask.id);
  store.deleteTask('已完成任务', store.getCategory('已完成任务').tasks[0].id);

  // 防御性改投
  store.moveTask('回收站', store.getTrashCategory().tasks[0].id, '学习');

  const md = store.serialize();
  const cats = parseMarkdown(md);

  const completed = findCat(cats, '已完成任务');
  const learning = findCat(cats, '学习');
  // writer 兜底：空回收站整段不写出，parser 也不会凭空造出空 TRASH 分类
  // —— 这里只断言 completed/learning 各自的不变量成立
  const trash = findCat(cats, '回收站');

  check('磁盘层：「已完成任务」下任务全部 completed=true',
    completed && completed.tasks.every(t => t.completed),
    `completed: ${completed?.tasks.map(t => `${t.text}(${t.completed})`).join(', ')}`);
  check('磁盘层：「学习」下任务全部 completed=false',
    learning && learning.tasks.every(t => !t.completed),
    `learning: ${learning?.tasks.map(t => `${t.text}(${t.completed})`).join(', ')}`);
  check('磁盘层：回收站不存在或为空（writer 兜底：空回收站不写出）',
    !trash || trash.tasks.length === 0,
    `trash: ${trash?.tasks.map(t => t.text).join(', ') || '(未写出)'}`);
}

// ============================================================
// [5] 完整路径：垃圾任务从未分类 → 回收站 → 拖到「学习」(NORMAL) 成功
// ============================================================
console.log('\n[5] 普通路径回归：从普通子分类 → 回收站 → 拖回普通子分类');

{
  const store = makeStore(BASE_DOC);
  const uncatTask = store.getCategory('未分类').tasks[0];
  const uncatId = uncatTask.id;

  // 移到回收站
  store.deleteTask('未分类', uncatId);
  check('任务进回收站',
    store.getTrashCategory().tasks.some(t => t.text === '杂事'));

  // 拖到「工作」
  const result = store.moveTask('回收站', uncatId, '工作');
  check('moveTask 返回「工作」',
    result === '工作', `actual=${result}`);
  check('任务现在在「工作」',
    store.getCategory('工作').tasks.some(t => t.text === '杂事'));
  check('回收站空',
    store.getTrashCategory().tasks.length === 0);
}

// ============================================================
// [7] moveTask 从「已完成任务」拖动 completed 任务到普通子分类 → 强制 completed=false
//     （与 TRASH 防御改投的语义不同：这里尊重用户意图"让任务回到活跃工作"）
//
// 漏洞历史：从「已完成任务」智能视图拖 completed 任务到 sidebar 子分类时，
// 旧实现既不强制 completed=false 也不重路由 → 任务留在 NORMAL 子分类但 completed=true，
// 破坏 v3.4 数据归属不变量。右鍵菜单 (buildStandardContextMenuItems) 已通过
// isCompletedView 守卫屏蔽掉「移到分类…」入口，但拖拽路径没有同款护栏。
// ============================================================
console.log('\n[7] moveTask 从「已完成任务」搬 completed 任务到普通子分类 → 强制 completed=false');

{
  const store = makeStore(BASE_DOC);
  // 制造一个 completed 任务在「已完成任务」分类
  const workTask = store.getCategory('工作').tasks[0];
  store.toggleTask('工作', workTask.id);  // 进已完成（原分类="工作"）

  const completedCat = store.getCompletedCategory();
  const completedTask = completedCat.tasks[0];
  check('前置：任务在「已完成任务」且 completed=true',
    completedTask && completedTask.completed === true);

  // 用户从「已完成任务」智能视图拖动到「学习」（NORMAL 子分类）。
  // 这里 _fromCategory 模拟智能视图下的 enriched cat（move 接受的是 _fromCategory 来源名）
  const result = store.moveTask('已完成任务', completedTask.id, '学习');

  check('moveTask 返回的是用户指定的目标分类名（"学习"）',
    result === '学习', `actual=${result}`);
  check('任务落在「学习」',
    store.getCategory('学习').tasks.some(t => t.text === '写周报'),
    `学习: ${store.getCategory('学习').tasks.map(t => t.text).join(', ')}`);
  check('任务不在「已完成任务」',
    !store.getCategory('已完成任务').tasks.some(t => t.text === '写周报'),
    `已完成任务: ${store.getCategory('已完成任务').tasks.map(t => t.text).join(', ')}`);
  // v3.4 数据归属不变量：拖到普通分类 → 强制 completed=false
  check('任务 completed 状态被强制为 false（不变量维持）',
    store.getCategory('学习').tasks.find(t => t.text === '写周报').completed === false,
    `actual=${store.getCategory('学习').tasks.find(t => t.text === '写周报').completed}`);
  check('任务 originalCategory 清空（已不在已完成态）',
    store.getCategory('学习').tasks.find(t => t.text === '写周报').originalCategory === null);
}

// ============================================================
// [8] moveTask 跨已完成 → 普通子分类后往返到磁盘，磁盘层不变量仍然成立
// ============================================================
console.log('\n[8] moveTask COMPLETED → NORMAL 后往返到磁盘，磁盘层不变量成立');

{
  const store = makeStore(BASE_DOC);
  const workTask = store.getCategory('工作').tasks[0];
  store.toggleTask('工作', workTask.id);

  // 防御性 completed=false
  store.moveTask('已完成任务', store.getCompletedCategory().tasks[0].id, '学习');

  const md = store.serialize();
  const cats = parseMarkdown(md);

  const completed = findCat(cats, '已完成任务');
  const learning = findCat(cats, '学习');
  check('磁盘层：「学习」下任务全部 completed=false',
    learning && learning.tasks.every(t => !t.completed),
    `learning: ${learning?.tasks.map(t => `${t.text}(${t.completed})`).join(', ')}`);
  check('磁盘层：「已完成任务」不存在或为空（writer 兜底）',
    !completed || completed.tasks.length === 0,
    `已完成任务: ${completed?.tasks.map(t => t.text).join(', ') || '(空)'}`);
}

// ============================================================
// [9] batchMoveTasks 跨已完成 → 普通子分类同样维持不变量（批量路径对称）
// ============================================================
console.log('\n[9] batchMoveTasks 从「已完成任务」批量搬到普通子分类 → 全部 completed=false');

{
  const store = makeStore(BASE_DOC);
  // 制造 2 条 completed 任务在「已完成任务」分类
  store.toggleTask('工作', store.getCategory('工作').tasks[0].id);  // 第一条 → 已完成
  store.toggleTask('学习', store.getCategory('学习').tasks[0].id);  // 第二条 → 已完成

  const completedCat = store.getCompletedCategory();
  check('前置：「已完成任务」有 2 条任务',
    completedCat.tasks.length === 2, `count=${completedCat.tasks.length}`);

  // 批量拖回「未分类」
  const refs = completedCat.tasks.map(t => ({
    categoryName: '已完成任务',
    taskId: t.id
  }));
  const result = store.batchMoveTasks(refs, '未分类');
  check('batchMoveTasks 返回 moved=2',
    result.moved === 2 && result.skipped === 0,
    JSON.stringify(result));

  const uncat = store.getCategory('未分类');
  check('任务落在「未分类」',
    uncat.tasks.filter(t => t.text === '写周报' || t.text === '看 Rust 入门').length === 2);
  check('「未分类」下任务全部 completed=false（不变量维持）',
    uncat.tasks.every(t => !t.completed),
    `未分类: ${uncat.tasks.map(t => `${t.text}(${t.completed})`).join(', ')}`);
  check('「已完成任务」分类为空（writer 兜底后下次不写出）',
    completedCat.tasks.length === 0);
}

// ============================================================
// [10] reorderTask 在「已完成任务」（kind=COMPLETED）下重排：
//      - 智能视图 in-list reorder 的 store 层基础：不变量维持（completed/originalCategory 不动）
//      - 磁盘顺序反映新顺序（持久化到底层分类）
//      - sortBy 自动切回 MANUAL（避免下次渲染按字母覆盖）
//
// 漏洞历史：「已完成任务」智能视图下原本完全禁用 in-list 拖拽（task-list.js _updateDrag 跳过
// _findDropTarget）—— 鼠标拖动没反应，让用户怀疑功能坏了。新豁免「已完成任务」智能视图
// 允许 in-list reorder 后，必须确认 reorderTask 落到 kind=COMPLETED 分类是安全的：
//   - 跨 _fromCategory 的 enriched 副本（理论上已完成视图里都同 _fromCategory）
//   - 但测试要保护 reorderTask 不修改 completed / originalCategory —— 这些是 toggle/move
//     流程才该改的字段，单纯重排不该动它们。
// ============================================================
console.log('\n[10] reorderTask 在「已完成任务」分类下重排：不变量 + 持久化 + 切回 MANUAL');

{
  // 准备 3 条 completed 任务，分别来自不同原分类（验证 originalCategory 不被破坏）
  const FIXTURE = `# 全部任务

## 工作

- [ ] 任务A（工作）

## 学习

- [ ] 任务C（学习）

## 未分类

- [ ] 任务D（未分类）
`;
  const store = makeStore(FIXTURE);
  // 用 toggleTask 把三条任务搬到「已完成任务」分类
  store.toggleTask('工作', store.getCategory('工作').tasks[0].id);    // A 进已完成
  store.toggleTask('学习', store.getCategory('学习').tasks[0].id);    // C 进已完成
  store.toggleTask('未分类', store.getCategory('未分类').tasks[0].id); // D 进已完成

  const completedCat = store.getCompletedCategory();
  check('前置：「已完成任务」分类 kind=COMPLETED',
    completedCat.kind === CategoryKind.COMPLETED,
    `kind=${completedCat.kind}`);
  check('前置：「已完成任务」下有 3 条任务',
    completedCat.tasks.length === 3,
    `count=${completedCat.tasks.length}`);

  // 顺序：completedPosition 默认 front（最新的放最前），所以 toggle 顺序 A→C→D
  // 落到「已完成任务」分类后实际顺序是 [D, C, A]
  const beforeTexts = completedCat.tasks.map(t => t.text);
  check('前置：「已完成任务」下顺序 = [D, C, A]',
    JSON.stringify(beforeTexts) === JSON.stringify(['任务D（未分类）', '任务C（学习）', '任务A（工作）']),
    `actual=${JSON.stringify(beforeTexts)}`);

  // 切到 ALPHABET —— 验证 reorderTask 后会切回 MANUAL
  store.setSortBy('alphabet');
  check('前置：sortBy=alphabet', store.sortBy === 'alphabet');

  // 重排：把 A（idx=2，末尾）挪到开头（idx=0）。reorderTask 语义是 splice(from,1) + splice(to,0,task)
  //   splice(2, 1) 移除 A → [D, C]
  //   splice(0, 0, A) 在开头插入 A → [A, D, C]
  const ok = store.reorderTask('已完成任务', 2, 0);
  check('reorderTask 返回 true', ok === true);

  const afterTexts = completedCat.tasks.map(t => t.text);
  check('「已完成任务」下顺序变为 [A, D, C]',
    JSON.stringify(afterTexts) === JSON.stringify(['任务A（工作）', '任务D（未分类）', '任务C（学习）']),
    `actual=${JSON.stringify(afterTexts)}`);

  // 不变量：每条任务 completed=true、originalCategory 保留
  const a = completedCat.tasks.find(t => t.text === '任务A（工作）');
  const c = completedCat.tasks.find(t => t.text === '任务C（学习）');
  const d = completedCat.tasks.find(t => t.text === '任务D（未分类）');
  check('A.completed=true（不变量）', a && a.completed === true);
  check('A.originalCategory="工作"（reorder 不重写）', a && a.originalCategory === '工作',
    `actual=${a && a.originalCategory}`);
  check('C.completed=true（不变量）', c && c.completed === true);
  check('C.originalCategory="学习"（reorder 不重写）', c && c.originalCategory === '学习',
    `actual=${c && c.originalCategory}`);
  check('D.completed=true（不变量）', d && d.completed === true);
  check('D.originalCategory="未分类"（reorder 不重写）', d && d.originalCategory === '未分类',
    `actual=${d && d.originalCategory}`);

  // sortBy 被切回 MANUAL（避免下次渲染按字母重排覆盖用户意图）
  check('reorderTask 自动把 sortBy 切回 MANUAL',
    store.sortBy === 'manual', `actual=${store.sortBy}`);

  // serialize → parseMarkdown：磁盘层顺序也是 [C, D, A]
  const md = store.serialize();
  const cats = parseMarkdown(md);
  const diskCompleted = findCat(cats, '已完成任务');
  check('磁盘层：parseMarkdown 后能找到「已完成任务」分类',
    !!diskCompleted);
  check('磁盘层：「已完成任务」分类 kind=COMPLETED',
    diskCompleted && diskCompleted.kind === CategoryKind.COMPLETED,
    `kind=${diskCompleted && diskCompleted.kind}`);
  const diskTexts = diskCompleted ? diskCompleted.tasks.map(t => t.text) : [];
  check('磁盘层：「已完成任务」段顺序 = [A, D, C]',
    JSON.stringify(diskTexts) === JSON.stringify(['任务A（工作）', '任务D（未分类）', '任务C（学习）']),
    `actual=${JSON.stringify(diskTexts)}`);
  check('磁盘层：每条任务 completed=true（不变量）',
    diskCompleted && diskCompleted.tasks.every(t => t.completed === true),
    `tasks: ${diskCompleted?.tasks.map(t => `${t.text}(${t.completed})`).join(', ')}`);
}

// ============================================================
// [6] mergeFromDisk 后必须维持不变量（防外部编辑过的磁盘文件合并后不变量失守）
//
// 漏洞历史：parseMarkdown 只按名字标 kind，不跑迁移逻辑（散落 [✓]、重复「未分类」、
// 缺失的「已完成任务」分类等）。mergeFromDisk 以前漏 _ensureBaseStructure 调用，
// 直接把磁盘 raw categories 灌进 this.categories —— completed=true 任务会留在
// NORMAL 子分类，破坏 v3.4 数据归属不变量。
// ============================================================
console.log('\n[6] mergeFromDisk 后维持不变量');

{
  // 6.1) 旧格式磁盘：散落 [✓] 任务在 NORMAL 子分类
  const DIRTY_DISK = `# 全部任务

## 工作

- [ ] 正常任务
- [✓] 旧格式已完成任务（散落在子分类）

## 未分类

- [ ] 普通任务
`;
  const diskCats = parseMarkdown(DIRTY_DISK);

  const store = makeStore(null);
  store.mergeFromDisk(diskCats, {});  // 用默认 resolutions：disk 获胜

  // 旧格式的 [✓] 任务应该被 _ensureBaseStructure 迁到「已完成任务」分类
  const completed = store.getCategory('已完成任务');
  check('mergeFromDisk 后「已完成任务」分类已创建',
    !!completed, `categories: ${store.categories.map(c => c.name).join(', ')}`);
  check('mergeFromDisk 后「已完成任务」下带原分类记录',
    completed && completed.tasks.some(t =>
      t.text === '旧格式已完成任务（散落在子分类）' &&
      t.completed === true &&
      t.originalCategory === '工作'),
    `completed: ${completed?.tasks.map(t => `${t.text}(${t.completed}, ${t.originalCategory})`).join(', ')}`);
  check('mergeFromDisk 后「工作」分类下没有散落的 [✓]',
    !store.getCategory('工作').tasks.some(t => t.completed),
    `工作: ${store.getCategory('工作').tasks.map(t => `${t.text}(${t.completed})`).join(', ')}`);
}

{
  // 6.2) 重复「未分类」：外部编辑导致磁盘文件出现同名子分类，合并后应该去重
  const DUP_DISK = `# 全部任务

## 工作

- [ ] 正常任务

## 未分类

- [ ] 第一个未分类任务

## 未分类

- [ ] 第二个未分类任务
`;
  const diskCats = parseMarkdown(DUP_DISK);

  const store = makeStore(null);
  store.mergeFromDisk(diskCats, {});

  const uncats = store.categories.filter(c => c.name === '未分类');
  check('mergeFromDisk 后「未分类」分类已去重（只剩 1 个）',
    uncats.length === 1, `count=${uncats.length}`);
  check('重复「未分类」下的任务被合并到同一个分类',
    uncats[0] && uncats[0].tasks.length === 2,
    `tasks: ${uncats[0]?.tasks.map(t => t.text).join(', ')}`);
}

{
  // 6.3) 不变量：mergeFromDisk 后 NORMAL 子分类下没有 completed=true 任务
  const INVARIANT_DISK = `# 全部任务

## 工作

- [ ] 任务A
- [✓] 任务B（散落）

## 学习

- [✓] 任务C（散落）

## 未分类

- [ ] 任务D
- [✓] 任务E（散落）
`;
  const diskCats = parseMarkdown(INVARIANT_DISK);

  const store = makeStore(null);
  store.mergeFromDisk(diskCats, {});

  // 遍历所有 NORMAL 子分类，断言没有 completed=true 任务
  const violations = [];
  for (const cat of store.categories) {
    if (cat.kind === CategoryKind.NORMAL || cat.kind === CategoryKind.OTHER_TASKS) {
      for (const t of cat.tasks) {
        if (t.completed) {
          violations.push(`${cat.name}: ${t.text}`);
        }
      }
    }
  }
  check('mergeFromDisk 后 NORMAL 子分类下没有 completed=true 任务',
    violations.length === 0, `violations: ${violations.join('; ')}`);
}

console.log(`\n结果：通过 ${summary.pass} / 失败 ${summary.fail}`);
process.exit(summary.fail === 0 ? 0 : 1);