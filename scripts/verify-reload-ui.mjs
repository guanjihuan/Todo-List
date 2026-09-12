// 模拟用户场景：外部修改 → resolveExternalChangeConflict → loadFromContent → UI 更新
//
// 真实测试：插入任务到「## 工作」分类下（保持子分类结构）

import { readFileSync } from 'node:fs';
import { parseMarkdown } from '../src/markdown-parser.js';
import { writeMarkdown } from '../src/markdown-writer.js';
import { pathsEqual } from '../src/utils/path.js';
import { findTodoFile } from './_lib/find-todo-path.mjs';
import { check, summary, printSummary } from './_lib/check.mjs';

class MockStore {
  constructor(initialContent, initialPath) {
    this.categories = parseMarkdown(initialContent);
    this.filePath = initialPath;
    this.selectedCategoryName = '工作';
    this.selectedSmartList = null;
    this.dirty = false;
    this._suppressDirty = false;
    this.events = [];
    this._listeners = {};
  }
  on(event, listener) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(listener);
    return () => { this._listeners[event] = this._listeners[event].filter(l => l !== listener); };
  }
  emit(event, ...args) {
    this.events.push({ event, args });
    (this._listeners[event] || []).forEach(l => l(...args));
  }
  serialize() { return writeMarkdown(this.categories); }
  cancelPendingSave() {}
  loadFromContent(content, filePath = null) {
    this._suppressDirty = true;
    try {
      const previousSelected = this.selectedCategoryName;
      const previousSmart = this.selectedSmartList;
      this.categories = parseMarkdown(content);
      this.filePath = filePath;
      const stillExists = previousSelected && this.categories.some(c => c.name === previousSelected);
      if (previousSmart) {
        this.selectedSmartList = previousSmart;
      } else if (stillExists) {
        this.selectedCategoryName = previousSelected;
        this.selectedSmartList = null;
      } else {
        this.selectedSmartList = 'current';
        this.selectedCategoryName = null;
      }
      this.dirty = false;
      this.emit('file-path', this.filePath);
      this.emit('load', { categories: this.categories });
      this.emit('change');
    } finally {
      this._suppressDirty = false;
    }
    this.emit('dirty', false);
  }
}

// 优先用用户的真实 todo.md 做端到端验证，缺文件则用内置样例
// 路径解析统一走 scripts/_lib/find-todo-path.mjs，避免硬编码用户路径
const found = findTodoFile();
const todoPath = found ? found.path : null;
const SAMPLE_MD = `# 全部任务

## 工作

- [ ] 工作任务 A
- [ ] 工作任务 B
- [✓] 已完成的工作任务

## 学习

- [ ] 学习任务 A
- [ ] 学习任务 B

## 未分类

- [ ] 未分类任务
`;
let original;
if (found) {
  original = found.content;
  console.log(`[verify-reload-ui] 使用用户文件 ${todoPath}（${original.length} 字符）`);
} else {
  original = SAMPLE_MD;
  console.log('[verify-reload-ui] 找不到用户 todo.md，回退到内置样例（不写回磁盘）');
}
// 统一占位路径：用户路径缺失时用一个固定的虚拟路径给 MockStore，
// 后续断言只用它做字符串比对（pathsEqual），具体值不影响测试语义
const mockFilePath = todoPath || `${process.platform === 'win32' ? 'C:\\TodoList' : '/tmp'}/todo.md`;

console.log('\n[场景 A] 在第一个子分类下追加任务（用户最常见的 VSCode 编辑场景）');

const store = new MockStore(original, mockFilePath);

// 选第一个「有任务」的子分类做目标（c.tasks 是数组，空数组也是 truthy，必须明确判 length）
let targetSub = store.categories.find(c =>
  c.kind === 'normal' && c.parentOtherTasks && c.tasks.length > 0);
let targetName = targetSub ? targetSub.name : '工作';
store.selectedCategoryName = targetName;

// 用户文件所有子分类都空时，「插入到目标段」毫无意义 —— 切回 SAMPLE_MD 跑。
// SAMPLE 里有「工作」「学习」「未分类」三个有任务的子分类，下面的段插入测试才有信号。
// 必须把 store 也用 SAMPLE_MD 重载 —— 不然 store.categories 还是用户文件的，目标段
// 名（如「工作」）在用户分类里根本不存在，find() 返回 undefined，后续断言全挂。
if (original !== SAMPLE_MD && !targetSub) {
  console.log('[setup] 用户文件没有含任务的子分类,切回 SAMPLE_MD 以保留测试信号');
  original = SAMPLE_MD;
  store.loadFromContent(original, mockFilePath);
  targetSub = store.categories.find(c =>
    c.kind === 'normal' && c.parentOtherTasks && c.tasks.length > 0);
  targetName = targetSub ? targetSub.name : '工作';
  store.selectedCategoryName = targetName;
}

// 找 targetName 这一 h2 段：起点 = `## {targetName}`，终点 = 下一个 `\n## ` 或 `\n# `
// （h2 之后的下一个 h1 也会终止本段；用户文件里学习子分类后是 `# 已完成任务`，必须兼容）
const targetHeaderIdx = original.indexOf(`## ${targetName}`);
if (targetHeaderIdx < 0) {
  console.log(`  ⚠️  找不到 ## ${targetName} 段，跳过场景 A`);
} else {
  const h2 = original.indexOf('\n## ', targetHeaderIdx);
  const h1 = original.indexOf('\n# ',  targetHeaderIdx);
  // 取最近的下个标题作为段落终点；都没有就贴文件尾 —— 必须落在目标段内
  let workInsertPoint;
  if (h2 > 0 && h1 > 0)      workInsertPoint = Math.min(h2, h1);
  else if (h2 > 0)           workInsertPoint = h2;
  else if (h1 > 0)           workInsertPoint = h1;
  else                       workInsertPoint = original.length;

  const modified = original.slice(0, workInsertPoint) +
                   `\n- [ ] 外部添加的新任务 A1\n` +
                   `- [✓] 外部添加的已完成 B2 [⭐]\n` +
                   original.slice(workInsertPoint);
  console.log(`原文件 ${original.length} 字符 → 修改后 ${modified.length} 字符（修改段：${targetName}）`);

  // 模拟主进程 IPC 发来的 changedPath（反斜杠）
  // mockFilePath 在 win32 上已用反斜杠；正反斜杠等价仍由 pathsEqual 覆盖
  const ipcChangedPath = mockFilePath.replace(/\//g, '\\');
  check('pathsEqual 通过（正反斜杠等价）', pathsEqual(ipcChangedPath, store.filePath));
  check('文件内容确实与内存不同', modified !== store.serialize());

  // 调用 loadFromContent
  const beforeWorkTasks = store.categories.find(c => c.name === targetName).tasks.length;
  store.loadFromContent(modified, ipcChangedPath);
  const afterWorkTasks = store.categories.find(c => c.name === targetName).tasks.length;

  console.log(`「${targetName}」任务数: ${beforeWorkTasks} → ${afterWorkTasks}`);
  check(`重载后「${targetName}」任务数增加`, afterWorkTasks === beforeWorkTasks + 2,
    `${beforeWorkTasks} → ${afterWorkTasks}`);
  const newWorkCat = store.categories.find(c => c.name === targetName);
  check(`重载后「${targetName}」包含 A1 任务`,
    newWorkCat.tasks.some(t => t.text === '外部添加的新任务 A1'));
  check(`重载后「${targetName}」包含 B2 任务`,
    newWorkCat.tasks.some(t => t.text === '外部添加的已完成 B2'));
  check('重载后 A1 是 pending',
    newWorkCat.tasks.find(t => t.text === '外部添加的新任务 A1')?.completed === false);
  check('重载后 B2 是 completed',
    newWorkCat.tasks.find(t => t.text === '外部添加的已完成 B2')?.completed === true);
  check('重载后 B2 是 important',
    newWorkCat.tasks.find(t => t.text === '外部添加的已完成 B2')?.important === true);
  check('change 事件触发', store.events.some(e => e.event === 'change'));
  check('load 事件触发', store.events.some(e => e.event === 'load'));
  check(`selectedCategoryName 保持「${targetName}」`, store.selectedCategoryName === targetName);
}

console.log('\n[场景 B] CRLF 行尾处理（VSCode Windows 默认保存 CRLF）');

const crlf = original.replace(/\n/g, '\r\n');
const storeB = new MockStore(original, mockFilePath);
{
  // 同样的「段终点」兜底 —— 必须落在目标段内，否则任务会跑到已完成/回收站去
  const targetHeaderIdxB = crlf.indexOf(`\r\n## ${targetName}`);
  let workInsertPointB;
  if (targetHeaderIdxB < 0) {
    workInsertPointB = crlf.length;
  } else {
    const h2b = crlf.indexOf('\r\n## ', targetHeaderIdxB + 2);
    const h1b = crlf.indexOf('\r\n# ',  targetHeaderIdxB + 2);
    if (h2b > 0 && h1b > 0)     workInsertPointB = Math.min(h2b, h1b);
    else if (h2b > 0)           workInsertPointB = h2b;
    else if (h1b > 0)           workInsertPointB = h1b;
    else                        workInsertPointB = crlf.length;
  }
  const modifiedB = crlf.slice(0, workInsertPointB) +
                    `\r\n- [ ] CRLF 测试任务\r\n` +
                    crlf.slice(workInsertPointB);

  const parsed = parseMarkdown(modifiedB).find(c => c.name === targetName);
  check(`parseMarkdown 容忍 CRLF（${targetName}）`,
    parsed && parsed.tasks.some(t => t.text === 'CRLF 测试任务'));
}

console.log('\n[场景 C] 选中分类被外部删除');

const storeC = new MockStore(original, mockFilePath);
storeC.selectedCategoryName = targetName;
// 删掉 `## ${targetName}` 整段：向后看必须兼顾下一个 h2 或下一个 h1
// （用户文件里最后一个子分类后可能直接接 # 已完成任务 / # 回收站，没有 `\n## ` 也得删干净）
// 同时必须删干净**所有同名 h2**（如 `## 未分类` 双写）—— 不然剩下那一份会
// 兜住 selectedCategoryName，让"分类被删回退到 current"的断言看起来没过，
// 但实际是产品行为正确：内存里那个分类没被真正删掉。
const escName = targetName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
let removedWork = original.replace(
  new RegExp('## ' + escName + '[\\s\\S]*?(?=\\n## |\\n# |$)', 'g'),
  ''
);
if (removedWork === original) {
  // 兜底：上面的正则在某些边界条件下没命中，改用 slice 整段切走。
  // 同样需要清掉所有同名 h2 —— 反复 slice 直到 indexOf 找不到为止。
  let working = original;
  let startIdx = working.indexOf('## ' + targetName);
  while (startIdx >= 0) {
    let endIdx = -1;
    const after = startIdx + ('## ' + targetName).length + 1;
    const nextH1 = working.indexOf('\n# ', after);
    const nextH2 = working.indexOf('\n## ', after);
    if (nextH1 > 0 && nextH2 > 0) endIdx = Math.min(nextH1, nextH2);
    else if (nextH1 > 0) endIdx = nextH1;
    else if (nextH2 > 0) endIdx = nextH2;
    else endIdx = working.length;
    working = working.slice(0, startIdx) + working.slice(endIdx);
    startIdx = working.indexOf('## ' + targetName);
  }
  removedWork = working;
}
storeC.loadFromContent(removedWork, mockFilePath);
check('分类被删后回退到 current 智能视图',
  storeC.selectedSmartList === 'current',
  `selectedSmartList=${storeC.selectedSmartList}, selectedCategoryName=${storeC.selectedCategoryName}`);
check('分类被删后 selectedCategoryName 清空',
  storeC.selectedCategoryName === null);

console.log(`\n通过 ${summary.pass} / 失败 ${summary.fail}`);
process.exit(summary.fail === 0 ? 0 : 1);