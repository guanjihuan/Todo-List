// 回归测试：H5 — [⭐] / [▶] 行尾原子块识别
//
// 背景：旧版 MARKER_TAIL_RE 强制前导 `\s`，导致：
//   - `unimportant[⭐]`（任务文本紧贴 [⭐]，无空格）→ 解析为普通文本，important=false
//   - 下次保存 serialize 后，原文 `unimportant[⭐]` → 变成 `unimportant`（标记丢失）
//
// 修复（v3.7+）：tail 正则去掉 `\s` 前导，`[⭐]` / `[▶]` 在行尾被识别为
// 内联原子块（不是「必须前面有空白字符」）。本脚本验证这条修复路径。
//
// 跑法：node scripts/check-marker-tail.mjs

import {
  parseMarkdown,
  extractInlineMarkers
} from '../src/markdown-parser.js';
import { check, ok, summary, printSummary } from './_lib/check.mjs';

// ── [1] extractInlineMarkers：行尾 [⭐] 不再要求前导空白 ──
console.log('\n[1] extractInlineMarkers 行尾 [⭐] / [▶] 不要求前导空白');

{
  // 修复前：\s 前导强制要求 → 失败；修复后：直接 [⭐]$ 匹配
  const r1 = extractInlineMarkers('unimportant[⭐]');
  check('unimportant[⭐]（无前导空白）→ important=true',
    r1.important === true,
    `important=${r1.important}, text=${r1.text}`);
  check('unimportant[⭐] 文本剥到只剩 unimportant',
    r1.text === 'unimportant',
    `text=${JSON.stringify(r1.text)}`);

  // 带前导空白的老用法 —— 仍然支持（无回归）
  const r2 = extractInlineMarkers('important task [⭐]');
  check('带空白的 important task [⭐] 仍识别',
    r2.important === true && r2.text === 'important task',
    `important=${r2.important}, text=${JSON.stringify(r2.text)}`);

  // 行尾 [▶] 同款修复
  const r3 = extractInlineMarkers('focus[▶]');
  check('focus[▶]（无前导空白）→ current=true',
    r3.current === true && r3.text === 'focus',
    `current=${r3.current}, text=${JSON.stringify(r3.text)}`);

  // 行尾同时有 ⭐ 和 ▶ —— 不带空格紧凑写法
  const r4 = extractInlineMarkers('critical work[⭐][▶]');
  check('critical work[⭐][▶] 两个标记都识别',
    r4.important === true && r4.current === true,
    `important=${r4.important}, current=${r4.current}, text=${JSON.stringify(r4.text)}`);
  // loop 顺序剥：先 [⭐] 后 [▶]，text 应剥到 "critical work"
  check('critical work[⭐][▶] 文本剥到只剩 critical work',
    r4.text === 'critical work',
    `text=${JSON.stringify(r4.text)}`);

  // 行内非尾部 [⭐] 不应被剥离（中间嵌入文本不应误识别）
  const r5 = extractInlineMarkers('关键任务 [⭐] 描述');
  // 这里 [⭐] 在中间 —— 不在行尾，按设计应该不剥离（不是 H5 修复范围）
  // 行为约定：MARKER_TAIL_RE 的 `$` 锚点要求标记在行尾；中间位置不识别。
  check('行内 [⭐] 不被尾部规则剥离（不在 H5 修复范围）',
    r5.text.includes('[⭐]') && !r5.important,
    `text=${JSON.stringify(r5.text)}, important=${r5.important}`);

  // 不含标记的纯文本
  const r6 = extractInlineMarkers('just text');
  check('无标记 → important/current 都 false，text 不变',
    !r6.important && !r6.current && r6.text === 'just text');
}

// ── [2] parseMarkdown 端到端：行尾 [⭐] 被解析为 important ──
console.log('\n[2] parseMarkdown 端到端：行尾 [⭐] 解析为 important');

{
  const md = `# 全部任务

## 工作

- [ ] unimportant[⭐]
- [ ] 关注今日[▶]
- [ ] 双标[⭐][▶]
- [ ] 普通任务

## 未分类

`;
  const cats = parseMarkdown(md);
  const work = cats.find(c => c.name === '工作');

  const find = (text) => work.tasks.find(t => t.text === text);

  const t1 = find('unimportant');
  check('「工作」下 unimportant[⭐] → text=unimportant, important=true',
    !!t1 && t1.important === true && t1.completed === false,
    `task=${JSON.stringify(t1)}`);

  const t2 = find('关注今日');
  check('「工作」下 关注今日[▶] → text=关注今日, current=true',
    !!t2 && t2.current === true && t2.important === false,
    `task=${JSON.stringify(t2)}`);

  const t3 = find('双标');
  check('「工作」下 双标[⭐][▶] → 两种标记同时 true',
    !!t3 && t3.important === true && t3.current === true,
    `task=${JSON.stringify(t3)}`);

  const t4 = find('普通任务');
  check('「工作」下 普通任务 → 标记均为 false',
    !!t4 && !t4.important && !t4.current);
}

// ── [3] 写回往返：important 不会丢 ──
console.log('\n[3] 写回往返：行尾 [⭐] 经 serialize → parse 后标记保留');

{
  // 这里只验证解析侧的不可逆（writeMarkdown 单测已在 check-md-ui-sync 覆盖）：
  // 解析出来后，task.important === true ⇒ 文本里仍可看到 [⭐]；
  // 后续写回会在 writer 端用 [⭐] 行首标记（统一格式）输出，不再依赖原始紧凑写法。
  const md = `- [ ] hello[⭐]\n`;
  const cats = parseMarkdown(`# 全部任务\n\n## 工作\n\n${md}\n\n## 未分类\n\n`);
  const task = cats.find(c => c.name === '工作')?.tasks[0];
  check('hello[⭐] 解析后 important=true（持久性证据）',
    task && task.important === true && task.text === 'hello');
}

printSummary('check-marker-tail');