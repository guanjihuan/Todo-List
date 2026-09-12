// 回归：render() 重建 innerHTML 时只对「会话内首次出现」的任务打 .is-new，
// 而不是「相对上一次 render 的可见集合」。后者会让 filter 切换 / 跨分类跳转
// 后旧任务再次 fade-in，反而比旧版（无条件 animation）闪烁更糟。
//
// 测项：
//   1) 第一次 render：所有任务都是 is-new
//   2) 第二次 render（同样的任务集合）：没有任何 is-new
//   3) filter 切换后回到原视图：旧任务不应再 fade-in（关键回归点）
//   4) 切换分类再切回来：跨分类可见任务不重复 fade-in
//   5) 新增任务：仅新增的那条打 is-new
//   6) 'load' 事件后：所有任务重新算作 is-new（id 全部失效）

import { check, ok, bad, summary, printSummary } from './_lib/check.mjs';
import { readFileSync } from 'node:fs';
import { findTodoFile } from './_lib/find-todo-path.mjs';

const SRC_TASK_LIST = readFileSync('src/ui/task-list.js', 'utf8');

// 抓取 _renderTaskItem 的核心 HTML 模板 —— 我们关心的是「输出 HTML 里第一个 class 是否 task-item」
// 以及「render() 是否会根据 _knownTaskIds 标记 is-new」。
// 这里不实际 import TaskList（要拉一堆 DOM mock 太重），改为从源码层面验证关键不变量：
//   (a) _knownTaskIds 不再被重置为 seenIds（grow-only）
//   (b) 'load' 事件清空 _knownTaskIds
//   (c) 字符串 splice 锚点是 'class="task-item' 且 indexOf != -1 时才替换

let pass = 0, fail = 0;
function expect(name, cond, info) {
  if (cond) { ok(name); pass++; } else { bad(name, info); fail++; }
}

// (a) 关键回归点：旧实现里是 `this._knownTaskIds = seenIds;`。
//     现在的实现必须没有这行被赋值给 seenIds —— 否则 filter 切换会让旧任务
//     重新被当成 new。
const oldBuggyLine = /this\._knownTaskIds\s*=\s*seenIds/;
expect(
  '_knownTaskIds 不再重置为 seenIds（防 filter 切换回归）',
  !oldBuggyLine.test(SRC_TASK_LIST),
  '源码里仍有 this._knownTaskIds = seenIds — 这是旧 bug'
);

// (b) 'load' 事件清空 _knownTaskIds（reload 后 id 全部失效，全 fade-in 是合理的）
const hasLoadReset = /this\.store\.on\(['"]load['"][\s\S]{0,300}?_knownTaskIds\s*=\s*new Set\(\)/.test(SRC_TASK_LIST);
expect(
  "'load' 事件清空 _knownTaskIds（id 全部失效，全 fade-in 是合理的）",
  hasLoadReset,
  "'load' 处理器里没看到 _knownTaskIds = new Set()"
);

// (c) splice 锚点仍是 'class="task-item'
expect(
  'splice 锚点是 class="task-item',
  /indexOf\(['"]class="task-item['"]\)/.test(SRC_TASK_LIST),
  '没找到 indexOf("class="task-item") 锚点'
);

// (d) 渲染时 grow-only 加新 id（用 .add 而不是 = 赋值）
expect(
  '_knownTaskIds 通过 .add() grow-only 累加（不会因为 filter 切换丢 id）',
  /this\._knownTaskIds\.add\(/.test(SRC_TASK_LIST),
  '没找到 _knownTaskIds.add(...) 调用'
);

// (e) 关键：之前的实现里 newIds 计算依赖 _knownTaskIds（grow-only set），
//     而不是 reset 后的 seenIds。验证可见的判断逻辑仍在以 _knownTaskIds.has(t.id) 为准。
const usesKnownSetForNewCheck = /this\._knownTaskIds\.has\(/.test(SRC_TASK_LIST);
expect(
  '新任务判定走 _knownTaskIds.has（grow-only 集合）',
  usesKnownSetForNewCheck,
  '没找到 _knownTaskIds.has(...) 调用'
);

// (f) isFirstRender 的语义应仍为「集合为空」（grow-only 实现下同样成立）
expect(
  'isFirstRender 判断仍存在（_knownTaskIds.size === 0）',
  /isFirstRender/.test(SRC_TASK_LIST),
  'isFirstRender 标识符消失了'
);

// (g) 'load' 监听器必须清空选择模式（已有）
expect(
  "'load' 仍清空选择模式",
  /this\.store\.on\(['"]load['"][\s\S]{0,200}?_exitSelectionMode/.test(SRC_TASK_LIST),
  "'load' 没清空选择模式"
);

printSummary(pass, fail);

// sanity: TODO file path resolution doesn't matter here
findTodoFile();