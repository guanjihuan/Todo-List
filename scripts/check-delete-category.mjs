// 一次性验证脚本：删除分类时任务必须完整迁移到「未分类」，且能通过 Markdown 往返。
//
// 关键：只检查内存状态是不够的 —— 任务可能挂在一个「脱离 categories 数组」或
// 「序列化后无法被 parser 认回」的分类上。所以每个用例都做
//   内存变更 → serialize() → parseMarkdown() → 重新数任务
// 这才能证明数据真的落盘且能读回来。
//
// 用法：node scripts/check-delete-category.mjs

import { TaskStore, UNCATEGORIZED_NAME, OTHER_TASKS_NAME } from '../src/task-store.js';
import { check, ok, bad, summary, printSummary } from './_lib/check.mjs';
import { makeStore } from './_lib/store-fixture.mjs';
import { parseMarkdown, CategoryKind } from '../src/markdown-parser.js';

// 收集一份「任务文本 → 出现次数」的多重集，用于比较迁移前后是否等价
function taskMultiset(categories) {
  const m = new Map();
  for (const cat of categories) {
    for (const t of cat.tasks || []) {
      const key = `${t.text}|${t.completed ? 1 : 0}|${t.important ? 1 : 0}`;
      m.set(key, (m.get(key) || 0) + 1);
    }
  }
  return m;
}

function multisetEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

function describeMultiset(m) {
  return [...m.entries()].map(([k, v]) => `${k}×${v}`).sort().join(', ') || '(空)';
}

// 构造一个 store，绕过 window.api（不触发真实落盘）

// 核心断言：删除 name 后，任务多重集不变，且经过 Markdown 往返仍不变
function expectNoLoss(label, markdown, deleteName) {
  console.log(`\n[${label}] 删除「${deleteName}」`);
  const store = makeStore(markdown);

  const before = taskMultiset(store.categories);
  const targetCat = store.getCategory(deleteName);
  const movedCount = targetCat ? targetCat.tasks.length : 0;

  const ok = store.deleteCategory(deleteName);
  check('deleteCategory 返回 true', ok === true, `实际返回 ${ok}`);
  check(`分类「${deleteName}」已移除`, !store.categories.some(c => c.name === deleteName));

  // 1) 内存层面：任务多重集必须完全一致
  const afterMem = taskMultiset(store.categories);
  check(
    '内存中任务无丢失',
    multisetEqual(before, afterMem),
    `迁移前 [${describeMultiset(before)}]\n      迁移后 [${describeMultiset(afterMem)}]`
  );

  // 2) 任务必须真的落在「未分类」里
  const fallback = store.categories.find(c => c.name === UNCATEGORIZED_NAME);
  if (movedCount > 0) {
    check(`「${UNCATEGORIZED_NAME}」存在于 categories 数组中`, !!fallback);
    if (fallback) {
      check(
        `「${UNCATEGORIZED_NAME}」承接了 ${movedCount} 项任务`,
        fallback.tasks.length >= movedCount,
        `实际只有 ${fallback.tasks.length} 项`
      );
    }
  }

  // 3) 往返测试：序列化 → 重新解析 → 任务仍必须完整
  //    这一步能抓出「分类脱离数组」或「写成孤立 ## 被 parser 丢弃」的情况
  const md = store.serialize();
  const reparsed = parseMarkdown(md);
  const afterRoundTrip = taskMultiset(reparsed);
  check(
    'Markdown 往返后任务无丢失',
    multisetEqual(before, afterRoundTrip),
    `往返前 [${describeMultiset(before)}]\n      往返后 [${describeMultiset(afterRoundTrip)}]\n      --- 生成的 Markdown ---\n${md.split('\n').map(l => '      ' + l).join('\n')}`
  );

  return store;
}

console.log('='.repeat(64));
console.log('删除分类：任务迁移到「未分类」—— 数据完整性验证');
console.log('='.repeat(64));

// ---------- 用例 1：「未分类」已存在，删除中间的分类 ----------
expectNoLoss('用例1 未分类已存在', `# 当前任务

- [ ] 今日任务A

# ${OTHER_TASKS_NAME}

## 工作

- [ ] 工作任务1
- [✓] 工作任务2
- [ ] 工作任务3 ⭐

## 学习

- [ ] 学习任务1

## ${UNCATEGORIZED_NAME}

- [ ] 已有的零散任务
`, '工作');

// ---------- 用例 2：「未分类」缺失，删除容器后的第一个子分类 ----------
// 这是最危险的场景：新建「未分类」会插到 oIdx+1，正好和被删分类的原索引重叠
expectNoLoss('用例2 未分类缺失+删首个子分类', `# 当前任务

- [ ] 今日任务A

# ${OTHER_TASKS_NAME}

## 工作

- [ ] 工作任务1
- [✓] 工作任务2
- [ ] 工作任务3 ⭐

## 学习

- [ ] 学习任务1
`, '工作');

// ---------- 用例 3：「未分类」缺失，删除最后一个子分类 ----------
expectNoLoss('用例3 未分类缺失+删末个子分类', `# 当前任务

# ${OTHER_TASKS_NAME}

## 工作

- [ ] 工作任务1

## 生活

- [ ] 生活任务1
- [✓] 生活任务2
`, '生活');

// ---------- 用例 4：「未分类」缺失，且这是唯一的子分类 ----------
expectNoLoss('用例4 未分类缺失+唯一子分类', `# 当前任务

# ${OTHER_TASKS_NAME}

## 工作

- [ ] 唯一分类里的任务1
- [✓] 唯一分类里的任务2 ⭐
`, '工作');

// ---------- 用例 5：删除空分类 ----------
console.log('\n[用例5] 删除空分类');
{
  const store = makeStore(`# 当前任务

# ${OTHER_TASKS_NAME}

## 工作

- [ ] 工作任务1

## 空分类
`);
  const subsBefore = store.getSubCategories().map(c => c.name);
  const ok = store.deleteCategory('空分类');
  check('deleteCategory 返回 true', ok === true);
  const subsAfter = store.getSubCategories().map(c => c.name);
  check('空分类已移除', !subsAfter.includes('空分类'));
  // 删空分类不该凭空造出一个「未分类」
  const spawnedUncategorized =
    !subsBefore.includes(UNCATEGORIZED_NAME) && subsAfter.includes(UNCATEGORIZED_NAME);
  check(
    `删除空分类不会凭空创建「${UNCATEGORIZED_NAME}」`,
    !spawnedUncategorized,
    `删除后子分类：${subsAfter.join(' / ')}`
  );
}

// ---------- 用例 6：「未分类」自身不可删除 ----------
console.log('\n[用例6] 「未分类」不可删除');
{
  const store = makeStore(`# 当前任务

# ${OTHER_TASKS_NAME}

## ${UNCATEGORIZED_NAME}

- [ ] 兜底里的任务
`);
  const ok = store.deleteCategory(UNCATEGORIZED_NAME);
  check('deleteCategory 返回 false', ok === false, `实际返回 ${ok}`);
  check(
    `「${UNCATEGORIZED_NAME}」仍在`,
    store.categories.some(c => c.name === UNCATEGORIZED_NAME)
  );
  check('兜底里的任务仍在', taskMultiset(store.categories).size === 1);
}

// ---------- 用例 7：特殊分类不可删除 ----------
console.log('\n[用例7] 特殊分类不可删除');
{
  const store = makeStore(`# 当前任务

- [ ] 今日任务

# ${OTHER_TASKS_NAME}

## 工作

- [ ] 工作任务
`);
  const before = taskMultiset(store.categories);
  check('删除「当前任务」被拒绝', store.deleteCategory('当前任务') === false);
  check(`删除「${OTHER_TASKS_NAME}」被拒绝`, store.deleteCategory(OTHER_TASKS_NAME) === false);
  check('删除不存在的分类被拒绝', store.deleteCategory('不存在的分类') === false);
  check('任务完全未受影响', multisetEqual(before, taskMultiset(store.categories)));
}

// ---------- 用例 8：连续删除多个分类 ----------
console.log('\n[用例8] 连续删除多个有任务的分类');
{
  const store = makeStore(`# 当前任务

- [ ] 今日任务

# ${OTHER_TASKS_NAME}

## 工作

- [ ] 工作任务1
- [ ] 工作任务2

## 学习

- [✓] 学习任务1

## 生活

- [ ] 生活任务1 ⭐
`);
  const before = taskMultiset(store.categories);
  store.deleteCategory('工作');
  store.deleteCategory('学习');
  store.deleteCategory('生活');
  check('三个分类全部移除', store.getSubCategories().every(c => c.name === UNCATEGORIZED_NAME));
  check(
    '内存中任务无丢失',
    multisetEqual(before, taskMultiset(store.categories)),
    `前 [${describeMultiset(before)}]\n      后 [${describeMultiset(taskMultiset(store.categories))}]`
  );
  const reparsed = parseMarkdown(store.serialize());
  check(
    'Markdown 往返后任务无丢失',
    multisetEqual(before, taskMultiset(reparsed)),
    `往返后 [${describeMultiset(taskMultiset(reparsed))}]\n      --- Markdown ---\n${store.serialize().split('\n').map(l => '      ' + l).join('\n')}`
  );
}

// ---------- 用例 9：结构不变量 —— 子分类必须紧跟在容器之后 ----------
// writeMarkdown 依赖这个顺序：parentOtherTasks 的分类写成 ##，
// 如果它出现在 # 容器之前，parser 会因 insideOtherTasks=false 而丢弃整段
console.log('\n[用例9] 结构不变量：子分类必须在容器之后');
{
  const store = makeStore(`# 当前任务

# ${OTHER_TASKS_NAME}

## 工作

- [ ] 工作任务1
`);
  store.deleteCategory('工作');
  const containerIdx = store.categories.findIndex(c => c.kind === CategoryKind.OTHER_TASKS);
  const subIdxs = store.categories
    .map((c, i) => (c.parentOtherTasks ? i : -1))
    .filter(i => i >= 0);
  check('存在 OTHER_TASKS 容器', containerIdx >= 0);
  check(
    '所有子分类都排在容器之后',
    subIdxs.every(i => i > containerIdx),
    `容器在 ${containerIdx}，子分类在 [${subIdxs.join(', ')}]`
  );
}

// ---------- 用例 10：不产生重名「未分类」 ----------
// 重名会让 getCategory() 只认第一个，后续 addTask/toggleTask 全打到错的对象上
console.log('\n[用例10] 不产生重名「未分类」');
{
  const store = makeStore(`# 当前任务

# ${OTHER_TASKS_NAME}

## 工作

- [ ] 工作任务1

## ${UNCATEGORIZED_NAME}

- [ ] 兜底任务1
`);
  // 人为破坏标记，模拟历史数据里 parentOtherTasks 缺失的「未分类」
  const u = store.categories.find(c => c.name === UNCATEGORIZED_NAME);
  u.parentOtherTasks = false;

  const before = taskMultiset(store.categories);
  store.deleteCategory('工作');

  const dupes = store.categories.filter(c => c.name === UNCATEGORIZED_NAME);
  check(
    `「${UNCATEGORIZED_NAME}」只有一个（无重名）`,
    dupes.length === 1,
    `实际有 ${dupes.length} 个`
  );
  check(`「${UNCATEGORIZED_NAME}」的 parentOtherTasks 已补正`, dupes[0]?.parentOtherTasks === true);
  check('内存中任务无丢失', multisetEqual(before, taskMultiset(store.categories)));
  const reparsed = parseMarkdown(store.serialize());
  check(
    'Markdown 往返后任务无丢失',
    multisetEqual(before, taskMultiset(reparsed)),
    `往返后 [${describeMultiset(taskMultiset(reparsed))}]`
  );
}

// ---------- 用例 11：容器缺失时不能写出孤立的 ## ----------
// writeMarkdown 把 parentOtherTasks 写成 `## X`，parseMarkdown 只在 `# 全部任务`
// 之后才认 `##`。孤立的 `## 未分类` 不会让任务消失，但会静默改写归属：
// parser 跳过该 h2 时不重置 currentCategory，任务被并进上一个 h1（通常是「当前任务」）。
// 所以这里要断言的是「归属正确」，不只是「总数正确」。
console.log('\n[用例11] 容器缺失时任务归属不被改写');
{
  const store = makeStore(`# 当前任务

- [ ] 今日原有任务

# ${OTHER_TASKS_NAME}

## 工作

- [ ] 工作任务1
- [✓] 工作任务2 ⭐
`);
  // 人为移除 OTHER_TASKS 容器，模拟结构受损的数据
  const cIdx = store.categories.findIndex(c => c.kind === CategoryKind.OTHER_TASKS);
  store.categories.splice(cIdx, 1);

  const before = taskMultiset(store.categories);
  store.deleteCategory('工作');

  check(
    'OTHER_TASKS 容器已被重建',
    store.categories.some(c => c.kind === CategoryKind.OTHER_TASKS)
  );
  const containerIdx = store.categories.findIndex(c => c.kind === CategoryKind.OTHER_TASKS);
  const subIdxs = store.categories.map((c, i) => (c.parentOtherTasks ? i : -1)).filter(i => i >= 0);
  check(
    '所有子分类都排在容器之后',
    subIdxs.every(i => i > containerIdx),
    `容器在 ${containerIdx}，子分类在 [${subIdxs.join(', ')}]`
  );

  const md = store.serialize();
  const reparsed = parseMarkdown(md);
  check(
    'Markdown 往返后任务总数不变',
    multisetEqual(before, taskMultiset(reparsed)),
    `往返前 [${describeMultiset(before)}]\n      往返后 [${describeMultiset(taskMultiset(reparsed))}]`
  );
  // v3 起没有 TODAY 真实分类 —— 「今日原有任务」在加载时被 _migrateTodayCategory
  // 搬到了首个子分类，并打上 @当前 标记。所以这里要验证的是：
  //   1. parseMarkdown 后不存在任何 kind=TODAY 的分类（迁移彻底）
  //   2. 删除「工作」后，工作里未完成的 1 项任务 + 今日 1 项任务 → 「未分类」
  //      （v3.4 后，[✓] 任务会在加载时被搬到「# 已完成任务」分类，所以「工作」
  //       删完后只剩 2 项进「未分类」，原 [✓] 的「工作任务2」落在「# 已完成任务」）
  //   3. 「未分类」里的「今日原有任务」带 @当前 标记，被「当前」智能视图聚合得到
  const todayAfter = reparsed.find(c => c.kind === CategoryKind.TODAY);
  const uncatAfter = reparsed.find(c => c.name === UNCATEGORIZED_NAME);
  const completedAfter = reparsed.find(c => c.kind === CategoryKind.COMPLETED);
  check(
    'v3 已无 TODAY 真实分类（# 当前任务 在迁移时被搬空）',
    !todayAfter,
    `仍有 TODAY 分类（${todayAfter?.tasks.length ?? '?'} 项）`
  );
  check(
    `搬走的 2 项任务（含 @当前 的）留在「${UNCATEGORIZED_NAME}」`,
    uncatAfter && uncatAfter.tasks.length === 2,
    `实际 ${uncatAfter ? uncatAfter.tasks.length + ' 项' : '分类不存在'}\n      --- Markdown ---\n${md.split('\n').map(l => '      ' + l).join('\n')}`
  );
  check(
    '原 [✓] 的「工作任务2」落在「# 已完成任务」（v3.4 自动搬迁）',
    completedAfter?.tasks?.some(t => t.text === '工作任务2'),
    `已完成任务分类任务：${completedAfter?.tasks?.map(t => t.text).join(' / ') || '无'}`
  );
  // 「当前」智能视图能聚合到那条带 @当前 标记的「今日原有任务」
  const currentView = store._buildSmartListView('current');
  check(
    '「当前」智能视图能聚合到 @当前 标记的「今日原有任务」',
    currentView.tasks.some(t => t.text === '今日原有任务'),
    `当前视图任务：${currentView.tasks.map(t => t.text).join(' / ')}`
  );
}

// ---------- 用例 12：删除当前选中分类后，视图切到任务的新家 ----------
console.log('\n[用例12] 删除选中分类后视图跟随任务');
{
  const store = makeStore(`# ${OTHER_TASKS_NAME}

## 工作

- [ ] 工作任务1

## 空的
`);
  store.selectCategory('工作');
  store.deleteCategory('工作');
  check(
    `删有任务的分类 → 视图切到「${UNCATEGORIZED_NAME}」`,
    store.selectedCategoryName === UNCATEGORIZED_NAME,
    `实际是「${store.selectedCategoryName}」`
  );

  store.selectCategory('空的');
  store.deleteCategory('空的');
  // v3 起没有 TODAY 真实分类 —— 删空分类后落到「当前」智能视图
  check(
    '删空分类 → 视图退回「当前」智能视图',
    store.selectedSmartList === 'current',
    `实际停在 selectedCategoryName=${store.selectedCategoryName} / selectedSmartList=${store.selectedSmartList}`
  );
  check('选中的分类/视图真实存在', store.getSelectedCategory() !== null);
}

console.log('\n' + '='.repeat(64));
console.log(`结果：${summary.pass} 通过, ${summary.fail} 失败`);
console.log('='.repeat(64));
process.exit(summary.fail === 0 ? 0 : 1);
