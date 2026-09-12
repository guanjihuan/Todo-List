// 回归测试：H10 — file:exists 必须走 assertInDataDir
//
// 背景：旧版 file:exists 直接 fs.access(filePath) —— 配合一个 XSS（任何能从
// renderer 调到 api.fileExists 的注入）就能枚举整盘存在性：
//   for (let p of commonPaths) { if (await api.fileExists(p)) found.push(p); }
// 任意文件存在性是隐私 + 安全敏感信息（用户的密码管理器 DB 是否存在、
// 公司加密软件安装情况等）。
//
// 修复（v3.7+）：file:exists 与 file:write / file:read 同款走 assertInDataDir，
// 数据目录外的路径 → 一律返回 false（不抛错，避免泄露信息）。
//
// 跑法：node scripts/check-assert-in-data-dir.mjs

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { check, summary, printSummary } from './_lib/check.mjs';

// ── [1] assertInDataDir 行为镜像 ──
console.log('\n[1] assertInDataDir 行为：拒绝数据目录外路径');

const dataDir = path.resolve(os.homedir(), 'TodoList');

function assertInDataDir(p) {
  if (typeof p !== 'string' || !p) {
    throw new Error('path must be a non-empty string');
  }
  const root = path.resolve(dataDir);
  const abs = path.resolve(p);
  const rootCmp = process.platform === 'win32' ? root.toLowerCase() : root;
  const absCmp = process.platform === 'win32' ? abs.toLowerCase() : abs;
  if (absCmp !== rootCmp && !absCmp.startsWith(rootCmp + path.sep)) {
    throw new Error('path outside data directory');
  }
  return abs;
}

{
  check('数据目录内的合法路径 → 不抛错',
    (() => { try { return assertInDataDir(path.join(dataDir, 'todo.md')); } catch { return false; } })() !== false);

  check('上级目录穿越 → 抛错',
    (() => { try { assertInDataDir(path.join(dataDir, '..', 'evil.txt')); return false; } catch { return true; } })());

  check('绝对路径在数据目录外 → 抛错',
    (() => {
      const outside = process.platform === 'win32' ? 'C:\\Windows\\System32\\evil.dll' : '/etc/passwd';
      try { assertInDataDir(outside); return false; } catch { return true; }
    })());

  check('空字符串 → 抛错',
    (() => { try { assertInDataDir(''); return false; } catch { return true; } })());

  check('非字符串（数字）→ 抛错',
    (() => { try { assertInDataDir(123); return false; } catch { return true; } })());

  check('非字符串（null）→ 抛错',
    (() => { try { assertInDataDir(null); return false; } catch { return true; } })());
}

// ── [2] file:exists 行为：对外路径一律返回 false ──
console.log('\n[2] file:exists 模拟：对外路径一律返回 false');

/**
 * 模拟 main.js 的 file:exists handler：assertInDataDir + fs.access + try/catch。
 * 任意一步抛错都返回 false（不向 renderer 抛错，避免泄露目录结构）。
 */
async function fileExists(filePath) {
  try {
    const abs = assertInDataDir(filePath);
    await fs.access(abs);
    return true;
  } catch {
    return false;
  }
}

{
  // 数据目录内：文件存在 → true
  // 准备：临时创建数据目录内的一个文件，跑完删除
  const tmpFile = path.join(dataDir, `__check-assert-${Date.now()}.tmp`);
  try {
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(tmpFile, 'hello', 'utf8');
    check('数据目录内已存在的文件 → file:exists 返回 true',
      await fileExists(tmpFile) === true);
  } finally {
    try { await fs.unlink(tmpFile); } catch { /* ignore */ }
  }

  // 数据目录内：文件不存在 → false（不是抛错）
  check('数据目录内不存在的文件 → file:exists 返回 false',
    await fileExists(path.join(dataDir, 'definitely-does-not-exist.md')) === false);

  // 数据目录外：fs.access 能探测到也必须返回 false
  check('Windows 系统目录（无论是否存在）→ file:exists 返回 false（防信息泄露）',
    await fileExists(process.platform === 'win32' ? 'C:\\Windows\\System32\\drivers\\etc\\hosts' : '/etc/passwd') === false);

  // 绝对路径在数据目录外
  check('数据目录外绝对路径 → file:exists 返回 false',
    await fileExists(process.platform === 'win32' ? 'C:\\Users\\Public\\test.txt' : '/tmp/test.txt') === false);

  // 路径穿越攻击
  check('路径穿越（../evil.txt）→ file:exists 返回 false',
    await fileExists(path.join(dataDir, '..', 'evil.txt')) === false);

  // 空字符串
  check('空字符串 → file:exists 返回 false',
    await fileExists('') === false);

  // 非字符串
  check('非字符串（null）→ file:exists 返回 false',
    await fileExists(null) === false);
}

printSummary('check-assert-in-data-dir');