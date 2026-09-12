// 回归测试：_consolidateCompleted 的兜底行为
//
// 触发 bug 的姿势：
//   1. 用户在外部编辑器手敲多个 `# 已完成任务` —— 例如 VSCode 多光标编辑、
//      Git 合并冲突没解干净、模板工具批量生成。parser 忠实地产出多个
//      kind=COMPLETED 分类。
//   2. 把「已完成任务」写成容器下的 `## 已完成任务` —— 解析成 NORMAL 子分类。
//
// 旧行为：只走 parser 的 classifyByName，第一次 # 已完成任务 是 COMPLETED，后续
//   副本按 h1 名命中 COMPLETED_KEYS 也是 COMPLETED。后续副本里的任务在 UI 上既
//   看不到也没法恢复（getCompletedCategory 只返回第一个）—— 数据无声消失。
//   ## 已完成任务 子分类也类似 —— 走 NORMAL 路径，completed=true 任务违反
//   v3.4 数据归属不变量。
//
// 新行为：_consolidateCompleted() 两段防御
//   1) 把「名字正好是规范名『已完成任务』、kind 是 NORMAL/子分类」正名为 COMPLETED
//      （与 _consolidateTrash 第一段同源问题：避免 _getOrCreateCompletedCategory
//      与同名普通子分类撞名）
//   2) 多份 kind=COMPLETED → 保留第一份，tasks 拼接，删副本
//
// 跑法：node scripts/check-completed-consolidate.mjs

import { check, ok, bad, summary, printSummary } from './_lib/check.mjs';
import { makeStore } from './_lib/store-fixture.mjs';
import { parseMarkdown } from '../src/markdown-parser.js';
import { writeMarkdown } from '../src/markdown-writer.js';
import { COMPLETED_NAME } from '../src/task-store.js';

// ============================================================
// [1] 多 `# 已完成任务` → 合并到第一份，tasks 拼接，绝不丢任务
// ============================================================
console.log('\n[1] 多个 # 已完成任务 副本合并');
{
  const md = `# 全部任务

## 工作

- [ ] a

# 已完成任务

- [✓] first-done

# 已完成任务

- [✓] second-done

# 已完成任务

- [✓] third-done
`;
  const store = makeStore(md);

  const allCompleted = store.categories.filter(c => c.kind === 'completed');
  check('多个副本 → 收敛成 1 个 COMPLETED 分类',
    allCompleted.length === 1,
    `actual count: ${allCompleted.length}`);

  const completed = allCompleted[0];
  if (completed) {
    const texts = completed.tasks.map(t => t.text).join('|');
    // 顺序按文件出现顺序：first-done / second-done / third-done
    check('tasks 拼接保留所有 3 条任务',
      completed.tasks.length === 3 && texts === 'first-done|second-done|third-done',
      `texts=${texts}`);
    check('拼接后所有任务仍 completed=true',
      completed.tasks.every(t => t.completed === true),
      completed.tasks.map(t => `${t.text}(${t.completed})`).join(','));

    // 数据归属不变量：completed=true 任务**只能**活在 kind=COMPLETED
    for (const c of store.categories) {
      if (c.kind === 'completed') continue;
      const strayCompleted = c.tasks.filter(t => t.completed === true);
      check(`${c.name || c.kind} 分类无 completed=true 任务`,
        strayCompleted.length === 0,
        strayCompleted.map(t => t.text).join(','));
    }
  }
}

// ============================================================
// [2] 单 `# 已完成任务` → no-op，不重复 / 不删错
// ============================================================
console.log('\n[2] 单副本不动');
{
  const md = `# 全部任务

## 工作

- [ ] a

# 已完成任务

- [✓] only-done
`;
  const store = makeStore(md);

  const allCompleted = store.categories.filter(c => c.kind === 'completed');
  check('单副本 → 仍是 1 个 COMPLETED', allCompleted.length === 1);
  check('任务未被改',
    allCompleted[0]?.tasks?.length === 1 && allCompleted[0].tasks[0].text === 'only-done',
    JSON.stringify(allCompleted[0]?.tasks?.map(t => t.text)));
}

// ============================================================
// [3] `## 已完成任务` 子分类 → 提升为 COMPLETED h1
// ============================================================
console.log('\n[3] ## 已完成任务 子分类正名为 h1');
{
  // ## 已完成任务 在 # 全部任务 容器下 → parser 会解析成 NORMAL 子分类
  const md = `# 全部任务

## 工作

- [ ] a

## 已完成任务

- [✓] promoted-done
`;
  const store = makeStore(md);

  const allCompleted = store.categories.filter(c => c.kind === 'completed');
  check('子分类 `## 已完成任务` 被提升为 COMPLETED h1',
    allCompleted.length === 1,
    `actual: ${allCompleted.length} completed, all cats: ${store.categories.map(c => `${c.name}=${c.kind}`).join(',')}`);
  if (allCompleted[0]) {
    check('提升后任务还在',
      allCompleted[0].tasks.length === 1 && allCompleted[0].tasks[0].text === 'promoted-done',
      allCompleted[0].tasks.map(t => t.text).join(','));
    check('提升后 isSpecial=true / parentOtherTasks=false',
      allCompleted[0].isSpecial === true && allCompleted[0].parentOtherTasks === false,
      `isSpecial=${allCompleted[0].isSpecial}, parentOtherTasks=${allCompleted[0].parentOtherTasks}`);
  }
}

// ============================================================
// [4] 混合：多 h1 副本 + 子分类副本
// ============================================================
console.log('\n[4] 多 h1 副本 + ## 已完成任务 子分类混合');
{
  const md = `# 全部任务

## 工作

- [ ] a

# 已完成任务

- [✓] h1-first

## 已完成任务

- [✓] sub-promoted

# 已完成任务

- [✓] h1-second
`;
  const store = makeStore(md);

  const allCompleted = store.categories.filter(c => c.kind === 'completed');
  check('混合场景 → 仍收敛成 1 个 COMPLETED',
    allCompleted.length === 1,
    `count=${allCompleted.length}`);

  if (allCompleted[0]) {
    // 拼接顺序的细节依赖 _migrateCompletedTasksToCategory（v3.4 归属迁移）的
    // 内部策略：h1 副本里的任务按出现顺序在前，从 NORMAL 子分类迁移过来的追加
    // 在末尾。这里只验证 _consolidateCompleted 的核心承诺（不丢任务 + 任务集合
    // 完整），顺序细节不锁。
    const foundTexts = allCompleted[0].tasks.map(t => t.text);
    check('所有 3 条任务都进了最终 COMPLETED（不丢任务）',
      allCompleted[0].tasks.length === 3,
      `tasks: ${foundTexts.join(',')}`);

    const sortedActual = [...foundTexts].sort().join('|');
    const sortedExpected = 'h1-first|h1-second|sub-promoted';
    check('任务集合完整无丢失',
      sortedActual === sortedExpected,
      `actual=${sortedActual}, expected=${sortedExpected}`);
  }
}

// ============================================================
// [5] roundtrip：合并后写回 markdown → 再读仍是单分类 + 任务齐全
// ============================================================
console.log('\n[5] roundtrip 不再复活重复副本');
{
  const md = `# 全部任务

## 工作

- [ ] a

# 已完成任务

- [✓] t1

# 已完成任务

- [✓] t2
`;
  const store = makeStore(md);
  const md2 = writeMarkdown(store.categories);
  // 写出去应该只有 1 个 `# 已完成任务`
  const h1Count = (md2.match(/^# 已完成任务$/gm) || []).length;
  check('写出的 markdown 只含 1 个 # 已完成任务', h1Count === 1, `count=${h1Count}`);

  // 再解析回来：仍是 1 个 COMPLETED 分类 + 任务齐全
  const cats2 = parseMarkdown(md2);
  // 注意：再 parseMarkdown 不走 store 兜底（store 的 _consolidateCompleted 只在
  // loadFromContent / _ensureBaseStructure 路径跑），所以这里必须确认 writeMarkdown
  // 写出的格式已经是「已合并」状态 —— 否则 store 之外的纯 parser 调用会再次看到多副本
  const allCompleted = cats2.filter(c => c.kind === 'completed');
  check('parser 再次解析也是 1 个 COMPLETED（writeMarkdown 已合并）',
    allCompleted.length === 1,
    `count=${allCompleted.length}, kinds: ${cats2.map(c => c.kind).join(',')}`);
  if (allCompleted[0]) {
    const texts = allCompleted[0].tasks.map(t => t.text).sort().join('|');
    check('roundtrip 任务齐全（t1 + t2）',
      texts === 't1|t2',
      texts);
  }
}

// ============================================================
// [6] 与 _consolidateTrash / _consolidateUncategorized 共存
// ============================================================
console.log('\n[6] 三个 consolidate 路径同时触发，互不干扰');
{
  const md = `# 全部任务

## 工作

- [ ] a

## 未分类

- [ ] orphan

## 未分类

- [ ] orphan-2

# 已完成任务

- [✓] done-1

# 已完成任务

- [✓] done-2

# 回收站

- [ ] trash-1

# 回收站

- [ ] trash-2
`;
  const store = makeStore(md);

  // COMPLETED 应只剩 1 份，含 done-1 + done-2
  const completed = store.categories.filter(c => c.kind === 'completed');
  check('COMPLETED 收敛为 1',
    completed.length === 1,
    `count=${completed.length}`);
  if (completed[0]) {
    const sortedTexts = completed[0].tasks.map(t => t.text).sort().join('|');
    check('COMPLETED 含 done-1 + done-2',
      sortedTexts === 'done-1|done-2',
      sortedTexts);
  }

  // TRASH 应只剩 1 份，含 trash-1 + trash-2
  const trash = store.categories.filter(c => c.kind === 'trash');
  check('TRASH 收敛为 1',
    trash.length === 1,
    `count=${trash.length}`);
  if (trash[0]) {
    const sortedTexts = trash[0].tasks.map(t => t.text).sort().join('|');
    check('TRASH 含 trash-1 + trash-2',
      sortedTexts === 'trash-1|trash-2',
      sortedTexts);
  }

  // UNCATEGORIZED 应只剩 1 份（## 子分类），含 orphan + orphan-2
  const uncats = store.categories.filter(c => c.parentOtherTasks && c.name === '未分类');
  check('## 未分类 收敛为 1',
    uncats.length === 1,
    `count=${uncats.length}`);
  if (uncats[0]) {
    const sortedTexts = uncats[0].tasks.map(t => t.text).sort().join('|');
    check('## 未分类 含 orphan + orphan-2',
      sortedTexts === 'orphan|orphan-2',
      sortedTexts);
  }
}

// ============================================================
// [7] 不撞名的子分类保持 NORMAL —— 不被错杀成 COMPLETED
// ============================================================
console.log('\n[7] 不在 COMPLETED_KEYS 的子分类保持 NORMAL（不被错杀）');
{
  // 「mytasks」不在 COMPLETED_KEYS / OTHER_TASKS_KEYS / TRASH_KEYS 任何保留名列表里
  // —— parser 解析为 NORMAL 子分类，_consolidateCompleted 第一段不会动它。
  // 名字也不撞 COMPLETED_NAME，所以正名分支不触发。
  const md = `# 全部任务

## 工作

- [ ] a

## mytasks

- [ ] b
`;
  const store = makeStore(md);

  // _ensureCompletedCategory 会无条件保证 1 个空 COMPLETED 分类存在（UI 入口兜底），
  // 所以这里只能验证「mytasks 没被错合并进 COMPLETED」，且「COMPLETED 是空的」。
  const completed = store.getCompletedCategory();
  check('COMPLETED 分类是空（mytasks 任务未被错误搬进）',
    completed?.tasks?.length === 0,
    `completed tasks: ${completed?.tasks?.map(t => t.text).join(',')}`);

  // 关键不变量：mytasks 是 NORMAL 子分类，没被改名为「已完成任务」/parentOtherTasks=false
  const mytasks = store.categories.find(c => c.name === 'mytasks');
  check('`## mytasks` 仍是 NORMAL 子分类（未正名/未挂到 kind=COMPLETED 上）',
    mytasks?.kind === 'normal' && mytasks?.parentOtherTasks === true,
    `kind=${mytasks?.kind}, parentOtherTasks=${mytasks?.parentOtherTasks}`);

  // 工作分类还在，未被错误归入已完成
  const work = store.getCategory('工作');
  check('工作分类未被吃',
    work?.tasks?.length === 1 && work.tasks[0].text === 'a',
    `work tasks: ${work?.tasks?.map(t => t.text).join(',')}`);
}

printSummary('check-completed-consolidate');
