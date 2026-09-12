// 回归测试：过滤筛选（filter / sort / smart-list bypass）
//
// 涵盖：
//   1) v3.4 不变量：completed=true 任务只能活在 kind=COMPLETED 分类 ——
//      loadFromContent 完成迁移后，普通 NORMAL 分类下不应再有 completed=true。
//   2) getVisibleTasks 在各 Filter 下的行为：
//      - ALL/CURRENT/COMPLETED/IMPORTANT 四种过滤在普通分类 + 智能列表下
//        的可见性 + 数量 + 文本都符合预期。
//        CURRENT 的语义是 `t.current`（[▶] 驱动），不是「未完成」 ——
//        从 PENDING（!completed）迁移过来，与「当前任务」智能列表对称。
//   3) bypassFilter 边界：「已完成任务 / 重要任务 / 当前任务」智能列表下，
//      任何 Filter 都不再二次过滤（避免「在「已完成任务」里选 current
//      永远空」这种自相矛盾）；「全部任务」智能列表下保留过滤能力。
//   4) 搜索叠加：在过滤后的结果上再搜索，结果是子集。
//   5) UI 文案：_renderEmptyState 在 COMPLETED 过滤下的 hint 不能再说
//      "勾选任务后会出现在这里"（v3.4 后是错的 —— 勾选后任务会搬到
//      kind=COMPLETED 分类），必须提示用户去「已完成任务」分类看。
//
// 跑法：node scripts/check-filter.mjs

import { readFileSync } from 'node:fs';
import { check, ok, bad, summary, printSummary } from './_lib/check.mjs';
import { makeStore } from './_lib/store-fixture.mjs';
import { installApiStub } from './_lib/api-stub.mjs';

installApiStub();

const { TaskStore, Filter } = await import('../src/task-store.js');
const { CategoryKind } = await import('../src/markdown-parser.js');

// ============================================
// [1] v3.4 不变量：completed=true 任务只能在 kind=COMPLETED 分类
// ============================================
console.log('\n[1] v3.4 不变量：completed 任务只能活在 kind=COMPLETED 分类');

{
  const store = makeStore([
    '# 全部任务',
    '',
    '## 工作',
    '',
    '- [ ] 任务A',
    '- [x] 任务B',
    '- [ ] [⭐] 任务C',
    '- [x] [⭐] 任务D',
    '',
    '## 学习',
    '',
    '- [x] [⭐] 学习B',
  ].join('\n'));

  for (const cat of store.categories) {
    if (cat.kind === CategoryKind.OTHER_TASKS) continue;
    if (cat.kind === CategoryKind.COMPLETED) continue;
    // 普通分类 / 回收站：不允许出现 completed=true 任务
    const violators = cat.tasks.filter(t => t.completed);
    check(`${cat.name} (kind=${cat.kind}) 不含 completed=true 任务`,
      violators.length === 0,
      violators.map(t => t.text).join(','));
  }
  // 「已完成任务」分类：必须承接所有 completed 任务
  const completedCat = store.getCompletedCategory();
  check('kind=COMPLETED 分类存在', !!completedCat);
  check('已完成任务分类有 3 条任务（B/D/学习B）',
    completedCat.tasks.length === 3,
    `实际 ${completedCat.tasks.length} 条`);
}

// ============================================
// [2] getVisibleTasks：普通分类下四种过滤
// ============================================
console.log('\n[2] 普通分类下 getVisibleTasks 行为正确');

{
  const store = makeStore([
    '# 全部任务',
    '',
    '## 工作',
    '',
    '- [ ] A',
    '- [x] B',
    '- [ ] [▶] C',
    '- [ ] [⭐] D',
    '- [ ] [▶] [⭐] E',
  ].join('\n'));

  const workCat = store.getCategory('工作');
  store.selectCategory('工作');

  const cases = [
    { filter: Filter.ALL,       expect: ['A', 'C', 'D', 'E'], label: 'ALL' },
    { filter: Filter.CURRENT,   expect: ['C', 'E'],           label: 'CURRENT（[▶] 驱动）' },
    { filter: Filter.COMPLETED, expect: [],                    label: 'COMPLETED (v3.4: 普通分类下永远空)' },
    { filter: Filter.IMPORTANT, expect: ['D', 'E'],            label: 'IMPORTANT' },
  ];
  for (const { filter, expect, label } of cases) {
    store.setFilter(filter);
    const got = store.getVisibleTasks(store.getSelectedCategory()).map(t => t.text);
    check(`${label} 过滤可见文本 = ${JSON.stringify(expect)}`,
      JSON.stringify(got) === JSON.stringify(expect),
      `实际 ${JSON.stringify(got)}`);
  }
}

// ============================================
// [3] bypassFilter：智能列表下不二次过滤
// ============================================
console.log('\n[3] bypassFilter 边界：「已完成/重要/当前」智能列表下过滤被跳过');

{
  const store = makeStore([
    '# 全部任务',
    '',
    '## 工作',
    '',
    '- [ ] A',
    '- [ ] [▶] B',
    '- [ ] [⭐] C',
    '- [x] [⭐] D',
  ].join('\n'));

  // 「已完成任务」智能列表下选 CURRENT —— 应仍然看到全部（D），不应被过滤成空
  store.selectSmartList('completed');
  store.setFilter(Filter.CURRENT);
  const completedView = store.getSelectedCategory();
  const vis = store.getVisibleTasks(completedView).map(t => t.text).sort();
  check('completed 智能列表 + CURRENT 过滤 → 仍返回全部',
    JSON.stringify(vis) === JSON.stringify(['D']),
    `实际 ${JSON.stringify(vis)}`);

  // 「重要任务」智能列表下选 COMPLETED —— v3.4 后"完成 = 归档"，D 不在重要聚合里
  store.selectSmartList('important');
  store.setFilter(Filter.COMPLETED);
  const importantView = store.getSelectedCategory();
  const impVis = store.getVisibleTasks(importantView).map(t => t.text).sort();
  check('important 智能列表 + COMPLETED 过滤 → 重要聚合只剩 C（D 已归档）',
    JSON.stringify(impVis) === JSON.stringify(['C']),
    `实际 ${JSON.stringify(impVis)}`);

  // 「全部任务」智能列表下保留过滤能力（不 bypass）
  store.selectSmartList('allTasks');
  store.setFilter(Filter.CURRENT);
  const allTasksView = store.getSelectedCategory();
  const allVis = store.getVisibleTasks(allTasksView).map(t => t.text);
  check('allTasks 智能列表 + CURRENT 过滤 → 过滤生效（仅 [▶] 任务）',
    JSON.stringify(allVis) === JSON.stringify(['B']),
    `实际 ${JSON.stringify(allVis)}`);

  // 「当前任务」智能列表：v3.4 后 completed+current 不出现在 current 聚合
  // 这里只放未完成的当前任务，避免被 v3.4 归档逻辑影响
  const store2 = makeStore([
    '# 全部任务',
    '',
    '## 工作',
    '',
    '- [ ] [▶] A',
    '- [ ] [▶] B',
    '- [ ] C',
  ].join('\n'));
  store2.selectSmartList('current');
  store2.setFilter(Filter.CURRENT);
  const curVis = store2.getVisibleTasks(store2.getSelectedCategory()).map(t => t.text).sort();
  check('current 智能列表 + CURRENT 过滤 → 仍返回全部当前任务（不二次过滤）',
    JSON.stringify(curVis) === JSON.stringify(['A', 'B']),
    `实际 ${JSON.stringify(curVis)}`);
}

// ============================================
// [4] 搜索叠加在过滤结果上
// ============================================
console.log('\n[4] 搜索在过滤结果上叠加：结果应是子集');

{
  const store = makeStore([
    '# 全部任务',
    '',
    '## 工作',
    '',
    '- [ ] 买菜',
    '- [ ] 做饭',
    '- [ ] [⭐] 买咖啡',
    '- [ ] [⭐] 写代码',
  ].join('\n'));

  store.selectCategory('工作');
  store.setFilter(Filter.IMPORTANT);
  store.setSearchQuery('买');
  const vis = store.getVisibleTasks(store.getSelectedCategory()).map(t => t.text).sort();
  check('IMPORTANT 过滤 + 搜索"买" → 只剩 [买咖啡]',
    JSON.stringify(vis) === JSON.stringify(['买咖啡']),
    `实际 ${JSON.stringify(vis)}`);

  store.setFilter(Filter.ALL);
  store.setSearchQuery('买');
  const visAll = store.getVisibleTasks(store.getSelectedCategory()).map(t => t.text).sort();
  check('ALL 过滤 + 搜索"买" → 买菜 + 买咖啡',
    JSON.stringify(visAll) === JSON.stringify(['买咖啡', '买菜']),
    `实际 ${JSON.stringify(visAll)}`);
}

// ============================================
// [5] UI 文案 + 过滤菜单隐藏「已完成」选项（普通分类下）
// ============================================
console.log('\n[5] _renderEmptyState 文案 + 普通分类下隐藏「已完成」过滤');

{
  const src = readFileSync(new URL('../src/ui/task-list.js', import.meta.url), 'utf8');

  // 5a) _renderEmptyState 在 COMPLETED 过滤下的 hint 不再说"勾选任务后会出现在这里"
  const fnMatch = src.match(/_renderEmptyState\([^)]*\)\s*\{([\s\S]*?)\n  \}/);
  if (!fnMatch) {
    bad('找不到 _renderEmptyState 函数（源码结构变了？）');
  } else {
    const body = fnMatch[1];
    const completedBranch = body.match(
      /this\.store\.filter\s*===\s*Filter\.COMPLETED[\s\S]*?else if/m
    );
    if (!completedBranch) {
      bad('找不到 COMPLETED 过滤分支');
    } else {
      const branch = completedBranch[0];
      check('COMPLETED 过滤分支包含「已完成任务」字样',
        /已完成任务/.test(branch),
        branch.replace(/\s+/g, ' ').slice(0, 200));
      check('COMPLETED 过滤分支不再含错文案「勾选任务后会出现在这里」',
        !/勾选任务后会出现在这里/.test(branch),
        branch.replace(/\s+/g, ' ').slice(0, 200));
      const currentBranch = body.match(
        /this\.store\.filter\s*===\s*Filter\.CURRENT[\s\S]*?else if/m
      );
      if (currentBranch) {
        check('CURRENT 过滤分支提示用 ▶ / [▶] 标记',
          /▶/.test(currentBranch[0]) || /\[▶\]/.test(currentBranch[0]),
          currentBranch[0].replace(/\s+/g, ' ').slice(0, 200));
      } else {
        bad('找不到 CURRENT 过滤分支（应提示用户给任务打 [▶]）');
      }
    }
  }

  // 5b) _showFilterMenu 在普通分类下隐藏「已完成」选项（v3.4 后永远空，不应诱导）
  const showFnMatch = src.match(/_showFilterMenu\(\)\s*\{([\s\S]*?)\n  \}/);
  if (!showFnMatch) {
    bad('找不到 _showFilterMenu 函数（源码结构变了？）');
  } else {
    const fnBody = showFnMatch[1];
    check('_showFilterMenu 引入 hideCompleted 判断（普通分类下不显示「已完成」）',
      /hideCompleted/.test(fnBody) && /Filter\.COMPLETED/.test(fnBody),
      '源码应同时含 hideCompleted 和 Filter.COMPLETED 检查');
    check('_showFilterMenu 同时判断 !isSmartList 与 kind !== TRASH',
      /!\s*[a-zA-Z]+\.isSmartList/.test(fnBody) &&
      /CategoryKind\.TRASH/.test(fnBody),
      '应排除智能列表之外的"普通分类/容器"且保留回收站/智能列表显示 COMPLETED');
  }

  // 5c) render 入口：进入普通分类 + filter=COMPLETED → 自动 fallback 到 ALL
  const renderFnMatch = src.match(/render\(\)\s*\{([\s\S]*?)\n  \}/);
  if (!renderFnMatch) {
    bad('找不到 render 函数（源码结构变了？）');
  } else {
    const renderBody = renderFnMatch[1];
    check('render 入口有「普通分类 + filter=COMPLETED → ALL」兜底',
      /filter\s*===\s*Filter\.COMPLETED/.test(renderBody) &&
      /setFilter\(Filter\.ALL\)/.test(renderBody),
      'render 顶部应检测到无效的 filter 组合并 fallback');
  }
}

// ============================================
console.log(`\n${'─'.repeat(48)}`);
console.log(`通过 ${summary.pass} / 失败 ${summary.fail}`);
process.exit(summary.fail === 0 ? 0 : 1);
