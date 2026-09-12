// 全面回归：markdown ↔ UI 同步契约
// 覆盖「文件字符 → 内存字段 → UI 渲染 → 写回文件」整条链路
//
// 关键不变量（v3.4 起）：
//   - completed=true 的任务**只能**活在 kind=COMPLETED 分类
//   - completed=false 的任务**只能**活在 kind=NORMAL 子分类
//   - 子分类相对顺序在 roundtrip 后保留
//   - 任务顺序在子分类内 roundtrip 后保留
//   - 所有 inline 标记（[⭐] / [▶] / [原分类：xxx]）在 parser / writer 间对称

import { parseMarkdown, CategoryKind, extractInlineMarkers } from '../src/markdown-parser.js';
import { check, ok, bad, summary, printSummary } from './_lib/check.mjs';
import { makeStore } from './_lib/store-fixture.mjs';
import { writeMarkdown, createDefaultDoc } from '../src/markdown-writer.js';
import { TaskStore } from '../src/task-store.js';
import { escapeHtml } from '../src/utils/dom.js';
import { installApiStub } from './_lib/api-stub.mjs';

// 把 jsdom 没有的环境变量兜底 —— 多个测试都依赖 store 但只设一次即可
function setupWindow() {
  installApiStub();
}
setupWindow();

const TEST_ID = 'check-md-ui-sync';

// 提取 `## X` / `# X` 段（从该标题到下一个 ## / # 之前）。
// 用于边界断言，避免贪婪正则跨段匹配污染测试信号。
// sectionMarker: e.g. '## 工作' 或 '# 回收站'
function extractSection(md, sectionMarker) {
  const start = md.indexOf(sectionMarker);
  if (start < 0) return '';
  const after = start + sectionMarker.length;
  const nextH2 = md.indexOf('\n## ', after);
  const nextH1 = md.indexOf('\n# ',  after);
  let end;
  if (nextH2 > 0 && nextH1 > 0) end = Math.min(nextH2, nextH1);
  else if (nextH2 > 0)          end = nextH2;
  else if (nextH1 > 0)          end = nextH1;
  else                          end = md.length;
  return md.slice(start, end);
}

// ============================================================
// [1] 基础字段 roundtrip：text / completed / important / current
// ============================================================
console.log('\n[1] 字段 roundtrip：text / completed / important / current');
{
  const md = `# 全部任务

## 工作

- [ ] 普通任务
- [ ] [⭐] 重要任务
- [ ] [▶] 当前任务
- [ ] [▶] [⭐] 既当前又重要
- [ ] 任务有 [⭐] 但是 inline
- [ ] 任务有 [▶] inline
- [✓] 已完成的任务
- [✓] [▶] [⭐] 完成且当前且重要
`;
  const store = new TaskStore();
  store.loadFromContent(md, null);
  store._autoSave = Object.assign(() => {}, { cancel() {}, flush() {} });

  const work = store.getCategory('工作');
  // 加载后 [✓] 任务被搬到「# 已完成任务」分类，「工作」里只剩 6 条
  check('[1] [✓] 已搬到「# 已完成任务」', work.tasks.length === 6,
    `实际 ${work.tasks.length}`);

  check('[1] 普通任务文本', work.tasks[0]?.text === '普通任务');
  check('[1] 普通任务未完成', work.tasks[0]?.completed === false);
  check('[1] 普通任务不重要', work.tasks[0]?.important === false);
  check('[1] 普通任务非当前', work.tasks[0]?.current === false);

  check('[1] 重要任务标记', work.tasks.find(t => t.text === '重要任务')?.important === true);
  check('[1] 当前任务标记', work.tasks.find(t => t.text === '当前任务')?.current === true);
  check('[1] 既当前又重要 current', work.tasks.find(t => t.text === '既当前又重要')?.current === true);
  check('[1] 既当前又重要 important', work.tasks.find(t => t.text === '既当前又重要')?.important === true);

  // parser 只剥行首/行尾位置的 [⭐] [▶]；行内的保留为字面字符串
  const inline = work.tasks.filter(t => t.text.includes('[⭐]') || t.text.includes('[▶]'));
  check('[1] 行内 [⭐] [▶] 保留在文本', inline.length === 2);
  check('[1] 行内 [⭐] 不算 important', inline.every(t => !t.important));
  check('[1] 行内 [▶] 不算 current', inline.every(t => !t.current));

  // 「工作」里的 6 条任务的文本都不能含行首/行尾位置的 [⭐] [▶]
  const hasLeftoverMarker = work.tasks.some(t =>
    /^[\[（(]?[⭐▶]/.test(t.text.trim()) ||
    /[\[（(]?[⭐▶][\]）)]?$/.test(t.text.trim())
  );
  check('[1] 文本不含行首/行尾 [⭐] [▶]', !hasLeftoverMarker);

  const completed = store.getCompletedCategory();
  check('[1] [✓] 任务搬到「# 已完成任务」', !!completed);
  check('[1] 已完成分类含「已完成的任务」',
    completed?.tasks?.some(t => t.text === '已完成的任务' && t.completed === true));
  check('[1] 已完成分类含「完成且当前且重要」',
    completed?.tasks?.some(t => t.text === '完成且当前且重要' && t.completed === true));
}

// ============================================================
// [2] parser → writer → parser 幂等
// ============================================================
console.log('\n[2] parser → writer → parser 幂等');
{
  const md = `# 全部任务

## 工作

- [ ] a
- [ ] b
- [ ] [⭐] c
- [ ] [▶] d

## 学习

- [ ] e
`;
  const cats1 = parseMarkdown(md);
  const written1 = writeMarkdown(cats1);
  const cats2 = parseMarkdown(written1);
  const written2 = writeMarkdown(cats2);

  check('[2] 两次写出结果一致（幂等）', written1 === written2,
    `\n--- 第一次 ---\n${written1}\n--- 第二次 ---\n${written2}`);

  // 字段一致性
  const work1 = cats1.find(c => c.name === '工作');
  const work2 = cats2.find(c => c.name === '工作');
  check('[2] 「工作」任务数一致', work1.tasks.length === work2.tasks.length);
  check('[2] 「工作」任务文本一致',
    work1.tasks.map(t => t.text).join(',') === work2.tasks.map(t => t.text).join(','));
  check('[2] 「工作」important 字段一致',
    work1.tasks.map(t => t.important).join(',') === work2.tasks.map(t => t.important).join(','));
  check('[2] 「工作」current 字段一致',
    work1.tasks.map(t => t.current).join(',') === work2.tasks.map(t => t.current).join(','));

  // writer 对 [✓] 任务的处理
  const mdWithDone = `# 全部任务

## 工作

- [ ] 未完成
- [✓] 已完成
`;
  const catsWithDone = parseMarkdown(mdWithDone);
  // parser 后 [✓] 在「工作」里
  check('[2] parser 后 [✓] 在「工作」里',
    catsWithDone.find(c => c.name === '工作')?.tasks[1]?.completed === true);
  // writer 写出 [✓]
  check('[2] writer 输出 [✓]', writeMarkdown(catsWithDone).includes('- [✓] 已完成'));
}

// ============================================================
// [3] 子分类相对顺序保留
// ============================================================
console.log('\n[3] 子分类相对顺序保留');
{
  const md = `# 全部任务

## 工作

- [ ] a

## 学习

- [ ] b

## 生活

- [ ] c

## 未分类

- [ ] d
`;
  const cats = parseMarkdown(md);
  const subNames = cats.filter(c => c.parentOtherTasks).map(c => c.name);
  check('[3] parser 顺序 工作/学习/生活/未分类',
    subNames.join(',') === '工作,学习,生活,未分类', subNames.join(','));

  const written = writeMarkdown(cats);
  const cats2 = parseMarkdown(written);
  const subNames2 = cats2.filter(c => c.parentOtherTasks).map(c => c.name);
  check('[3] roundtrip 顺序一致',
    subNames.join(',') === subNames2.join(','), subNames2.join(','));
}

// ============================================================
// [4] 任务顺序在子分类内保留
// ============================================================
console.log('\n[4] 任务顺序保留');
{
  const md = `# 全部任务

## 工作

- [ ] 1st
- [ ] 2nd
- [ ] 3rd
- [ ] 4th
`;
  const cats = parseMarkdown(md);
  const written = writeMarkdown(cats);
  const cats2 = parseMarkdown(written);
  const work2 = cats2.find(c => c.name === '工作');
  check('[4] roundtrip 任务顺序',
    work2.tasks.map(t => t.text).join(',') === '1st,2nd,3rd,4th');
}

// ============================================================
// [5] 特殊字符与 HTML 转义
// ============================================================
console.log('\n[5] 特殊字符与 HTML 转义');
{
  const md = `# 全部任务

## 工作

- [ ] 普通
- [ ] 含 <尖括号>
- [ ] 含 & 符号
- [ ] 含 "双引号"
- [ ] 含 '单引号'
- [ ] 含 [方括号]
- [ ] 含 (圆括号)
- [ ] 含 \\反斜杠\\
`;
  const cats = parseMarkdown(md);
  const work = cats.find(c => c.name === '工作');
  check('[5] 8 条任务', work.tasks.length === 8, `实际 ${work.tasks.length}`);

  const written = writeMarkdown(cats);
  check('[5] writer 保留 <尖括号>', written.includes('含 <尖括号>'));
  check('[5] writer 保留 &', written.includes('含 & 符号'));
  check('[5] writer 保留 "', written.includes('含 "双引号"'));
  check('[5] writer 保留 [方括号]', written.includes('含 [方括号]'));

  const lt = work.tasks.find(t => t.text === '含 <尖括号>');
  check('[5] parser 正确解析 <尖括号>', lt?.text === '含 <尖括号>');
  const escaped = escapeHtml(lt.text);
  check('[5] UI escape 不破坏文本结构', escaped.includes('&lt;'));
}

// ============================================================
// [6] 空文本任务
// ============================================================
console.log('\n[6] 空文本任务');
{
  const md = `# 全部任务

## 工作

- [ ]
- [✓]
- [ ] [⭐]
`;
  // parser 不做迁移（迁移是 store 的事）—— 3 条全在「工作」里
  const cats = parseMarkdown(md);
  const work = cats.find(c => c.name === '工作');
  check('[6] parser 保留 3 条任务（含空文本）',
    work.tasks.length === 3,
    `实际 ${work.tasks.length}`);

  // 加载到 store 后，[✓] 被搬到「# 已完成任务」分类
  const store = new TaskStore();
  store.loadFromContent(md, null);
  store._autoSave = Object.assign(() => {}, { cancel() {}, flush() {} });
  check('[6] 加载后「工作」剩 2 条（[✓] 被迁移）',
    store.getCategory('工作').tasks.length === 2,
    `实际 ${store.getCategory('工作').tasks.length}`);
  check('[6] 加载后「# 已完成任务」有 1 条空文本',
    store.getCompletedCategory()?.tasks?.some(t => t.text === ''));

  const written = writeMarkdown(cats);
  check('[6] writer 输出空文本任务', /- \[ \]\s*\n/.test(written));
  // parser 不做迁移，所以「## 工作」段里也会有 [✓] 空文本 —— 写回后由 store 迁移处理
  check('[6] writer 输出空 [✓] 任务（在源段，因为 parser 不迁移）',
    /- \[✓\]\s*\n/.test(written));

  // 走 store 加载链路后，[✓] 被搬到已完成分类，写回就在已完成段了
  const writtenViaStore = store.serialize();
  const completedSec = extractSection(writtenViaStore, '# 已完成任务');
  check('[6] store.serialize() 后 [✓] 在已完成段',
    /\[✓\]/.test(completedSec),
    `已完成段:\n${completedSec}`);
}

// ============================================================
// [7] 中文字符、emoji 与空格
// ============================================================
console.log('\n[7] 中文字符、emoji 与空格');
{
  const md = `# 全部任务

## 工作

- [ ] 中文任务：你好世界
- [ ] Emoji 🎉🚀✨
- [ ] 含多个空格的   任务
- [ ] 首尾空格   任务
`;
  const cats = parseMarkdown(md);
  const work = cats.find(c => c.name === '工作');
  check('[7] 中文文本完整', work.tasks.find(t => t.text === '中文任务：你好世界')?.text === '中文任务：你好世界');
  check('[7] Emoji 完整', work.tasks.find(t => t.text.includes('🎉'))?.text.includes('🎉'));
  check('[7] 中间多个空格保留',
    work.tasks.find(t => t.text === '含多个空格的   任务')?.text === '含多个空格的   任务');
}

// ============================================================
// [8] BOM 头处理
// ============================================================
console.log('\n[8] BOM 头处理');
{
  const md = '﻿# 全部任务\n\n## 工作\n\n- [ ] a\n';
  const cats = parseMarkdown(md);
  const work = cats.find(c => c.name === '工作');
  check('[8] BOM 不会让整个文件被忽略', work?.tasks?.length === 1,
    `tasks=${work?.tasks?.length}`);
  check('[8] BOM 文件后任务 a 存在', work.tasks[0]?.text === 'a');
}

// ============================================================
// [9] CRLF 行尾
// ============================================================
console.log('\n[9] CRLF 行尾');
{
  const md = '# 全部任务\r\n\r\n## 工作\r\n\r\n- [ ] 任务1\r\n- [✓] 任务2\r\n';
  const cats = parseMarkdown(md);
  const work = cats.find(c => c.name === '工作');
  check('[9] CRLF 行尾 任务1', work.tasks.find(t => t.text === '任务1')?.text === '任务1');
  // [✓] 任务在 parser 阶段还在「工作」里；migration 走 loadFromContent 才会搬
  check('[9] 文本无 \\r', work.tasks.every(t => !t.text.includes('\r')));
}

// ============================================================
// [10] [原分类：xxx] 标记 - 仅在 COMPLETED/TRASH 出现
// ============================================================
console.log('\n[10] [原分类：xxx] 标记');
{
  const md = `# 全部任务

## 工作

- [ ] 普通任务

## 未分类

- [✓] [原分类：工作] 已完成的工作任务

# 已完成任务

- [✓] [原分类：工作] 已完成的工作任务 2
`;
  const store = new TaskStore();
  store.loadFromContent(md, null);
  store._autoSave = Object.assign(() => {}, { cancel() {}, flush() {} });

  const written = store.serialize();
  check('[10] writer 输出 [原分类：工作]', written.includes('[原分类：工作]'));
  check('[10] writer 在「# 已完成任务」分类下写 [原分类：工作]',
    /# 已完成任务[\s\S]*\[原分类：工作\]/.test(written));

  // 关键断言：「# 已完成任务」之前的所有子分类段落都不能出现 [原分类：xxx]
  // 用截取已完成段之前的全部内容做正则检查
  const beforeCompleted = written.split('# 已完成任务')[0];
  check('[10] 子分类段不含 [原分类：xxx]',
    !beforeCompleted.includes('[原分类：'),
    `beforeCompleted 内容:\n${beforeCompleted}`);
}

// ============================================================
// [11] extractInlineMarkers 边界情况
// ============================================================
console.log('\n[11] extractInlineMarkers 边界情况');
{
  const empty = extractInlineMarkers('');
  check('[11] 空文本', empty.text === '' && !empty.important && !empty.current);

  const onlyMarkers = extractInlineMarkers('[⭐] [▶]');
  check('[11] 只有标记 - 文本为空', onlyMarkers.text === '');
  check('[11] 只有标记 - important', onlyMarkers.important === true);
  check('[11] 只有标记 - current', onlyMarkers.current === true);

  const tailMarkers = extractInlineMarkers('任务 [⭐] [▶]');
  check('[11] 行尾 [⭐] 抽走', !tailMarkers.text.includes('[⭐]'));
  check('[11] 行尾 [▶] 抽走', !tailMarkers.text.includes('[▶]'));
  check('[11] 行尾 important=true', tailMarkers.important === true);
  check('[11] 行尾 current=true', tailMarkers.current === true);

  const inline = extractInlineMarkers('对比 [⭐] 和 [ ]');
  check('[11] 行内 [⭐] 保留', inline.text.includes('[⭐]'));
  check('[11] 行内 [⭐] 不算 important', inline.important === false);

  const reversed = extractInlineMarkers('[⭐] [▶] 任务');
  check('[11] 反向顺序 important=true', reversed.important === true);
  check('[11] 反向顺序 current=true', reversed.current === true);
  check('[11] 反向顺序 文本干净', reversed.text === '任务');

  const legacyCurrent = extractInlineMarkers('@当前 任务');
  check('[11] @当前 抽走', legacyCurrent.current === true && !legacyCurrent.text.includes('@当前'));

  const legacyStar = extractInlineMarkers('任务 ⭐');
  check('[11] 裸 ⭐ 抽走', legacyStar.important === true && !legacyStar.text.includes('⭐'));

  const legacyPlay = extractInlineMarkers('任务 ▶');
  check('[11] 裸 ▶ 抽走', legacyPlay.current === true && !legacyPlay.text.includes('▶'));

  const origCat = extractInlineMarkers('[原分类：工作] 任务');
  check('[11] [原分类：xxx] 抽走', origCat.originalCategory === '工作' && !origCat.text.includes('[原分类'));
}

// ============================================================
// [12] 默认文档结构完整
// ============================================================
console.log('\n[12] createDefaultDoc 默认结构');
{
  const doc = createDefaultDoc();
  const names = doc.map(c => c.name);
  check('[12] 容器存在', doc.some(c => c.kind === CategoryKind.OTHER_TASKS));
  check('[12] 包含 工作/学习/生活/未分类',
    names.includes('工作') && names.includes('学习') && names.includes('生活') && names.includes('未分类'));
  check('[12] 容器位置在最前（OTHER_TASKS）',
    doc[0].kind === CategoryKind.OTHER_TASKS);
  check('[12] 「未分类」是子分类', doc.find(c => c.name === '未分类')?.parentOtherTasks === true);
}

// ============================================================
// [13] 智能列表视图聚合正确
// ============================================================
console.log('\n[13] 智能列表视图聚合正确');
{
  const md = `# 全部任务

## 工作

- [ ] [▶] 工作当前
- [ ] [⭐] 工作重要

## 学习

- [ ] [▶] 学习当前
- [ ] 普通任务

# 已完成任务

- [✓] [▶] 已完成但带当前
`;
  const store = new TaskStore();
  store.loadFromContent(md, null);
  store._autoSave = Object.assign(() => {}, { cancel() {}, flush() {} });

  const smart = store.collectSmartListTasks();
  // v3.4：完成 = 归档。已勾选的任务从「当前任务」「重要任务」聚合里消失，
  // 只通过「已完成任务」分类暴露。
  // v4.1：toggleTask 勾选时**不再**清 task.current（标记与 completed 正交，
  // 详见 collectSmartListTasks 注释），所以 completed+current 共存是正常形态 ——
  // 但聚合排除规则不变：状态保留在文件里，只是不参与「当前任务」视图。
  check('[13] current 视图 2 条（不含已完成的）',
    smart.current.length === 2,
    smart.current.map(t => t.text).join(','));
  check('[13] important 视图 1 条',
    smart.important.length === 1,
    smart.important.map(t => t.text).join(','));
  check('[13] allTasks 视图 4 条（子分类下未完成，不含已完成分类）',
    smart.allTasks.length === 4,
    smart.allTasks.map(t => t.text).join(','));
  check('[13] completed 视图 1 条',
    smart.completed.length === 1,
    smart.completed.map(t => t.text).join(','));
}

// ============================================================
// [14] 子分类重命名 / 删除后文件 roundtrip
// ============================================================
console.log('\n[14] 子分类重命名 / 删除后文件 roundtrip');
{
  const store = new TaskStore();
  store.loadFromContent('# 全部任务\n\n## 工作\n\n- [ ] a\n- [ ] b\n\n## 学习\n\n- [ ] c\n', null);
  store._autoSave = Object.assign(() => {}, { cancel() {}, flush() {} });

  store.renameCategory('工作', '任务');
  check('[14] 重命名成功', store.getCategory('任务')?.name === '任务');
  check('[14] 旧名不存在', !store.getCategory('工作'));

  const written = store.serialize();
  const cats2 = parseMarkdown(written);
  check('[14] roundtrip 重命名后名字保留',
    !!cats2.find(c => c.name === '任务'));
  check('[14] roundtrip 重命名后任务还在',
    !!cats2.find(c => c.name === '任务')?.tasks.find(t => t.text === 'a'));

  store.deleteCategory('任务');
  const written2 = store.serialize();
  const cats3 = parseMarkdown(written2);
  const uncat = cats3.find(c => c.name === '未分类');
  check('[14] 删除后任务到「未分类」',
    uncat?.tasks?.length === 2,
    `实际 ${uncat?.tasks?.length}`);
}

// ============================================================
// [15] writeMarkdown 在空状态下的兜底
// ============================================================
console.log('\n[15] writeMarkdown 边界');
{
  let threw = false;
  try { writeMarkdown([]); } catch { threw = true; }
  check('[15] 空数组抛错', threw);

  threw = false;
  try { writeMarkdown(null); } catch { threw = true; }
  check('[15] null 抛错', threw);

  const cats = [{
    name: '全部任务',
    kind: CategoryKind.OTHER_TASKS,
    isSpecial: true,
    meta: null,
    parentOtherTasks: false,
    tasks: []
  }, {
    name: '未分类',
    kind: CategoryKind.NORMAL,
    isSpecial: false,
    meta: null,
    parentOtherTasks: true,
    tasks: [{ text: 'a', completed: false, important: false, current: false }]
  }];
  const out = writeMarkdown(cats);
  check('[15] 最小文档能写出',
    out.includes('# 全部任务') && out.includes('## 未分类') && out.includes('- [ ] a'));
}

// ============================================================
// [16] updateTaskText 写回后的 roundtrip
// ============================================================
console.log('\n[16] UI 文本编辑 → 文件 roundtrip');
{
  const store = new TaskStore();
  store.loadFromContent('# 全部任务\n\n## 工作\n\n- [ ] 原文本\n', null);
  store._autoSave = Object.assign(() => {}, { cancel() {}, flush() {} });

  const work = store.getCategory('工作');
  const taskId = work.tasks[0].id;
  store.updateTaskText('工作', taskId, '新文本 & 含特殊 <字符>');

  const written = store.serialize();
  check('[16] 写回包含新文本', written.includes('新文本 & 含特殊 <字符>'));

  const cats2 = parseMarkdown(written);
  const work2 = cats2.find(c => c.name === '工作');
  check('[16] 重新解析后文本一致',
    work2.tasks[0]?.text === '新文本 & 含特殊 <字符>');
}

// ============================================================
// [17] 完整操作序列 roundtrip（含 toggleTask 跨分类）
// ============================================================
console.log('\n[17] 完整操作序列 roundtrip');
{
  const store = new TaskStore();
  store.loadFromContent('# 全部任务\n\n## 工作\n\n- [ ] task1\n- [ ] task2\n', null);
  store._autoSave = Object.assign(() => {}, { cancel() {}, flush() {} });

  const work = store.getCategory('工作');
  const t1 = work.tasks.find(t => t.text === 'task1').id;
  const t2 = work.tasks.find(t => t.text === 'task2').id;

  // 1) 标记 task1 为重要
  store.updateTaskMeta('工作', t1, { important: true });
  // 2) 标记 task2 为当前
  store.updateTaskMeta('工作', t2, { current: true });
  // 3) 勾选 task1 → 搬到「# 已完成任务」
  store.toggleTask('工作', t1);

  const written = store.serialize();
  check('[17] 写回含 [▶] task2（[▶] 在 [⭐] 前）',
    written.includes('[▶] task2'));
  const completedSection = extractSection(written, '# 已完成任务');
  const workSection17 = extractSection(written, '## 工作');
  check('[17] 写回含 [⭐] task1（在已完成段）',
    /\[⭐\][\s\S]*?task1/.test(completedSection),
    `completedSection:\n${completedSection}`);
  check('[17] 写回含 [✓] task1（在已完成段）',
    /\[✓\][\s\S]*?task1/.test(completedSection));
  check('[17] task1 不在工作分类段',
    !workSection17.includes('task1'),
    `工作段:\n${workSection17}`);

  // 重新加载
  const store2 = new TaskStore();
  store2.loadFromContent(written, null);
  store2._autoSave = Object.assign(() => {}, { cancel() {}, flush() {} });

  const completed2 = store2.getCompletedCategory();
  const work2 = store2.getCategory('工作');
  check('[17] 重载 task1 在「# 已完成任务」且 important=true',
    completed2?.tasks?.some(t => t.text === 'task1' && t.important === true && t.completed === true));
  check('[17] 重载 task2 在「工作」且 current=true',
    work2?.tasks?.some(t => t.text === 'task2' && t.current === true));

  // 4) 取消勾选 task1 → 回到原分类（工作）
  const completedTaskId = completed2.tasks.find(t => t.text === 'task1').id;
  // 关键：调用 toggleTask 时必须用 store 里的分类名（不带 `#` 前缀）
  store2.toggleTask('已完成任务', completedTaskId);
  const work3 = store2.getCategory('工作');
  check('[17] 取消勾选后 task1 回到「工作」',
    work3?.tasks?.some(t => t.text === 'task1'));
  check('[17] 取消勾选后 important 标记仍保留',
    work3?.tasks?.find(t => t.text === 'task1')?.important === true);
  check('[17] 取消勾选后 originalCategory 已清掉（避免噪音）',
    !work3?.tasks?.find(t => t.text === 'task1')?.originalCategory);
}

// ============================================================
// [18] 批量导入 → 写回 → 解析完整链路
//     （关键回归：importTasksToCategory 必须把 [✓] 搬到「# 已完成任务」，
//      否则违反 v3.4 数据归属不变量 —— 这是最近修的 bug）
// ============================================================
console.log('\n[18] 批量导入 roundtrip + v3.4 数据归属');
{
  const store = new TaskStore();
  store.loadFromContent('# 全部任务\n\n## 工作\n\n', null);
  store._autoSave = Object.assign(() => {}, { cancel() {}, flush() {} });

  const lines = [
    '- [ ] 普通任务',
    '- [✓] 已完成',
    '- [ ] [⭐] 重要',
    '- [ ] [▶] 当前',
    '- [ ] 任务有 [⭐] inline',
    '裸任务',
    ''
  ];
  const result = store.importTasksToCategory('工作', lines);
  check('[18] 导入返回 ok', result.ok === true);
  check('[18] 导入 6 条（空行 skipped）', result.added === 6,
    `actual ${result.added}, skipped=${result.skipped}`);

  // 关键：v3.4 数据归属不变量 —— [✓] 任务必须立即被搬到「# 已完成任务」分类
  const work = store.getCategory('工作');
  const completed = store.getCompletedCategory();
  check('[18] 「工作」里 5 条未完成任务',
    work.tasks.length === 5,
    `工作实际 ${work.tasks.length}`);
  check('[18] 「工作」里无 completed=true 的任务（v3.4 不变量）',
    work.tasks.every(t => !t.completed),
    work.tasks.map(t => `${t.text}(done=${t.completed})`).join(','));
  check('[18] 「# 已完成任务」里有 1 条任务',
    completed?.tasks?.length === 1,
    `已完成实际 ${completed?.tasks?.length}`);
  check('[18] 已完成的任务带 originalCategory=工作',
    completed?.tasks[0]?.originalCategory === '工作');

  const written = store.serialize();
  // 抽出 ## 工作 段（到下一个 ## 或 # 之前）
  const workSection = extractSection(written, '## 工作');
  check('[18] 写回含 [✓] 已完成（在已完成段）',
    /# 已完成任务[\s\S]*?\[✓\][\s\S]*?已完成/.test(written));
  check('[18] 写回不含 [✓] 已完成 在工作分类段',
    !workSection.includes('[✓]'),
    `工作段:\n${workSection}`);

  // 重新解析，结构一致
  const cats2 = parseMarkdown(written);
  const work2 = cats2.find(c => c.name === '工作');
  const completed2 = cats2.find(c => c.kind === CategoryKind.COMPLETED);
  check('[18] 重新解析「工作」5 条',
    work2.tasks.length === 5);
  check('[18] 重新解析「# 已完成任务」1 条',
    completed2?.tasks?.length === 1);
}

// ============================================================
// [19] 标题层级：h3+ 不重置分类
//     h3 任务是孤儿，按 parser 当前行为归入上一分类 —— 避免丢数据。
//     这是有意保留的 roundtrip 安全行为，本测试固化契约。
// ============================================================
console.log('\n[19] 标题层级（h3+ 不重置分类）');
{
  const md = `# 全部任务

## 工作

- [ ] a

### 子节 (h3)

- [ ] b

#### 更深 (h4)

- [ ] c

## 学习

- [ ] d
`;
  const cats = parseMarkdown(md);
  const work = cats.find(c => c.name === '工作');
  // parser 行为：h3 不重置 currentCategory → b/c 归入「工作」（不丢数据）
  check('[19] h3+ 任务归入上一分类（避免数据丢失）',
    work.tasks.length === 3, `actual ${work.tasks.length}`);
  const study = cats.find(c => c.name === '学习');
  check('[19] 学习分类 1 条任务', study.tasks.length === 1);

  // writer 不输出 h3 — 视觉信息丢失但任务保留
  const written = writeMarkdown(cats);
  check('[19] writer 不输出 h3/h4 标题', !/^#{3,}\s/m.test(written));
  check('[19] writer 输出所有任务', written.includes('- [ ] a') && written.includes('- [ ] b') && written.includes('- [ ] c'));
}

// ============================================================
// [20] 容器直接包含任务（无 ## 子分类）
// ============================================================
console.log('\n[20] 容器直接包含任务 → 归到「未分类」');
{
  const md = `# 全部任务

- [ ] 容器下直接的任务
- [ ] [⭐] 容器下的重要任务
`;
  const cats = parseMarkdown(md);
  const uncat = cats.find(c => c.name === '未分类' && c.parentOtherTasks);
  check('[20] 「未分类」子分类存在', !!uncat);
  check('[20] 任务归到「未分类」', uncat?.tasks?.length === 2);

  const written = writeMarkdown(cats);
  check('[20] writer 输出 ## 未分类 段', written.includes('## 未分类'));
}

// ============================================================
// [21] 侧边栏结构 ↔ 文件结构完全一致
//     模拟 sidebar 渲染逻辑：从 store 的 categories 数组生成 sidebar HTML，
//     再和 parser 从文件 parseMarkdown 出的 categories 对比。
// ============================================================
console.log('\n[21] sidebar 数据来源 = 文件结构');
{
  const md = `# 全部任务

## 工作

- [ ] a

## 学习

- [ ] b

## 自定义分类

- [ ] c

# 已完成任务

- [✓] done
`;
  const store = new TaskStore();
  store.loadFromContent(md, null);
  store._autoSave = Object.assign(() => {}, { cancel() {}, flush() {} });

  const subNames = store.getSubCategories().map(c => c.name);
  check('[21] 侧边栏子分类 = 工作/学习/自定义分类',
    subNames.join(',') === '工作,学习,自定义分类', subNames.join(','));

  const written = store.serialize();
  const cats2 = parseMarkdown(written);
  const subNames2 = cats2.filter(c => c.parentOtherTasks).map(c => c.name);
  check('[21] roundtrip 后子分类一致',
    subNames.join(',') === subNames2.join(','), subNames2.join(','));
}

// ============================================================
// [22] search 同步：highlightTaskText 与 case-insensitive 搜索一致
// ============================================================
console.log('\n[22] 搜索同步');
{
  const store = new TaskStore();
  store.loadFromContent('# 全部任务\n\n## 工作\n\n- [ ] Hello World\n- [ ] 你好世界\n', null);
  store._autoSave = Object.assign(() => {}, { cancel() {}, flush() {} });

  store.setSearchQuery('hello');
  const segs = store.highlightTaskText('Hello World');
  check('[22] 大小写不敏感命中', segs.some(s => s.highlight && s.text === 'Hello'));

  store.setSearchQuery('你好');
  const segs2 = store.highlightTaskText('你好世界');
  check('[22] 中文搜索命中', segs2.some(s => s.highlight && s.text === '你好'));

  store.setSearchQuery('');
  const segs3 = store.highlightTaskText('你好世界');
  check('[22] 空搜索 → 无 highlight',
    segs3.length === 1 && segs3[0].highlight === false);
}

// ============================================================
// [23] 删除/恢复 流程：UI 操作 → 文件 roundtrip
// ============================================================
console.log('\n[23] 删除 → 恢复 roundtrip');
{
  const store = new TaskStore();
  store.loadFromContent('# 全部任务\n\n## 工作\n\n- [ ] keep\n- [ ] delete-me\n', null);
  store._autoSave = Object.assign(() => {}, { cancel() {}, flush() {} });

  const work = store.getCategory('工作');
  const taskId = work.tasks.find(t => t.text === 'delete-me').id;

  // 删
  store.deleteTask('工作', taskId);
  check('[23] 删除后「工作」剩 1 条', store.getCategory('工作').tasks.length === 1);
  check('[23] 删除后回收站有 1 条', store.getTrashCategory()?.tasks?.length === 1);

  // 写回
  const written = store.serialize();
  check('[23] 写回含 # 回收站', written.includes('# 回收站'));
  // 用 extractSection 严格限定只查 ## 工作 段（防止正则跨段匹配）
  const workSection = extractSection(written, '## 工作');
  check('[23] 写回不含 delete-me 在工作段',
    !workSection.includes('delete-me'),
    `工作段:\n${workSection}`);
  check('[23] 写回含 delete-me 在回收站段',
    /# 回收站[\s\S]*?delete-me/.test(written));

  // 重新加载
  const store2 = new TaskStore();
  store2.loadFromContent(written, null);
  store2._autoSave = Object.assign(() => {}, { cancel() {}, flush() {} });
  check('[23] 重载「工作」1 条', store2.getCategory('工作').tasks.length === 1);
  check('[23] 重载回收站 1 条', store2.getTrashCategory()?.tasks?.length === 1);

  // 恢复
  const trashId = store2.getTrashCategory().tasks[0].id;
  store2.restoreTask(trashId);
  check('[23] 恢复后回收站 0 条', store2.getTrashCategory()?.tasks?.length === 0);
  const written2 = store2.serialize();
  check('[23] 恢复后写回不含 # 回收站 段', !written2.includes('# 回收站'));
}

// ============================================================
// [24] 跨分类移动 + 文件 roundtrip
// ============================================================
console.log('\n[24] 跨分类移动 roundtrip');
{
  const store = new TaskStore();
  store.loadFromContent('# 全部任务\n\n## 工作\n\n- [ ] a\n\n## 学习\n\n- [ ] b\n', null);
  store._autoSave = Object.assign(() => {}, { cancel() {}, flush() {} });

  const work = store.getCategory('工作');
  const aId = work.tasks.find(t => t.text === 'a').id;
  store.moveTask('工作', aId, '学习');
  check('[24] 移动后工作 0 条', store.getCategory('工作').tasks.length === 0);
  check('[24] 移动后学习 2 条', store.getCategory('学习').tasks.length === 2);

  const written = store.serialize();
  // 严格提取 ## 工作 段（到下一个 ## 或 # 之前），避免正则跨段匹配
  const workSection = extractSection(written, '## 工作');
  check('[24] 工作段无 a',
    !workSection.includes('- [ ] a'),
    `工作段:\n${workSection}`);
  check('[24] 学习段有 a',
    extractSection(written, '## 学习').includes('- [ ] a'));
}

console.log(`\n通过 ${summary.pass} / 失败 ${summary.fail}`);
process.exit(summary.fail === 0 ? 0 : 1);