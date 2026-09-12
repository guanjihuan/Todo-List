// 回归：模态/命令面板关闭时的 250ms 兜底必须 resolve Promise。
//
// 旧实现：animationend 漏触发（如 display:none / 元素被提前 detach）→
//   Promise 永远挂住 → 对 confirmDialog 是 await 卡死、对 command-palette
//   是 _active 永不清 → Ctrl+K 永久失效（致命）。
//
// 验证项：
//   (a) 所有 close 站点（confirmDialog / inputDialog / openCommandPalette /
//       openSettingsDialog 的 finish / cancel / openConflictDialog /
//       openDiffPreview / openImportDialog）都调用统一的 finalize 帮手
//   (b) finalize 里 focus() 必须在 overlay.remove() 之前 —— 否则焦点跳 body
//   (c) 250ms setTimeout 必须以 finalize 作为回调（而不是只 remove 不 resolve）
//   (d) settings-dialog 的 finish / cancel 必须有共享 closed 守卫防双 resolve

import { check, ok, bad, summary, printSummary } from './_lib/check.mjs';
import { readFileSync } from 'node:fs';

const FEEDBACK = readFileSync('src/ui/feedback.js', 'utf8');
const SETTINGS_DIALOG = readFileSync('src/ui/settings-dialog.js', 'utf8');
const COMMAND_PALETTE = readFileSync('src/ui/command-palette.js', 'utf8');
const CONFLICT_DIALOG = readFileSync('src/ui/conflict-dialog.js', 'utf8');
const DIFF_PREVIEW = readFileSync('src/ui/diff-preview-dialog.js', 'utf8');
const IMPORT_DIALOG = readFileSync('src/ui/import-dialog.js', 'utf8');

let pass = 0, fail = 0;
function expect(name, cond, info) {
  if (cond) { ok(name); pass++; } else { bad(name, info); fail++; }
}

// 通用 helper：验证 close 函数片段是否使用 finalize / 共享 setTimeout
function expectCloseFinalize(label, source, closeNeedle) {
  const startIdx = source.indexOf(closeNeedle);
  if (startIdx < 0) {
    bad(`${label}: 找不到 close 锚点 ${closeNeedle}`);
    fail++;
    return;
  }
  // 取 close 函数片段到下一个 const XXX / function / export 之前
  const tail = source.slice(startIdx);
  const endMatch = tail.match(/\n  (?:const |function |export |\})/);
  const endIdx = endMatch ? startIdx + endMatch.index : source.length;
  const closeBlock = source.slice(startIdx, endIdx);

  expect(
    `${label} 使用 finalize() 帮手`,
    /const finalize\s*=/.test(closeBlock),
    `${label} 里没找到 const finalize`
  );
  expect(
    `${label} 的 250ms 兜底调用 finalize（不是只 remove）`,
    /setTimeout\(finalize,\s*250\)/.test(closeBlock),
    `${label} 的 250ms 兜底不是 finalize —— animationend 漏触发时 Promise 挂住`
  );
  expect(
    `${label} 中 focus 在 remove 之前`,
    /finalize[\s\S]*?previouslyFocused\.focus\(\)[\s\S]*?overlay\.remove\(\)/.test(closeBlock),
    `${label}.finalize 里 focus() 顺序在 remove() 之后 —— 被销毁祖先上 focus 跳 body`
  );
}

// (a) confirmDialog close：使用 finalize / setTimeout(finalize, 250) 模式
{
  // 抓 confirmDialog 整段代码 —— 从 'export function confirmDialog' 到 'export function inputDialog'
  const startIdx = FEEDBACK.indexOf('export function confirmDialog');
  const endIdx = FEEDBACK.indexOf('export function inputDialog');
  const confirmBlock = FEEDBACK.slice(startIdx, endIdx);
  expect(
    'confirmDialog.close 使用 finalize() 帮手',
    /const finalize\s*=/.test(confirmBlock),
    'confirmDialog 里没找到 const finalize'
  );
  expect(
    'confirmDialog.close 的 250ms 兜底调用 finalize（不是只 remove）',
    /setTimeout\(finalize,\s*250\)/.test(confirmBlock),
    'confirmDialog 的 250ms 兜底不是 finalize —— animationend 漏触发时 Promise 挂住'
  );
  expect(
    'confirmDialog.close 中 focus 在 remove 之前',
    /finalize[\s\S]*?previouslyFocused\.focus\(\)[\s\S]*?overlay\.remove\(\)/.test(confirmBlock),
    'confirmDialog.finalize 里 focus() 顺序在 remove() 之后 —— 被销毁祖先上 focus 跳 body'
  );
}

// (b) inputDialog close：同样模式
{
  const startIdx = FEEDBACK.indexOf('export function inputDialog');
  // inputDialog 是最后一个 export，下一个 export 是 inputDialog 内部函数 inputDialog
  // 取下一个 export function 之前的所有内容（如果没有下一个，则取到文件末尾）
  const endIdx = FEEDBACK.indexOf('export function inputDialog', startIdx + 1);
  const inputBlock = endIdx > 0 ? FEEDBACK.slice(startIdx, endIdx) : FEEDBACK.slice(startIdx);
  expect(
    'inputDialog.close 使用 finalize() 帮手',
    /const finalize\s*=/.test(inputBlock),
    'inputDialog 里没找到 const finalize'
  );
  expect(
    'inputDialog.close 的 250ms 兜底调用 finalize',
    /setTimeout\(finalize,\s*250\)/.test(inputBlock),
    'inputDialog 的 250ms 兜底不是 finalize'
  );
  expect(
    'inputDialog.close 中 focus 在 remove 之前',
    /finalize[\s\S]*?previouslyFocused\.focus\(\)[\s\S]*?overlay\.remove\(\)/.test(inputBlock),
    'inputDialog.finalize 里 focus() 顺序在 remove() 之后'
  );
}

// (c) command-palette close：同样模式
{
  const startIdx = COMMAND_PALETTE.indexOf('const close = () =>');
  const endIdx = COMMAND_PALETTE.indexOf('  const execute', startIdx);
  const closeBlock = COMMAND_PALETTE.slice(startIdx, endIdx > 0 ? endIdx : COMMAND_PALETTE.length);
  expect(
    'command-palette.close 使用 finalize() 帮手',
    /const finalize\s*=/.test(closeBlock),
    'command-palette.close 里没找到 const finalize'
  );
  expect(
    'command-palette.close 的 250ms 兜底调用 finalize（防 _active 永不清）',
    /setTimeout\(finalize,\s*250\)/.test(closeBlock),
    'command-palette 的 250ms 兜底不是 finalize —— 这是致命：会让 Ctrl+K 永久失效'
  );
}

// (e) conflict-dialog close：避免 Promise 永久挂起让 _doResolveExternalChangeConflict 后续
//     saveNow / toast 永远不执行
expectCloseFinalize('conflict-dialog.close', CONFLICT_DIALOG, 'const close = (result) =>');

// (f) diff-preview-dialog close：用户关掉行级 diff 后焦点必须回到 conflict-dialog「查看完整 diff」按钮
expectCloseFinalize('diff-preview.close', DIFF_PREVIEW, 'const close = () =>');

// (g) import-dialog close：避免 _addFromImport 后续逻辑挂起
expectCloseFinalize('import-dialog.close', IMPORT_DIALOG, 'const close = (result) =>');

// (d) settings-dialog 的 finish / cancel 都用 finalize + 共享 closed 守卫
expect(
  "settings-dialog 有共享 'closed' 守卫（防 finish/cancel 双竞态）",
  /let closed = false/.test(SETTINGS_DIALOG) &&
    /const cancel[\s\S]*?if \(closed\) return/.test(SETTINGS_DIALOG) &&
    /const finish[\s\S]*?if \(closed\) return/.test(SETTINGS_DIALOG),
  "settings-dialog 缺 'closed' 守卫 —— finish/cancel 可并发执行，丢设置"
);

expect(
  'settings-dialog.finish 用 finalize()',
  /const finish[\s\S]*?const finalize\s*=/.test(SETTINGS_DIALOG),
  'settings-dialog.finish 里没找到 finalize'
);
expect(
  'settings-dialog.cancel 用 finalize()',
  /const cancel[\s\S]*?const finalize\s*=/.test(SETTINGS_DIALOG),
  'settings-dialog.cancel 里没找到 finalize'
);

expect(
  'settings-dialog.finish 的 250ms 兜底调用 finalize',
  /setTimeout\(finalize,\s*250\)/.test(SETTINGS_DIALOG),
  'settings-dialog.finish 的 250ms 兜底不是 finalize'
);
expect(
  'settings-dialog.cancel 的 250ms 兜底调用 finalize',
  SETTINGS_DIALOG.match(/const cancel[\s\S]*?setTimeout\(finalize, 250\)/) !== null,
  'settings-dialog.cancel 的 250ms 兜底不是 finalize'
);

printSummary(pass, fail);