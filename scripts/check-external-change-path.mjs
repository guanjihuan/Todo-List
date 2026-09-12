// 测试 pathsEqual —— 外部修改检测路径比较的健壮性
//
// 背景：原实现 `changedPath !== store.filePath` 在 Windows 上永远失败：
//   - store.filePath 由 joinPath 拼出（forward slash） `C:/Users/<user>/TodoList/todo.md`
//   - IPC 发来的 changedPath 走 path.resolve（backslash）`C:\\Users\\<user>\\TodoList\\todo.md`
// 结果是 resolveExternalChangeConflict 永远提前 return，外部修改的 toast / reload
// 全部被静默吞掉 —— 用户看到「改了文件，软件没反应」。
//
// 这个测试覆盖各类路径等价场景，确保比较逻辑不会再退化。
//
// 注：测试 fixture 里出现的 `D:/TodoList` / `D:\\TodoList\\todo.md` 仅作 Windows
// 路径示例（验证 slash 方向、大小写不敏感、UNC 等行为），不指代实际默认目录。

import { pathsEqual } from '../src/utils/path.js';
import { check, ok, bad, summary, printSummary } from './_lib/check.mjs';
import { makeStore } from './_lib/store-fixture.mjs';

// ============================================================
// [1] Windows：核心 bug —— slash 方向不同
// ============================================================
console.log('\n[1] Windows: 核心 bug —— slash 方向不同');
{
  // 模拟 store.filePath (joinPath 输出)
  const fwd = 'D:/TodoList/todo.md';
  // 模拟主进程 IPC 发来的 changedPath (path.resolve 输出)
  const bwd = 'D:\\TodoList\\todo.md';
  check('forward slash vs backslash → 等价', pathsEqual(fwd, bwd),
    `fwd=${fwd} bwd=${bwd}`);
  check('反方向也一样', pathsEqual(bwd, fwd));
}

// ============================================================
// [2] Windows：完全相同
// ============================================================
console.log('\n[2] Windows: 完全相同');
{
  const a = 'D:/TodoList/todo.md';
  check('同 forward slash → 等价', pathsEqual(a, a));
  const b = 'D:\\TodoList\\todo.md';
  check('同 backslash → 等价', pathsEqual(b, b));
}

// ============================================================
// [3] Windows：大小写差异（NTFS 默认大小写不敏感）
// ============================================================
console.log('\n[3] Windows: 大小写差异');
{
  check('D:/TodoList vs d:/todolist → 等价',
    pathsEqual('D:/TodoList/todo.md', 'd:/todolist/todo.md'));
  check('混合大小写 vs 全大写 → 等价',
    pathsEqual('C:/Users/Admin/Todo.md', 'C:/USERS/admin/TODO.MD'));
}

// ============================================================
// [4] Windows：不同路径 → 不等价
// ============================================================
console.log('\n[4] Windows: 不同路径');
{
  check('不同文件名 → 不等价',
    !pathsEqual('D:/TodoList/foo.md', 'D:/TodoList/bar.md'));
  check('不同目录 → 不等价',
    !pathsEqual('D:/TodoA/foo.md', 'D:/TodoB/foo.md'));
  check('不同盘符 → 不等价',
    !pathsEqual('C:/TodoList/foo.md', 'D:/TodoList/foo.md'));
}

// ============================================================
// [5] POSIX：完全相同
// ============================================================
console.log('\n[5] POSIX: 完全相同');
{
  check('同路径 → 等价',
    pathsEqual('/home/user/todo.md', '/home/user/todo.md'));
  check('同路径反方向调用 → 等价',
    pathsEqual('/home/user/todo.md', '/home/user/todo.md'));
}

// ============================================================
// [6] POSIX：大小写不同 → 不等价（POSIX 默认大小写敏感）
// ============================================================
console.log('\n[6] POSIX: 大小写敏感（保守策略）');
{
  // 设计取舍：让 macOS / Linux 上的 TODO.md 和 todo.md 在用户角度确实可能是同一文件
  // （HFS+ / APFS 默认不敏感），但保守起见这里只把「带盘符」的 Windows 路径放宽，
  // POSIX 路径严格区分大小写。误报比漏报代价小。
  check('POSIX 路径大小写不同 → 不等价（保守）',
    !pathsEqual('/home/user/Todo.md', '/home/user/todo.md'));
}

// ============================================================
// [7] null / undefined 处理
// ============================================================
console.log('\n[7] null / undefined');
{
  // 实现选择：null / undefined 走严格比较（`a === b`），不互通。
  // 实际场景两边都是字符串（joinPath / path.resolve 的产物），这条只是
  // 「实现别在 null 上抛错」级别的健壮性保险，不需要语义层面的兼容性。
  check('两个 null → 等价', pathsEqual(null, null));
  check('两个 undefined → 等价', pathsEqual(undefined, undefined));
  check('null vs undefined → 不等价（严格模式）', !pathsEqual(null, undefined));
  check('null vs 字符串 → 不等价', !pathsEqual(null, 'D:/TodoList/todo.md'));
  check('字符串 vs null → 不等价', !pathsEqual('D:/TodoList/todo.md', null));
  check('undefined vs 字符串 → 不等价',
    !pathsEqual(undefined, 'D:/TodoList/todo.md'));
}

// ============================================================
// [8] 空字符串
// ============================================================
console.log('\n[8] 空字符串');
{
  check('两个空串 → 等价', pathsEqual('', ''));
  check('空串 vs 字符串 → 不等价', !pathsEqual('', 'D:/TodoList/todo.md'));
  check('字符串 vs 空串 → 不等价', !pathsEqual('D:/TodoList/todo.md', ''));
}

// ============================================================
// [9] UNC 路径（Windows 网络共享）：斜杠归一化后等价
// ============================================================
console.log('\n[9] UNC 路径');
{
  // \\server\share\file.md 归一化后是 //server/share/file.md
  // 两个写法（backslash / forward）归一化后一致 → 应等价
  check('UNC 双反斜杠 vs 双正斜杠 → 等价',
    pathsEqual('\\\\server\\share\\file.md', '\\\\server/share/file.md'));
}

// ============================================================
// [10] 核心回归：直接模拟 resolveExternalChangeConflict 的入参
// ============================================================
console.log('\n[10] 模拟 resolveExternalChangeConflict 的入参');
{
  // 真实数据流：app.js bootstrap 里 joinPath 拼出 filePath（正斜杠），
  // 然后通过 readFile IPC 走到主进程，主进程 path.resolve 后回填到 currentFilePath（反斜杠）。
  // 之后 fs.watch / polling 检测到变化，发 'file:external-change' IPC 把 currentFilePath
  // （反斜杠形态）送回渲染端。
  const joinPathOut = 'D:/TodoList/todo.md';
  const ipcPayload = 'D:\\TodoList\\todo.md';

  // 旧实现的判断 `changedPath !== store.filePath`：
  // 两个字符串字符不同 → 不等 → 触发提前 return → bug 触发
  const oldCheckSaysNotEqual = joinPathOut !== ipcPayload;
  check('旧实现 !== 在 Windows 上判定为不等（bug 触发）',
    oldCheckSaysNotEqual === true,
    `旧实现会让 resolveExternalChangeConflict 提前 return`);

  // 新实现：pathsEqual 把两条路径判定为相等
  check('新实现 pathsEqual 判定为相等（不触发提前 return）',
    pathsEqual(joinPathOut, ipcPayload) === true);

  // 验证 bug 已修复的核心对比
  check('核心 bug 已修复：slash 不同但路径相同能被识别',
    pathsEqual('D:/TodoList/todo.md', 'D:\\TodoList\\todo.md'));
}

// ============================================================
// [11] macOS：大小写不敏感（APFS / HFS+ 默认）
// ============================================================
//
// 真实场景：用户在 macOS 上手敲 ~/TodoList/todo.md，外部编辑器保存时
// 拼出 /users/admin/todolist/todo.md —— APFS / HFS+ 默认大小写不敏感，
// 两条路径指向同一文件。pathsEqual 必须能识别等价，否则外部修改会被吞。
console.log('\n[11] macOS: 大小写不敏感（通过 navigator.platform 模拟）');
{
  // 在单测里塞 navigator.platform 模拟 macOS 环境
  // Node 18+ 的 globalThis.navigator 是只读 getter，需用 defineProperty。
  const savedNav = globalThis.navigator;
  Object.defineProperty(globalThis, 'navigator', {
    value: { platform: 'MacIntel', userAgent: 'Mozilla/5.0 (Macintosh)' },
    configurable: true,
    writable: true
  });

  try {
    check('macOS 下 /Users/Foo/Todo.md vs /users/foo/todo.md → 等价',
      pathsEqual('/Users/Foo/Todo.md', '/users/foo/todo.md'));
    check('macOS 下混合大小写也等价',
      pathsEqual('/Users/Admin/Todo.md', '/USERS/admin/TODO.MD'));
    check('macOS 下完全不同路径 → 不等价',
      !pathsEqual('/Users/Foo/Todo.md', '/Users/Bar/Todo.md'));
  } finally {
    Object.defineProperty(globalThis, 'navigator', {
      value: savedNav,
      configurable: true,
      writable: true
    });
  }
}

// ============================================================
// [12] macOS 探测：非 macOS 平台不会触发大小写不敏感
// ============================================================
console.log('\n[12] 非 macOS 平台：POSIX 仍严格大小写敏感');
{
  const savedNav = globalThis.navigator;
  Object.defineProperty(globalThis, 'navigator', {
    value: { platform: 'Linux x86_64', userAgent: 'Mozilla/5.0 (X11; Linux)' },
    configurable: true,
    writable: true
  });

  try {
    check('Linux 下大小写不同 → 不等价',
      !pathsEqual('/home/user/Todo.md', '/home/user/todo.md'));
    check('Linux 下完全相同 → 等价',
      pathsEqual('/home/user/todo.md', '/home/user/todo.md'));
  } finally {
    Object.defineProperty(globalThis, 'navigator', {
      value: savedNav,
      configurable: true,
      writable: true
    });
  }
}

console.log(`\n通过 ${summary.pass} / 失败 ${summary.fail}`);
process.exit(summary.fail === 0 ? 0 : 1);
