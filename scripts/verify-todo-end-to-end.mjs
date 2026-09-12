// 端到端验证：用真实 todo.md 验证往返后任务总数与分类结构守恒。
//
// v3.6 起 todo.md 不再含顶部「# 当前任务」/「# 重要任务」镜像段；智能视图在内存中
// 按 task.current / task.important 聚合，源任务行只活在「全部任务」容器的子分类下。
//
// 本脚本验证：
//   1. 加载当前 todo.md（或内置样例，缺文件时兜底）
//   2. 解析 + 重新序列化 + 再次解析
//   3. 任务总数与每个分类的任务数完全一致（不丢、不翻倍）
//
// 用法：node scripts/verify-todo-end-to-end.mjs
// 路径查找顺序（避免在别人机器 / CI 上硬挂）：
//   1) --file <path> 命令行参数（CI / 自定义）
//   2) TODO_LIST_FILE 环境变量
//   3) 当前用户的真实 todo.md（~/TodoList/todo.md，跨平台一致）
//   4) 内置 SAMPLE_MD —— 跑端到端往返但**不**回写，避免污染未知位置的文件
// 脚本会备份原文件到 <todo.md>.e2e.bak，再把重新序列化结果写回，方便人工 diff。

import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { parseMarkdown } from '../src/markdown-parser.js';
import { writeMarkdown } from '../src/markdown-writer.js';
import { check, summary, printSummary } from './_lib/check.mjs';

// 内置样例 —— 文件不在 / 无法定位时兜底，确保脚本在任意机器上都能跑通
const SAMPLE_MD = `# 全部任务

## 工作

- [ ] 工作任务 A
- [ ] 工作任务 B
- [✓] 已完成的工作任务

## 学习

- [ ] 学习任务 A
- [ ] 学习任务 B

## 未分类

- [ ] 未分类任务

# 已完成任务

- [✓] 单独的已完成任务
`;

// 找用户的真实 todo.md —— 跨平台 + 避坑非 ASCII 路径
// 已抽到 scripts/_lib/find-todo-path.mjs，这里 import 复用
import { findTodoFile } from './_lib/find-todo-path.mjs';

let todoPath, original, isSample;
const found = findTodoFile();
if (found) {
  todoPath = found.path;
  original = found.content;
  isSample = false;
} else {
  console.log('[verify-todo-end-to-end] 找不到用户 todo.md，回退到内置样例（不写回磁盘）');
  todoPath = null;
  original = SAMPLE_MD;
  isSample = true;
}

if (!isSample) {
  const backupPath = todoPath + '.e2e.bak';
  copyFileSync(todoPath, backupPath);
  console.log(`已备份原文件到 ${backupPath}（共 ${original.length} 字符）`);
} else {
  const sampleLineCount = SAMPLE_MD.split('\n').filter(Boolean).length;
  console.log(`（样例模式：${sampleLineCount} 行内置内容，仅跑往返不落盘）`);
}

const cats1 = parseMarkdown(original);
const beforeTotal = cats1.reduce((n, c) => n + c.tasks.length, 0);
console.log(`\n解析结果：${cats1.length} 个分类，${beforeTotal} 条任务`);

for (const c of cats1) {
  console.log(`  · ${c.name}：${c.tasks.length} 条`);
}

const md2 = writeMarkdown(cats1);
const cats2 = parseMarkdown(md2);
const afterTotal = cats2.reduce((n, c) => n + c.tasks.length, 0);

console.log(`\n重新序列化：${md2.length} 字符`);
console.log(`往返后任务总数：${beforeTotal} → ${afterTotal}（差 ${afterTotal - beforeTotal}）`);

console.log('\n[断言]');
check('往返后任务总数不变', beforeTotal === afterTotal, `${beforeTotal} → ${afterTotal}`);

// 每个分类的任务数也应一一对应（按 name 匹配；不存在的分类允许新增空分类）
const before = new Map(cats1.map(c => [c.name, c.tasks.length]));
const after = new Map(cats2.map(c => [c.name, c.tasks.length]));
let mismatched = 0;
for (const [name, count] of before) {
  const a = after.get(name);
  if (a !== count) {
    mismatched++;
    console.log(`  ✗ 分类「${name}」：${count} → ${a}`);
  }
}
check('每个分类的任务数也守恒', mismatched === 0);

// 写回文件（让用户能看到效果）；样例模式不落盘避免污染未知位置
if (!isSample && todoPath) {
  writeFileSync(todoPath, md2, 'utf8');
  console.log(`\n已写回文件 ${todoPath}（共 ${md2.length} 字符）`);
} else {
  console.log(`\n（样例模式：往返结果未落盘）`);
}
console.log(`\n${'─'.repeat(48)}\n通过 ${summary.pass} / 失败 ${summary.fail}`);
process.exit(summary.fail === 0 ? 0 : 1);