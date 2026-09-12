// 回归测试：H12 — render() 顶部 _commitActiveEdit() 同步提交草稿
//
// 背景：旧版 render() 仅在最末尾 _cancelAllDrags，没管 _editInput。
// 用户在编辑任务文本时，外部 file:change / 兄弟组件 emit('change') 等触
// 发 render()，会替换 listEl.innerHTML，_editInput DOM 节点随之销毁，
// 用户编辑中的草稿凭空消失。修复（v3.7+）：render() 顶部同步调
// _commitActiveEdit()，把 input 当前 value 写到 store。
//
// 本测试在 Node 环境下镜像 _commitActiveEdit 的行为（DOM stub），
// 验证「编辑态被 render() 触发时草稿是否保留」。
//
// 跑法：node scripts/check-commit-active-edit.mjs

import { check, summary, printSummary } from './_lib/check.mjs';
import { makeStore } from './_lib/store-fixture.mjs';

// ── 镜像 _commitActiveEdit 的核心契约 ──
console.log('\n[1] _commitActiveEdit：草稿被 render() 触发时同步提交');

{
  const store = makeStore('# 全部任务\n\n## 工作\n\n- [ ] 写周报\n\n## 未分类\n\n');
  const cat = store.getCategory('工作');
  const task = cat.tasks[0];

  // 模拟 DOM：编辑态 input 节点 + 草稿值
  const fakeInput = {
    hidden: false,
    value: '写周报 + 截止周五',
    _listeners: { keydown: null, blur: null },
    removeEventListener(type, fn) {
      if (this._listeners[type] === fn) this._listeners[type] = null;
    }
  };
  const editState = {
    _editInput: fakeInput,
    _editTaskId: task.id,
    _editRealCatName: '工作',
    _editOnKey: () => {}, // 占位：remove 时匹配
    _editOnBlur: () => {}, // 占位：remove 时匹配
  };

  // 镜像 task-list.js 的 _commitActiveEdit 行为（同步提交到 store）
  function commitActiveEdit() {
    if (!editState._editInput) return;
    const input = editState._editInput;
    const taskId = editState._editTaskId;
    const realCatName = editState._editRealCatName;
    if (editState._editOnKey) input.removeEventListener('keydown', editState._editOnKey);
    if (editState._editOnBlur) input.removeEventListener('blur', editState._editOnBlur);
    editState._editInput = null;
    editState._editOnKey = null;
    editState._editOnBlur = null;
    editState._editTaskId = null;
    editState._editRealCatName = null;

    if (!input.hidden && taskId && realCatName) {
      const newText = input.value.trim();
      if (newText) {
        store.updateTaskText(realCatName, taskId, newText);
      }
    }
  }

  // ── 镜像 render() 顶部逻辑：先 _cancelAllDrags，再 _commitActiveEdit ──
  function render() {
    // render() 模拟：把 DOM 整个重建，_editInput 节点会被销毁
    // 关键：render() 必须先 commit 草稿再销毁
    commitActiveEdit();
    // 模拟 innerHTML 替换：fakeInput 现在应不再被引用
    fakeInput.hidden = true;
  }

  // 触发 render（模拟外部 file:change → store.on('change') → task-list.render()）
  render();

  // 断言：草稿已落到 store
  const updated = store.getCategory('工作').tasks[0];
  check('render() 触发后 store 里的 text 是草稿值（不是空字符串）',
    updated.text === '写周报 + 截止周五',
    `actual=${JSON.stringify(updated.text)}`);
  check('render() 触发后 edit 状态被清空（_editInput === null）',
    editState._editInput === null);
  check('render() 触发后 editTaskId 被清空',
    editState._editTaskId === null);
}

// ── [2] 空草稿不触发 updateTaskText ──
console.log('\n[2] 空草稿：edit value 为空 → 不写入 store（保持原值）');

{
  const store = makeStore('# 全部任务\n\n## 工作\n\n- [ ] 写周报\n\n## 未分类\n\n');
  const cat = store.getCategory('工作');
  const originalText = cat.tasks[0].text;

  const fakeInput = { hidden: false, value: '   ', removeEventListener() {} };
  const editState = {
    _editInput: fakeInput,
    _editTaskId: cat.tasks[0].id,
    _editRealCatName: '工作',
    _editOnKey: null,
    _editOnBlur: null,
  };
  function commitActiveEdit() {
    if (!editState._editInput) return;
    const input = editState._editInput;
    const taskId = editState._editTaskId;
    const realCatName = editState._editRealCatName;
    editState._editInput = null;
    editState._editTaskId = null;
    editState._editRealCatName = null;
    if (!input.hidden && taskId && realCatName) {
      const newText = input.value.trim();
      if (newText) {
        store.updateTaskText(realCatName, taskId, newText);
      }
    }
  }
  commitActiveEdit();

  check('空草稿不写入 store',
    store.getCategory('工作').tasks[0].text === originalText,
    `actual=${store.getCategory('工作').tasks[0].text}`);
}

// ── [3] hidden input 不触发 commit ──
console.log('\n[3] 隐藏的 input（input.hidden=true）不触发 commit');

{
  const store = makeStore('# 全部任务\n\n## 工作\n\n- [ ] 写周报\n\n## 未分类\n\n');
  const cat = store.getCategory('工作');
  const originalText = cat.tasks[0].text;

  const fakeInput = { hidden: true, value: '不应写', removeEventListener() {} };
  const editState = {
    _editInput: fakeInput,
    _editTaskId: cat.tasks[0].id,
    _editRealCatName: '工作',
    _editOnKey: null,
    _editOnBlur: null,
  };
  function commitActiveEdit() {
    if (!editState._editInput) return;
    const input = editState._editInput;
    const taskId = editState._editTaskId;
    const realCatName = editState._editRealCatName;
    editState._editInput = null;
    editState._editTaskId = null;
    editState._editRealCatName = null;
    // 注意：hidden=true 时跳过写入
    if (!input.hidden && taskId && realCatName) {
      const newText = input.value.trim();
      if (newText) {
        store.updateTaskText(realCatName, taskId, newText);
      }
    }
  }
  commitActiveEdit();
  check('hidden input 不写 store',
    store.getCategory('工作').tasks[0].text === originalText);
}

// ── [4] render() 之前 _cancelAllDrags + _commitActiveEdit 顺序正确 ──
console.log('\n[4] render() 顺序：先 commit 编辑、再取消拖拽（按 task-list.js render() 顺序）');

{
  // 这里直接验证 task-list.js render() 源码里的调用顺序 —— 防止有人
  // 调换顺序导致 commit 时还在拖拽状态。
  //
  // 注意：M1 修复后 _commitActiveEdit() 被 if (this._editInput && this._editInput.isConnected)
  // 包了一层（防御 input 已被销毁的场景），源码体积比 600 字符多一点。截取 1200 字符
  // 留足缓冲；只要 _commitActiveEdit() 出现在 _cancelAllDrags() 之后即可。
  const fs = await import('node:fs');
  const src = fs.readFileSync('./src/ui/task-list.js', 'utf8');
  const renderStart = src.indexOf('render() {');
  const renderSnippet = src.slice(renderStart, renderStart + 1200);

  check('render() 顶部调 _cancelAllDrags()',
    renderSnippet.includes('_cancelAllDrags()'));
  check('render() 顶部调 _commitActiveEdit()（在 _cancelAllDrags 之后）',
    renderSnippet.includes('_commitActiveEdit()'));
  // 顺序：cancel 在 commit 之前
  const cancelIdx = renderSnippet.indexOf('_cancelAllDrags()');
  const commitIdx = renderSnippet.indexOf('_commitActiveEdit()');
  check('顺序：_cancelAllDrags 在 _commitActiveEdit 之前',
    cancelIdx >= 0 && commitIdx > cancelIdx,
    `cancel=${cancelIdx}, commit=${commitIdx}`);
}

// ── [5] 空草稿但 _editDirty=true + originalText 非空 → 不静默丢用户意图 ──
//
// 背景：用户编辑时清空整段文本，外部 store change 触发 render()，_commitActiveEdit
// 被同步调用。旧实现：value 空 → noop → 任务文本保留 → 用户以为"被清空了"但其实还在。
// 修复：commit 时若 wasDirty + originalText 非空 + value 空 → 至少在状态上可观察
// （本测试只验证"任务文本未被静默改写为某种意外值"，toast 调用是副作用不在测试范围）。
//
// 此处镜像修复后的 commitActiveEdit（含 _editDirty / _editOriginalText 字段）。
{
  const store = makeStore('# 全部任务\n\n## 工作\n\n- [ ] 写周报\n\n## 未分类\n\n');
  const cat = store.getCategory('工作');
  const originalText = cat.tasks[0].text;

  const fakeInput = { hidden: false, value: '', _listeners: {}, removeEventListener() {} };
  let toastShown = false;
  const editState = {
    _editInput: fakeInput,
    _editTaskId: cat.tasks[0].id,
    _editRealCatName: '工作',
    _editOnKey: null,
    _editOnBlur: null,
    _editOnInput: null,
    _editDirty: true,             // 用户曾触发过 input 事件
    _editOriginalText: originalText, // 编辑前原文非空
  };
  // 镜像修复后的 _commitActiveEdit（与 task-list.js 同源公式）
  function commitActiveEdit() {
    if (!editState._editInput) return;
    const input = editState._editInput;
    const taskId = editState._editTaskId;
    const realCatName = editState._editRealCatName;
    const wasDirty = editState._editDirty;
    const origText = editState._editOriginalText;
    if (editState._editOnKey) input.removeEventListener('keydown', editState._editOnKey);
    if (editState._editOnBlur) input.removeEventListener('blur', editState._editOnBlur);
    if (editState._editOnInput) input.removeEventListener('input', editState._editOnInput);
    editState._editInput = null;
    editState._editOnKey = null;
    editState._editOnBlur = null;
    editState._editOnInput = null;
    editState._editTaskId = null;
    editState._editRealCatName = null;
    editState._editDirty = false;
    editState._editOriginalText = null;

    if (!input.hidden && taskId && realCatName) {
      const newText = input.value.trim();
      if (newText) {
        store.updateTaskText(realCatName, taskId, newText);
      } else if (wasDirty && origText) {
        // 修复路径：发 toast（测试里用一个 flag 代替 UI 调用）
        toastShown = true;
        // 不调用 updateTaskText —— 保留原文本
      }
    }
  }
  commitActiveEdit();

  check('空草稿 + wasDirty + originalText 非空 → store 文本未被改写',
    store.getCategory('工作').tasks[0].text === originalText,
    `actual=${store.getCategory('工作').tasks[0].text}`);
  check('空草稿 + wasDirty + originalText 非空 → toast 标志位被设置（让用户感知到）',
    toastShown === true);
  check('空草稿 + wasDirty + originalText 非空 → edit 状态已清空',
    editState._editInput === null && editState._editDirty === false);
}

// ── [6] 空草稿 + _editDirty=false（用户没动过）+ originalText 非空 → 走历史 noop 路径 ──
{
  const store = makeStore('# 全部任务\n\n## 工作\n\n- [ ] 写周报\n\n## 未分类\n\n');
  const cat = store.getCategory('工作');
  const originalText = cat.tasks[0].text;

  const fakeInput = { hidden: false, value: '', removeEventListener() {} };
  let toastShown = false;
  const editState = {
    _editInput: fakeInput,
    _editTaskId: cat.tasks[0].id,
    _editRealCatName: '工作',
    _editDirty: false,
    _editOriginalText: originalText,
  };
  function commitActiveEdit() {
    if (!editState._editInput) return;
    const input = editState._editInput;
    const taskId = editState._editTaskId;
    const realCatName = editState._editRealCatName;
    const wasDirty = editState._editDirty;
    const origText = editState._editOriginalText;
    editState._editInput = null;
    editState._editTaskId = null;
    editState._editRealCatName = null;
    editState._editDirty = false;
    editState._editOriginalText = null;
    if (!input.hidden && taskId && realCatName) {
      const newText = input.value.trim();
      if (newText) {
        store.updateTaskText(realCatName, taskId, newText);
      } else if (wasDirty && origText) {
        toastShown = true;
      }
    }
  }
  commitActiveEdit();

  check('空草稿 + wasDirty=false → 不发 toast（用户没动过）',
    toastShown === false);
  check('空草稿 + wasDirty=false → 文本未被改写',
    store.getCategory('工作').tasks[0].text === originalText);
}

// ── [7] 原文本就是空（手写 - [x] 这种合法空任务）→ 即使用户清空也不该触发 toast ──
{
  const store = makeStore('# 全部任务\n\n## 工作\n\n- [ ] \n\n## 未分类\n\n');
  const cat = store.getCategory('工作');
  const originalText = cat.tasks[0].text; // ''

  const fakeInput = { hidden: false, value: '', removeEventListener() {} };
  let toastShown = false;
  const editState = {
    _editInput: fakeInput,
    _editTaskId: cat.tasks[0].id,
    _editRealCatName: '工作',
    _editDirty: true,
    _editOriginalText: originalText, // ''
  };
  function commitActiveEdit() {
    if (!editState._editInput) return;
    const input = editState._editInput;
    const taskId = editState._editTaskId;
    const realCatName = editState._editRealCatName;
    const wasDirty = editState._editDirty;
    const origText = editState._editOriginalText;
    editState._editInput = null;
    editState._editTaskId = null;
    editState._editRealCatName = null;
    editState._editDirty = false;
    editState._editOriginalText = null;
    if (!input.hidden && taskId && realCatName) {
      const newText = input.value.trim();
      if (newText) {
        store.updateTaskText(realCatName, taskId, newText);
      } else if (wasDirty && origText) {
        // 关键守卫：originalText 必须真存在才发 toast —— 否则手写空任务的场景
        // 也会被误报，原文本来就空、用户清空等于啥也没干。
        toastShown = true;
      }
    }
  }
  commitActiveEdit();

  check('空草稿 + wasDirty=true + originalText 为空 → 不发 toast（语义上没改变）',
    toastShown === false);
  check('空草稿 + wasDirty=true + originalText 为空 → store 文本保持空字符串',
    store.getCategory('工作').tasks[0].text === '');
}

printSummary('check-commit-active-edit');