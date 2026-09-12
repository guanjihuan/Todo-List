// 跨脚本共享：找用户的真实 todo.md 路径并读取内容。
//
// 解决 user memory 里反复提到的硬编码路径问题：
//   - 之前 `scripts/check-*.mjs` / `verify-*.mjs` 直接写死 `c:/Users/guan/TodoList/todo.md`
//     在别人的机器 / CI 必挂；
//   - 这套查找链按优先级收敛：CLI `--file` → `TODO_LIST_FILE` 环境变量 → 平台约定
//     （用户主目录下的 ~/TodoList/todo.md，跨平台统一）。
//
// 用法：
//   import { findTodoFile } from './_lib/find-todo-path.mjs';
//   const { path: todoPath, content } = findTodoFile() ?? {};
//   if (!todoPath) { /* 走内置 SAMPLE 兜底 */ }
//
// 返回 `null`（找不到任何候选）让调用方决定降级策略 —— 通常是回落到内置 SAMPLE 跑，
// 与「脚本不能因为路径在别人机器上不一样就硬挂」的回归策略一致。

import { readFileSync } from 'node:fs';

/**
 * 找用户的真实 todo.md。
 * @returns {{ path: string, content: string } | null}
 */
export function findTodoFile() {
  // 1) 命令行 --file=xxx / --file xxx 优先（CI / 调试覆盖）
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file' && argv[i + 1]) {
      const p = argv[i + 1];
      try {
        return { path: p, content: readFileSync(p, 'utf8') };
      } catch {
        return null;
      }
    }
    if (a.startsWith('--file=')) {
      const p = a.slice('--file='.length);
      try {
        return { path: p, content: readFileSync(p, 'utf8') };
      } catch {
        return null;
      }
    }
  }

  // 2) 环境变量（脚本间共享 —— e.g. CI 全局指定一个 todo.md）
  const envPath = process.env.TODO_LIST_FILE;
  if (envPath) {
    try {
      return { path: envPath, content: readFileSync(envPath, 'utf8') };
    } catch {
      /* 文件被删 / 权限不足 —— 继续往下找 */
    }
  }

  // 3) 平台约定：用户主目录下的 TodoList（~/TodoList）。
  //
  // 注意：不要用 HOMEDRIVE 单拼 —— `HOMEDRIVE=C:` + 不带 HOMEPATH 会得到
  // `C:\TodoList\todo.md`（C: 盘根目录下的 TodoList），完全不是用户的 home。
  // 应该走 USERPROFILE / HOME 这类已经合并好 drive + path 的环境变量。
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const candidates = [];
  if (home) {
    if (process.platform === 'win32') {
      candidates.push(`${home}\\TodoList\\todo.md`, `${home}/TodoList/todo.md`);
    } else {
      candidates.push(`${home}/TodoList/todo.md`);
    }
  }

  for (const p of candidates) {
    try {
      return { path: p, content: readFileSync(p, 'utf8') };
    } catch {
      /* 跳过不存在的候选 */
    }
  }
  return null;
}
