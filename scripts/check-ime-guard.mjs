// 回归：UI 文件里所有 Enter 与 Escape 按键处理都必须有 IME 守卫。
//
// 历史 bug：command-palette.js 的 onKey 在 key === 'Enter' 时直接执行命令，
// 没检查 `e.isComposing || e.keyCode === 229` —— CJK 用户用输入法上屏
// 候选词时按 Enter，会被误判为「确认命令」，意外触发高亮项。
//
// 同样问题适用于 Escape：CJK/JP/KR 用户在 IME 组合中按 Esc 是「取消 IME 组合」，
// 不是「关闭弹窗 / 取消编辑」。无守卫会让 Esc 同时关掉 IME 和上层 UI。
//
// 修复：所有 UI 文件的 Enter / Esc 分支都要叠加 `!isImeComposing(e)` 或
// `if (isImeComposing(e)) return;`，由 src/utils/keymap.js 提供统一 helper。
//
// 静态分析覆盖：feedback.js / conflict-dialog.js / diff-preview-dialog.js /
// import-dialog.js / settings-dialog.js / task-list.js / command-palette.js。
//
// 用法：node scripts/check-ime-guard.mjs

import { readFileSync } from 'node:fs';
import { ok, bad, printSummary } from './_lib/check.mjs';

const FILES = [
  'src/ui/feedback.js',
  'src/ui/conflict-dialog.js',
  'src/ui/diff-preview-dialog.js',
  'src/ui/import-dialog.js',
  'src/ui/settings-dialog.js',
  'src/ui/task-list.js',
  'src/ui/command-palette.js',
  'src/ui/sidebar.js',
  'src/ui/toolbar.js',
];

// 用 indexOf 代替 regex —— 一些 Node / shell 组合下 regex 字面量会被静默改写。
function hasImeImport(src) {
  const idx = src.indexOf('isImeComposing');
  if (idx < 0) return false;
  const before = src.lastIndexOf('import', idx);
  if (before < 0) return false;
  const after = src.indexOf('keymap.js', idx);
  if (after < 0 || after - idx > 200) return false;
  return true;
}

// 通用：扫某种 key 的所有出现位置，检查其后窗口内是否有 IME 守卫。
function findBareKeys(src, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`e\\.key\\s*===\\s*['"]${escaped}['"]`, 'g');
  const matches = [...src.matchAll(re)];
  const bare = [];
  for (const em of matches) {
    const pos = em.index;
    const window = src.slice(Math.max(0, pos - 50), pos + 400);
    const guarded = /!\s*isImeComposing\s*\(\s*e\s*\)/.test(window)
      || /isImeComposing\s*\(\s*e\s*\)\s*\)?\s*return/.test(window)
      // `if (e.key === 'X' && !isImeComposing(e))` —— 守卫可能在条件之后
      || new RegExp(`e\\.key\\s*===\\s*['"]${escaped}['"][^)]*&&\\s*!\\s*isImeComposing`).test(window);
    if (!guarded) {
      const line = src.slice(0, pos).split('\n').length;
      bare.push({ line, snippet: src.slice(pos, pos + 80).replace(/\n/g, ' ') });
    }
  }
  return bare;
}

for (const file of FILES) {
  const src = readFileSync(file, 'utf8');

  if (hasImeImport(src)) {
    ok(`${file}: 引入 isImeComposing helper`);
  } else {
    bad(`${file}: 引入 isImeComposing helper`, '未 import isImeComposing —— Enter/Esc 守卫可能漏写');
  }

  for (const key of ['Enter', 'Escape']) {
    const bare = findBareKeys(src, key);
    if (bare.length === 0) {
      ok(`${file}: 所有 ${key} 分支均已守卫（共 0 个未守卫）`);
    } else {
      for (const b of bare) {
        const reason = key === 'Enter'
          ? 'CJK 用户上屏候选词会被误判为确认'
          : 'CJK 用户按 Esc 取消 IME 组合会被误判为关闭弹窗/取消编辑';
        bad(`${file}:${b.line} 裸 ${key} 分支无 IME 守卫`,
          `附近代码：${b.snippet}……  ${reason}`);
      }
    }
  }
}

printSummary('check-ime-guard');
