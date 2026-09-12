// 一次性验证脚本：回收站语义 —— 删除即「移到回收站」，且任何删除都不可在软件内彻底丢弃。
//
// 关键：只检查内存状态是不够的 —— 用户的真相之源是 Markdown 文件。所以每个用例都做
//   内存变更 → serialize() → parseMarkdown() → 重新数任务
// 这才能证明被删的任务真的落在文件里的「# 回收站」下，而不是只活在内存里。
//
// 用法：node scripts/check-trash.mjs

import { TaskStore, TRASH_NAME, OTHER_TASKS_NAME, COMPLETED_NAME } from '../src/task-store.js';
import { check, ok, bad, summary, printSummary } from './_lib/check.mjs';
import { makeStore } from './_lib/store-fixture.mjs';
import { parseMarkdown, CategoryKind } from '../src/markdown-parser.js';

// 往返：serialize 出来再 parse 回来，返回 parse 后的 categories
// （parseMarkdown 直接返回数组，不是 { categories }）
function roundTrip(store) {
  return parseMarkdown(store.serialize());
}

function findCat(categories, name) {
  return categories.find(c => c.name === name) || null;
}

function texts(cat) {
  return (cat?.tasks || []).map(t => t.text);
}

function totalTasks(categories) {
  return categories.reduce((n, c) => n + (c.tasks?.length || 0), 0);
}

const DOC = `# 当前任务

- [ ] 今天写周报
- [✓] today 已完成 ⭐

# 全部任务

## 工作

- [ ] 工作任务A
- [✓] 工作已完成B

## 未分类

- [ ] 杂事C
`;

// ============================================================
// v3 起没有 TODAY 真实分类 —— DOC 里的 `# 当前任务` 章节在加载时被
// _migrateTodayCategory 迁移到了「未分类」子分类（迁移策略优先未分类），
// 任务打上 @当前 标记。所以测试用「未分类」代替 v2 时代的「当前任务」。
// ============================================================
const TODAY_SUB = '未分类';

console.log('\n[1] 删除任务 = 移到回收站，且经 Markdown 往返仍在');
{
  const store = makeStore(DOC);
  const before = totalTasks(store.categories);
  const today = store.getCategory(TODAY_SUB);
  const victim = today.tasks.find(t => t.text === '今天写周报');

  const ok = store.deleteTask(TODAY_SUB, victim.id);
  check('deleteTask 返回 true', ok === true, `实际 ${ok}`);
  check('任务已离开原分类', !texts(store.getCategory(TODAY_SUB)).includes('今天写周报'));
  check('任务出现在内存回收站', texts(store.getTrashCategory()).includes('今天写周报'));
  check('任务总数不变（未丢弃）', totalTasks(store.categories) === before,
    `${before} → ${totalTasks(store.categories)}`);

  const md = store.serialize();
  check('序列化出现「# 回收站」', md.includes(`# ${TRASH_NAME}`), md);
  check('「# 回收站」排在所有 ## 子分类之后',
    md.lastIndexOf('## ') < md.indexOf(`# ${TRASH_NAME}`),
    `子分类末位 ${md.lastIndexOf('## ')} / 回收站 ${md.indexOf(`# ${TRASH_NAME}`)}`);

  const rt = roundTrip(store);
  check('往返后回收站里仍有该任务', texts(findCat(rt, TRASH_NAME)).includes('今天写周报'),
    JSON.stringify(texts(findCat(rt, TRASH_NAME))));
  check('往返后原分类里没有该任务',
    !texts(findCat(rt, TODAY_SUB)).includes('今天写周报'));
  check('往返后任务总数不变', totalTasks(rt) === before, `${before} → ${totalTasks(rt)}`);
  check('往返后子分类没被吞掉（工作/未分类都在，且仍挂在容器下）',
    findCat(rt, '工作')?.parentOtherTasks === true && findCat(rt, '未分类')?.parentOtherTasks === true,
    JSON.stringify(rt.map(c => `${c.name}:${c.kind}:${c.parentOtherTasks}`)));
  check('往返后回收站 kind=TRASH', findCat(rt, TRASH_NAME)?.kind === CategoryKind.TRASH);
}

// ============================================================
console.log('\n[2] 回收站内不能彻底删除（软件里没有任何不可逆入口）');
{
  const store = makeStore(DOC);
  const today = store.getCategory(TODAY_SUB);
  store.deleteTask(TODAY_SUB, today.tasks[0].id);
  const trash = store.getTrashCategory();
  const inTrash = trash.tasks[0];

  const ok = store.deleteTask(TRASH_NAME, inTrash.id);
  check('deleteTask(回收站, …) 返回 false', ok === false, `实际 ${ok}`);
  check('任务仍在回收站', store.getTrashCategory().tasks.length === 1);

  check('clearCompleted(回收站) 不清空回收站', store.clearCompleted(TRASH_NAME) === 0);
  check('deleteCategory(回收站) 返回 false', store.deleteCategory(TRASH_NAME) === false);
  check('回收站分类仍存在', store.getTrashCategory() !== null);
  check('renameCategory(回收站, …) 返回 false',
    store.renameCategory(TRASH_NAME, '我的垃圾') === false);
  // addTask / addSubCategory 的失败约定是返回 null（不是 false）
  check('addTask(回收站, …) 返回 null', store.addTask(TRASH_NAME, '不该出现') === null);
  check('回收站没被塞进新任务', store.getTrashCategory().tasks.length === 1);
  check('addSubCategory 不能占用保留名「回收站」', store.addSubCategory('回收站') === null);
  check('addSubCategory 不能占用别名「trash」', store.addSubCategory('trash') === null);
}

// ============================================================
console.log('\n[3] 回收站排除于智能列表之外（删掉的任务不该继续出现在 重要/全部/已完成）');
{
  const store = makeStore(DOC);
  // v3.4：DOC 里带 [✓] + ⭐ 的任务在加载时已被搬到「# 已完成任务」分类，
  // 不能再去 TODAY_SUB 找（那里只剩「今天写周报」一条）。
  // 测试本意是「删掉一条带 ⭐ 的任务，验证它不再出现在任何智能列表」——
  // 任务从哪个分类删掉不影响语义，换个分类即可。
  const completed = store.getCompletedCategory();
  const starred = completed?.tasks?.find(t => t.important);
  if (!starred) throw new Error('未找到 starred 任务（fixture 异常）');
  store.deleteTask(COMPLETED_NAME, starred.id);

  for (const key of ['important', 'allTasks', 'completed']) {
    const view = store._buildSmartListView(key);
    check(`智能列表「${key}」不含已删除任务`,
      !view.tasks.some(t => t.id === starred.id),
      JSON.stringify(view.tasks.map(t => t.text)));
  }
}

// ============================================================
console.log('\n[4] 清除已完成 = 移到回收站，而不是丢弃');
{
  const store = makeStore(DOC);
  const before = totalTasks(store.categories);
  const n = store.clearCompleted();
  check('clearCompleted 返回移动条数 2', n === 2, `实际 ${n}`);
  check('任务总数不变（都进了回收站）', totalTasks(store.categories) === before,
    `${before} → ${totalTasks(store.categories)}`);
  const rt = roundTrip(store);
  check('往返后两条已完成都在回收站里',
    texts(findCat(rt, TRASH_NAME)).length === 2,
    JSON.stringify(texts(findCat(rt, TRASH_NAME))));
  check('往返后总数仍不变', totalTasks(rt) === before, `${before} → ${totalTasks(rt)}`);
}

// ============================================================
console.log('\n[5] 恢复：从回收站移回分类（复用 moveTask / restoreTask）');
{
  const store = makeStore(DOC);
  const today = store.getCategory(TODAY_SUB);
  store.deleteTask(TODAY_SUB, today.tasks.find(t => t.text === '今天写周报').id);
  const trashTask = store.getTrashCategory().tasks[0];

  const ok = store.moveTask(TRASH_NAME, trashTask.id, '工作');
  // moveTask 现在返回实际生效的目标分类名（防御性改投语义），不再是布尔。
  // 这里任务是 uncompleted → 不触发改投 → 返回值就是用户传的 '工作'。
  check('moveTask(回收站 → 工作) 返回「工作"（uncompleted 不触发改投）',
    ok === '工作', `实际 ${ok}`);
  check('回收站已空', store.getTrashCategory().tasks.length === 0);
  check('任务在「工作」里', texts(store.getCategory('工作')).includes('今天写周报'));

  const md = store.serialize();
  check('回收站空 → 文件里不写「# 回收站」', !md.includes(`# ${TRASH_NAME}`), md);
  const rt = roundTrip(store);
  check('往返后任务仍在「工作」', texts(findCat(rt, '工作')).includes('今天写周报'));
  check('往返后子分类结构完好',
    findCat(rt, '工作')?.parentOtherTasks === true && findCat(rt, '未分类')?.parentOtherTasks === true);
}

// ============================================================
console.log('\n[6] restoreTask 默认回到原分类（v3.5.2+）；无原分类兜底到「未分类」');
{
  const store = makeStore(DOC);

  // 7a) restoreTask 在垃圾任务 / 不存在任务时返回 { ok: false }
  check('无回收站时 restoreTask 返回 { ok: false }', store.restoreTask('nope').ok === false);

  // 7b) 普通路径：从「工作」删除 → trash 记 originalCategory='工作' →
  // 默认 restoreTask 走 _resolveRestoreTarget 命中 'category'，归位到「工作」。
  // 不再走「未分类」兜底（v3.5.1 的旧行为）。
  const work = store.getCategory('工作');
  store.deleteTask('工作', work.tasks.find(t => t.text === '工作任务A').id);
  const id = store.getTrashCategory().tasks[0].id;
  const result = store.restoreTask(id);
  check('restoreTask 返回 { ok: true, restored: true }',
    result.ok === true && result.restored === true,
    `result=${JSON.stringify(result)}`);
  check('默认按原分类归位（v3.5.2+ 新行为）',
    texts(store.getCategory('工作')).includes('工作任务A'),
    `work=${texts(store.getCategory('工作'))}`);
  check('restoreHint.kind === "category" 且带 targetName',
    result.restoreHint && result.restoreHint.kind === 'category' &&
      result.restoreHint.targetName === '工作',
    `restoreHint=${JSON.stringify(result.restoreHint)}`);

  // 7c) 兜底：删另一条后抹掉 originalCategory（模拟很旧的文件） → fallback 到「未分类」
  store.deleteTask('工作', work.tasks.filter(t => t.text === '工作任务A')[0].id);
  const id2 = store.getTrashCategory().tasks[0].id;
  store.getTrashCategory().tasks[0].originalCategory = null;
  const fallbackResult = store.restoreTask(id2);
  check('无 originalCategory 时 restoreHint.kind === "fallback"',
    fallbackResult.restoreHint && fallbackResult.restoreHint.kind === 'fallback',
    `restoreHint=${JSON.stringify(fallbackResult.restoreHint)}`);
  check('fallback 落到「未分类」',
    texts(store.getCategory('未分类')).includes('工作任务A'),
    `uncategorized=${texts(store.getCategory('未分类'))}`);

  // 7d) 显式 toCategoryName 传给非法目标（容器）→ 拒绝、任务留在 trash
  // 用「今天写周报」（在「未分类」里，completed=false）做这条断言：
  //   - completed=true 的任务会被 store 强制路由到「已完成任务」无视 toCategoryName，
  //     不能拿来做"显式无效参数拒绝"的回归
  const today = store.getCategory(TODAY_SUB);
  store.deleteTask(TODAY_SUB, today.tasks.find(t => t.text === '今天写周报').id);
  const id3 = store.getTrashCategory().tasks[0].id;
  const rejectResult = store.restoreTask(id3, OTHER_TASKS_NAME);
  check('不能恢复到容器「全部任务」 → ok: false 且任务留在 trash',
    rejectResult.ok === false && store.getTrashCategory().tasks.length === 1);
}

// ============================================================
console.log('\n[7] 已有「# 回收站」的文件能被认出来，且不会被当成普通分类');
{
  const withTrash = DOC + `
# 回收站

<!-- 手工编辑说明 -->

- [ ] 早先删掉的东西
`;
  const store = makeStore(withTrash);
  const trash = store.getTrashCategory();
  check('解析出 kind=TRASH 的回收站', trash !== null && trash.kind === CategoryKind.TRASH);
  check('回收站里有 1 条任务', trash?.tasks.length === 1, JSON.stringify(texts(trash)));
  check('HTML 注释没被读成任务', !texts(trash).some(t => t.includes('<!--')));
  check('回收站不出现在子分类列表里',
    !store.getSubCategories().some(c => c.kind === CategoryKind.TRASH),
    JSON.stringify(store.getSubCategories().map(c => c.name)));
  check('回收站在 categories 末位',
    store.categories[store.categories.length - 1].kind === CategoryKind.TRASH,
    JSON.stringify(store.categories.map(c => c.name)));
}

// ============================================================
console.log('\n[8] 手工编辑产物：回收站必须收敛成唯一一个，且不丢任务');
{
  // 8a: 两个 # 回收站 → 合并成一个，两边的任务都要在
  const two = `# 当前任务

- [ ] A

# 回收站

- [ ] 第一个回收站的

# 回收站

- [ ] 第二个回收站的
`;
  const s1 = makeStore(two);
  const trashes1 = s1.categories.filter(c => c.kind === CategoryKind.TRASH);
  check('多个「# 回收站」合并为 1 个', trashes1.length === 1,
    `实际 ${trashes1.length} 个`);
  check('两个回收站的任务都保留',
    texts(s1.getTrashCategory()).includes('第一个回收站的') &&
    texts(s1.getTrashCategory()).includes('第二个回收站的'),
    JSON.stringify(texts(s1.getTrashCategory())));
  check('合并后总数不变', totalTasks(s1.categories) === 3,
    `实际 ${totalTasks(s1.categories)}`);
  check('合并后往返仍不丢', totalTasks(roundTrip(s1)) === 3);

  // 8b: ## 回收站 被写成子分类 → 提升为 TRASH，不能与新建的回收站重名
  const asSub = `# 当前任务

- [ ] A

# 全部任务

## 回收站

- [ ] 我被写成了子分类

## 工作

- [ ] W1
`;
  const s2 = makeStore(asSub);
  check('「## 回收站」被提升为 kind=TRASH',
    s2.getTrashCategory()?.kind === CategoryKind.TRASH,
    JSON.stringify(s2.categories.map(c => `${c.name}:${c.kind}`)));
  check('提升后不再是子分类',
    s2.getTrashCategory()?.parentOtherTasks === false);
  check('原有任务跟着保留',
    texts(s2.getTrashCategory()).includes('我被写成了子分类'),
    JSON.stringify(texts(s2.getTrashCategory())));
  check('回收站排到了末位',
    s2.categories[s2.categories.length - 1].kind === CategoryKind.TRASH,
    JSON.stringify(s2.categories.map(c => c.name)));

  // 删一个任务后不能出现同名分类
  // v3：A 在迁移时搬到了首个子分类「工作」（此 DOC 没有「未分类」，所以用 first sub 兜底）
  const workCat = s2.getCategory('工作');
  const aTask = workCat.tasks.find(t => t.text === 'A');
  s2.deleteTask('工作', aTask.id);
  const sameName = s2.categories.filter(c => c.name === TRASH_NAME);
  check('删除任务后没有产生同名「回收站」分类', sameName.length === 1,
    `实际 ${sameName.length} 个`);
  check('被删任务进了唯一的那个回收站',
    texts(s2.getTrashCategory()).includes('A'),
    JSON.stringify(texts(s2.getTrashCategory())));
  check('往返后任务总数不变（3 项）', totalTasks(roundTrip(s2)) === 3,
    `实际 ${totalTasks(roundTrip(s2))}`);

  // 8c: 别名（# trash）也要被认成回收站，且保留用户的写法
  const alias = `# 当前任务

- [ ] A

# trash

- [ ] 英文回收站里的
`;
  const s3 = makeStore(alias);
  check('别名「# trash」识别为 TRASH',
    s3.getTrashCategory()?.kind === CategoryKind.TRASH);
  check('别名不丢任务', texts(s3.getTrashCategory()).includes('英文回收站里的'));
}

// ============================================================
console.log('\n[9] 正看着回收站时把它恢复空了 —— 选中项要跟着任务走，不能停在隐藏的分类上');
{
  const store = makeStore(DOC);
  const today = store.getCategory(TODAY_SUB);

  // 只删一条 → 回收站里只有 1 项
  store.deleteTask(TODAY_SUB, today.tasks.find(t => t.text === '今天写周报').id);
  store.selectCategory(TRASH_NAME);
  check('已选中回收站', store.getSelectedCategory()?.name === TRASH_NAME);

  // 恢复最后一条 → 回收站空了，侧边栏会隐藏它，选中项必须转移
  store.restoreTask(store.getTrashCategory().tasks[0].id, '工作');
  check('回收站空后选中项跟到「工作」',
    store.getSelectedCategory()?.name === '工作',
    `实际停在「${store.getSelectedCategory()?.name}」`);
  check('不会停在被隐藏的回收站上',
    store.getSelectedCategory()?.kind !== CategoryKind.TRASH);

  // 还有剩余时不该乱跳
  const store2 = makeStore(DOC);
  const t2 = store2.getCategory(TODAY_SUB);
  store2.deleteTask(TODAY_SUB, t2.tasks[0].id);
  store2.deleteTask(TODAY_SUB, t2.tasks[0].id);
  store2.selectCategory(TRASH_NAME);
  store2.restoreTask(store2.getTrashCategory().tasks[0].id, '工作');
  check('回收站还有剩余时保持停留在回收站',
    store2.getSelectedCategory()?.name === TRASH_NAME,
    `实际跳到「${store2.getSelectedCategory()?.name}」`);

  // moveTask 走的恢复路径同样要跟随
  const store3 = makeStore(DOC);
  const t3 = store3.getCategory(TODAY_SUB);
  store3.deleteTask(TODAY_SUB, t3.tasks[0].id);
  store3.selectCategory(TRASH_NAME);
  store3.moveTask(TRASH_NAME, store3.getTrashCategory().tasks[0].id, '未分类');
  check('moveTask 清空回收站后也跟随到目标分类',
    store3.getSelectedCategory()?.name === '未分类',
    `实际停在「${store3.getSelectedCategory()?.name}」`);
}

// ============================================================
// [10] 手工编辑文件后重新加载 —— 这是「彻底删除」的唯一途径，绝不能吃任务
//
// 软件刻意不提供「清空回收站」，官方指引就是「自己打开 Markdown 删掉那一行」。
// 所以「手工编辑过的文件」是一等公民路径，它上面的任何一处数据丢失都比普通
// bug 严重：用户是照着我们的说明书操作，结果丢了别的任务。
// ============================================================
{
  console.log('\n[10] 手工编辑过的文件重新加载：不吃任务、不误判归属');

  // ---- 10a. 旧文件 id 注释 + 手工新增行混合 ----
  // 旧文件中残留的 `<!-- id:tN -->`（写时器 v3+ 不再写入，但历史文件可能仍有）
  // 会被解析器剥掉，然后所有任务由解析器末尾的统一计数器重新分配 t1/t2/...
  // 这里验证：手工新增的没有 id 注释的行也能被正确收进来，不被忽略或丢弃。
  const HAND_EDITED = [
    '# 当前任务', '',
    '- [ ] 任务一 <!-- id:t1 -->',
    '- [ ] 手写任务甲',
    '- [ ] 任务三 <!-- id:t3 -->',
    '- [ ] 手写任务乙', '',
    '# 回收站', '',
    '- [ ] 我被删过 <!-- id:t2 -->', ''
  ].join('\n');

  const cats = parseMarkdown(HAND_EDITED);
  const allTexts = cats.flatMap(c => c.tasks.map(t => t.text));
  check('手工新增的无 id 行不会撞掉已有任务（5 条全在）',
    allTexts.length === 5,
    `实际 ${allTexts.length} 条：${allTexts.join(' | ')}`);
  for (const want of ['任务一', '手写任务甲', '任务三', '手写任务乙', '我被删过']) {
    check(`  保留「${want}」`, allTexts.includes(want));
  }
  const ids = cats.flatMap(c => c.tasks.map(t => t.id));
  check('分配后 id 全局唯一', new Set(ids).size === ids.length, ids.join(','));
  const hTrash = cats.find(c => c.kind === CategoryKind.TRASH);
  check('回收站没有整节消失', !!hTrash && hTrash.tasks.length === 1);

  // ---- 10b. 用户整行复制（含 id 注释）→ 两条真实任务 ----
  // v3+ 解析器不再从文件里读 id，所以两行都会剥离 id 注释，
  // 然后由解析器末尾的统一计数器分配独立 id。两条任务都保留。
  const DUP_ID = [
    '# 当前任务', '',
    '- [ ] 原始 <!-- id:t1 -->',
    '- [ ] 复制出来的 <!-- id:t1 -->', ''
  ].join('\n');
  const dupCats = parseMarkdown(DUP_ID);
  const dupTexts = dupCats.flatMap(c => c.tasks.map(t => t.text));
  check('复制行的两条任务都保留（不丢一条）',
    dupTexts.length === 2 && dupTexts.includes('原始') && dupTexts.includes('复制出来的'),
    dupTexts.join(' | '));
  const dupIds = dupCats.flatMap(c => c.tasks.map(t => t.id));
  check('两条任务由解析器分配不同的 id',
    new Set(dupIds).size === 2, dupIds.join(','));

  // ---- 10c. 在「# 回收站」后面接着写 ## 分类 ----
  // 回收站是文件最后一节，手工编辑时在它后面往下写是很自然的动作。
  // 若这些任务继承了回收站，活跃任务会被标成「已删除」，而且下次保存时
  // 这个 `##` 标题会彻底消失。
  const AFTER_TRASH = [
    '# 当前任务', '',
    '- [ ] 活着的', '',
    '# 回收站', '',
    '- [ ] 已删除的', '',
    '## 我手写的分类', '',
    '- [ ] 我不该被当成已删除', ''
  ].join('\n');
  const atCats = parseMarkdown(AFTER_TRASH);
  const atTrash = atCats.find(c => c.kind === CategoryKind.TRASH);
  check('回收站里只有真正被删的那条',
    atTrash && atTrash.tasks.length === 1 && atTrash.tasks[0].text === '已删除的',
    atTrash ? atTrash.tasks.map(t => t.text).join(' | ') : '(无回收站)');
  const atAll = atCats.flatMap(c => c.tasks.map(t => t.text));
  check('回收站之后的任务没有丢', atAll.includes('我不该被当成已删除'), atAll.join(' | '));

  const atStore = makeStore(AFTER_TRASH);
  const atRT = roundTrip(atStore);
  const atRTTrash = atRT.find(c => c.kind === CategoryKind.TRASH);
  check('往返后仍不在回收站里',
    !atRTTrash || !atRTTrash.tasks.some(t => t.text === '我不该被当成已删除'));
  check('往返后总数不变（3 条）',
    atRT.reduce((n, c) => n + c.tasks.length, 0) === 3);

  // ---- 10d. 叫 bin / trash / 垃圾桶 的**子分类**不该被改判成回收站 ----
  // 需要「正名」的唯一理由是和软件自己创建的「回收站」重名冲突；别名不冲突，
  // 强行改判会把用户一整个装着活跃任务的分类标成已删除，标题也随之消失。
  for (const alias of ['bin', 'trash', '垃圾桶']) {
    const ALIAS_SUB = [
      '# 当前任务', '',
      '# 全部任务', '',
      `## ${alias}`, '',
      '- [ ] 我是活跃任务', ''
    ].join('\n');
    const aStore = makeStore(ALIAS_SUB);
    const aCat = aStore.getCategory(alias);
    check(`子分类「${alias}」保持普通分类（不被判成回收站）`,
      aCat && aCat.kind !== CategoryKind.TRASH,
      aCat ? `kind=${aCat.kind}` : '(分类不见了)');
    check(`  「${alias}」里的任务没被当成已删除`,
      !aStore.getTrashCategory() ||
      !aStore.getTrashCategory().tasks.some(t => t.text === '我是活跃任务'));
    const aRT = roundTrip(aStore);
    check(`  往返后「## ${alias}」这一节还在`,
      !!findCat(aRT, alias) && findCat(aRT, alias).tasks.length === 1);
  }
}

// ============================================================
// [11] v3.6 起不再写顶部 # 当前任务 / # 重要任务 镜像段：[▶]/[⭐] 由 inline 标识
// 承载，智能视图在内存中按标识聚合。文件里同一条任务只活一次 —— 顶部不再重复。
//
// 本节回归：v3.x 顶部镜像段在旧文件里可能仍然存在 ——
//   - # 当前任务 → TODAY 分类（store 的 _migrateTodayCategory 搬到首个子分类并打 [▶]）
//   - # 重要任务 → SMART_LIST_KEYS 命中，__skip__ 整段跳过、任务归「未分类」
// 下一次保存即扁平化为新结构 —— 不会丢数据。
//
// 「# 已完成任务」v3.4 起是真实分类（kind=COMPLETED），与「回收站」同款；
// 段下带 [✓] 的任务自动收入并标记 completed=true。
// ============================================================
{
  console.log('\n[11] v3.6 不再写顶部镜像段：旧文件镜像段消化路径');

  // ---- 11a. v3.6 writer 不再生成 # 当前任务 / # 重要任务 顶部镜像段 ----
  //
  // 从旧格式文件加载（# 当前任务 是 TODAY 临时分类），clearCompleted 把 [x] 的「做完了」
  // 移入回收站后序列化为 v3.6 新格式 —— 文件开头**不再**含顶部镜像段。
  const s = makeStore('# 当前任务\n\n- [x] 做完了\n- [ ] 重要的 ⭐\n- [ ] 普通的\n');
  s.clearCompleted();
  const md = s.serialize();
  check('写入器不再输出「# 当前任务」顶部镜像段',
    !md.includes('# 当前任务'), md.split('\n').slice(0, 6).join('\n'));
  check('写入器不再输出「# 重要任务」顶部镜像段',
    !md.includes('# 重要任务'), md.split('\n').slice(0, 6).join('\n'));
  check('写入器不再带「顶部摘要」引导注释',
    !md.includes('<!-- 顶部摘要'), md.split('\n').slice(0, 6).join('\n'));
  // v3.4 起仍不输出 # 已完成任务 镜像段 —— 它是真实分类（kind=COMPLETED），
  // 段下任务由 store 自动搬入（这里没有已完成任务，所以不写）。
  check('写入器不输出「# 已完成任务」镜像段（无人打过勾）',
    !md.includes('# 已完成任务'), md);
  // v3：重要任务由 ⭐ inline 标识驱动，标识位置仍在每条任务行末
  check('任务的 ⭐ 标识原样保留在文件中',
    md.includes('⭐'), md);

  const rt = parseMarkdown(md);
  // 「做完了」在回收站里，源任务三条；新格式下镜像段不存在，不会翻倍。
  check('v3.6 文件往返后总数仍是 3（已删除那条在回收站、未被翻倍计入）',
    rt.reduce((n, c) => n + c.tasks.length, 0) === 3,
    rt.flatMap(c => c.tasks.map(t => t.text)).join(' | '));
  check('已删除的「做完了」仍在回收站',
    rt.find(c => c.kind === CategoryKind.TRASH)?.tasks.some(t => t.text === '做完了'));

  // 二次往返：确认不是「刚好第一次没翻倍」
  const s2 = makeStore(md);
  check('二次往返总数仍为 3',
    parseMarkdown(s2.serialize()).reduce((n, c) => n + c.tasks.length, 0) === 3);

  // ---- 11b. 旧文件里残留的「# 重要任务」段被消化 —— __skip__ 整段跳过 ----
  // 这是手工升级路径最重要的保证：旧文件被打开 → 解析 → 第一次保存后扁平化。
  // 「# 重要任务」作为 SMART_LIST_KEYS 命中被 parser 整体跳过；段下手写行落到「未分类」
  // （保守策略 —— 宁可多一条需要用户挪动的任务，也不要少一条）。
  //
  // 「# 已完成任务」v3.4 起是真实分类（kind=COMPLETED），段下带 [✓] 的任务归入并标记 completed。
  const LEGACY_FILE = [
    '# 全部任务', '',
    '## 工作', '',
    '- [ ] 工作任务A', '',
    '# 重要任务', '',
    '- [ ] 镜像段里的工作A', '',
    '# 已完成任务', '',
    '- [x] 镜像段里的已完成A', '',
    '# 回收站', '',
    '- [ ] 已删除A', ''
  ].join('\n');
  const legacy = parseMarkdown(LEGACY_FILE);
  const allTexts = legacy.flatMap(c => c.tasks.map(t => t.text));
  check('「# 重要任务」旧镜像段没有进入 categories',
    !legacy.some(c => c.name === '重要任务'),
    legacy.map(c => c.name).join(' / '));
  const legacyCompleted = legacy.find(c => c.name === '已完成任务');
  check('「# 已完成任务」是真实分类（kind=COMPLETED）',
    !!legacyCompleted && legacyCompleted.kind === CategoryKind.COMPLETED,
    legacy.map(c => `${c.name}(${c.kind})`).join(' / '));
  check('旧镜像段下带 [✓] 的「镜像段里的已完成A」进入「# 已完成任务」并带 completed=true',
    legacyCompleted?.tasks?.some(t => t.text === '镜像段里的已完成A' && t.completed === true),
    legacyCompleted?.tasks?.map(t => `${t.text}(${t.completed})`).join(' | '));
  check('真实分类里的任务不丢',
    allTexts.includes('工作任务A') && allTexts.includes('已删除A'),
    allTexts.join(' | '));
  // 「# 重要任务」镜像段下的手写行落到「未分类」—— 4 条全部保留
  check('「# 重要任务」镜像段下的手写任务也未丢，归入「未分类」',
    allTexts.length === 4 &&
      allTexts.includes('镜像段里的工作A') &&
      allTexts.includes('镜像段里的已完成A'),
    allTexts.join(' | '));

  // ---- 11c. 旧文件把「# 当前任务」段放到文件前面 —— TODAY 迁移路径 ----
  //
  // v3.6 解析器对用户手敲的 `# 当前任务` 仍然识别为 TODAY 分类（兼容旧文件），
  // store 的 _migrateTodayCategory 会把任务搬到首个子分类、打上 [▶] 标记、
  // 删除临时分类 —— 不会丢数据。
  const REORDERED = [
    '# 已完成任务', '',
    '<!-- 所有已勾选的任务，从各分类自动聚合 -->', '',
    '- [✓] 做完了 <!-- id:t1 -->', '',
    '# 当前任务', '',
    '- [✓] 做完了 <!-- id:t1 -->',
    '- [ ] 没做完 <!-- id:t2 -->', ''
  ].join('\n');
  const ro = parseMarkdown(REORDERED);
  // 「# 已完成任务」是真实分类，下面的「做完了」按真实分类归属
  const roCompleted = ro.find(c => c.name === '已完成任务');
  check('「# 已完成任务」是真实分类（kind=COMPLETED）',
    !!roCompleted && roCompleted.kind === CategoryKind.COMPLETED,
    ro.map(c => `${c.name}(${c.kind})`).join(' / '));
  check('「# 已完成任务」下「做完了」带 completed=true',
    roCompleted?.tasks?.some(t => t.text === '做完了' && t.completed === true),
    ro.flatMap(c => c.tasks.map(t => `${t.text}(${t.completed})`)).join(' | '));
  check('「# 当前任务」TODAY 分类下的两条任务都保留（待 store 迁移）',
    ro.find(c => c.name === '当前任务')?.tasks.length === 2,
    ro.flatMap(c => c.tasks.map(t => t.text)).join(' | '));
  const roAll = ro.flatMap(c => c.tasks.map(t => t.text));
  check('所有 3 条任务都在（不丢数据）',
    roAll.length === 3 && roAll.filter(t => t === '做完了').length === 2 && roAll.includes('没做完'),
    roAll.join(' | '));
}

// ============================================================
// [12] 回收站内 toggleTask 原地切换完成态（不再搬到「已完成任务」）
//
// 旧行为：回收站里打勾 → 任务移到「# 已完成任务」，违背"回收站是删除前的
// 暂存区、用户在那里可以预览/清理"的心智模型（用户报 bug：在回收站里点了
// 「已完成」的打勾，应该还是在回收站里，而不是跑到「已完成任务」里面）。
//
// 修复后：
//   - 回收站里打勾 → 任务**仍留在回收站**，只切 completed 标记
//   - 回收站里清勾 → 同上，留在回收站
//   - originalCategory 不动（恢复时还要靠它归位）
//   - writer 在回收站段照样写出 [✓]，parser 加载时识别 task.completed=true
// ============================================================
console.log('\n[12] 回收站 toggleTask 原地切换完成态（不跨分类）');
{
  // 12a) 回收站里 [ ] → [✓] → 任务仍留回收站，不进「已完成任务」
  const store = makeStore(DOC);
  const today = store.getCategory(TODAY_SUB);
  store.deleteTask(TODAY_SUB, today.tasks.find(t => t.text === '今天写周报').id);
  const trashId = store.getTrashCategory().tasks[0].id;
  const beforeCompleted = store.getCompletedCategory().tasks.length;

  const result = store.toggleTask(TRASH_NAME, trashId);
  check('toggleTask(回收站) 返回 { ok: true }',
    result && result.ok === true, `actual=${JSON.stringify(result)}`);
  check('任务仍在回收站', store.getTrashCategory().tasks.some(t => t.id === trashId));
  check('「已完成任务」分类条数不变（没把任务搬过来）',
    store.getCompletedCategory().tasks.length === beforeCompleted,
    `before=${beforeCompleted} / after=${store.getCompletedCategory().tasks.length}`);
  check('任务 completed === true',
    store.getTrashCategory().tasks.find(t => t.id === trashId).completed === true);

  // writer 写出 [✓]
  const md = store.serialize();
  const trashSection = md.split(`# ${TRASH_NAME}`)[1] || '';
  check('writer 在回收站段写出 [✓]',
    trashSection.includes('[✓]') && trashSection.includes('今天写周报'),
    trashSection.slice(0, 200));

  // 12b) Markdown 往返：task.completed=true 保留在回收站段，不丢、不搬到「已完成任务」
  const rt = roundTrip(store);
  const rtTrash = findCat(rt, TRASH_NAME);
  check('往返后回收站里任务仍带 completed=true',
    rtTrash?.tasks?.some(t => t.text === '今天写周报' && t.completed === true),
    JSON.stringify(rtTrash?.tasks?.map(t => `${t.text}(${t.completed})`)));
  // DOC 本身带 [✓] 任务（被 _consolidateCompleted 搬到「已完成任务」），
  // 但我们刚 toggle 的「今天写周报」不该出现在那里：
  check('往返后「今天写周报」不在「已完成任务」分类里',
    !findCat(rt, COMPLETED_NAME)?.tasks?.some(t => t.text === '今天写周报'),
    JSON.stringify(findCat(rt, COMPLETED_NAME)?.tasks?.map(t => t.text)));

  // 12c) 回收站里 [✓] → [ ] → 任务仍在回收站、不回到「已完成任务」
  store.toggleTask(TRASH_NAME, trashId);
  check('再 toggle 回 [ ]，任务 completed === false',
    store.getTrashCategory().tasks.find(t => t.id === trashId).completed === false);
  check('再 toggle 回 [ ]，任务仍在回收站（不跑到其它分类）',
    store.getTrashCategory().tasks.some(t => t.id === trashId));

  // 12d) originalCategory 不动 —— 恢复时还要靠它归位
  const work = store.getCategory('工作');
  const originalId = work.tasks.find(t => t.text === '工作任务A').id;
  store.deleteTask('工作', originalId);
  const trashedWithOrig = store.getTrashCategory().tasks.find(t => t.text === '工作任务A');
  check('删到回收站后 originalCategory === "工作"（前置）',
    trashedWithOrig?.originalCategory === '工作');
  store.toggleTask(TRASH_NAME, trashedWithOrig.id);
  const afterToggle = store.getTrashCategory().tasks.find(t => t.text === '工作任务A');
  check('回收站里勾选后 originalCategory 仍为 "工作"（不重写）',
    afterToggle?.originalCategory === '工作',
    `actual=${afterToggle?.originalCategory}`);
  store.toggleTask(TRASH_NAME, trashedWithOrig.id); // 清回 [ ]
  check('回收站里清勾后 originalCategory 仍为 "工作"（不重写）',
    afterToggle?.originalCategory === '工作',
    `actual=${store.getTrashCategory().tasks.find(t => t.text === '工作任务A')?.originalCategory}`);
}

// ============================================================
console.log(`\n${'─'.repeat(48)}`);
console.log(`通过 ${summary.pass} / 失败 ${summary.fail}`);
process.exit(summary.fail === 0 ? 0 : 1);
