// 一次性验证脚本：内容导入功能（task-store.parseImportLine + importTasksToCategory）
//
// 覆盖：
//   1. parseImportLine 纯函数的所有解析分支（checkbox / 列表符号剥离 / 普通行 / 空行）
//   2. importTasksToCategory 与序列化往返（Markdown 是真相之源 —— 必须能 parse 回来）
//   3. 目标分类的守卫（容器 / 回收站 / 不存在的分类）
//   4. 0 条有效行时不污染 dirty 状态
//   5. 中文标点「、」/「。」不会被当成列表符号误剥离
//
// 用法：node scripts/check-import-tasks.mjs

import { TaskStore, parseImportLine } from '../src/task-store.js';
import { check, ok, bad, summary, printSummary } from './_lib/check.mjs';
import { makeStore } from './_lib/store-fixture.mjs';
import { parseMarkdown, CategoryKind } from '../src/markdown-parser.js';
import { OTHER_TASKS_NAME, TRASH_NAME } from '../src/markdown-parser.js';

// ============================================================
//  [1] parseImportLine —— checkbox 行
// ============================================================
console.log('\n[1] parseImportLine 识别 Markdown checkbox');

{
  // 完成态：[✓]/[x]/[X] 一律视为已完成；与 markdown-parser 对齐
  for (const marker of ['✓', 'x', 'X']) {
    const r = parseImportLine(`- [${marker}] 已完成的任务`, { stripLeadingBullets: true });
    check(`- [${marker}] 行 → completed=true, text 已剥掉 checkbox`,
      r && r.completed === true && r.text === '已完成的任务',
      JSON.stringify(r));
  }

  // 未完成：[ ] 是合法 checkbox（字符集收紧到 ` ✓xX`，见 TASK_LINE_RE 注释）。
  // 旧版 [!high] 这种"非标准 checkbox"字符现在被 fallback 接管 —— 不再被当作
  // checkbox 剥掉，而是当列表项文本原样保留（completed=false）：
  //   - 旧 bug 是「任何 [X] 都当 checkbox」会让 `[⭐]` 这种 inline 标记被吃掉
  //   - fix 是「只 [ ✓xX] 是 checkbox」+「其余 [X] 当列表项文本」
  const r0 = parseImportLine('- [ ] 未完成的任务', { stripLeadingBullets: true });
  check('- [ ] 行 → completed=false, text 已剥掉 checkbox',
    r0 && r0.completed === false && r0.text === '未完成的任务',
    JSON.stringify(r0));
  const r0b = parseImportLine('- [!high] 未完成的任务', { stripLeadingBullets: true });
  check('- [!high] 行 → completed=false，!high 当作列表项文本保留（不再当 checkbox 剥）',
    r0b && r0b.completed === false && r0b.text === '[!high] 未完成的任务',
    JSON.stringify(r0b));

  // checkbox 行的前导列表符号 `*`/`+` 也兼容
  const r1 = parseImportLine('* [ ] 用 * 开头', { stripLeadingBullets: true });
  check('* [ ] 行 → 识别为 checkbox，不当列表符号剥除',
    r1 && r1.completed === false && r1.text === '用 * 开头',
    JSON.stringify(r1));

  const r2 = parseImportLine('+ [✓] 用 + 开头', { stripLeadingBullets: true });
  check('+ [✓] 行 → 识别为 checkbox',
    r2 && r2.completed === true && r2.text === '用 + 开头',
    JSON.stringify(r2));

  // checkbox 文本部分允许为空吗？早期实现返回 null（empty text 视为无效），
  // 但这与 parseMarkdown 不一致 —— 文件里合法手写的 `- [x]`（无文本）会被
  // loadFromContent 保留下来；导入却悄悄丢，会让用户数据「莫名消失」。
  // 现在统一允许 —— text 为空字符串。明确测一下避免未来回归。
  const r3 = parseImportLine('- [ ] ', { stripLeadingBullets: true });
  check('checkbox 行无文本 → 接受（与 parseMarkdown 对齐）',
    r3 && r3.completed === false && r3.text === '',
    JSON.stringify(r3));
  const r4 = parseImportLine('- [x]', { stripLeadingBullets: true });
  check('纯勾选 `- [x]` → text="" 但 completed=true（与 parseMarkdown 对齐）',
    r4 && r4.completed === true && r4.text === '',
    JSON.stringify(r4));
}

// ============================================================
//  [2] parseImportLine —— 普通列表符号剥离
// ============================================================
console.log('\n[2] parseImportLine 剥离普通列表符号');

{
  for (const [input, expected] of [
    ['- foo', 'foo'],
    ['* foo', 'foo'],
    ['+ foo', 'foo'],
    ['• foo', 'foo'],
    ['1. foo', 'foo'],
    ['2) foo', 'foo'],
    ['10. 多位数也行', '多位数也行'],
    // 多个空白字符也应被吞掉（`-   foo` → `foo`）
    ['-   多空格', '多空格']
  ]) {
    const r = parseImportLine(input, { stripLeadingBullets: true });
    check(`剥离「${input}」→「${expected}」`,
      r && r.completed === false && r.text === expected,
      JSON.stringify(r));
  }

  // 中文标点不是列表符号
  for (const input of ['、任务', '。任务', '；任务', '，任务']) {
    const r = parseImportLine(input, { stripLeadingBullets: true });
    check(`中文标点「${input.charAt(0)}」不被剥离，原样保留`,
      r && r.text === input,
      JSON.stringify(r));
  }

  // 关闭选项时：前导列表符号保留
  const r = parseImportLine('- foo', { stripLeadingBullets: false });
  check('stripLeadingBullets=false 时保留前导「- 」',
    r && r.text === '- foo',
    JSON.stringify(r));

  // 没有列表符号的普通行
  const r2 = parseImportLine('普通任务', { stripLeadingBullets: true });
  check('无符号普通行原样',
    r2 && r2.text === '普通任务' && r2.completed === false,
    JSON.stringify(r2));
}

// ============================================================
//  [3] parseImportLine —— 空行 / 仅空白 / 默认行为
// ============================================================
console.log('\n[3] parseImportLine 空行处理');

{
  check('空字符串 → null', parseImportLine('', { stripLeadingBullets: true }) === null);
  check('仅空白 → null', parseImportLine('   \t  ', { stripLeadingBullets: true }) === null);
  check('null/undefined 输入 → null', parseImportLine(null, {}) === null);
  check('默认选项 = stripLeadingBullets=true（不显式传）',
    parseImportLine('- foo').text === 'foo',
    JSON.stringify(parseImportLine('- foo')));
}

// ============================================================
//  [4] importTasksToCategory —— 基本导入 + Markdown 往返
// ============================================================
console.log('\n[4] importTasksToCategory 批量导入 + 序列化往返');

{
  // 注入一个让 *Position 全部走 'back' 的 settingsStore —— 本节断言「按出现顺序」= push 顺序。
  // 默认 'front' 模式（最新在最上）由 check-insert-position.mjs 覆盖。
  const backSettings = {
    _values: { newTaskPosition: 'back', completedPosition: 'back', trashPosition: 'back' },
    get(k) { return this._values[k]; }
  };
  const store = makeStore(null, { settingsStore: backSettings });
  // 默认文档自带「工作 / 学习 / 生活」三个子分类（见 markdown-writer.createDefaultDoc），
  // 直接复用它们：addSubCategory 对重名返回 null，测试逻辑不该依赖它是否新建。
  const workCat = store.getCategory('工作');
  store.getCategory('学习'); // 确保复用，不创建

  const input = [
    '- [ ] 任务 A',
    '- [✓] 任务 B（已完成）',
    '- 任务 C',
    '* 任务 D',
    '1. 任务 E',
    '• 任务 F',
    '',
    '   ',
    '普通行'
  ];
  const result = store.importTasksToCategory('工作', input);

  check('导入返回 ok=true', result.ok === true);
  check('added = 7（跳过 2 行空内容）', result.added === 7,
    `实际 added=${result.added}, skipped=${result.skipped}`);
  check('skipped = 2', result.skipped === 2,
    `实际 skipped=${result.skipped}`);
  // v3.4 数据归属不变量：completed=true 的任务会被立即搬到「# 已完成任务」分类，
  // 所以「工作」里只剩 6 条 pending 任务；用 find() 按 text 查，避免依赖数组下标。
  check('未完成任务按出现顺序排列',
    workCat.tasks.map(t => t.text).join('|') ===
      '任务 A|任务 C|任务 D|任务 E|任务 F|普通行',
    workCat.tasks.map(t => t.text).join('|'));
  check('未完成任务中第一条 completed=false',
    workCat.tasks[0].completed === false);
  check('未完成任务剩余 completed=false',
    workCat.tasks.slice(1).every(t => t.completed === false));
  check('id 已生成', workCat.tasks.every(t => typeof t.id === 'string' && t.id.length > 0));
  check('重要标记未被自动加上',
    workCat.tasks.every(t => t.important === false && t.current === false));
  check('dirty 已被标脏', store.dirty === true);

  // 「# 已完成任务」分类应收到 1 条 - [✓] 任务 B
  const completedCat = store.getCompletedCategory();
  check('「# 已完成任务」收到 [✓] 任务 B（v3.4）',
    completedCat?.tasks?.length === 1 &&
    completedCat.tasks[0].text === '任务 B（已完成）' &&
    completedCat.tasks[0].completed === true &&
    completedCat.tasks[0].originalCategory === '工作');

  // 往返：导入后的内容 serialize() 出来再 parseMarkdown() 回来，7 条任务都还在
  const md = store.serialize();
  check('序列化结果包含「## 工作」', md.includes('## 工作'),
    md.split('\n').slice(0, 6).join('\n'));
  // v3.4：[✓] 任务不在「## 工作」段里 —— 它在「# 已完成任务」段
  check('序列化包含 `[✓] 任务 B`（在「# 已完成任务」段）',
    /# 已完成任务[\s\S]*\[✓\]\s*\[原分类：工作\]\s*任务 B（已完成）/.test(md),
    md);

  const reparsed = parseMarkdown(md);
  const reparsedWork = reparsed.find(c => c.name === '工作');
  const reparsedCompleted = reparsed.find(c => c.kind === CategoryKind.COMPLETED);
  check('往返后「工作」子分类仍存在', !!reparsedWork);
  check('往返后「工作」里 6 条未完成任务',
    reparsedWork?.tasks.length === 6,
    `实际 ${reparsedWork?.tasks?.length} 条`);
  check('往返后「# 已完成任务」分类有 1 条',
    reparsedCompleted?.tasks?.length === 1,
    `实际 ${reparsedCompleted?.tasks?.length} 条`);
  check('往返后「任务 B（已完成）」仍标 completed',
    reparsedCompleted?.tasks?.find(t => t.text === '任务 B（已完成）')?.completed === true);
}

// ============================================================
//  [5] importTasksToCategory —— 目标分类守卫
// ============================================================
console.log('\n[5] importTasksToCategory 目标分类守卫');

{
  const store = makeStore();

  // 容器（OTHER_TASKS）拒绝
  const r1 = store.importTasksToCategory(OTHER_TASKS_NAME, ['任务']);
  check('目标=容器 → ok=false, reason=INVALID_CATEGORY',
    r1.ok === false && r1.reason === 'INVALID_CATEGORY',
    JSON.stringify(r1));

  // 回收站（TRASH）拒绝
  // TRASH 还没创建，但我们直接传名字 —— getCategory 应找不到
  const r2 = store.importTasksToCategory(TRASH_NAME, ['任务']);
  check('目标=回收站 → ok=false, reason=INVALID_CATEGORY',
    r2.ok === false && r2.reason === 'INVALID_CATEGORY',
    JSON.stringify(r2));

  // 不存在的分类名
  const r3 = store.importTasksToCategory('不存在的分类', ['任务']);
  check('目标=不存在的分类 → ok=false, reason=INVALID_CATEGORY',
    r3.ok === false && r3.reason === 'INVALID_CATEGORY',
    JSON.stringify(r3));

  // 已确认容器/回收站分类确实没被偷偷建出来
  check('容器分类没被创建', store.getCategory(OTHER_TASKS_NAME)?.kind === CategoryKind.OTHER_TASKS,
    '容器是 base structure 自带的，但 kind 必须是 OTHER_TASKS');
  check('回收站分类仍未被创建', store.getTrashCategory() === null);

  // dirty 状态未被上述失败调用污染
  check('守卫失败时未标 dirty', store.dirty === false);
}

// ============================================================
//  [6] importTasksToCategory —— 全空输入 / 0 条有效行
// ============================================================
console.log('\n[6] importTasksToCategory 空输入');

{
  const store = makeStore();
  const cat = store.getCategory('工作');

  const r1 = store.importTasksToCategory('工作', []);
  check('空数组 → ok=true, added=0, skipped=0',
    r1.ok === true && r1.added === 0 && r1.skipped === 0,
    JSON.stringify(r1));

  const r2 = store.importTasksToCategory('工作', ['', '   ', '\t', '']);
  check('全空白行 → ok=true, added=0, skipped=4',
    r2.ok === true && r2.added === 0 && r2.skipped === 4,
    JSON.stringify(r2));

  // 监听 change 事件：0 条有效行时不应该触发
  let changeCount = 0;
  const handler = () => { changeCount++; };
  store.on('change', handler);
  store.importTasksToCategory('工作', ['', '   ']);
  store.off('change', handler);
  check('0 条有效行不触发 change 事件', changeCount === 0,
    `change 触发了 ${changeCount} 次`);
  check('0 条有效行不标 dirty', store.dirty === false);

  // 真导入 1 条 → 应当触发
  store.on('change', () => { changeCount++; });
  store.importTasksToCategory('工作', ['有效任务']);
  store.off('change', handler);
  check('1 条有效行触发 change', changeCount >= 1,
    `change 触发了 ${changeCount} 次`);
  check('dirty 已被标脏', store.dirty === true);

  // 分类里任务数 = 1（前面那些 0 条导入都没留痕）
  check('分类里只有 1 条任务（前面的 0 条导入未留痕）',
    cat.tasks.length === 1 && cat.tasks[0].text === '有效任务',
    `实际 ${cat.tasks.length} 条`);
}

// ============================================================
//  [7] parseImportLine —— 边界场景
// ============================================================
console.log('\n[7] parseImportLine 边界场景');

{
  // 「- 」/「1. 」 trim 后只剩符号 —— parseImportLine 尊重用户输入原样保留。
  // 理由：trim 在解析入口已经把两端的空白吃掉了，解析器只能看到单字符 `-` / `1.`，
  // 它们不再匹配 `\s+(.*)`（要求列表符号后至少一个空白），于是落到「普通行」分支返回原样。
  // 用户在 UI 看到的就是他们输入的字符（含 trailing 空格已被 trim）。
  const r6 = parseImportLine('- ', { stripLeadingBullets: true });
  check('「- 」trim 后只剩符号 → 当成普通行返回',
    r6 && r6.text === '-' && r6.completed === false,
    JSON.stringify(r6));
  const r7 = parseImportLine('1. ', { stripLeadingBullets: true });
  check('「1. 」trim 后只剩符号 → 当成普通行返回',
    r7 && r7.text === '1.' && r7.completed === false,
    JSON.stringify(r7));

  // 没有数字时的点号 → 不被剥离（避免「1.5 foo」里的「1.」误剥）
  const r = parseImportLine('1.5 是版本号', { stripLeadingBullets: true });
  check('「1.5」不被当列表符号（避免误剥小数点）',
    r && r.text === '1.5 是版本号',
    JSON.stringify(r));

  // 中文行内包含英文点
  const r2 = parseImportLine('版本 2.0 发布了', { stripLeadingBullets: true });
  check('「2.0」版本号行内嵌入 → 不被剥离',
    r2 && r2.text === '版本 2.0 发布了',
    JSON.stringify(r2));

  // 数字+空格+点（异常输入，如 `1 . foo`）：因为正则要求 `数字[.)]`，中间有空格就不匹配
  const r3 = parseImportLine('1 . foo', { stripLeadingBullets: true });
  check('「1 . 」异常格式不剥离',
    r3 && r3.text === '1 . foo',
    JSON.stringify(r3));

  // 带 checkbox 但又混着前后空白
  const r4 = parseImportLine('   - [ ] 前后都有空白   ', { stripLeadingBullets: true });
  check('带前后空白的 checkbox 行 → 正确解析',
    r4 && r4.completed === false && r4.text === '前后都有空白',
    JSON.stringify(r4));

  // tab 分隔也算空白
  const r5 = parseImportLine('\t- foo\t', { stripLeadingBullets: true });
  check('带 tab 的列表行 → 正确解析',
    r5 && r5.text === 'foo',
    JSON.stringify(r5));
}

// ============================================================
//  [8] importTasksToCategory —— 批量 emit（性能关键）
//
//  早期实现里 _appendTask 每次都 emit('change')，批量导入 N 条任务 = N 次 UI 重渲染。
//  修复后走批量路径：无论导入多少条，change 只触发 1 次。
// ============================================================
console.log('\n[8] 批量导入只触发一次 change 事件（避免 N 次 UI 重渲染）');

{
  // 用全局 back-mode settings（newTaskPosition 等）让 addTask 走末尾追加；
  // 导入顺序使用默认 'order'（按入参顺序 + 插到最前面）。对「按出现顺序」的断言
  // 同样成立：order 模式下 unshift 整批，line1 在最前、lineN 在最后 —— 与入参
  // 顺序完全一致。注意：历史上这里用 importPosition='back'，现已删除该模式，
  // 改用默认 'order'，行为对「按入参顺序」的断言不变。参见 [12] 验证两种模式。
  const backSettings = {
    _values: {
      newTaskPosition: 'back',
      completedPosition: 'back',
      trashPosition: 'back'
    },
    get(k) { return this._values[k]; }
  };
  const store = makeStore(null, { settingsStore: backSettings });
  const cat = store.getCategory('工作');

  // 50 条任务：早期实现会触发 50 次 change；批量路径必须只有 1 次
  const N = 50;
  const lines = [];
  for (let i = 0; i < N; i++) lines.push(`任务 ${i + 1}`);

  let changeCount = 0;
  const onChange = () => { changeCount++; };
  store.on('change', onChange);

  const result = store.importTasksToCategory('工作', lines);
  store.off('change', onChange);

  check(`50 条任务全部导入（added=${N}）`, result.added === N);
  check('change 事件只触发 1 次（不是 50 次）', changeCount === 1,
    `实际 ${changeCount} 次`);

  // dirty 也应只触发一次（_markDirty 内部会 push autoSave，debounce 仍合并）
  check('dirty 已被标脏（合并后 = true）', store.dirty === true);

  // 验证任务确实全部落地
  check(`「工作」分类里有 ${N} 条任务`, cat.tasks.length === N);
  check('任务按出现顺序排列（order 模式 = 入参顺序）',
    cat.tasks.map(t => t.text).join('|') === lines.join('|'),
    cat.tasks.map(t => t.text).join('|'));
}

// ============================================================
//  [9] importTasksToCategory —— 与 addTask 走两条路径不冲突
// ============================================================
console.log('\n[9] 批量路径与 addTask 路径各自 emit 正确次数');

{
  const store = makeStore();
  const cat = store.getCategory('工作');

  // 1) addTask 单条：1 次 emit
  let changeCount = 0;
  const onChange1 = () => { changeCount++; };
  store.on('change', onChange1);
  store.addTask('工作', '单条');
  store.off('change', onChange1);
  check('addTask 单条 → change 触发 1 次', changeCount === 1,
    `实际 ${changeCount} 次`);

  // 2) 批量导入：1 次 emit
  changeCount = 0;
  const onChange2 = () => { changeCount++; };
  store.on('change', onChange2);
  store.importTasksToCategory('工作', ['批 1', '批 2', '批 3']);
  store.off('change', onChange2);
  check('importTasksToCategory 批量 3 条 → change 触发 1 次', changeCount === 1,
    `实际 ${changeCount} 次`);

  // 3) 0 条有效行的批量：0 次 emit（不是 1 次 —— 0 条不应该假装操作发生了）
  changeCount = 0;
  const onChange3 = () => { changeCount++; };
  store.on('change', onChange3);
  store.importTasksToCategory('工作', ['', '   ', '']);
  store.off('change', onChange3);
  check('0 条有效行 → change 触发 0 次', changeCount === 0,
    `实际 ${changeCount} 次`);
}

// ============================================================
//  [10] _createTask —— 单条 ID 生成器
//
//  抽出后给 _appendTask 和 importTasksToCategory 共用。
//  自检确保批量路径里的任务也带合法 ID。
// ============================================================
console.log('\n[10] _createTask ID 生成');

{
  const store = makeStore();
  const task = store._createTask('测试', false);
  check('id 是字符串且非空', typeof task.id === 'string' && task.id.length > 0,
    `实际 ${JSON.stringify(task)}`);
  check('字段默认值正确',
    task.text === '测试' && task.completed === false &&
    task.important === false && task.current === false);

  // completed=true 也要正常赋值
  const task2 = store._createTask('已完成', true);
  check('completed=true 被保留', task2.completed === true);
}

// ============================================================
//  [11] 数据保真度：inline 标记 [⭐] / [▶] 必须翻译成 important / current
//
//  早期 parseImportLine 只返回 { text, completed } —— 文本里的 [⭐] / [▶]
//  会被原样写进任务 text，但 important / current 字段仍是 false。
//  后果：UI 上看起来文字里「写着 [⭐] 重要」，但实际不算重要；下次保存后
//  parseMarkdown 又把 [⭐] 抽走 —— 用户数据在「导入 → 保存 → 重载」之间
//  被悄悄改写。
//
//  修复：parseImportLine 与 parseMarkdown 共用 extractInlineMarkers，
//  保证两套入口行为完全一致。
// ============================================================
console.log('\n[11] 数据保真度：[⭐]/[▶] 标记翻译成 important/current');

{
  // 11.1 复现原 bug：checkbox + inline important
  // 直接用 store.importTasksToCategory 验证端到端
  const store = makeStore();
  const r = store.importTasksToCategory('工作', [
    '- [ ] [⭐] 重要任务',
    '- [ ] [▶] 当前任务',
    '- [✓] [⭐] 已完成且重要',
    '- [ ] [▶] [⭐] 两个都在行首（合法）',
    '- [ ] 对比 [⭐] 和 [ ] 行内不应被剥',  // 行内 [⭐] —— 故意不应被识别
    '- [ ] 任务 [⭐]',           // 末尾 [⭐]（前有空格）也应被识别
    '- [ ] 任务 [▶]',
    '[⭐] 重要（无 checkbox）',
    '⭐ 裸星（前后空格）',
    '▶ 裸三角'
  ], { stripLeadingBullets: true });

  check('10 条全部接受（无 skipped）', r.added === 10 && r.skipped === 0,
    `added=${r.added}, skipped=${r.skipped}`);

  // v3.4 数据归属不变量：- [✓] 已完成且重要 会立即被搬到「# 已完成任务」分类，
  // 所以「工作」里只会有 9 条 pending 任务，已完成分类里有 1 条。
  // 用 find() 按 text 查，避免依赖数组顺序（顺序会随 v3.4 重排）。
  const tasks = store.getCategory('工作').tasks;
  const completed = store.getCompletedCategory()?.tasks || [];

  // 注意：[⭐] / [▶] 必须出现在行首（紧贴开头）或行尾（前有空格）才会被识别。
  // 行内位置「对比 [⭐] 和 [ ]」中间的 [⭐] 故意不被识别 —— 这是设计：
  // parser 用位置锚避免误中「用户在文本里写了 [⭐] 字面字符」的情况。
  // 测试要反映这个事实，而不是测「应该识别中间位置」—— 那种实现会低门槛地损坏数据。
  check('[⭐] 开头：text="重要任务", important=true, current=false',
    tasks.find(t => t.text === '重要任务')?.important === true &&
    tasks.find(t => t.text === '重要任务')?.current === false);
  check('[▶] 开头：text="当前任务", important=false, current=true',
    tasks.find(t => t.text === '当前任务')?.important === false &&
    tasks.find(t => t.text === '当前任务')?.current === true);
  // v3.4：[✓] 任务搬到「# 已完成任务」，并在「工作」里看不到
  check('[✓]+[⭐] 在已完成分类里 completed=true 且 important=true',
    completed.find(t => t.text === '已完成且重要')?.completed === true &&
    completed.find(t => t.text === '已完成且重要')?.important === true,
    JSON.stringify(completed));
  check('[✓]+[⭐] 不在「工作」分类里（v3.4 不变量）',
    !tasks.some(t => t.text === '已完成且重要'));
  check('[✓]+[⭐] 带 originalCategory=工作（便于取消勾选归位）',
    completed.find(t => t.text === '已完成且重要')?.originalCategory === '工作');
  check('两个标记都紧贴行首 [▶] [⭐]：important=true 且 current=true',
    tasks.find(t => t.text === '两个都在行首（合法）')?.important === true &&
    tasks.find(t => t.text === '两个都在行首（合法）')?.current === true);
  // 关键：「对比 [⭐] 和 [ ]」里 [⭐] 出现在中间位置 —— parser 故意不识别
  // 这是设计意图（避免误剥用户文本里的字面 [⭐] 字符），不是 bug。
  check('行内 [⭐] 不被识别（保护用户文本里的字面字符）',
    tasks.find(t => t.text === '对比 [⭐] 和 [ ] 行内不应被剥')?.important === false &&
    tasks.find(t => t.text === '对比 [⭐] 和 [ ] 行内不应被剥')?.text === '对比 [⭐] 和 [ ] 行内不应被剥');
  check('末尾 [⭐]（前有空格）：剥掉且 important=true',
    tasks.find(t => t.text === '任务' && t.important === true) !== undefined);
  check('末尾 [▶]：剥掉且 current=true',
    tasks.find(t => t.text === '任务' && t.current === true) !== undefined);
  check('[⭐] 开头（无 checkbox）：important=true',
    tasks.find(t => t.text === '重要（无 checkbox）')?.important === true);
  // 裸 ⭐ / ▶ 因为前后有空格，extractInlineMarkers 会识别 —— 这是设计：
  // 写文件时强制用 [⭐] / [▶] 这种方括号标记，裸字符仅用于向后兼容旧文件
  check('裸 ⭐（前后空格）被识别为 important',
    tasks.find(t => t.text === '裸星（前后空格）')?.important === true);
  check('裸 ▶（前后空格）被识别为 current',
    tasks.find(t => t.text === '裸三角')?.current === true);
  check('「工作」分类只有 9 条未完成任务（v3.4 后）',
    tasks.length === 9, `实际 ${tasks.length}`);
  check('「# 已完成任务」分类有 1 条已完成任务',
    completed.length === 1, `实际 ${completed.length}`);

  // 11.2 往返：序列化后再 parseMarkdown 解析，标记不应被「重复剥」或漏剥
  const md = store.serialize();
  const reloaded = parseMarkdown(md);
  const reloadedWork = reloaded.find(c => c.name === '工作');
  const reloadedCompleted = reloaded.find(c => c.kind === CategoryKind.COMPLETED);

  check('重载后「工作」任务数 = 9（[✓] 已在已完成分类）',
    reloadedWork?.tasks?.length === 9,
    `实际 ${reloadedWork?.tasks?.length}`);
  check('重载后「# 已完成任务」任务数 = 1',
    reloadedCompleted?.tasks?.length === 1,
    `实际 ${reloadedCompleted?.tasks?.length}`);
  check('重载后 [⭐] 重要任务仍标 important',
    reloadedWork?.tasks?.find(t => t.text === '重要任务')?.important === true);
  check('重载后 [▶] 当前任务仍标 current',
    reloadedWork?.tasks?.find(t => t.text === '当前任务')?.current === true);
  check('重载后 两个标记都在行首的任务仍标 important+current',
    reloadedWork?.tasks?.find(t => t.text === '两个都在行首（合法）' &&
      t.important === true && t.current === true) !== undefined);
  // 「对比 [⭐] 和 [ ]」是行内位置，重载后 text 应保持原样（[⭐] 不能被剥）
  check('重载后行内 [⭐] 不会被破坏',
    reloadedWork?.tasks?.find(t => t.text === '对比 [⭐] 和 [ ] 行内不应被剥') !== undefined);
}

// ============================================================
//  [12] 数据保真度：纯 checkbox 行（无文本）不再被悄悄丢弃
//
//  早期实现：`- [x]` → null → skipped++
//  后果：用户手写的纯勾选行导入时莫名消失。
//
//  修复：与 parseMarkdown 行为对齐 —— 文本允许为空（空字符串 ""）。
//  实际意义不大（UI 上一条空文本任务看起来奇怪），但保证「load → import」对称。
// ============================================================
console.log('\n[12] 数据保真度：纯 checkbox 行不被丢弃');

{
  const store = makeStore();
  // 混合输入：纯勾选行 + 正常任务
  const r = store.importTasksToCategory('工作', [
    '- [ ]',
    '- [x]',
    '- [✓]',
    '- [ ] 正常任务'
  ], { stripLeadingBullets: true });

  check('4 行全部接受（无 skipped）', r.added === 4 && r.skipped === 0,
    `added=${r.added}, skipped=${r.skipped}`);

  // v3.4 数据归属不变量：completed=true 的任务被搬到「# 已完成任务」分类，
  // 「工作」里只剩 2 条 pending 任务（- [ ] 空任务 + - [ ] 正常任务）。
  const tasks = store.getCategory('工作').tasks;
  const completed = store.getCompletedCategory()?.tasks || [];
  check('- [ ] 留在「工作」分类里 completed=false',
    tasks.find(t => t.text === '' && t.completed === false) !== undefined);
  check('正常任务在「工作」分类里',
    tasks.find(t => t.text === '正常任务' && t.completed === false) !== undefined);
  check('「工作」分类只有 2 条未完成任务（v3.4 后）',
    tasks.length === 2, `实际 ${tasks.length}`);
  check('- [x] 搬到「# 已完成任务」 completed=true',
    completed.find(t => t.completed === true) !== undefined);
  check('- [✓] 搬到「# 已完成任务」 completed=true',
    completed.filter(t => t.completed === true).length === 2,
    `completed 实际 ${completed.length} 条`);

  // 往返：serialize → parseMarkdown，4 条任务都还在
  const md = store.serialize();
  const reloaded = parseMarkdown(md);
  const reloadedWork = reloaded.find(c => c.name === '工作');
  const reloadedCompleted = reloaded.find(c => c.kind === CategoryKind.COMPLETED);
  check('重载后「工作」有 2 条任务',
    reloadedWork?.tasks?.length === 2,
    `实际 ${reloadedWork?.tasks?.length}`);
  check('重载后「# 已完成任务」有 2 条任务',
    reloadedCompleted?.tasks?.length === 2,
    `实际 ${reloadedCompleted?.tasks?.length}`);
  check('重载后已完成任务仍 completed=true',
    reloadedCompleted?.tasks?.every(t => t.completed === true));
}

// ============================================================
//  [13] 数据保真度：导入对既有任务零干扰
//
//  回归测试 —— 之前发现批量路径会用 _appendTask 一次只追加一条，
//  可能污染既有任务的顺序 / ID / 状态。批量路径应只 push，不修改其它字段。
//
//  注：本测试早期版本用 importPosition='back' 让既有任务「保持原位」、新导入
//  任务追加到末尾，从而验证既有任务的 id / 字段快照未被修改。importPosition
//  收成两个选项后不再有 'back'，所以本测试改用「默认 order」语义：导入任务按
//  入参顺序插到最前面，既有任务被自然推到列表下方。重点验证的「既有任务 id 与
//  字段不被改」这条不变量与排序模式无关 —— 无论用 order / front，导入路径都
//  不能触碰既有任务对象的字段。
// ============================================================
console.log('\n[13] 数据保真度：批量导入对既有任务零干扰');

{
  // 默认 settingsStore（不注入）：importPosition 走 'order' 默认值。
  // 同时显式把 *Position 系列全部设为 'front'，避免测试受其它全局设置影响。
  const settings = {
    _values: {
      newTaskPosition: 'front',
      completedPosition: 'front',
      uncompletePosition: 'front',
      trashPosition: 'front',
      restorePosition: 'front'
      // importPosition 不设 → store 内部兜底为 'order'
    },
    get(k) { return this._values[k]; }
  };
  const store = makeStore(null, { settingsStore: settings });
  const cat = store.getCategory('工作');

  // 既有任务：混合状态。
  // 注意 addTask 走 newTaskPosition='front'（unshift），所以调用顺序「existing 1 → existing 2」
  // 之后，cat.tasks 里顺序是 [existing 2, existing 1]（existing 2 插到最前）。
  // 用「在 add 完之后按 add 顺序定位」的方式拿引用，避免依赖 cat.tasks 下标。
  store.addTask('工作', 'existing 1');
  const ex1 = cat.tasks.find(t => t.text === 'existing 1');
  store.addTask('工作', 'existing 2');
  const ex2 = cat.tasks.find(t => t.text === 'existing 2');
  // 标记 ex2 为重要 + 完成 + 当前 —— 这是要保真的「既有任务 2」
  ex2.important = true;
  ex2.completed = true;
  ex2.current = true;

  const ex1Id = ex1.id;
  const ex2Id = ex2.id;
  const ex2Snapshot = JSON.stringify({
    text: ex2.text, completed: ex2.completed, important: ex2.important, current: ex2.current
  });

  // 批量导入
  store.importTasksToCategory('工作', [
    '- [ ] new A',
    '- [✓] [⭐] new B',
    'new C'
  ]);

  // 既有任务的 ID 必须不变（order 模式下新导入任务插到最前，既有任务被推到下面）
  // 先记录被推到列表下方后，既有任务的当前下标。
  const ex1Idx = cat.tasks.findIndex(t => t.id === ex1Id);
  const ex2Idx = cat.tasks.findIndex(t => t.id === ex2Id);
  check('既有任务 1 的 id 仍在分类里', ex1Idx >= 0);
  check('既有任务 2 的 id 仍在分类里', ex2Idx >= 0);
  // 既有任务的状态字段快照必须完全一致（防止批量路径意外修改）
  const ex2After = cat.tasks.find(t => t.id === ex2Id);
  const ex2AfterSnapshot = JSON.stringify({
    text: ex2After.text, completed: ex2After.completed,
    important: ex2After.important, current: ex2After.current
  });
  check('既有任务 2 的所有字段未变', ex2AfterSnapshot === ex2Snapshot,
    `before=${ex2Snapshot}, after=${ex2AfterSnapshot}`);
  // 既有任务的 id 在导入前后必须完全一致 —— 这是「批量路径不修改既有任务对象」
  // 的核心不变量，与 importPosition 是 order 还是 front 无关。
  check('既有任务 1 的 id 未变', cat.tasks[ex1Idx].id === ex1Id);
  check('既有任务 2 的 id 未变', cat.tasks[ex2Idx].id === ex2Id);
  // 既有任务 2 的 text 也未变
  check('既有任务 2 的 text 未变', cat.tasks[ex2Idx].text === 'existing 2');

  // v3.4：[✓] 任务被搬到「# 已完成任务」，所以「工作」里剩 4 条（existing 1/2 + new A + new C）
  // 用 find() 按 text 查，不依赖下标（顺序由 importPosition 决定，这里不固定）。
  check('「工作」分类追加新任务，共 4 条', cat.tasks.length === 4,
    `实际 ${cat.tasks.length}`);
  check('new A 按入参顺序（order）排在最前',
    cat.tasks[0].text === 'new A',
    JSON.stringify(cat.tasks.map(t => t.text)));
  check('new C 按入参顺序排在 new A 之后',
    cat.tasks[1].text === 'new C',
    JSON.stringify(cat.tasks.map(t => t.text)));
  check('既有任务 1 在 new A / new C 之后',
    cat.tasks.find(t => t.text === 'existing 1') !== undefined);
  check('既有任务 2 在 new A / new C 之后',
    cat.tasks.find(t => t.text === 'existing 2') !== undefined);
  check('new B 不在「工作」分类里（v3.4 不变量）',
    !cat.tasks.some(t => t.text === 'new B'));

  // 新任务的 ID 与既有任务不冲突
  const allIds = cat.tasks.map(t => t.id);
  check('所有任务 ID 唯一', new Set(allIds).size === allIds.length);

  // v3.4：new B 进了「# 已完成任务」分类 —— 验证 inline 标记正确落地
  const completed = store.getCompletedCategory()?.tasks || [];
  const newB = completed.find(t => t.text === 'new B');
  check('new B 在「# 已完成任务」里 completed=true 且 important=true',
    newB?.completed === true && newB?.important === true,
    JSON.stringify(newB));
  check('new B 带 originalCategory=工作',
    newB?.originalCategory === '工作');
}

// ============================================================
//  [12] importPosition 两种模式：order / front
//
//  早期实现直接复用 newTaskPosition = 'front'（默认），导致：
//    - 旧版：「按入参顺序粘贴 3 行」 → 最后一行跑到列表最前面，与用户输入顺序相反。
//  现拆出独立的 importPosition（settingsStore.importPosition）两种合法值：
//    - 'order'（默认）：按入参顺序插到目标位置的最前面 —— 第一行排到最上。
//    - 'front'        ：入参倒序插到目标位置的最前面 —— 最后一行排到最上（与 newTaskPosition='front' 同款）。
//
//  历史上曾有第三种 'back' 模式（按入参顺序追加到末尾），但与全局 newTaskPosition='back'
//  行为完全重叠 ——「追加到末尾」属于位置语义，归全局设置管；导入对话框只管「顺序」。
//  收成两个选项后这条测试用例被移除。
//
//  调用方还可以通过 options.importPosition 直接覆盖 settingsStore 的值，本测试
//  也验证这条覆盖路径（settingsStore 没字段 / 字段非法时仍能拿到合法默认值）。
// ============================================================
console.log('\n[12] importPosition 两种模式（与 newTaskPosition 解耦）');

{
  const baseSettings = {
    _values: { newTaskPosition: 'front', completedPosition: 'front' },
    get(k) { return this._values[k]; }
  };

  // 12.1 order 模式（默认）—— 不依赖 settingsStore 注入也走默认值
  {
    // 不注入 settingsStore，验证 importPosition 默认 'order'（按入参顺序 + 插到最前面）
    const store = makeStore();
    const cat = store.getCategory('工作');
    // 先放一条现有任务作为「锚点」—— 验证新导入任务真的插到了前面，而不是追加到末尾
    cat.tasks.push({ id: 'existing', text: '现有任务', completed: false, important: false, current: false });

    const lines = ['第一行', '第二行', '第三行'];
    store.importTasksToCategory('工作', lines);

    const texts = cat.tasks.map(t => t.text);
    check('order 模式：现有任务保留在最后',
      texts[texts.length - 1] === '现有任务',
      JSON.stringify(texts));
    check('order 模式：导入任务按入参顺序插到最前面',
      texts.slice(0, 3).join('|') === '第一行|第二行|第三行',
      JSON.stringify(texts));
  }

  // 12.2 front 模式 —— 入参倒序，最后一行在最上
  {
    const settings = { _values: { ...baseSettings._values, importPosition: 'front' }, get(k) { return this._values[k]; } };
    const store = makeStore(null, { settingsStore: settings });
    const cat = store.getCategory('工作');
    cat.tasks.push({ id: 'existing', text: '现有任务', completed: false, important: false, current: false });

    store.importTasksToCategory('工作', ['第一行', '第二行', '第三行']);
    const texts = cat.tasks.map(t => t.text);
    check('front 模式：现有任务保留在最后',
      texts[texts.length - 1] === '现有任务',
      JSON.stringify(texts));
    check('front 模式：导入任务倒序插到最前面（最后一行在最上）',
      texts.slice(0, 3).join('|') === '第三行|第二行|第一行',
      JSON.stringify(texts));
  }

  // 12.3 解耦验证 —— 即便 newTaskPosition='back'，importPosition 默认 'order'
  //     也能确保导入任务插到前面。这是用户报告的「后面的内容排在前面」bug 的核心修复点。
  {
    const settings = {
      // 模拟用户主设置里把「新增任务」设为「后面」（最下追加），
      // 但导入对话框希望默认走 order —— 验证二者真的解耦。
      _values: { newTaskPosition: 'back', completedPosition: 'back' },
      get(k) { return this._values[k]; }
    };
    const store = makeStore(null, { settingsStore: settings });
    const cat = store.getCategory('工作');
    cat.tasks.push({ id: 'existing', text: '现有任务', completed: false, important: false, current: false });

    store.importTasksToCategory('工作', ['A', 'B', 'C']);
    const texts = cat.tasks.map(t => t.text);
    check('与 newTaskPosition 解耦：newTaskPosition=back 不影响导入顺序',
      texts.slice(0, 3).join('|') === 'A|B|C',
      JSON.stringify(texts));
    check('与 newTaskPosition 解耦：现有任务仍被推到末尾（importPosition=order）',
      texts[texts.length - 1] === '现有任务',
      JSON.stringify(texts));
  }

  // 12.5 options.importPosition 覆盖 settingsStore —— 导入对话框的选择优先级最高
  {
    const settings = {
      _values: { importPosition: 'front' }, // settingsStore 说用 front
      get(k) { return this._values[k]; }
    };
    const store = makeStore(null, { settingsStore: settings });
    const cat = store.getCategory('工作');

    // 但 options.importPosition='order' 覆盖 → 应该按入参顺序插到最前面
    store.importTasksToCategory('工作', ['A', 'B', 'C'], { importPosition: 'order' });
    const texts = cat.tasks.map(t => t.text);
    check('options.importPosition 覆盖 settingsStore：order 优先于 front',
      texts.join('|') === 'A|B|C',
      JSON.stringify(texts));
  }

  // 12.6 非法值兜底 —— settingsStore 给了非法值时回退到 'order'
  {
    const settings = {
      _values: { importPosition: 'bogus-value' },
      get(k) { return this._values[k]; }
    };
    const store = makeStore(null, { settingsStore: settings });
    const cat = store.getCategory('工作');

    store.importTasksToCategory('工作', ['A', 'B']);
    const texts = cat.tasks.map(t => t.text);
    check('非法 importPosition 值 → 兜底为 order（按入参顺序 + 插到最前）',
      texts.join('|') === 'A|B',
      JSON.stringify(texts));
  }

  // 12.7 已完成任务也走同一个 importPosition —— pending / completed 行为对称
  {
    const settings = {
      _values: { importPosition: 'order' },
      get(k) { return this._values[k]; }
    };
    const store = makeStore(null, { settingsStore: settings });
    // 先用一次空批导入触发「# 已完成任务」分类的创建（_getOrCreateCompletedCategory
    // 是惰性的，不导入 completed 任务时不创建），再把锚点放进去。
    store.importTasksToCategory('工作', ['- [✓] placeholder']);
    const completedCat = store.getCompletedCategory();
    completedCat.tasks.push({ id: 'existing-c', text: '已有完成', completed: true, important: false, current: false });

    // 混合导入：第 1 条 pending，第 2 条 completed
    store.importTasksToCategory('工作', ['pending-X', '- [✓] completed-Y']);
    const workTasks = store.getCategory('工作').tasks.map(t => t.text);
    const completedTasks = store.getCompletedCategory().tasks.map(t => t.text);

    check('order 模式：pending 按入参顺序插到工作分类前面',
      workTasks[0] === 'pending-X',
      JSON.stringify(workTasks));
    check('order 模式：completed 也按入参顺序插到前面（与 pending 对称）',
      completedTasks[0] === 'completed-Y' &&
      completedTasks[completedTasks.length - 1] === '已有完成',
      JSON.stringify(completedTasks));
  }
}

// ============================================================
//  总结
// ============================================================
console.log(`\n==========\n通过 ${summary.pass} / 失败 ${summary.fail}\n==========`);
process.exit(summary.fail === 0 ? 0 : 1);