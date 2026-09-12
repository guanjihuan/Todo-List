// 全面 round-trip 一致性：UI 显示 ↔ markdown 完全对应
//
// 用户要求：软件里看到的每条任务、分类、状态、顺序，都必须能在 markdown 文件里找到，
// 反过来 markdown 里的每条任务、分类、状态、顺序也都必须能在 UI 里看到。
//
// 本测试覆盖：
//   1. 文本逐字符一致（含中文、emoji、Markdown 强调、代码、链接、特殊空白）
//   2. 状态（⭐/▶/[✓]）映射一致
//   3. 顺序一致
//   4. 分类名称一致（含空格、CJK、emoji）
//   5. parser → writer → parser 幂等
//   6. writer → parser 不会丢任务
//   7. 空文本任务、纯空白任务、特殊字符任务保留

import { parseMarkdown, CategoryKind } from '../src/markdown-parser.js';
import { writeMarkdown, createDefaultDoc } from '../src/markdown-writer.js';
import { check, summary, printSummary } from './_lib/check.mjs';

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log('\n[1] 文本逐字符一致：所有字符（包括 Markdown 强调、链接、emoji）原样保留');
{
  const cases = [
    // 普通中文
    '买菜',
    // emoji
    '🐛 fix login bug',
    '🎉 发布 v3',
    // Markdown 强调（不应被解析为语法，只作为普通文本）
    '**加粗**',
    '*斜体*',
    '`代码片段`',
    '~~删除线~~',
    // Markdown 链接
    '看 [文档](https://example.com)',
    // 多种引号
    '"英文双引号"',
    "'英文单引号'",
    '「中文双引号」',
    '『中文嵌套引号』',
    // 反引号、管道符
    '`code`',
    'a | b | c',
    // 数字、英文混合
    'RTFM 101',
    // 多空格：解析器只 trim 首尾，不主动合并中间空格（除非遇到 ⭐/▶ 走 .replace(/\s+/g, ' ')）
    '前后  多空  格',
    // 中英混合
    '完成 Q3 项目设计文档',
    // 反斜杠
    '路径 C:\\Users\\test',
    // URL
    'https://github.com/foo/bar?x=1&y=2#hash',
    // 数学符号
    '计算 a² + b² = c²',
    // 特殊 CJK
    '한글 테스트',
    '日本語テスト',
  ];
  for (const text of cases) {
    const md = `# 全部任务\n\n## 工作\n\n- [ ] ${text}\n`;
    const cats = parseMarkdown(md);
    const got = cats.find(c => c.name === '工作').tasks[0].text;
    // 解析器只 trim 首尾空白；只有 ⭐/▶ 标识走过的代码路径才会 .replace(/\s+/g, ' ')
    const expected = text.replace(/^\s+|\s+$/g, '');
    check(`文本保留：${text.slice(0, 30)}${text.length > 30 ? '...' : ''}`, got === expected,
      `got=${JSON.stringify(got)} expected=${JSON.stringify(expected)}`);
  }
}

console.log('\n[2] 状态标识映射：UI 看到的 ↔ markdown 写的');
{
  const cases = [
    { md: '- [ ] 普通任务', expected: { completed: false, important: false, current: false } },
    { md: '- [✓] 已完成', expected: { completed: true, important: false, current: false } },
    { md: '- [ ] [⭐] 重要', expected: { completed: false, important: true, current: false } },
    { md: '- [ ] [▶] 当前', expected: { completed: false, important: false, current: true } },
    { md: '- [ ] [▶] [⭐] 重要且当前', expected: { completed: false, important: true, current: true } },
    { md: '- [✓] [▶] [⭐] 三状态', expected: { completed: true, important: true, current: true } },
    // 兼容旧标记
    { md: '- [ ] ⭐ 旧版重要', expected: { completed: false, important: true, current: false } },
    { md: '- [ ] ▶ 旧版当前', expected: { completed: false, important: false, current: true } },
    { md: '- [ ] @当前 旧版当前', expected: { completed: false, important: false, current: true } },
    // [x] / [X] 也算完成
    { md: '- [x] x 完成', expected: { completed: true, important: false, current: false } },
    { md: '- [X] X 完成', expected: { completed: true, important: false, current: false } },
  ];
  for (const { md, expected } of cases) {
    const cats = parseMarkdown(`# 全部任务\n\n## 工作\n\n${md}\n`);
    const task = cats.find(c => c.name === '工作').tasks[0];
    const got = { completed: task.completed, important: task.important, current: task.current };
    check(`状态：${md}`, eq(got, expected), `got=${JSON.stringify(got)}`);
  }
}

console.log('\n[3] 顺序完全保留（无 sort）');
{
  // 用一些字母接近的文本，确认不会按字母排
  const md = `# 全部任务\n\n## 工作\n\n- [ ] zebra\n- [ ] apple\n- [ ] mango\n- [ ] banana\n- [ ] cherry\n`;
  const cats = parseMarkdown(md);
  const texts = cats.find(c => c.name === '工作').tasks.map(t => t.text);
  check('文本顺序：zebra, apple, mango, banana, cherry',
    eq(texts, ['zebra', 'apple', 'mango', 'banana', 'cherry']),
    texts.join(','));

  // 跨分类顺序也保留
  const md2 = `# 全部任务\n\n## 工作\n\n- [ ] 工作 2\n- [ ] 工作 1\n\n## 学习\n\n- [ ] 学习 3\n- [ ] 学习 1\n- [ ] 学习 2\n`;
  const cats2 = parseMarkdown(md2);
  check('工作内顺序', eq(cats2.find(c => c.name === '工作').tasks.map(t => t.text),
    ['工作 2', '工作 1']));
  check('学习内顺序', eq(cats2.find(c => c.name === '学习').tasks.map(t => t.text),
    ['学习 3', '学习 1', '学习 2']));
}

console.log('\n[4] 分类名称完全保留（含空格、CJK、emoji、特殊字符）');
{
  const cases = [
    '工作',
    '工作 学习',
    '  带空格  ',  // trim 后变「带空格」
    '分类-A',
    '分类 A',
    '中文 / 子分类',
    '🐛 bugs',
    '🎉 发布',
    '123 数字',
  ];
  for (const name of cases) {
    const md = `# 全部任务\n\n## ${name}\n\n- [ ] 任务\n`;
    const cats = parseMarkdown(md);
    const trimmed = name.replace(/^\s+|\s+$/g, '');
    const found = cats.find(c => c.name === trimmed);
    check(`分类名「${name}」`, found !== undefined,
      cats.map(c => c.name).join(' | '));
  }
}

console.log('\n[5] parser → writer → parser 幂等：往返不丢任何信息');
{
  const inputs = [
    // 简单
    `# 全部任务\n\n## 工作\n\n- [ ] a\n- [✓] b\n- [ ] [⭐] c\n- [ ] [▶] d\n`,
    // 多分类
    `# 全部任务\n\n## 工作\n\n- [ ] 工作 1\n- [ ] 工作 2\n\n## 学习\n\n- [ ] 学习 1\n\n## 生活\n\n- [ ] 生活 1\n- [✓] 生活 2\n`,
    // 含空文本任务
    `# 全部任务\n\n## 工作\n\n- [ ]\n- [ ] 有文本\n- [✓]\n`,
    // 含旧版标记
    `# 全部任务\n\n## 工作\n\n- [ ] ⭐ 旧版\n- [ ] @当前 旧版\n`,
    // 含 emoji
    `# 全部任务\n\n## 工作\n\n- [ ] 🐛 fix bug\n- [ ] 🎉 release\n`,
  ];
  for (const [i, input] of inputs.entries()) {
    const cats1 = parseMarkdown(input);
    const md1 = writeMarkdown(cats1);
    const cats2 = parseMarkdown(md1);
    const md2 = writeMarkdown(cats2);

    // markdown 完全一致（往返幂等）
    check(`[${i}] markdown 往返一致 (md1 === md2)`, md1 === md2,
      `md1=${JSON.stringify(md1)} md2=${JSON.stringify(md2)}`);

    // 任务数一致
    const n1 = cats1.reduce((s, c) => s + c.tasks.length, 0);
    const n2 = cats2.reduce((s, c) => s + c.tasks.length, 0);
    check(`[${i}] 任务数不变`, n1 === n2, `${n1} → ${n2}`);

    // 任务 (text, completed, important, current) 元组完全一致
    const flat1 = cats1.flatMap(c => c.tasks.map(t => ({t: t.text, c: t.completed, i: t.important, r: t.current})));
    const flat2 = cats2.flatMap(c => c.tasks.map(t => ({t: t.text, c: t.completed, i: t.important, r: t.current})));
    check(`[${i}] 任务元组一致`, eq(flat1, flat2),
      `\n      flat1=${JSON.stringify(flat1)}\n      flat2=${JSON.stringify(flat2)}`);
  }
}

console.log('\n[6] writer → parser 不丢任务：写出去再读回来，任务全在');
{
  // 起点：构造一份较复杂的 categories
  const initial = parseMarkdown(`# 全部任务\n\n## 工作\n\n- [ ] a\n- [✓] b\n- [ ] [⭐] c\n- [ ] [▶] d\n- [ ] [▶] [⭐] e\n\n## 学习\n\n- [ ] 旧标记 ⭐\n- [ ] 旧标记 @当前\n\n## 未分类\n\n- [ ] 孤儿任务\n`);
  const written = writeMarkdown(initial);

  // 写出去再读
  const reloaded = parseMarkdown(written);

  // 验证：所有任务都在
  const initialTexts = initial.flatMap(c => c.tasks.map(t => t.text));
  const reloadedTexts = reloaded.flatMap(c => c.tasks.map(t => t.text));
  check('所有任务文本都回来', initialTexts.every(t => reloadedTexts.includes(t)),
    `\n      lost=${JSON.stringify(initialTexts.filter(t => !reloadedTexts.includes(t)))}`);
  check('任务数一致', initialTexts.length === reloadedTexts.length);

  // 验证：所有状态都回来（用 (分类名, 任务索引) 配对，避免同名任务撞）
  for (const cat of initial) {
    cat.tasks.forEach((t, i) => {
      const reloadedCat = reloaded.find(c => c.name === cat.name);
      const found = reloadedCat?.tasks[i];
      check(`状态：${cat.name}[${i}]「${t.text}」`,
        found && found.text === t.text &&
        found.completed === t.completed &&
        found.important === t.important &&
        found.current === t.current,
        found && `expected=${JSON.stringify({c:t.completed,i:t.important,r:t.current})} got=${JSON.stringify({c:found.completed,i:found.important,r:found.current})}`);
    });
  }
}

console.log('\n[7] 空文本任务（合法手写）');
{
  // 软件允许「纯勾选无文本」的任务
  const md = `# 全部任务\n\n## 工作\n\n- [ ]\n- [ ] 有文本\n- [✓]\n`;
  const cats = parseMarkdown(md);
  const tasks = cats.find(c => c.name === '工作').tasks;
  check('3 条任务都在', tasks.length === 3);
  check('第 1 条空文本', tasks[0].text === '' && tasks[0].completed === false);
  check('第 2 条文本', tasks[1].text === '有文本');
  check('第 3 条已完成空文本', tasks[2].text === '' && tasks[2].completed === true);

  // 往返
  const written = writeMarkdown(cats);
  const reloaded = parseMarkdown(written);
  const reloadedTasks = reloaded.find(c => c.name === '工作').tasks;
  check('往返后任务数仍 3', reloadedTasks.length === 3);
  check('往返后空文本保留', reloadedTasks[0].text === '');
  check('往返后已完成保留', reloadedTasks[2].completed === true);
}

console.log('\n[8] 多行/换行处理：单行任务强制要求');
{
  // 任务文本中嵌入换行 → 写时器会压成单行，读时器会把「多出来的行」当新分类/任务
  // 这是已知行为，但需要测试：UI 任务数 = markdown 任务数
  const md = `# 全部任务\n\n## 工作\n\n- [ ] 任务 A\n- [ ] 任务 B\n`;
  const cats = parseMarkdown(md);
  check('基本多任务解析', cats.find(c => c.name === '工作').tasks.length === 2);
}

console.log('\n[9] BOM 处理：UTF-8 BOM 不影响解析');
{
  const md = '\uFEFF# 全部任务\n\n## 工作\n\n- [ ] a\n- [ ] b\n';
  const cats = parseMarkdown(md);
  check('BOM 后能正常解析', cats.find(c => c.name === '工作').tasks.length === 2,
    cats.map(c => `${c.name}(${c.tasks.length})`).join(' | '));
}

console.log('\n[10] CRLF / LF / CR：换行符归一化');
{
  const lf = `# 全部任务\n\n## 工作\n\n- [ ] a\n- [ ] b\n`;
  const crlf = `# 全部任务\r\n\r\n## 工作\r\n\r\n- [ ] a\r\n- [ ] b\r\n`;
  const catsLf = parseMarkdown(lf);
  const catsCrlf = parseMarkdown(crlf);
  check('LF 解析', catsLf.find(c => c.name === '工作').tasks.length === 2);
  check('CRLF 解析', catsCrlf.find(c => c.name === '工作').tasks.length === 2);
}

console.log('\n[11] 分类 kind 一致性：UI 视角的「全部任务容器/子分类/回收站」kind 不变');
{
  const md = `# 全部任务\n\n## 工作\n\n- [ ] a\n\n# 回收站\n\n- [ ] 已删\n`;
  const cats = parseMarkdown(md);
  const container = cats.find(c => c.kind === CategoryKind.OTHER_TASKS);
  const sub = cats.find(c => c.parentOtherTasks);
  const trash = cats.find(c => c.kind === CategoryKind.TRASH);

  check('容器：全部任务', container && container.name === '全部任务');
  check('子分类：工作', sub && sub.name === '工作');
  check('回收站：回收站', trash && trash.name === '回收站');
  check('子分类.parentOtherTasks=true', sub.parentOtherTasks === true);

  // 往返
  const written = writeMarkdown(cats);
  const reloaded = parseMarkdown(written);
  check('往返后容器仍为容器', reloaded.some(c => c.kind === CategoryKind.OTHER_TASKS));
  check('往返后子分类仍是子分类', reloaded.some(c => c.parentOtherTasks));
  check('往返后回收站仍是回收站', reloaded.some(c => c.kind === CategoryKind.TRASH));
}

console.log('\n[12] 创建默认文档：4 个子分类 + 容器');
{
  const cats = createDefaultDoc();
  const container = cats.find(c => c.kind === CategoryKind.OTHER_TASKS);
  const subs = cats.filter(c => c.parentOtherTasks);

  check('容器名为「全部任务」', container && container.name === '全部任务');
  check('默认 4 个子分类', subs.length === 4,
    `subs=${subs.map(s => s.name).join(',')}`);
  for (const name of ['工作', '学习', '生活', '未分类']) {
    check(`子分类 ${name} 存在`, subs.some(s => s.name === name));
  }
}

console.log('\n[13] 重要 + 当前 → 智能视图聚合（v3 不写镜像段，但聚合正确）');
{
  // UI 上看「重要任务」智能视图：所有 important=true 的任务
  // UI 上看「当前任务」智能视图：所有 current=true 的任务
  // UI 上看「已完成任务」智能视图：所有 completed=true 的任务
  const md = `# 全部任务\n\n## 工作\n\n- [ ] [⭐] a\n- [ ] b\n- [ ] [▶] c\n\n## 学习\n\n- [✓] [⭐] d\n- [ ] e\n- [✓] f\n`;
  const cats = parseMarkdown(md);
  const all = cats.flatMap(c => c.tasks);

  const important = all.filter(t => t.important).map(t => t.text).sort();
  const current = all.filter(t => t.current).map(t => t.text).sort();
  const completed = all.filter(t => t.completed).map(t => t.text).sort();

  check('重要任务视图：a, d', eq(important, ['a', 'd']), important.join(','));
  check('当前任务视图：c', eq(current, ['c']), current.join(','));
  check('已完成任务视图：d, f', eq(completed, ['d', 'f']), completed.join(','));
}

console.log('\n[14] 同一文本多份：每份都是独立任务');
{
  const md = `# 全部任务\n\n## 工作\n\n- [ ] 买菜\n- [ ] 买菜\n- [ ] 买菜\n`;
  const cats = parseMarkdown(md);
  const tasks = cats.find(c => c.name === '工作').tasks;
  check('3 条同名任务都在', tasks.length === 3);
  check('id 各不相同',
    new Set(tasks.map(t => t.id)).size === 3,
    tasks.map(t => t.id).join(','));
}

console.log('\n[15] 行中行尾混合的 <!-- id -->：行中保留为字面文本，行尾剥掉');
{
  // 行中：保留（用户可能写文档示例）
  // 行尾：剥掉（v3 不写，但旧文件兼容）
  const md = `# 全部任务\n\n## 工作\n\n- [ ] 看这里 <!-- id:t1 --> 中间内容 <!-- id:t99 -->\n`;
  const cats = parseMarkdown(md);
  const t = cats.find(c => c.name === '工作').tasks[0];
  // 行尾的剥掉，行中的保留
  check('行中保留 + 行尾剥掉',
    t.text === '看这里 <!-- id:t1 --> 中间内容',
    JSON.stringify(t.text));
  // 解析器对每个加载文件从 t1 开始，单任务就是 t1（运行时分配，非文件中的 t1）
  check('id 是「工作」分类第一条任务的运行时 id', t.id === 't1', `t.id=${t.id}`);

  // 写出去：行尾的 <!-- id:t99 --> 已被剥掉；行中的 <!-- id:t1 --> 是用户文本的一部分，保留
  const written = writeMarkdown(cats);
  check('写出去无行尾 <!-- id:（行中是字面文本保留）',
    !/<!--\s*id:[^\s>]+\s*-->$/.test(written.split('\n').find(l => l.startsWith('- '))),
    written);
  // 行中那串 `<!-- id:t1 -->` 仍在写出去的文本里（作为字面字符）
  check('行中 <!-- id:t1 --> 作为字面文本保留', written.includes('<!-- id:t1 -->'), written);
}

console.log(`\n通过 ${summary.pass} / 失败 ${summary.fail}`);
process.exit(summary.fail === 0 ? 0 : 1);
