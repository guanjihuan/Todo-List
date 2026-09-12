// 用最小 DOM mock 模拟 Sidebar + TaskList 在「外部修改 → loadFromContent」后的渲染行为
//
// 核心目的：捕获「change 事件触发后，listEl.innerHTML 是否真的反映了新 categories」

import { check, ok, bad, summary, printSummary } from './_lib/check.mjs';
import { makeStore } from './_lib/store-fixture.mjs';
import { readFileSync } from 'node:fs';
import { findTodoFile } from './_lib/find-todo-path.mjs';

// ====== Minimal DOM ======
class MiniElement {
  constructor(tag) {
    this.tagName = (tag || 'div').toUpperCase();
    this.children = [];
    this.parent = null;
    this._innerHTML = '';
    this._textContent = '';
    this.classList = {
      _classes: new Set(),
      add(c) { this._classes.add(c); },
      remove(c) { this._classes.delete(c); },
      toggle(c, force) {
        if (force === undefined) {
          if (this._classes.has(c)) this._classes.delete(c);
          else this._classes.add(c);
        } else if (force) this._classes.add(c);
        else this._classes.delete(c);
      },
      contains(c) { return this._classes.has(c); }
    };
    this.dataset = {};
    this.style = {};
    this.hidden = false;
    this.title = '';
    this.placeholder = '';
    this.disabled = false;
    this.value = '';
    this.checked = false;
    this.eventListeners = {};
    this._attrs = {};
  }
  setAttribute(k, v) { this._attrs[k] = v; }
  getAttribute(k) { return this._attrs[k]; }
  set innerHTML(html) {
    this._innerHTML = html;
    // 简单模拟：把 innerHTML 当作文本存储，统计 <li> 出现次数作为任务行数
    this._renderedHtml = html;
  }
  get innerHTML() { return this._innerHTML; }
  set textContent(t) { this._textContent = t; this._innerHTML = ''; }
  get textContent() { return this._textContent || ''; }
  appendChild(c) { this.children.push(c); c.parent = this; return c; }
  removeChild(c) { this.children = this.children.filter(x => x !== c); c.parent = null; }
  remove() { if (this.parent) this.parent.removeChild(this); }
  addEventListener(ev, fn) {
    (this.eventListeners[ev] = this.eventListeners[ev] || []).push(fn);
  }
  removeEventListener(ev, fn) {
    if (this.eventListeners[ev]) {
      this.eventListeners[ev] = this.eventListeners[ev].filter(f => f !== fn);
    }
  }
  closest(sel) {
    // 简化：返回自身（仅用于「找带 dataset.id 的元素」场景的兼容）
    return this;
  }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  setPointerCapture() {}
  releasePointerCapture() {}
  contains() { return false; }
  getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
  focus() {}
  click() {}
  blur() {}
  scrollIntoView() {}
}

// 注册 DOM 元素
const elements = {};
function makeEl(id, tag = 'div') {
  const el = new MiniElement(tag);
  el.id = id;
  elements[id] = el;
  return el;
}

const sidebar = makeEl('sidebar');
const categoryList = makeEl('category-list');
sidebar.appendChild(categoryList);
const ctxMenu = makeEl('category-context-menu');
sidebar.appendChild(ctxMenu);

const taskListEl = makeEl('task-list');
const titleEl = makeEl('category-title');
const titleProgressEl = makeEl('task-progress-text');
const inputEl = makeEl('task-input', 'input');
const submitBtn = makeEl('btn-submit-task', 'button');
const emptyEl = makeEl('empty-state');
const listEl = makeEl('task-list', 'ul');  // task-list 也是 ul（覆盖 taskListEl）
const filterBtn = makeEl('btn-filter', 'button');
const filterChipEl = makeEl('filter-chip');
const sortBtn = makeEl('btn-sort', 'button');
const sortChipEl = makeEl('sort-chip');
const importBtn = makeEl('btn-import', 'button');
const batchBtn = makeEl('btn-batch', 'button');
const chipText = makeEl('chip-text', 'span');
batchBtn.appendChild(chipText);
const statusMeta = makeEl('status-meta');
const statusText = makeEl('status-text');
const searchInput = makeEl('search-input', 'input');
const btnAddCategory = makeEl('btn-add-category', 'button');
const submitTaskBtn = submitBtn;
taskListEl.appendChild(titleEl);
taskListEl.appendChild(titleProgressEl);
taskListEl.appendChild(inputEl);
taskListEl.appendChild(submitBtn);
taskListEl.appendChild(emptyEl);
taskListEl.appendChild(listEl);
taskListEl.appendChild(filterBtn);
taskListEl.appendChild(sortBtn);
taskListEl.appendChild(importBtn);
taskListEl.appendChild(batchBtn);
taskListEl.appendChild(searchInput);
taskListEl.appendChild(btnAddCategory);

// document mock
globalThis.document = {
  getElementById: (id) => elements[id] || null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: () => {},
  removeEventListener: () => {},
  body: new MiniElement('body'),
  activeElement: null,
  createElement: (tag) => new MiniElement(tag),
  createDocumentFragment: () => new MiniElement('fragment'),
};
globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
globalThis.HTMLElement = MiniElement;
globalThis.Node = { ELEMENT_NODE: 1, TEXT_NODE: 3 };
globalThis.Event = class { constructor(type) { this.type = type; } };

// ====== 加载真实模块 ======
const { TaskStore, Filter, SortBy } = await import('../src/task-store.js');
const { Sidebar } = await import('../src/ui/sidebar.js');
const { TaskList } = await import('../src/ui/task-list.js');

// 优先用用户的真实 todo.md 做端到端验证，缺文件则用内置样例
// 路径解析统一走 scripts/_lib/find-todo-path.mjs —— 不能硬编码用户路径
const found = findTodoFile();
const userTodoPath = found ? found.path : null;
// v3.6 起 todo.md 不再含顶部「# 当前任务 / # 重要任务」镜像段：[▶]/[⭐] 标识直接
// 写在子分类里的源任务上即可，智能视图由 store 按标识聚合。
const SAMPLE_MD = `# 全部任务

## 工作打发打发的法大师傅

- [✓] [⭐] 通过 17 / 失败 0 (check-trash-fuzz)
- [ ] 通过 14 / 失败 0 (check-settings)
- [✓] 通过 15 / 失败 0 (check-status-met
- [✓] [▶] [⭐] 的28刚刚给烦烦烦
- [✓] [▶] [⭐] 2222111阿斯顿111
- [ ] [▶] [⭐] 通过 19 / 失败 0 (check-trash)1112222aaa撒旦发射点发

## 学习

- [✓] [▶] [⭐] 学习111111
- [✓] [⭐] 学习55

## 未分类

- [ ] 生活1

# 回收站

<!-- 在软件里删除的任务会移到这里，不会真的消失。软件不提供「清空回收站」，要彻底删除请直接删掉下面对应的行。 -->

- [✓] [▶] [⭐] 生活2
`;
let original, fwdPath;
if (found) {
  original = found.content;
  fwdPath = userTodoPath;
  console.log(`[check-render-flow] 使用用户文件 ${fwdPath}（${original.length} 字符）`);
} else {
  original = SAMPLE_MD;
  // 兜底路径 —— 跟用户路径一样参与 pathsEqual 等字符串比对，仅作为虚拟占位
  fwdPath = `${process.platform === 'win32' ? 'C:\\TodoList' : '/tmp'}/todo.md`;
  console.log('[check-render-flow] 找不到用户 todo.md，回退到内置样例（不写回磁盘）');
}

console.log('\n=== 完整流程：Sidebar + TaskList 订阅 change → 外部修改 → loadFromContent ===\n');

// 创建 store + 选一个有任务的子分类（兼容用户文件 + 内置样例）
// 不能硬取 [0] —— 用户可能把所有任务都从「未分类」清空了，导致初始任务数 = 0，
// 后续「初始渲染包含任务行」的断言无法成立。改取「第一个有任务的子分类」。
const store = new TaskStore();
store.loadFromContent(original, fwdPath);
// 优先选第一个有任务的子分类；若整个文件都没有子分类含任务，回退到第一个子分类
// （不是死路径 —— 子分类存在但空是合法状态，但「初始渲染包含任务行」断言依赖有任务可渲）。
let firstSub = store.getSubCategories().find(c => c.tasks.length > 0)
  || store.getSubCategories()[0];
if (!firstSub) throw new Error('未找到任何子分类');
// 用户文件里所有子分类都空（只有「未分类」「学习」空段 + 已完成任务真实分类）时，
// 后续断言「初始渲染包含任务行」永远过不去 —— 这种结构对侧边栏渲染测试不友好，
// 切回内置 SAMPLE_MD 跑 —— SAMPLE 里有「工作」「学习」「未分类」三个有任务的子分类。
// 注意：必须把 `original` 一起切到 SAMPLE_MD —— 下面的「模拟外部修改」用 original
// 找插入点；如果只切 store 不切 original，insertion 跑在用户文件上、load 进去
// 又是 SAMPLE 分类，initial 和 reloaded 两边来自不同文件，断言 +2 永远对不上。
// 也必须重新算 firstSub —— loadFromContent(SAMPLE) 会跑迁移，把「工作」清空、
// 「学习」变成首个有任务的子分类，旧的 firstSub ref 就废了。
if (original !== SAMPLE_MD && firstSub.tasks.length === 0) {
  console.log('[setup] 用户文件所有子分类都空,切回 SAMPLE_MD 以保留测试信号');
  original = SAMPLE_MD;
  store.loadFromContent(SAMPLE_MD, fwdPath);
  firstSub = store.getSubCategories().find(c => c.tasks.length > 0)
    || store.getSubCategories()[0];
}
if (!firstSub) throw new Error('未找到任何子分类');
store.selectCategory(firstSub.name);

const initial = store.getSelectedCategory();
if (!initial) throw new Error(`selectCategory(${firstSub.name}) 后 getSelectedCategory() 为 null`);
console.log(`初始: 「${initial.name}」任务数 = ${initial.tasks.length}`);

// 实例化 UI 组件（订阅 change 事件，触发初始 render）
const sidebarUI = new Sidebar(store);
const taskListUI = new TaskList(store);

const initHtml = listEl._renderedHtml || '';
const initTaskLines = (initHtml.match(/<li/g) || []).length;
console.log(`初始 TaskList 渲染任务行数: ${initTaskLines}`);
check('初始渲染包含任务行', initTaskLines > 0);

// 渲染层会在中西文边界插入空的 <span class="cjk-gap">（盘古之白，见
// check-cjk-autospace.mjs），所以混排任务文本在 HTML 里是被间隙元素切开的。
// 下面断言的是「任务文本有没有渲染出来」，不是 HTML 的字节形态 —— 先把间隙元素
// 抹掉再做子串匹配，否则这里会跟着排版逻辑一起假红。
const stripGaps = (h) => h.split('<span class="cjk-gap"></span>').join('');
// 用一段渲染层不会重排的标识串断言 —— 渲染层会把多空格压成单空格，
// 所以选不含连续空格的固定标识。「check-settings」是 SAMPLE_MD 工作分类里
// 仅有的两条 [ ] 待办之一，迁移完成后不会被搬到「# 已完成任务」，渲染层可见。
// 注意：不能用 `[✓]` 任务的标识（如 check-trash-fuzz）—— 迁移逻辑会把已
// 完成项从子分类搬到「# 已完成任务」，原位置就找不到这段文本了。
if (original === SAMPLE_MD) {
  check('初始渲染包含原始任务文本', stripGaps(initHtml).includes('check-settings'));
}

// 模拟外部修改：插入新任务 —— 用第一个真实子分类的位置（兼容用户文件 + 内置样例）
// 旧实现硬编码 `## 工作` 在用户机器上没有就直接挂；改用 firstSub.name 动态适配。
// v3.4：插入 [✓] 任务会触发「# 已完成任务」迁移，搬出当前子分类 —— 渲染流测试
// 不应耦合迁移逻辑，所以两条都插入 [ ]；[✓] 任务的搬迁路径在 check-trash 覆盖。
const h2Work = original.indexOf(`## ${firstSub.name}`);
// 段终点取「下一个 h2」或「下一个 h1」（哪个先到用哪个）——
// SAMPLE 里「未分类」是最后一个 h2，紧跟 `# 回收站`；只找 h2 会贴到 EOF，
// 新任务会被误归到回收站。verify-reload-ui.mjs 早就这么做了，这里补齐。
let insertPoint;
if (h2Work < 0) {
  insertPoint = original.length;
} else {
  const nextH2 = original.indexOf('\n## ', h2Work);
  const nextH1 = original.indexOf('\n# ',  h2Work);
  if (nextH2 > 0 && nextH1 > 0)      insertPoint = Math.min(nextH2, nextH1);
  else if (nextH2 > 0)               insertPoint = nextH2;
  else if (nextH1 > 0)               insertPoint = nextH1;
  else                               insertPoint = original.length;
}
const modified = original.slice(0, insertPoint) +
                 '\n- [ ] 外部添加的新任务A1\n' +
                 '- [ ] 外部添加的新任务B2 [⭐]\n' +
                 original.slice(insertPoint);

// 通过「外部修改检测路径」调用 loadFromContent
store.loadFromContent(modified, fwdPath);

const reloaded = store.getSelectedCategory();
console.log(`重载后: 「${reloaded.name}」任务数 = ${reloaded.tasks.length}`);

const reloadedHtml = listEl._renderedHtml || '';
const reloadedTaskLines = (reloadedHtml.match(/<li/g) || []).length;
console.log(`重载后 TaskList 渲染任务行数: ${reloadedTaskLines}`);

// 渲染层会在中西文边界插入空的 <span class="cjk-gap">（盘古之白，见
// check-cjk-autospace.mjs），所以「新任务A1」在 HTML 里是被间隙元素切开的。
// 断言的是「任务文本有没有渲染出来」，不是 HTML 的字节形态。
const reloadedText = stripGaps(reloadedHtml);

check('重载后 store 任务数增加',
  reloaded.tasks.length === initial.tasks.length + 2,
  `${initial.tasks.length} → ${reloaded.tasks.length}`);
check('重载后 DOM 包含 A1',
  reloadedText.includes('外部添加的新任务A1'),
  'A1 不在 listEl._renderedHtml 中');
check('重载后 DOM 包含 B2',
  reloadedText.includes('外部添加的新任务B2'),
  'B2 不在 listEl._renderedHtml 中');
check('重载后 DOM 行数增加',
  reloadedTaskLines > initTaskLines,
  `${initTaskLines} → ${reloadedTaskLines}`);

// ====== Sidebar 也要更新 ======
const sidebarHtml = categoryList._renderedHtml || '';
console.log(`\n Sidebar 渲染 HTML 长度: ${sidebarHtml.length}`);
// 检查 sidebar 是否包含第一个子分类 —— 用 firstSub.name 而不是硬编码「工作」，
// 让测试在用户机器上也能跑（用户的子分类名不一定是「工作」）。
const hasSubcategory = sidebarHtml.includes('subcategory') && sidebarHtml.includes(firstSub.name);
check(`Sidebar 渲染包含「${firstSub.name}」子分类`, hasSubcategory);
// 「学习」是 SAMPLE_MD 里的固定名 —— 仅在用样例时校验
if (original === SAMPLE_MD) {
  check('Sidebar 渲染包含「学习」子分类', sidebarHtml.includes('学习'));
}
check('Sidebar 渲染包含智能列表', sidebarHtml.includes('当前任务') && sidebarHtml.includes('重要任务'));

// ====== 关键检查：listEl.innerHTML 的实际值 ======
console.log('\n实际 listEl.innerHTML:');
console.log(reloadedHtml.slice(0, 500));

console.log(`\n通过 ${summary.pass} / 失败 ${summary.fail}`);
process.exit(summary.fail === 0 ? 0 : 1);