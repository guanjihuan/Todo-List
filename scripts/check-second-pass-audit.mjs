// 第二轮深度审计回归：
//
//  在第一轮修复 (_dragJustEnded) 之后，又排查出多个潜在的「按钮没反应 /
//  反应错」根因。本脚本一次性覆盖所有第二轮修复点，避免再次回归。
//
// 涵盖：
//   H1 - focus-trap.js 必须用 getClientRects / visibility 检查，
//         不能继续用 offsetParent（position: fixed 永远 null）
//   H2 - checkbox 点击：input 上的合成 click 必须跳过
//         （label 触发一次已 toggle，input 的合成 click 二次 toggle 会抵消）
//   H3 - Space / F2 / Delete keydown 必须有 isImeComposing 守卫
//   M8 - feedback.js 提供 registerBeforeModalShow，
//         confirmDialog / inputDialog 打开前调用 hooks，
//         task-list.js 注册 _cancelAllDrags、sidebar.js 注册 _abortAllSidebarDrags
//   L4 - _exitSelectionMode 必须立即同步 body.dataset.selectionMode = 'false'
//   M1 - render() 内 _commitActiveEdit 加 isConnected 守卫

import { readFileSync } from 'node:fs';
import { ok, bad, printSummary } from './_lib/check.mjs';

const TASK_LIST = readFileSync('src/ui/task-list.js', 'utf8');
const FOCUS_TRAP = readFileSync('src/utils/focus-trap.js', 'utf8');
const FEEDBACK = readFileSync('src/ui/feedback.js', 'utf8');
const SIDEBAR = readFileSync('src/ui/sidebar.js', 'utf8');

let pass = 0, fail = 0;
function expect(name, cond, info) {
  if (cond) { ok(name); pass++; } else { bad(name, info); fail++; }
}

function section(name) { console.log(`\n[${name}]`); }

// ─────────────────────────────────────────────────────────────────────────────
// H1: focus-trap 不再依赖 offsetParent
// ─────────────────────────────────────────────────────────────────────────────
section('H1: focus-trap.js 用 getClientRects / visibility，不用 offsetParent');

// 注释里允许提到 offsetParent 作为历史说明，但要确保代码里不再使用。
// 用「去掉所有注释后再检查」的策略：先去掉 /* ... */ 块注释，再剥 // 行注释。
const stripBlockComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const codeOnly = stripBlockComments(FOCUS_TRAP).split('\n').map(line => {
  const i = line.indexOf('//');
  if (i >= 0 && line.slice(0, i).trim() !== '') return line.slice(0, i);
  return line;
}).join('\n');

expect(
  'focus-trap.js 代码里不再用 offsetParent（注释中允许提到历史 bug）',
  !/offsetParent/.test(codeOnly),
  'offsetParent 对 position:fixed 元素恒为 null，会把 modal 内所有 focusable 误判为不可见'
);

expect(
  'focus-trap.js 使用 getClientRects() 判定可见性',
  /getClientRects\(\)/.test(FOCUS_TRAP),
  '需要 getClientRects().length === 0 判断零尺寸 / 不可见'
);

expect(
  'focus-trap.js 检查 computed visibility / display',
  /visibility\s*===\s*['"]hidden['"]/.test(FOCUS_TRAP) &&
    /display\s*===\s*['"]none['"]/.test(FOCUS_TRAP),
  '需要兜底 display:none / visibility:hidden'
);

// ─────────────────────────────────────────────────────────────────────────────
// H2: checkbox 双触发修复
// ─────────────────────────────────────────────────────────────────────────────
section('H2: checkbox 点击 → 跳过 input 上的合成 click');

// 抓取 this.listEl.addEventListener('click', ...) 整段（用括号计数法定位尾部 `});`）
{
  const start = TASK_LIST.indexOf("this.listEl.addEventListener('click'");
  expect(
    'click handler 可被静态解析',
    start >= 0,
    '没找到 click handler'
  );

  if (start >= 0) {
    const openIdx = TASK_LIST.indexOf('{', start);
    let depth = 1, i = openIdx + 1;
    while (i < TASK_LIST.length && depth > 0) {
      const ch = TASK_LIST[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      i++;
    }
    const body = TASK_LIST.slice(openIdx + 1, i - 1);

    expect(
      'checkbox 分支包含 task-checkbox-wrapper / task-checkbox-custom / task-checkbox 三选一匹配',
      /task-checkbox-wrapper/.test(body) && /task-checkbox-custom/.test(body) && /task-checkbox/.test(body),
      'checkbox 分支必须仍然能命中三种 className（不破坏现有逻辑）'
    );

    expect(
      'checkbox 分支包含「input 上的合成 click 跳过」守卫',
      /tagName\s*===\s*['"]INPUT['"][\s\S]{0,200}task-checkbox/.test(body) ||
        /tagName\s*===\s*['"]INPUT['"][\s\S]{0,200}return/.test(body),
      '必须检测 e.target.tagName === "INPUT" 且 class 含 task-checkbox 时 return'
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// H3: Space / F2 / Delete IME 守卫
// ─────────────────────────────────────────────────────────────────────────────
section('H3: keydown handler 的 Space / F2 / Delete 加 isImeComposing 守卫');

// 抓取 docKeydown 整段：括号计数法定位尾部
{
  const start = TASK_LIST.indexOf('const docKeydown = ');
  expect(
    'docKeydown handler 可被静态解析',
    start >= 0,
    '没找到 docKeydown 命名函数'
  );

  if (start >= 0) {
    const openIdx = TASK_LIST.indexOf('{', start);
    let depth = 1, i = openIdx + 1;
    while (i < TASK_LIST.length && depth > 0) {
      const ch = TASK_LIST[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      i++;
    }
    const body = TASK_LIST.slice(openIdx + 1, i - 1);

    // 验证每个键在分支条件里出现 isImeComposing(e)
    const checks = [
      { key: 'Space',  pattern: /e\.key\s*===\s*['"] ['"][\s\S]{0,80}!isImeComposing/ },
      { key: 'F2',     pattern: /e\.key\s*===\s*['"]F2['"][\s\S]{0,80}!isImeComposing/ },
      { key: 'Delete', pattern: /e\.key\s*===\s*['"]Delete['"][\s\S]{0,80}!isImeComposing/ }
    ];

    for (const c of checks) {
      expect(
        `${c.key} 分支带 isImeComposing 守卫`,
        c.pattern.test(body),
        `${c.key} 必须用 !isImeComposing(e) 与 selectedTaskId 一起判断`
      );
    }

    // Enter 仍然有守卫（防止被改坏）
    expect(
      'Enter 分支带 isImeComposing 守卫（防止重构时弄丢）',
      /e\.key\s*===\s*['"]Enter['"][\s\S]{0,80}!isImeComposing/.test(body),
      'Enter 的 IME 守卫必须保留'
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// M8: modal 打开前清掉拖拽
// ─────────────────────────────────────────────────────────────────────────────
section('M8: feedback.js 注册式 hook + confirm/inputDialog 调用 + 组件注册');

expect(
  'feedback.js 导出 registerBeforeModalShow',
  /export\s+function\s+registerBeforeModalShow/.test(FEEDBACK),
  '必须导出注册入口供组件挂载清理逻辑'
);

expect(
  'feedback.js 内部维护 beforeModalShowHooks Set',
  /beforeModalShowHooks[\s\S]{0,40}=[\s\S]{0,20}new\s+Set\(\)/.test(FEEDBACK),
  '需要 Set 而非 Array，避免同一 hook 重复注册后被多次调用'
);

expect(
  'feedback.js 有 runBeforeModalShow 内部调用函数',
  /function\s+runBeforeModalShow\(/.test(FEEDBACK),
  '需要统一的调用入口，便于 try/catch 隔离单个 hook 抛错'
);

// confirmDialog 与 inputDialog 在挂载 overlay 之前必须调用 runBeforeModalShow
const confirmMatch = FEEDBACK.match(
  /export\s+function\s+confirmDialog\([\s\S]*?return\s+new\s+Promise\([\s\S]*?runBeforeModalShow\(\);/
);
const inputMatch = FEEDBACK.match(
  /export\s+function\s+inputDialog\([\s\S]*?return\s+new\s+Promise\([\s\S]*?runBeforeModalShow\(\);/
);

expect(
  'confirmDialog 在 overlay 创建前调 runBeforeModalShow()',
  !!confirmMatch,
  'confirmDialog 必须先调 hook 再 document.body.appendChild(overlay)'
);

expect(
  'inputDialog 在 overlay 创建前调 runBeforeModalShow()',
  !!inputMatch,
  'inputDialog 必须先调 hook 再 document.body.appendChild(overlay)'
);

// 其他 4 个 modal 也必须调 runBeforeModalShow —— 否则用户在这些 dialog
// 打开时拖拽状态会残留，pointerup 重排任务。
const otherModals = [
  { name: 'openImportDialog (import-dialog.js)', file: readFileSync('src/ui/import-dialog.js', 'utf8') },
  { name: 'openSettingsDialog (settings-dialog.js)', file: readFileSync('src/ui/settings-dialog.js', 'utf8') },
  { name: 'openConflictDialog (conflict-dialog.js)', file: readFileSync('src/ui/conflict-dialog.js', 'utf8') },
  { name: 'openDiffPreview (diff-preview-dialog.js)', file: readFileSync('src/ui/diff-preview-dialog.js', 'utf8') },
  { name: '_openCommandPaletteInner (command-palette.js)', file: readFileSync('src/ui/command-palette.js', 'utf8') }
];

for (const m of otherModals) {
  expect(
    `${m.name} import runBeforeModalShow`,
    /import\s*\{[^}]*runBeforeModalShow[^}]*\}\s*from\s*['"]\.\/feedback\.js['"]/.test(m.file),
    `${m.name} 必须从 feedback.js 导入 runBeforeModalShow`
  );

  expect(
    `${m.name} 在 Promise 体内调 runBeforeModalShow()`,
    /return\s+new\s+Promise\([\s\S]*?runBeforeModalShow\(\);/.test(m.file) ||
      /return\s+new\s+Promise\([\s\S]*?runBeforeModalShow\(\)/.test(m.file),
    `${m.name} 必须先调 hook 再 document.body.appendChild(overlay)`
  );
}

// task-list.js 注册 _cancelAllDrags 到 hook
expect(
  'task-list.js 注册 _cancelAllDrags 作为 modal 打开前 hook',
  /registerBeforeModalShow\(\(\)\s*=>\s*this\._cancelAllDrags\(\)\)/.test(TASK_LIST),
  'task-list.js 必须注册 hook 调 _cancelAllDrags'
);

expect(
  'task-list.js 在 destroy() 里注销 hook',
  /destroy\(\)\s*\{[\s\S]*?_unregisterModalHook[\s\S]*?delete\(|this\._unregisterModalHook\s*=\s*null/.test(TASK_LIST),
  'destroy 必须调反注册函数并清引用，防止热重载 / 多实例化累加 hook'
);

// sidebar.js 注册 _abortAllSidebarDrags
expect(
  'sidebar.js 注册 _abortAllSidebarDrags 作为 modal 打开前 hook',
  /registerBeforeModalShow\(\(\)\s*=>\s*this\._abortAllSidebarDrags\(\)\)/.test(SIDEBAR),
  'sidebar.js 必须注册 hook 调 _abortAllSidebarDrags'
);

expect(
  'sidebar.js 在 destroy() 里注销 hook',
  /destroy\(\)\s*\{[\s\S]*?_unregisterModalHook[\s\S]*?delete\(|this\._unregisterModalHook\s*=\s*null/.test(SIDEBAR),
  'sidebar.destroy 必须注销 hook'
);

// ─────────────────────────────────────────────────────────────────────────────
// L4: _exitSelectionMode 立即同步 body data 属性
// ─────────────────────────────────────────────────────────────────────────────
section('L4: _exitSelectionMode 立即同步 body[data-selection-mode] = false');

const exitMatch = TASK_LIST.match(
  /_exitSelectionMode\(\{[\s\S]*?\}\s*=\s*\{\}\)\s*\{([\s\S]*?)\n  \}/
);

expect(
  '_exitSelectionMode 可被静态解析',
  !!exitMatch,
  '没找到 _exitSelectionMode 函数'
);

if (exitMatch) {
  const body = exitMatch[1];
  const setIdx = body.indexOf("document.body.dataset.selectionMode = 'false'");
  const renderIdx = body.indexOf('this.render();');

  expect(
    'body 里包含 body.dataset.selectionMode = "false" 同步赋值',
    setIdx >= 0,
    '必须在 render() 之前同步设 data 属性，杜绝中间态'
  );

  expect(
    'data 属性赋值在 render() 之前',
    setIdx >= 0 && renderIdx >= 0 && setIdx < renderIdx,
    `set 在 ${setIdx}，render 在 ${renderIdx} —— 必须前者在前`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// M1: render() 中 _commitActiveEdit 加 isConnected 守卫
// ─────────────────────────────────────────────────────────────────────────────
section('M1: render() 内 _commitActiveEdit 加 isConnected 守卫');

// 用括号计数法精确抓取 render() 函数体（不用 regex，避免复杂的非贪婪匹配）
{
  // 找第一个 `render() {`
  const start = TASK_LIST.search(/^\s*render\(\)\s*\{/m);
  expect(
    'render() 可被静态解析',
    start >= 0,
    '没找到 render() 方法'
  );

  if (start >= 0) {
    const openIdx = TASK_LIST.indexOf('{', start);
    let depth = 1, i = openIdx + 1;
    while (i < TASK_LIST.length && depth > 0) {
      const ch = TASK_LIST[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      i++;
    }
    const body = TASK_LIST.slice(openIdx + 1, i - 1);

    expect(
      'render() 用 isConnected 守卫 _commitActiveEdit',
      /_editInput[\s\S]{0,40}isConnected/.test(body) && /_commitActiveEdit\(\)/.test(body),
      '必须有 if (this._editInput && this._editInput.isConnected) this._commitActiveEdit();'
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 收口
// ─────────────────────────────────────────────────────────────────────────────
printSummary('check-second-pass-audit', true);