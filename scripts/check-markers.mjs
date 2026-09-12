// 回归测试：Markdown 解析器对内联标记的处理
//
// 关键场景：
//   - [⭐] / [▶] 后直接接文字（无空格）必须被识别
//   - 裸 ⭐ / 裸 ▶ 必须前后有空白，避免吃掉行内字符（如「⭐buy」不应被识别）
//   - 同一行 [⭐] 与 [▶] 同时出现要分别正确归位
//   - 行尾的标记要被识别（位置不限）
//   - 旧版标记 [▶] / ▶ / @当前 都要被识别
//
// 跑法：node scripts/check-markers.mjs

import { parseMarkdown } from '../src/markdown-parser.js';
import { check, ok, bad, summary, printSummary } from './_lib/check.mjs';
import { makeStore } from './_lib/store-fixture.mjs';
import { writeMarkdown } from '../src/markdown-writer.js';

// 取出第一个被解析出来的任务
function firstTask(md) {
  return parseMarkdown(md).flatMap(c => c.tasks)[0] || null;
}

console.log('\n[1] 方括号标记 [⭐] / [▶] 紧贴文字必须被识别');
{
  const t1 = firstTask('# X\n\n## A\n\n- [ ] [⭐]buy milk');
  check('[⭐]buy milk 标记为重要且文字干净', t1 && t1.important === true && t1.text === 'buy milk', JSON.stringify(t1));

  const t2 = firstTask('# X\n\n## A\n\n- [ ] [▶]follow up');
  check('[▶]follow up 标记为当前且文字干净', t2 && t2.current === true && t2.text === 'follow up', JSON.stringify(t2));

  const t3 = firstTask('# X\n\n## A\n\n- [ ] [▶][⭐]task');
  check('[▶][⭐]task 两个标记同时识别', t3 && t3.important === true && t3.current === true && t3.text === 'task', JSON.stringify(t3));
}

console.log('\n[2] 裸 ⭐ / 裸 ▶ / @当前 必须前后有空白');
{
  const t1 = firstTask('# X\n\n## A\n\n- [ ] ⭐buy');
  check('裸 ⭐buy 被拒绝（标记泄漏保留）', t1 && t1.important === false && t1.text === '⭐buy', JSON.stringify(t1));

  const t2 = firstTask('# X\n\n## A\n\n- [ ] ▶task');
  check('裸 ▶task 被拒绝', t2 && t2.current === false && t2.text === '▶task', JSON.stringify(t2));

  const t3 = firstTask('# X\n\n## A\n\n- [ ] @当前task');
  check('@当前task 被拒绝（多字符中文）', t3 && t3.current === false && t3.text === '@当前task', JSON.stringify(t3));
}

console.log('\n[3] 正常带空白的标记依然可用');
{
  const t1 = firstTask('# X\n\n## A\n\n- [ ] [⭐] task');
  check('[⭐] task 重要', t1 && t1.important === true && t1.text === 'task', JSON.stringify(t1));

  const t2 = firstTask('# X\n\n## A\n\n- [ ] ⭐ task');
  check('裸 ⭐ task 重要', t2 && t2.important === true && t2.text === 'task', JSON.stringify(t2));

  const t3 = firstTask('# X\n\n## A\n\n- [ ] @当前 task');
  check('@当前 task 当前', t3 && t3.current === true && t3.text === 'task', JSON.stringify(t3));

  const t4 = firstTask('# X\n\n## A\n\n- [ ] task [⭐]');
  check('task [⭐] 行尾标记重要', t4 && t4.important === true && t4.text === 'task', JSON.stringify(t4));
}

console.log('\n[4] 往返一致性：二次写出的 Markdown 等价');
{
  const input = `# 全部任务

## 工作

- [ ] [⭐]紧贴任务
- [ ] [▶]紧贴任务
- [ ] [⭐] 带空格
- [ ] [▶] 带空格
- [ ] [▶][⭐]两个都有
- [ ] 普通任务
`;
  const cats1 = parseMarkdown(input);
  const md1 = writeMarkdown(cats1);
  const cats2 = parseMarkdown(md1);
  const md2 = writeMarkdown(cats2);
  check('二次往返 markdown 完全一致', md1 === md2, `md1 != md2`);
  check('二次往返任务数一致',
    cats1.flatMap(c => c.tasks).length === cats2.flatMap(c => c.tasks).length);

  // 重要/当前 状态也要在两次往返后保持
  const tasks1 = cats1.flatMap(c => c.tasks);
  const tasks2 = cats2.flatMap(c => c.tasks);
  const states1 = tasks1.map(t => `${t.text}|${t.important ? 1 : 0}${t.current ? 1 : 0}`).sort();
  const states2 = tasks2.map(t => `${t.text}|${t.important ? 1 : 0}${t.current ? 1 : 0}`).sort();
  check('任务状态 (text,important,current) 完全一致', JSON.stringify(states1) === JSON.stringify(states2),
    `\n      states1=${JSON.stringify(states1)}\n      states2=${JSON.stringify(states2)}`);
}

console.log('\n[5] 旧版标记仍被识别（向后兼容）');
{
  // 这些标记在升级前的文件里可能出现；升级后仍要能加载
  const t1 = firstTask('# X\n\n## A\n\n- [ ] ⭐ task');
  check('裸 ⭐ 旧版仍识别', t1 && t1.important === true, JSON.stringify(t1));

  const t2 = firstTask('# X\n\n## A\n\n- [ ] ▶ task');
  check('裸 ▶ 旧版仍识别', t2 && t2.current === true, JSON.stringify(t2));

  const t3 = firstTask('# X\n\n## A\n\n- [ ] @当前 task');
  check('@当前 旧版仍识别', t3 && t3.current === true, JSON.stringify(t3));
}

console.log('\n[7] 文本中的特殊字符不被解析器误吃');
{
  // TASK_LINE_RE 只锚 checkbox `[xxx]`，文本里的 `[1]` / `[abc]` 都是字面字符，
  // 不会与 inline 标记 `[⭐]` / `[▶]` / `[原分类：xxx]` 混淆：
  //   - `[⭐]` 等用的是 ✅ U+2B50 / ▶ U+25B6，方括号 + 字面 unicode 字符
  //   - 文本里的 `[1]` 是 ASCII 数字 `1`，regex `^\[([^\]]+)\]` 第一次匹配整行 checkbox，
  //     文本部分走 group(2)，不会再触发 marker 抽取
  // 验证「文本里含 ]」与「文本里含中文括号」都不会触发解析误判
  const t1 = firstTask('# X\n\n## A\n\n- [ ] 任务 [1] 内容');
  check('文本中的 [1] 保留为字面文本',
    t1 && t1.text === '任务 [1] 内容' && !t1.important && !t1.current && !t1.originalCategory,
    JSON.stringify(t1));

  const t2 = firstTask('# X\n\n## A\n\n- [ ] 任务（中文括号）');
  check('文本中的中文括号保留为字面文本',
    t2 && t2.text === '任务（中文括号）' && !t2.important && !t2.current,
    JSON.stringify(t2));

  const t3 = firstTask('# X\n\n## A\n\n- [ ] a]b]c');
  check('文本中含嵌套 ] 保留为字面文本（不会吃掉第二个]）',
    t3 && t3.text === 'a]b]c',
    JSON.stringify(t3));
}

console.log('\n[8] [原分类：xxx] 内含 ] 字符的边界（非贪婪匹配首个 ] 即终止）');
{
  // `[原分类：a]b]` 应解析为 originalCategory=`a`，文本保留 `b]`
  // —— 因为 regex 是 `[^\]]+?` 非贪婪，首个 ] 即关闭标记。
  // 同样适用于 [原分类：xxx] 内含 → 等特殊字符
  const md = `# 全部任务

## 工作

- [ ] 任务
- [✓] [原分类：a]b] 任务
# 已完成任务
- [✓] [原分类：含→符号] 任务
`;
  const cats = parseMarkdown(md);
  const workCat = cats.find(c => c.name === '工作');
  const workTasks = workCat?.tasks || [];
  // 工作分类下应该有一条「[原分类：a]b] 任务」→ originalCategory=`a`, text=`b] 任务`
  const moved = workTasks.find(t => t.text.startsWith('b]'));
  check('[原分类：a]b] 在「工作」分类下解析为 originalCategory=a / text="b] 任务"',
    moved && moved.originalCategory === 'a' && moved.text === 'b] 任务',
    JSON.stringify(moved));

  const completedCat = cats.find(c => c.kind === 'completed');
  const completedTasks = completedCat?.tasks || [];
  const sym = completedTasks.find(t => t.text === '任务');
  check('[原分类：含→符号] 在「已完成任务」分类下解析为 originalCategory="含→符号"',
    sym && sym.originalCategory === '含→符号' && sym.text === '任务',
    JSON.stringify(sym));
}

console.log('\n[9] 空文本任务合法（手写 `- [ ]` / `- [✓]`）');
{
  // parser 必须接受空文本，否则会被 _ensureBaseStructure 当成纯文本忽略、丢失任务数据
  const t1 = firstTask('# X\n\n## A\n\n- [ ]');
  check('空文本未完成 task.text=""',
    t1 && t1.text === '' && t1.completed === false,
    JSON.stringify(t1));

  const t2 = firstTask('# X\n\n## A\n\n- [✓]');
  check('空文本已完成 task.text="" / completed=true',
    t2 && t2.text === '' && t2.completed === true,
    JSON.stringify(t2));

  // 纯空白文本 → trim 后为空文本，与空文本等价
  const t3 = firstTask('# X\n\n## A\n\n- [ ]    ');
  check('纯空白文本 trim 后变空字符串',
    t3 && t3.text === '',
    JSON.stringify(t3));
}

console.log('\n[6] 行尾 <!-- id --> 注释被剥掉（v3+ 写入器不再输出，仅用于旧文件迁移）');
{
  // 锚定行尾之前的 bug：正则 `/<!--\s*id:([^\s>]+)\s*-->/` 没有 $ 锚，
  // 会从文本中间抠出第一个匹配，把用户的字面字符串删掉。例如：
  //   `- [ ] 在 markdown 里可以这样写注释：<!-- id:t1 -->示例`
  // 旧实现会把 `<!-- id:t1 -->` 部分静默剥掉，留下「示例」。
  // 锚定行尾后，只剥写时器挂在末尾的注释。
  //
  // v3+ 写入器不再写 id 注释，解析器也不再从文件中提取 id 作为任务身份
  // （task.id 改由末尾的统一计数器分配）。但行尾 id 注释的剥离仍要保留，
  // 否则旧文件中的 `<!-- id:t99 -->` 会作为字面字符出现在 UI 文本里。
  const t1 = firstTask('# X\n\n## A\n\n- [ ] 写注释示例 <!-- id:t1 -->中间内容');
  check('文本中间的 <!-- id:xxx --> 保留为字面文本',
    t1 && t1.text === '写注释示例 <!-- id:t1 -->中间内容',
    JSON.stringify(t1));

  // 行尾的 id 注释被剥掉；id 由解析器统一分配（不再是文件里的值）
  const t2 = firstTask('# X\n\n## A\n\n- [ ] 普通任务 <!-- id:t99 -->');
  check('行尾的 id 注释被剥掉，文本干净，task.id 由解析器分配',
    t2 && t2.text === '普通任务' && typeof t2.id === 'string' && t2.id !== 't99',
    JSON.stringify(t2));

  // 文本里同时含行中和行尾两个，剥尾留中（行中的也作为文本）
  const t3 = firstTask('# X\n\n## A\n\n- [ ] 行中<!-- id:t1 -->也有<!-- id:t99 -->');
  // 行尾锚 $ 匹配 <!-- id:t99 -->；行中的 <!-- id:t1 --> 保留
  check('行中 + 行尾两个 id 注释：剥尾留中',
    t3 && typeof t3.id === 'string' && t3.text === '行中<!-- id:t1 -->也有',
    JSON.stringify(t3));
}

// ============================================================
// [N+1] 标记剥除后必须保留任务文本里的内部连续空格（H8 回归）
// ============================================================
//
// 旧实现 extractInlineMarkers 末尾用 `text.replace(/\s+/g, ' ').trim()` 做"全局空白折叠"，
// 触发条件是任务带了 `[⭐]` / `[▶]` / `[原分类：xxx]` 任一标记 ——
// 把用户原本写的 `前后  多空  格`（保留 N 个空格）压成 `前后 多空 格`（每个间隔 1 个空格）。
// 数据损坏静默：保存时 text 已经丢空格，下次读回来还是丢。
//
// 修复：去掉全局折叠，只 trim 两端。
console.log('\n[N+1] 标记剥除后保留任务文本里的内部连续空格');
{
  const t1 = firstTask('# X\n\n## A\n\n- [ ] [⭐]前后  多空  格');
  check('[⭐] + 内部 2 空格保留',
    t1 && t1.important === true && t1.text === '前后  多空  格',
    JSON.stringify(t1));

  const t2 = firstTask('# X\n\n## A\n\n- [ ] [▶] 任务  多空  文本 [⭐]');
  check('[▶] head + [⭐] tail + 内部 2 空格保留',
    t2 && t2.important === true && t2.current === true && t2.text === '任务  多空  文本',
    JSON.stringify(t2));

  const t3 = firstTask('# X\n\n## A\n\n- [ ] [原分类：工作] A  B  C');
  check('[原分类：xxx] + 内部 2 空格保留',
    t3 && t3.originalCategory === '工作' && t3.text === 'A  B  C',
    JSON.stringify(t3));

  const t4 = firstTask('# X\n\n## A\n\n- [ ] foo  bar  baz [⭐]');
  check('tail [⭐] + 内部 2 空格保留',
    t4 && t4.important === true && t4.text === 'foo  bar  baz',
    JSON.stringify(t4));
}

// ============================================================
// [N] writeMarkdown 在异常输入下必须抛错而不是静默吞掉
// ============================================================
{
  console.log('\n[writer] 空 categories 必须抛错（防止静默清空磁盘文件）');
  let threwEmpty = false;
  try {
    writeMarkdown([]);
  } catch (e) {
    threwEmpty = true;
  }
  check('空数组 throw（不是返回空字符串）', threwEmpty);

  console.log('\n[writer] 非数组输入必须 throw');
  let threwNonArray = false;
  try {
    writeMarkdown(null);
  } catch (e) {
    threwNonArray = true;
  }
  check('null throw', threwNonArray);
}

console.log(`\n通过 ${summary.pass} / 失败 ${summary.fail}`);
process.exit(summary.fail === 0 ? 0 : 1);
