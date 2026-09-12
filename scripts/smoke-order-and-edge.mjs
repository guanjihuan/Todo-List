// 全面 smoke test：验证外部编辑 → 软件反映

import { TaskStore } from '../src/task-store.js';
import { parseMarkdown, CategoryKind } from '../src/markdown-parser.js';
import { writeMarkdown } from '../src/markdown-writer.js';
import { check, ok, bad, summary, printSummary } from './_lib/check.mjs';
import { makeStore } from './_lib/store-fixture.mjs';
import { installApiStub } from './_lib/api-stub.mjs';

// 桩出 window.api，让 TaskStore 不真去写文件
installApiStub();

// ============================================================
// [1] 外部编辑 → 重新加载 → 顺序保留
// ============================================================
console.log('\n[1] 外部编辑调整顺序 → 重新加载 → 顺序保留');
{
  // 初始：a, b, c
  const initial = `# 全部任务\n\n## 工作\n\n- [ ] a\n- [ ] b\n- [ ] c\n`;
  const store = makeStore(initial);
  const work = store.getCategory('工作');
  check('初始顺序 a/b/c', work.tasks.map(t => t.text).join(',') === 'a,b,c',
    work.tasks.map(t => t.text).join(','));

  // 用户在编辑器里改成 c, a, b（保存 → fs.watch → 重新加载）
  const reordered = `# 全部任务\n\n## 工作\n\n- [ ] c\n- [ ] a\n- [ ] b\n`;
  store.loadFromContent(reordered, null);
  const work2 = store.getCategory('工作');
  check('重载后顺序变为 c/a/b', work2.tasks.map(t => t.text).join(',') === 'c,a,b',
    work2.tasks.map(t => t.text).join(','));

  // 跨分类移动：在工作里把 x 移到最前
  const store2 = makeStore(`# 全部任务\n\n## 工作\n\n- [ ] x\n- [ ] y\n- [ ] z\n\n## 学习\n\n- [ ] k1\n`);
  const store3 = makeStore(`# 全部任务\n\n## 工作\n\n- [ ] y\n- [ ] z\n- [ ] x\n\n## 学习\n\n- [ ] k1\n`);
  check('工作分类 y/z/x 顺序保留',
    store3.getCategory('工作').tasks.map(t => t.text).join(',') === 'y,z,x');

  // 顺序往返：parser → writer → parser
  const md = `# 全部任务\n\n## 工作\n\n- [ ] 第一\n- [ ] 第二\n- [ ] 第三\n`;
  const cats = parseMarkdown(md);
  const written = writeMarkdown(cats);
  const cats2 = parseMarkdown(written);
  const work3 = cats2.find(c => c.name === '工作');
  check('parser→writer→parser 顺序不变',
    work3.tasks.map(t => t.text).join(',') === '第一,第二,第三');
}

// ============================================================
// [2] 外部编辑 → 重新加载 → 文本变更同步
// ============================================================
console.log('\n[2] 外部编辑文本 → 重新加载 → 文本同步');
{
  const initial = `# 全部任务\n\n## 工作\n\n- [ ] 原文本\n`;
  const store = makeStore(initial);

  // 用户改成新文本
  const updated = `# 全部任务\n\n## 工作\n\n- [ ] 新文本\n`;
  store.loadFromContent(updated, null);
  const work = store.getCategory('工作');
  check('文本被新内容覆盖', work.tasks[0].text === '新文本',
    work.tasks[0].text);
  check('仍是 1 条任务', work.tasks.length === 1);
}

// ============================================================
// [3] 外部编辑 → 重新加载 → 删除任务
// ============================================================
console.log('\n[3] 外部编辑删除任务 → 重新加载 → 删除生效');
{
  const initial = `# 全部任务\n\n## 工作\n\n- [ ] a\n- [ ] b\n- [ ] c\n`;
  const store = makeStore(initial);

  const removed = `# 全部任务\n\n## 工作\n\n- [ ] a\n- [ ] c\n`;
  store.loadFromContent(removed, null);
  const work = store.getCategory('工作');
  check('删除中间那条，剩 a/c',
    work.tasks.map(t => t.text).join(',') === 'a,c',
    work.tasks.map(t => t.text).join(','));
}

// ============================================================
// [4] 外部编辑 → 重新加载 → 新增任务
// ============================================================
console.log('\n[4] 外部编辑新增任务 → 重新加载 → 新增生效');
{
  const initial = `# 全部任务\n\n## 工作\n\n- [ ] a\n`;
  const store = makeStore(initial);

  const added = `# 全部任务\n\n## 工作\n\n- [ ] a\n- [ ] 新增的\n`;
  store.loadFromContent(added, null);
  const work = store.getCategory('工作');
  check('新增后 a/新增的',
    work.tasks.map(t => t.text).join(',') === 'a,新增的',
    work.tasks.map(t =>t.text).join(','));
}

// ============================================================
// [5] 跨分类移动（外部编辑）
// ============================================================
console.log('\n[5] 跨分类移动 → 重新加载 → 位置同步');
{
  const initial = `# 全部任务\n\n## 工作\n\n- [ ] taskA\n\n## 学习\n\n- [ ] taskB\n`;
  const store = makeStore(initial);

  const moved = `# 全部任务\n\n## 工作\n\n\n## 学习\n\n- [ ] taskB\n- [ ] taskA\n`;
  store.loadFromContent(moved, null);
  const work = store.getCategory('工作');
  const study = store.getCategory('学习');
  check('taskA 移到学习分类末尾', study.tasks.map(t => t.text).join(',') === 'taskB,taskA');
  check('工作分类变空', work.tasks.length === 0);
}

// ============================================================
// [6] id 运行时分配 + 重新加载重新分配
// ============================================================
console.log('\n[6] 跨重载：task.id 重新分配');
{
  const initial = `# 全部任务\n\n## 工作\n\n- [ ] a\n- [ ] b\n`;
  const store1 = makeStore(initial);
  const work1 = store1.getCategory('工作');
  const ids1 = work1.tasks.map(t => t.id);
  check('初次加载 id 是 t1/t2', ids1.join(',') === 't1,t2', ids1.join(','));

  // 重新加载同样内容
  store1.loadFromContent(initial, null);
  const work2 = store1.getCategory('工作');
  const ids2 = work2.tasks.map(t => t.id);
  check('重新加载后 id 也是 t1/t2（确定性）', ids2.join(',') === 't1,t2', ids2.join(','));
  check('id 字符串相等（基于位置）', ids1.join(',') === ids2.join(','));
}

// ============================================================
// [7] 同名任务在不同分类 → 各自独立 id
// ============================================================
console.log('\n[7] 同名任务在不同分类 → 各自独立');
{
  const md = `# 全部任务\n\n## 工作\n\n- [ ] 买菜\n\n## 生活\n\n- [ ] 买菜\n`;
  const cats = parseMarkdown(md);
  const work = cats.find(c => c.name === '工作');
  const life = cats.find(c => c.name === '生活');
  check('工作和生活都有「买菜」', work.tasks[0].text === '买菜' && life.tasks[0].text === '买菜');
  check('两个 id 不同', work.tasks[0].id !== life.tasks[0].id,
    `工作=${work.tasks[0].id}, 生活=${life.tasks[0].id}`);
}

// ============================================================
// [8] 同名任务在同一分类 → 多个独立任务
// ============================================================
console.log('\n[8] 同名任务在同一分类 → 多个独立');
{
  const md = `# 全部任务\n\n## 工作\n\n- [ ] 买菜\n- [ ] 买菜\n`;
  const cats = parseMarkdown(md);
  const work = cats.find(c => c.name === '工作');
  check('两条「买菜」都在', work.tasks.length === 2);
  check('两条 id 不同', work.tasks[0].id !== work.tasks[1].id,
    `${work.tasks[0].id} vs ${work.tasks[1].id}`);
}

// ============================================================
// [9] 状态标识（⭐/▶/[✓]）保留
// ============================================================
console.log('\n[9] 状态标识（⭐/▶/[✓]）跨重载保留');
{
  const initial = `# 全部任务\n\n## 工作\n\n- [ ] [⭐] 重要任务\n- [ ] [▶] 当前任务\n- [✓] 已完成\n`;
  const store = makeStore(initial);
  const work = store.getCategory('工作');
  check('重要标记', work.tasks[0].important === true);
  check('当前标记', work.tasks[1].current === true);
  // v3.4 起：[✓] 任务在加载时自动从源分类搬到「# 已完成任务」真实分类，
  // 不再停留在原分类里 —— 数据归属明确，源分类里不再保留已完成的「鬼影」。
  const completed = store.getCompletedCategory();
  check('已完成任务被搬到「# 已完成任务」分类（v3.4）',
    completed?.tasks?.some(t => t.text === '已完成' && t.completed === true),
    completed?.tasks?.map(t => `${t.text}(${t.completed})`).join(' | '));

  // 重新加载
  store.loadFromContent(initial, null);
  const work2 = store.getCategory('工作');
  check('重载后重要标记保留', work2.tasks[0].important === true);
  check('重载后当前标记保留', work2.tasks[1].current === true);
  const completed2 = store.getCompletedCategory();
  check('重载后已完成任务仍在「# 已完成任务」并 completed=true',
    completed2?.tasks?.some(t => t.text === '已完成' && t.completed === true),
    completed2?.tasks?.map(t => `${t.text}(${t.completed})`).join(' | '));
}

// ============================================================
// [10] writer 永远不会输出 <!-- id:
// ============================================================
console.log('\n[10] writer 永不输出 <!-- id:');
{
  const md = `# 全部任务\n\n## 工作\n\n- [ ] a\n- [✓] [▶] b\n`;
  const cats = parseMarkdown(md);
  const written = writeMarkdown(cats);
  check('写入器无 <!-- id', !written.includes('<!-- id:'),
    written);

  // 即使用 task.id 也是字符串，writer 也不该写
  cats[1].tasks[0].id = 'some-injected-id';
  const written2 = writeMarkdown(cats);
  check('即便 task.id 是任意字符串也不写', !written2.includes('<!-- id:'),
    written2);
}

// ============================================================
// [11] 旧文件迁移（包含 <!-- id -->）→ 加载干净
// ============================================================
console.log('\n[11] 旧文件迁移：含 <!-- id -->');
{
  const old = `# 全部任务\n\n## 工作\n\n- [ ] 旧任务 <!-- id:t99 -->\n- [ ] 普通任务\n`;
  const cats = parseMarkdown(old);
  const work = cats.find(c => c.name === '工作');
  check('旧 id 注释被剥掉，文本干净', work.tasks.every(t => !t.text.includes('<!--')),
    work.tasks.map(t => t.text).join(' | '));
  check('id 由解析器分配（不再是 t99）',
    work.tasks.every(t => t.id && t.id !== 't99'),
    work.tasks.map(t => t.id).join(','));

  // 写回 → 不包含 <!-- id
  const written = writeMarkdown(cats);
  check('写回后无 <!-- id:', !written.includes('<!-- id:'));
}

// ============================================================
// [12] 删除/恢复仍然能工作（基于运行时 id）
// ============================================================
console.log('\n[12] 删除→恢复（基于运行时 id）');
{
  const store = makeStore(`# 全部任务\n\n## 工作\n\n- [ ] a\n- [ ] b\n- [ ] c\n`);
  const work = store.getCategory('工作');
  const bId = work.tasks.find(t => t.text === 'b').id;

  // 删 b
  const ok = store.deleteTask('工作', bId);
  check('deleteTask 返回 true', ok === true);
  check('工作剩 a/c', store.getCategory('工作').tasks.map(t => t.text).join(',') === 'a,c');

  // 从回收站恢复 —— v3.5.2+：默认按 originalCategory 归位（删除 b 时已记下"工作"）
  const restored = store.restoreTask(bId);
  check('restoreTask 返回 { ok: true }', restored.ok === true);
  const trash = store.getTrashCategory();
  check('回收站空了', trash.tasks.length === 0);
  // 默认归到「工作」（deleteTask 时记下的原分类）；本测试文档没有「未分类」子分类
  check('b 按原分类归位到「工作」',
    store.getCategory('工作').tasks.some(t => t.text === 'b'),
    JSON.stringify(store.getCategory('工作').tasks.map(t => t.text)));
}

// ============================================================
// [13] 跨分类移动（基于 runtime id）
// ============================================================
console.log('\n[13] 跨分类移动（基于 runtime id）');
{
  const store = makeStore(`# 全部任务\n\n## 工作\n\n- [ ] a\n- [ ] b\n\n## 学习\n\n- [ ] c\n`);
  const work = store.getCategory('工作');
  const aId = work.tasks.find(t => t.text === 'a').id;

  const ok = store.moveTask('工作', aId, '学习');
  // moveTask 现在返回实际生效的目标分类名（防御性改投语义），不再是布尔。
  // 普通路径：返回的就是用户传的目标分类。
  check('moveTask 返回「学习"（普通路径无改投）', ok === '学习');
  check('工作剩 b', store.getCategory('工作').tasks.map(t => t.text).join(',') === 'b');
  // 默认 movePosition='front'：移过来的任务落到目标分类最前面 → a,c
  check('学习有 a/c（默认 movePosition=front）', store.getCategory('学习').tasks.map(t => t.text).join(',') === 'a,c');
}

// ============================================================
// [14] 拖拽重排序（基于 runtime id）
// ============================================================
console.log('\n[14] 重排序（基于 runtime id）');
{
  const store = makeStore(`# 全部任务\n\n## 工作\n\n- [ ] a\n- [ ] b\n- [ ] c\n`);
  const work = store.getCategory('工作');
  const aId = work.tasks[0].id;
  const bId = work.tasks[1].id;

  // splice 语义：toIndex 是「移除前」的位置。
  // 起始 [a, b, c]，from=0, to=2 → splice(0,1) 得 [b,c]；再 splice(2,0,a) 得 [b,c,a]
  const ok = store.reorderTask('工作', 0, 2);
  check('reorderTask 返回 true', ok === true);
  check('顺序变为 b/c/a（splice 语义，toIndex 是移除前位置）',
    store.getCategory('工作').tasks.map(t => t.text).join(',') === 'b,c,a');

  // 拖到末尾：toIndex === length 也合法（commit 中明确放行）
  // 当前 [b, c, a]，把 b（位置 0）拖到末尾（位置 3）
  // splice(0,1) → [c,a]；splice(3,0,b) → [c,a,b]
  const ok2 = store.reorderTask('工作', 0, 3);
  check('把 b（位置 0）拖到 length 位置 → 顺序变为 c/a/b',
    ok2 === true &&
    store.getCategory('工作').tasks.map(t => t.text).join(',') === 'c,a,b');
}

// ============================================================
// [15] 外部编辑文件时自动切回 SortBy.MANUAL（用户原 bug 报告）
// ============================================================
console.log('\n[15] 外部编辑文件 → 自动切回 MANUAL（让文件顺序生效）');
{
  // 用户在软件里切到了「按字母排序」
  const initial = `# 全部任务\n\n## 工作\n\n- [ ] cherry\n- [ ] apple\n- [ ] banana\n`;
  const store = makeStore(initial);
  store.setSortBy('alphabet');
  check('设置 sortBy=alphabet 后生效',
    store.sortBy === 'alphabet');

  // 用户在 markdown 里改成「按她想要的顺序」存盘 → fs.watch 触发 reload
  const reordered = `# 全部任务\n\n## 工作\n\n- [ ] banana\n- [ ] cherry\n- [ ] apple\n`;
  store.loadFromContent(reordered, null);

  // 关键：sortBy 必须切回 MANUAL，否则 getVisibleTasks 会按字母重排
  check('loadFromContent 后 sortBy 自动切回 manual',
    store.sortBy === 'manual',
    `sortBy=${store.sortBy}`);

  // 现在 UI 渲染的顺序就是文件里的顺序
  const visible = store.getVisibleTasks(store.getCategory('工作'));
  check('UI 可见顺序按文件顺序：banana/cherry/apple',
    visible.map(t => t.text).join(',') === 'banana,cherry,apple',
    visible.map(t => t.text).join(','));
}

// ============================================================
// [16] 默认 sortBy=MANUAL 时，外部编辑不会无谓触发 sort 事件
// ============================================================
console.log('\n[16] sortBy=MANUAL 时 reload 不发 sort 事件（避免误触发 UI）');
{
  const initial = `# 全部任务\n\n## 工作\n\n- [ ] a\n- [ ] b\n`;
  const store = makeStore(initial);

  let sortEventCount = 0;
  store.on('sort', () => sortEventCount++);

  store.loadFromContent(`# 全部任务\n\n## 工作\n\n- [ ] b\n- [ ] a\n`, null);
  check('sortBy=MANUAL 时不触发 sort 事件',
    sortEventCount === 0,
    `sortEventCount=${sortEventCount}`);
}

// ============================================================
// [17] 自写入抑制：渲染端 readFile + serialize() 比对
//      （用户原 bug：外部编辑内容修改后软件没及时更新）
// ============================================================
console.log('\n[17] 自写入抑制：fs.watch → readFile → serialize() 比对');
{
  // 用户原 bug：1.5s 时间窗口会吞掉用户紧接着的外部保存。
  // 修复方案：主进程不过滤（fs.watch 时序不可靠），所有事件发 IPC。
  //           渲染端 readFile 后与 store.serialize() 比对 —— 完全相同视为
  //           自己写入的产物静默；任何字节差异视为外部修改正常 reload + toast。

  // (a) 模拟「autoSave 触发的写入」：文件内容 === serialize() → 静默
  const initial = `# 全部任务\n\n## 工作\n\n- [ ] a\n- [ ] b\n`;
  const store = makeStore(initial);
  // 模拟 autoSave 完成后的状态：内存中 a/b 的顺序，serialize 输出与文件一致
  const fileContentAfterAutoSave = store.serialize();
  check('autoSave 后文件内容 === serialize()',
    fileContentAfterAutoSave === initial,
    `serialize=${JSON.stringify(fileContentAfterAutoSave)}`);

  // (b) 模拟「用户在 markdown 里改了内容」：文件内容 !== serialize() → reload
  const userEdited = `# 全部任务\n\n## 工作\n\n- [ ] b\n- [ ] a\n- [ ] user-added\n`;
  check('用户编辑后内容 !== serialize() → 触发 reload',
    userEdited !== store.serialize());

  // (c) 模拟「外部修改文本」：任何字节差异都能识别
  const tinyEdit = `# 全部任务\n\n## 工作\n\n- [ ] a\n- [ ] b 修改\n`;
  check('用户改一个字也能识别',
    tinyEdit !== store.serialize());

  // (d) 用户删除任务：内容差异极大
  const deletedOne = `# 全部任务\n\n## 工作\n\n- [ ] a\n`;
  check('用户删除一条任务也能识别',
    deletedOne !== store.serialize());

  // (e) 极端情况：用户外部保存后内容恰好 === serialize()（误判为自写入）
  //     等价于「用户在外部编辑器里做了与内存状态完全一致的内容」—— 实际
  //     等同于用户没改。这种情况下渲染端会静默（不弹 toast），但用户也
  //     确实没改东西，无副作用。可接受。
  const sameAsSerialize = store.serialize();
  check('误判条件（用户保存内容 === serialize）可触发，但等价于没改',
    sameAsSerialize === store.serialize());
}

console.log(`\n通过 ${summary.pass} / 失败 ${summary.fail}`);
process.exit(summary.fail === 0 ? 0 : 1);
