// 回归：拖拽任务刚结束立刻点击 checkbox / ⭐ / ▶ / 编辑 / 删除按钮应该生效，
// 而不是被静默吞掉（间歇性「按钮没反应」现象）。
//
// 历史 bug：
//   _dragJustEnded 标志位在 pointerup 后被设为 true，目的是吞掉浏览器随后派发
//   的合成 click/dblclick（避免在松手位置触发意外选择或编辑）。但标志位的「清
//   除」只发生在**非 wrapper 区**的 pointerdown 里 —— checkbox / ⭐ / ▶ / 编辑
//   / 删除按钮的 pointerdown 都被 early-return 挡在 wrapper 检查之后，标志位
//   永远没机会重置。结果：拖完任务再点这些按钮，点一次没反应（被吞），点第二
//   次（pointerdown 重置标志位）才生效。表现为「间歇性按钮无响应」。
//
// 修复：在 pointerdown handler 的最顶端无条件重置 _dragJustEnded；同时加一个
// 250ms 兜底定时器（防止任何未来代码路径让标志位永久卡住）。
//
// 测项：
//   1) pointerdown handler 在 wrapper early-return 之前无条件重置 _dragJustEnded
//   2) pointerup handler 在设置 _dragJustEnded = true 后再启一个兜底定时器
//   3) 兜底定时器有 clear 路径（destroy + 新一轮 pointerdown）
//   4) _setupDrag 初始化时声明 _dragJustEndedTimer 字段

import { readFileSync } from 'node:fs';
import { check, ok, bad, printSummary } from './_lib/check.mjs';

const SRC = readFileSync('src/ui/task-list.js', 'utf8');

let pass = 0, fail = 0;
function expect(name, cond, info) {
  if (cond) { ok(name); pass++; } else { bad(name, info); fail++; }
}

// ── 1. 核心修复点 ─────────────────────────────────────────────────────────
// pointerdown handler 最开始（任何 early-return 之前）必须无条件重置 _dragJustEnded。
// 用 [\s\S]{0,1500} 抓取整个 handler body，确保检测的是同一个 handler 内部的相对位置。
//
// 回归签名：
//   - 必须出现 `this._dragJustEnded = false;` 在 pointerdown handler 内部
//   - 该赋值必须早于 `.task-checkbox-wrapper` early-return
//   - 不能落在 early-return 之后

// 抓取 pointerdown handler 全部 body
const pointerDownMatch = SRC.match(
  /this\.listEl\.addEventListener\(['"]pointerdown['"],\s*\(e\)\s*=>\s*\{([\s\S]*?)\}\);/
);
expect(
  'pointerdown handler 可被静态解析',
  !!pointerDownMatch,
  '没找到 pointerdown handler'
);

if (pointerDownMatch) {
  const body = pointerDownMatch[1];
  const resetIdx = body.indexOf('this._dragJustEnded = false');
  const wrapperEarlyReturnIdx = body.indexOf('.task-checkbox-wrapper');
  const buttonEarlyReturnIdx = body.indexOf('.task-action-btn');

  expect(
    'pointerdown body 包含 `_dragJustEnded = false` 重置',
    resetIdx >= 0,
    '没找到 _dragJustEnded = false'
  );

  expect(
    'pointerdown body 包含 .task-checkbox-wrapper 早退分支',
    wrapperEarlyReturnIdx >= 0,
    '没找到 .task-checkbox-wrapper 早退'
  );

  expect(
    '_dragJustEnded 重置位于 wrapper 早退之前（防 wrapper-点击卡死）',
    resetIdx >= 0 && wrapperEarlyReturnIdx >= 0 && resetIdx < wrapperEarlyReturnIdx,
    `_dragJustEnded 重置在位置 ${resetIdx}，wrapper 早退在 ${wrapperEarlyReturnIdx} —— 必须前者在前`
  );

  // 关键：reset 必须在 button early-return 之前（按钮也是 wrapper 的一种）
  expect(
    '_dragJustEnded 重置位于 .task-action-btn 早退之前（防编辑/删除卡死）',
    resetIdx >= 0 && buttonEarlyReturnIdx >= 0 && resetIdx < buttonEarlyReturnIdx,
    `重置在 ${resetIdx}，action 早退在 ${buttonEarlyReturnIdx}`
  );
}

// ── 2. 兜底定时器 ─────────────────────────────────────────────────────────
// pointerup 在设 _dragJustEnded = true 之后必须再启一个 setTimeout 兜底。
// 250ms 上限：浏览器合成 click 一般 < 50ms，250ms 已是绝对够用的上限。
//
// 注意：pointerup handler 在源码里是命名函数 `const onPointerUp = (e) => { ... }`，
// 然后 document.addEventListener('pointerup', onPointerUp) 把它挂上去 ——
// 不是 inline arrow。所以匹配的是 const onPointerUp = ... 整段。

const onPointerUpMatch = SRC.match(
  /const\s+onPointerUp\s*=\s*\(e\)\s*=>\s*\{([\s\S]*?)\n\s{4}\};/
);
expect(
  'onPointerUp handler 可被静态解析',
  !!onPointerUpMatch,
  '没找到 onPointerUp 命名函数'
);

if (onPointerUpMatch) {
  const body = onPointerUpMatch[1];
  const setTrueIdx = body.indexOf('this._dragJustEnded = true');
  const timerIdx = body.search(/setTimeout\([\s\S]{0,200}?_dragJustEnded\s*=\s*false/);

  expect(
    'onPointerUp body 包含 `_dragJustEnded = true`',
    setTrueIdx >= 0,
    '没找到 _dragJustEnded = true'
  );

  expect(
    'onPointerUp body 包含 250ms 兜底 setTimeout 重置 _dragJustEnded',
    timerIdx >= 0,
    '没找到 setTimeout(() => { this._dragJustEnded = false }, ...) 兜底'
  );

  expect(
    '兜底 setTimeout 在 _dragJustEnded = true 之后',
    setTrueIdx >= 0 && timerIdx >= 0 && timerIdx > setTrueIdx,
    `setTimeout 在 ${timerIdx}，setTrue 在 ${setTrueIdx}`
  );
}

// ── 3. destroy 中清理定时器 ────────────────────────────────────────────────
const destroyMatch = SRC.match(/destroy\(\)\s*\{([\s\S]*?)\n  \}/);
expect(
  'destroy() 可被静态解析',
  !!destroyMatch,
  '没找到 destroy() 方法'
);

if (destroyMatch) {
  const body = destroyMatch[1];
  const clearsTimer = body.includes('_dragJustEndedTimer') &&
    body.includes('clearTimeout');
  expect(
    'destroy() 清理 _dragJustEndedTimer（防止组件销毁后定时器还在跑）',
    clearsTimer,
    'destroy() 里没有清理 _dragJustEndedTimer'
  );
}

// ── 4. _setupDrag 初始化时声明 _dragJustEndedTimer ─────────────────────────
const setupDragMatch = SRC.match(/_setupDrag\(\)\s*\{([\s\S]*?)\n  \}/);
expect(
  '_setupDrag() 可被静态解析',
  !!setupDragMatch,
  '没找到 _setupDrag() 方法'
);

if (setupDragMatch) {
  const body = setupDragMatch[1];
  // 期望在 _setupDrag 顶部声明 _dragJustEndedTimer = null（与 _dragJustEnded = false 同行/相邻）
  const declIdx = body.indexOf('this._dragJustEndedTimer');
  expect(
    '_setupDrag 内声明 _dragJustEndedTimer 字段',
    declIdx >= 0,
    '没找到 this._dragJustEndedTimer 初始化'
  );
}

// ── 5. 选择模式下 ⭐/▶ 真正使用 .task-readonly-indicator 类 ─────────────────
// 防止「CSS 定义了但 JS 永不应用」的死代码状态。
const renderStarMatch = SRC.match(/class="task-star-btn[^"]*"/);
const renderCurMatch = SRC.match(/class="task-current-btn[^"]*"/);

expect(
  '⭐ 按钮渲染带条件 class="task-readonly-indicator"',
  !!renderStarMatch && /task-readonly-indicator/.test(renderStarMatch[0]),
  'class="task-star-btn" 字符串里没有 task-readonly-indicator —— 选择模式下 CSS 仍是死代码'
);

expect(
  '▶ 按钮渲染带条件 class="task-readonly-indicator"',
  !!renderCurMatch && /task-readonly-indicator/.test(renderCurMatch[0]),
  'class="task-current-btn" 字符串里没有 task-readonly-indicator'
);

printSummary('check-click-after-drag', true);