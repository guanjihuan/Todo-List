// 回归测试：「未分类」子分类必须只存在一份。
//
// 背景：用户手工编辑 todo.md 时可能写出两个 `## 未分类`（保留名不可重复）。
// 旧 parser 在 insideOtherTasks 下遇到 `## X` 就无条件 createCategory + push，
// 导致 categories 数组里出现两份同名分类 —— sidebar 渲染两份「未分类」入口，
// writer 顺势写两份，下次加载又被 parser 读成两份，自维持脏数据。
//
// 修复策略（双层防御）：
//   1. markdown-parser：遇到重复 `## 未分类` 时复用第一个已有的（不再 push 新分类）
//   2. task-store._consolidateUncategorized：任何绕过 parser 的路径都不能让
//      内存里出现两份，合并到第一份并丢弃副本
//
// 跑法：node scripts/check-uncategorized-duplicate.mjs

import { parseMarkdown, UNCATEGORIZED_NAME, CategoryKind } from '../src/markdown-parser.js';
import { check, ok, bad, summary, printSummary } from './_lib/check.mjs';
import { makeStore } from './_lib/store-fixture.mjs';
import { writeMarkdown } from '../src/markdown-writer.js';
import { TaskStore } from '../src/task-store.js';

// 拿 categories 数组里的「未分类」子分类（parentOtherTasks=true）
function uncategorizedCats(cats) {
  return cats.filter(c => c.parentOtherTasks && c.name === UNCATEGORIZED_NAME);
}

console.log('\n[1] parser：连续两个 `## 未分类` 只产出一个子分类');

{
  const md = `# 全部任务

## 学习

## ${UNCATEGORIZED_NAME}

## ${UNCATEGORIZED_NAME}

- [ ] [▶] [⭐] 任务1
- [ ] 任务2

## 工作
- [ ] 工作1
`;
  const cats = parseMarkdown(md);
  const uns = uncategorizedCats(cats);
  check('categories 里只有 1 个「未分类」', uns.length === 1,
    `实际 ${uns.length} 个：${JSON.stringify(uns.map(c => c.tasks.length))}`);
  check('「未分类」下面的任务数 = 2（两份 h2 之间的任务合并）', uns[0].tasks.length === 2,
    `实际：${JSON.stringify(uns[0].tasks.map(t => t.text))}`);
  check('任务 1 / 任务 2 都进了「未分类」',
    uns[0].tasks.map(t => t.text).join('|') === '任务1|任务2',
    `实际：${JSON.stringify(uns[0].tasks.map(t => t.text))}`);
}

console.log('\n[2] parser：连续三个 `## 未分类` 也只产出一个子分类');

{
  const md = `# 全部任务

## ${UNCATEGORIZED_NAME}

## ${UNCATEGORIZED_NAME}

- [ ] A

## ${UNCATEGORIZED_NAME}

- [ ] B
- [ ] C
`;
  const cats = parseMarkdown(md);
  const uns = uncategorizedCats(cats);
  check('categories 里只有 1 个「未分类」', uns.length === 1,
    `实际 ${uns.length} 个`);
  check('「未分类」收下 A/B/C 三条任务', uns[0].tasks.length === 3,
    `实际：${JSON.stringify(uns[0].tasks.map(t => t.text))}`);
}

console.log('\n[3] parser：用户实际场景（第一个 `## 未分类` 空，第二个带任务）');

{
  // 完全复刻用户 todo.md 的形态：保留「## 学习」（空）+ 两个 `## 未分类`（第一个空、第二个带任务）
  const md = `# 全部任务

## 学习

## ${UNCATEGORIZED_NAME}

## ${UNCATEGORIZED_NAME}

- [ ] [▶] [⭐] 二TV1111二位率顶顶顶顶让他人读过
- [ ] [▶] [⭐] 二TV
- [ ] 二TV1111二位率顶顶顶顶1111啊的撒发生
`;
  const cats = parseMarkdown(md);
  const uns = uncategorizedCats(cats);
  check('「未分类」子分类只有 1 个', uns.length === 1, `实际 ${uns.length} 个`);
  check('三条任务都在「未分类」里', uns[0].tasks.length === 3,
    `实际：${JSON.stringify(uns[0].tasks.map(t => t.text))}`);
}

console.log('\n[4] writer：往返一致 —— 重复 `## 未分类` 写回后只剩一个');

{
  const input = `# 全部任务

## ${UNCATEGORIZED_NAME}

## ${UNCATEGORIZED_NAME}

- [ ] 任务A
- [ ] 任务B
`;
  const cats1 = parseMarkdown(input);
  const md1 = writeMarkdown(cats1);
  const headerMatches = md1.match(/^##\s+未分类\s*$/gm) || [];
  check('writeMarkdown 只输出一个 `## 未分类`', headerMatches.length === 1,
    `实际出现 ${headerMatches.length} 次：${JSON.stringify(md1.match(/^##.+$/gm))}`);

  // 二次往返幂等
  const cats2 = parseMarkdown(md1);
  const md2 = writeMarkdown(cats2);
  check('二次往返 md 完全一致', md1 === md2, `md1 != md2`);
  check('二次往返「未分类」子分类数 = 1',
    uncategorizedCats(cats2).length === 1);

  // 任务没丢
  const tasks2 = cats2.flatMap(c => c.tasks).map(t => t.text).sort();
  check('任务 A/B 都在', JSON.stringify(tasks2) === JSON.stringify(['任务A', '任务B']),
    `实际：${JSON.stringify(tasks2)}`);
}

console.log('\n[5] store 兜底：内存里塞两个「未分类」，_consolidateUncategorized 必须合并');

{
  const store = new TaskStore();
  store._autoSave = Object.assign(() => {}, { cancel() {}, flush() {} });
  store.loadDefault(null);

  // 人为注入两份「未分类」（模拟绕过 parser 的路径）
  const realUn = store.categories.find(c => c.parentOtherTasks && c.name === UNCATEGORIZED_NAME);
  const ghostUn = {
    name: UNCATEGORIZED_NAME,
    kind: CategoryKind.NORMAL,
    isSpecial: false,
    meta: null,
    parentOtherTasks: true,
    tasks: [{ text: '幽灵任务', completed: false, important: false, current: false }]
  };
  // 插在「未分类」真身后面，模拟 categories 数组里出现两份同名
  const idx = store.categories.indexOf(realUn);
  store.categories.splice(idx + 1, 0, ghostUn);

  // 触发 _ensureBaseStructure —— 内部会调 _consolidateUncategorized
  store._ensureBaseStructure();

  const uns = store.categories.filter(c => c.parentOtherTasks && c.name === UNCATEGORIZED_NAME);
  check('「未分类」只剩 1 份', uns.length === 1, `实际 ${uns.length} 份`);
  check('幽灵任务被并入真身', uns[0].tasks.some(t => t.text === '幽灵任务'),
    `真身任务：${JSON.stringify(uns[0].tasks.map(t => t.text))}`);
}

console.log('\n[6] parser：「未分类」**不**影响普通子分类的重名（只有保留名收敛）');

{
  // 普通子分类重名时仍然按 parser 旧行为 push（不做合并）——
  // 重命名检查是用户责任，store.renameCategory 会拒绝与现有分类重名（不论保留还是普通）。
  // 这里只验证「未分类」这一个保留名的合并不会污染普通分类的重名行为。
  const md = `# 全部任务

## 工作

## 工作

- [ ] 工作任务
`;
  const cats = parseMarkdown(md);
  const work = cats.filter(c => c.parentOtherTasks && c.name === '工作');
  // 普通重名不被本修复合并（这是另一个语义问题 —— 至少保证「未分类」特殊路径不会被牵连）。
  check('普通重名「## 工作」保持原行为（不合并）', work.length === 2,
    `实际：${work.length} 个「工作」`);
}

console.log('\n[7] parser：合法的单一「未分类」行为不变（不误伤正常文件）');

{
  const md = `# 全部任务

## 学习
- [ ] 学习1

## ${UNCATEGORIZED_NAME}
- [ ] 兜底1
- [ ] 兜底2
`;
  const cats = parseMarkdown(md);
  const uns = uncategorizedCats(cats);
  check('单一「未分类」仍然产出 1 个分类', uns.length === 1);
  check('单一「未分类」任务数 = 2', uns[0].tasks.length === 2,
    `实际：${JSON.stringify(uns[0].tasks.map(t => t.text))}`);
  const written = writeMarkdown(cats);
  const headerCount = (written.match(/^##\s+未分类\s*$/gm) || []).length;
  check('写回文件只有 1 个 `## 未分类`', headerCount === 1,
    `实际 ${headerCount} 次`);
}

console.log('\n[8] store：真实 todo.md 走 loadFromContent 路径，只剩 1 个「未分类」');

{
  // 直接用用户的真实文件内容（截至 2026-08-23）
  const content = `# 全部任务

## 学习

## ${UNCATEGORIZED_NAME}

## ${UNCATEGORIZED_NAME}

- [ ] [▶] [⭐] 二TV1111二位率顶顶顶顶让他人读过
- [ ] [▶] [⭐] 二TV
- [ ] [▶] [⭐] 二TV1111二位率
- [ ] [▶] [⭐] 二TV1111二位率顶顶顶顶让他人读过
- [ ] [▶] [⭐] 二TV
- [ ] [▶] [⭐] 二TV1111二位率
- [ ] [▶] 二TV1111二位率顶顶顶顶1111啊的撒发生

# 已完成任务

<!-- [✓] 打勾的任务会自动移到本节；取消勾选后会回到它原来的分类。需要彻底归档请用「移到回收站」（Delete 键）。 -->

- [✓] 2
- [✓] [▶] [⭐] 3333
- [✓] [▶] [⭐] [原分类：学习] 1234453
- [✓] [▶] [⭐] [原分类：学习] 好吧
- [✓] [▶] [⭐] [原分类：未分类] 二TV1111二位率
- [✓] [▶] [原分类：未分类] 二TV1111二位率顶顶顶顶1111啊的撒发生
- [✓] [原分类：未分类] 哦哦
- [✓] [▶] [⭐] [原分类：未分类] 二TV
- [✓] [▶] [⭐] [原分类：学习] 二TV1111二位率顶顶顶顶让他人读过
- [✓] [原分类：学习] 111
`;
  const store = new TaskStore();
  store._autoSave = Object.assign(() => {}, { cancel() {}, flush() {} });
  store.loadFromContent(content, null);

  const subs = store.getSubCategories();
  const unCount = subs.filter(c => c.name === UNCATEGORIZED_NAME).length;
  check('加载后「未分类」子分类只有 1 个', unCount === 1, `实际 ${unCount} 个`);
  const unCat = subs.find(c => c.name === UNCATEGORIZED_NAME);
  check('「未分类」收下所有 7 条未完成任务', unCat.tasks.length === 7,
    `实际 ${unCat.tasks.length} 条：${JSON.stringify(unCat.tasks.map(t => t.text))}`);
}

console.log(`\n通过 ${summary.pass} / 失败 ${summary.fail}`);
process.exit(summary.fail === 0 ? 0 : 1);