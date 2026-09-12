// 一次性验证脚本：分类 API 的「拒绝保留名」守卫。
//
// 背景：store 里有几个「保留分类名」（今天类 / 全部任务类 / 回收站类，以及它们的英文别名）。
// 这些名字承担固定语义：今天类是智能视图的数据源，全部任务是子分类容器，回收站
// 是删除任务的暂存地。如果让用户给子分类起名为「回收站」，同名冲突会让 getCategory
// 只命中第一个，删除/恢复路径从此走错。
//
// 守卫点（在 task-store.js 里）：
//   - addSubCategory(name)     → 拒绝保留名，返回 null
//   - renameCategory(old, new) → 拒绝把已有分类改名为保留名，返回 false
//   - deleteCategory(name)     → 拒绝删 TODAY / OTHER_TASKS / TRASH
//                                以及「未分类」（兜底，必须始终存在）
//   - addTask(name, text)      → 拒绝向容器 / 回收站添加任务（前者不存任务，
//                                后者只接受 deleteTask 进入）
//
// 旧实现里这些守卫被静默写好，但 check-trash-fuzz 只覆盖了「以『回收站』为
// 目标名」的几种攻击姿势。剩余的（子分类改名成保留名、英文别名大小写变体、
// addTask 越界）走的是另一条路径，没被覆盖。这份脚本是补漏。
//
// 用法：node scripts/check-category-guards.mjs

import { TaskStore, UNCATEGORIZED_NAME, OTHER_TASKS_NAME, TRASH_NAME } from '../src/task-store.js';
import { CategoryKind, TODAY_KEYS, OTHER_TASKS_KEYS, TRASH_KEYS } from '../src/markdown-parser.js';
import { check, ok, bad, summary, printSummary } from './_lib/check.mjs';
import { makeStore } from './_lib/store-fixture.mjs';

console.log('[1] addSubCategory 拒绝保留名');

{
  const store = makeStore();
  // 中文保留名（这里覆盖每个 keys 集合的第一个值，足以代表整组）
  for (const name of ['当前任务', '今天', '今日', '全部任务', '其他任务', '待办任务', '回收站', '垃圾桶']) {
    const before = store.categories.length;
    const result = store.addSubCategory(name);
    check(
      `addSubCategory('${name}') 返回 null`,
      result === null,
      `实际返回 ${JSON.stringify(result)}`
    );
    check(
      `categories 长度未变（${name} 没被建出）`,
      store.categories.length === before,
      `${before} → ${store.categories.length}`
    );
  }
}

{
  const store = makeStore();
  // 英文 / 空格变体：保留名匹配是 lower + trim，所以大小写、零散空格都得拦
  // 注意：不测 SMART_LIST_KEYS（如 'all tasks' / 'completed tasks' / 'important'）。
  // 那些是 h1 智能列表段的别名 —— 写为 ## 时跟普通子分类一样被 parser 正确分类，
  // 不会丢数据；强制禁掉反而禁掉合理的英文命名（"All Tasks for Project X"）。
  for (const name of ['TODAY', 'Today', 'my day', 'todo', 'to do', 'Trash', 'Recycle Bin']) {
    const result = store.addSubCategory(name);
    check(
      `addSubCategory('${name}') 大小写/空格变体也被拒绝`,
      result === null,
      `实际返回 ${JSON.stringify(result)}`
    );
  }
}

{
  const store = makeStore();
  // 已存在的子分类不能重复建（用「副业」避开 loadDefault 的内置「工作/学习/生活/未分类」）
  const ok1 = store.addSubCategory('副业');
  const ok2 = store.addSubCategory('副业');
  check('addSubCategory 首次成功', ok1 !== null && ok1.name === '副业');
  check('addSubCategory 重复同名返回 null', ok2 === null, `实际 ${JSON.stringify(ok2)}`);
  // 空名 / 纯空白名也直接拒
  check('addSubCategory("") 返回 null', store.addSubCategory('') === null);
  check('addSubCategory("   ") 返回 null', store.addSubCategory('   ') === null);
  check('addSubCategory(null) 返回 null', store.addSubCategory(null) === null);
  check('addSubCategory(undefined) 返回 null', store.addSubCategory(undefined) === null);
}

console.log('\n[2] renameCategory 拒绝把已有分类改成保留名');

{
  const store = makeStore();
  store.addSubCategory('副业');
  store.addSubCategory('阅读');

  for (const newName of ['当前任务', '今日', '全部任务', '回收站', 'TODAY', 'trash']) {
    const ok = store.renameCategory('副业', newName);
    check(
      `rename('副业' → '${newName}') 返回 false`,
      ok === false,
      `实际返回 ${JSON.stringify(ok)}`
    );
    check(
      `「副业」的名字没被改成「${newName}」`,
      store.getCategory('副业') !== null,
      `当前存在的分类：${store.categories.map(c => c.name).join('、')}`
    );
  }
}

console.log('\n[2b] renameCategory 拒绝重命名「未分类」本身');

{
  // 「未分类」是任务兜底，它的字符串名是 store / parser / writer 共用的魔法标识符。
  // 一旦改名，下次删除别的有任务的子分类时，_getOrCreateUncategorizedCategory 找不到
  // cat.name === '未分类'，会凭空新建一个同名空分类，把释放任务丢进去 —— 用户
  // 改名的那个旧分类就成了孤儿，并且 markdown 写出去再读回来时还会进一步分裂。
  // renameCategory 必须把这条路径堵死，与 deleteCategory 的「未分类」拦截对称。
  const store = makeStore();
  store.addTask(UNCATEGORIZED_NAME, '兜底里的任务');

  const ok = store.renameCategory(UNCATEGORIZED_NAME, '其他');
  check(
    `rename('${UNCATEGORIZED_NAME}' → '其他') 返回 false`,
    ok === false,
    `实际返回 ${JSON.stringify(ok)}`
  );
  check(
    `「${UNCATEGORIZED_NAME}」名字没动`,
    store.getCategory(UNCATEGORIZED_NAME) !== null,
    `当前存在的分类：${store.categories.map(c => c.name).join('、')}`
  );
  // 兜底任务也不能丢
  check(
    `兜底里的任务仍归属「${UNCATEGORIZED_NAME}」`,
    store.getCategory(UNCATEGORIZED_NAME).tasks.length === 1
  );

  // 进一步：用「副业」做目标也不允许 —— 否则用户照样能把「未分类」换成自己的
  // 名字再触发同样的孤儿分裂。
  const ok2 = store.renameCategory(UNCATEGORIZED_NAME, '副业');
  check('rename(未分类 → 副业) 也被拒绝', ok2 === false);
  check('「未分类」依旧存在（未被改成「副业」）',
    store.getCategory(UNCATEGORIZED_NAME) !== null);
}

console.log('\n[2c] 「其他」作为普通子分类名可用（非保留名）');

{
  // 「其他」与「未分类」语义不同：前者是用户主动建的命名分类，后者是系统兜底。
  // 之前「其他」被误放进 OTHER_TASKS_KEYS（容器别名），导致 addSubCategory /
  // renameCategory / UI 校验全把它当保留名拒掉。回归这条用例锁住新语义。

  // 1) 新建「其他」子分类应成功
  const store = makeStore();
  const cat = store.addSubCategory('其他');
  check(
    `addSubCategory('其他') 返回新分类`,
    cat !== null && cat.name === '其他' && cat.parentOtherTasks === true,
    `实际返回 ${JSON.stringify(cat)}`
  );

  // 2) 「其他」与「未分类」可以共存 —— 这是这次产品决策的核心
  check(
    `「未分类」兜底未动`,
    store.getCategory(UNCATEGORIZED_NAME) !== null
  );
  check(
    `「其他」与「未分类」并存`,
    store.getCategory('其他') !== null && store.getCategory(UNCATEGORIZED_NAME) !== null
  );

  // 3) renameCategory 不拦截「其他」作为目标名
  const store2 = makeStore();
  store2.addSubCategory('杂事');
  const ok = store2.renameCategory('杂事', '其他');
  check(
    `renameCategory('杂事' → '其他') 成功`,
    ok === true && store2.getCategory('其他') !== null,
    `实际 ok=${ok}，getCategory('其他')=${store2.getCategory('其他')}`
  );

  // 4) 加载后空「其他」不再被静默改成「未分类」 —— 防回归到 task-store.js:2381-2395 那段迁移
  const store3 = makeStore();
  store3.addSubCategory('其他');
  store3._ensureBaseStructure();
  check(
    `空「其他」在加载后仍叫「其他」（不被静默改名为「未分类」）`,
    store3.getCategory('其他') !== null && store3.getCategory('其他').name === '其他'
  );
  check(
    `「未分类」依然作为兜底存在（与「其他」共存）`,
    store3.getCategory(UNCATEGORIZED_NAME) !== null
  );
}

console.log('\n[3] deleteCategory 拒绝破坏特殊分类');

{
  const store = makeStore();
  // loadDefault 已建出 工作/学习/生活/未分类。先在「工作」里加一条任务，然后
  // deleteTask → 回收站被 _getOrCreateTrashCategory 懒创建出来。
  // 这一步是为了让后续 deleteCategory(回收站) 真的命中 idx >= 0 的分支 —— 否则
  // 回收站不存在时 deleteCategory 走 idx < 0 的提前 return，守卫代码根本没被执行。
  store.addTask('工作', '待删');
  store.deleteTask('工作', store.getCategory('工作').tasks[0].id);
  const ok1 = store.deleteCategory(TRASH_NAME);
  check('deleteCategory(回收站) 返回 false', ok1 === false);
  check('回收站分类仍存在', store.getTrashCategory() !== null);

  const ok2 = store.deleteCategory(OTHER_TASKS_NAME);
  check('deleteCategory(全部任务) 返回 false', ok2 === false);
  check('全部任务容器仍存在', store.categories.some(c => c.kind === CategoryKind.OTHER_TASKS));

  const ok3 = store.deleteCategory(UNCATEGORIZED_NAME);
  check('deleteCategory(未分类) 返回 false', ok3 === false);
  check('「未分类」兜底仍存在', store.getCategory(UNCATEGORIZED_NAME) !== null);
}

console.log('\n[4] addTask 拒绝向容器 / 回收站添加任务');

{
  const store = makeStore();
  // 容器本身
  const t1 = store.addTask(OTHER_TASKS_NAME, '偷渡到容器');
  check('addTask(全部任务) 返回 null', t1 === null);
  // 容器没有被「污染」 —— 任务列表长度为 0
  const container = store.getCategory(OTHER_TASKS_NAME);
  check('容器不持任务（addTask 越界后 tasks 仍为 0）',
    container && container.tasks.length === 0);

  // 回收站 —— 只能由 deleteTask 进入，普通 addTask 必须拒绝
  const t2 = store.addTask(TRASH_NAME, '偷渡到回收站');
  check('addTask(回收站) 返回 null', t2 === null);
  // 拒绝后回收站仍然不存在 —— 因为 addTask 失败不会触发 _getOrCreateTrashCategory，
  // 后续 deleteTask 才会建出。这正是想要的「懒创建」行为。
  check('拒绝 addTask 后回收站仍未被创建（懒创建）',
    store.getTrashCategory() === null);
}

console.log('\n[5] 已存在「未分类」时，删它仍被拒绝');

{
  // 防止用户在有子分类的情况下意外删掉「未分类」—— 否则下次删别的分类，
  // 释放出的任务无家可归（_getOrCreateUncategorizedCategory 会再建，但语义是降级而非「正常」）。
  const store = makeStore();
  store.addSubCategory('副业');
  const ok = store.deleteCategory(UNCATEGORIZED_NAME);
  check('已存在「副业」时仍拒绝删「未分类」', ok === false);
}

console.log('\n[6] reorderSubCategory 不会让「未分类」漂离底部');

{
  // 「未分类」固定排在子分类末尾（_normalizeOrder 内部约定）。任何让它移动的重排都会被
  // _normalizeOrder 在下次加载时拉回 —— 用户看到的就是"我拖了它又自己跑回去"。
  // store 层必须把这条路径堵住，避免 UI 之外的入口（IPC、自动化脚本）触发。
  const store = makeStore();
  // 默认就有「工作 / 学习 / 生活 / 未分类」四个，按 _getSubCategories 顺序
  const subs = store.getSubCategories();
  const uIdx = subs.findIndex(c => c.name === UNCATEGORIZED_NAME);
  check(`「${UNCATEGORIZED_NAME}」在子分类数组中（默认就存在）`, uIdx >= 0);
  check(`「${UNCATEGORIZED_NAME}」在最后一位（默认排末尾）`, uIdx === subs.length - 1);

  // 1) 试图把「未分类」拖到中间 —— 被拒
  if (uIdx > 0) {
    const ok = store.reorderSubCategory(uIdx, 0, true);
    check(`reorder(未分类 → 0) 返回 false`, ok === false,
      `实际 ${JSON.stringify(ok)}`);
  }

  // 2) 试图把别的分类拖到「未分类」所在位置（让它跑到「未分类」前面 / 后面）——
  //    toIndex 在「未分类」上也必须被拒，否则"未分类"会被挤到中间。
  if (subs.length >= 2 && uIdx > 0) {
    const ok = store.reorderSubCategory(0, uIdx, true);
    check(`reorder(0 → 未分类) 返回 false（不允许把别的分类拖到未分类位置）`,
      ok === false, `实际 ${JSON.stringify(ok)}`);
  }

  // 3) 但同方向调整非「未分类」之间的相对顺序必须依然能成功（不破坏正常拖拽）
  const subs2 = store.getSubCategories();
  if (subs2.length >= 3) {
    const ok = store.reorderSubCategory(0, 2, true);
    check(`reorder(0 → 2) 仍允许（不影响「未分类」外其它分类的正常拖拽）`,
      ok === true, `实际 ${JSON.stringify(ok)}`);
  }

  // 4) 反向 (swap 语义) 同样：把 2 → 0 不经过「未分类」应该是 ok
  const subs3 = store.getSubCategories();
  if (subs3.length >= 3) {
    const ok = store.reorderSubCategory(2, 0, false);
    check(`reorder(2 → 0, dropAbove=false) 仍允许`,
      ok === true, `实际 ${JSON.stringify(ok)}`);
  }
}

console.log('\n' + '='.repeat(64));
console.log(`结果：${summary.pass} 通过, ${summary.fail} 失败`);
console.log('='.repeat(64));
process.exit(summary.fail > 0 ? 1 : 0);
