// 跨脚本共享：临时 todo.md 文件的创建 + 清理。
//
// 用途：polling-fallback / snapshot-creation / write-race 等脚本要在隔离目录
// 下模拟真实 todo.md 文件，每次都重复同样的 3 行 mkdtempSync+writeFileSync
// boilerplate，且清理端 `fs.rmSync(tmpDir, { recursive, force })` 在 3 个脚本
// 各自复制一份 —— 任何一处改成 `fs.rm` 或漏 `{ force: true }` 就会在 CI 上
// 留下 tmp 目录。
//
// 用法：
//   import { makeTmpTodoFile, cleanupTmpTodo } from './_lib/tmp-todo.mjs';
//   const { dir, file } = makeTmpTodoFile({ prefix: 'poll-test-' });
//   // ... 测试 ...
//   cleanupTmpTodo({ dir });

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 默认 seed：最小可工作的「全部任务」+「工作」分类 + 一条 a 任务。
// 覆盖路径：如果脚本要不同初始内容，传 `content` override（snapshot-creation
// 用 `# todo\n- [ ] A\n- [ ] B\n`；write-race 用 `## 工作\n\n- [ ] V0`）。
const DEFAULT_SEED = '# 全部任务\n\n## 工作\n\n- [ ] a\n';

/**
 * 创建一个临时目录并写入 todo.md，返回 { dir, file }。
 *
 * @param {object} [opts]
 * @param {string} [opts.prefix='todo-test-'] — mkdtempSync 前缀，含连字符
 * @param {string} [opts.content] — 初始 markdown 内容；不传走 DEFAULT_SEED
 * @returns {{ dir: string, file: string }}
 */
export function makeTmpTodoFile({ prefix = 'todo-test-', content = DEFAULT_SEED } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const file = path.join(dir, 'todo.md');
  fs.writeFileSync(file, content);
  return { dir, file };
}

/**
 * 清理临时目录。`force: true` 让目录不存在时也不抛 —— 测试中途崩了也能跑。
 *
 * @param {object} opts
 * @param {string} opts.dir
 */
export function cleanupTmpTodo({ dir }) {
  if (!dir) return;
  fs.rmSync(dir, { recursive: true, force: true });
}
