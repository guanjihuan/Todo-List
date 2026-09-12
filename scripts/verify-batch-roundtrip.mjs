// 验证「已完成任务」+「回收站」批量操作的真实数据流：
//   1) 已完成视图：批量「取消完成」→ 任务按 originalCategory 归位，completed=false
//   2) 回收站视图：批量「恢复到分类…」选 工作 → uncompleted 任务回到「工作」
//   3) 回收站视图：批量恢复 → completed 任务被硬路由到「已完成任务」
//   4) 回收站视图：批量「标重要」→ 任务的 [⭐] 标记写入
//
// 用 Playwright 跑真实浏览器。stub window.api，捕获 writeFile 调用，读回 markdown 反序列化校验。

import { chromium } from 'playwright-core';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const BASE = 'http://127.0.0.1:8765';
const tmpDir = mkdtempSync(join(tmpdir(), 'batch-rt-test-'));

// 简化版解析器 —— 复刻 src/markdown-parser.js 的核心规则
// 支持 [⭐]/[▶] 在行首或行尾，[原分类：xxx] 始终在行尾
function parseMd(md) {
  const lines = md.split('\n');
  const result = { cats: [], trash: [], completed: [] };
  let currentCat = null;
  let mode = 'normal'; // 'normal' | 'completed' | 'trash'
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('# ')) {
      const title = line.slice(2).trim();
      if (title === '回收站') {
        mode = 'trash';
        currentCat = null;
      } else if (title === '已完成任务') {
        mode = 'completed';
        currentCat = null;
      } else {
        // 容器或镜像段都忽略
        mode = 'normal';
        currentCat = null;
      }
      continue;
    }
    if (line.startsWith('## ')) {
      const name = line.slice(3).trim();
      currentCat = { name, tasks: [] };
      mode = 'normal';
      result.cats.push(currentCat);
      continue;
    }
    const m = line.match(/^-\s+\[([ xX✓])\]\s*(.*)$/);
    if (!m) continue;
    const completed = m[1] === 'x' || m[1] === 'X' || m[1] === '✓';
    let text = m[2];

    // 抽 [原分类：xxx] —— 始终在行尾
    let originalCategory = null;
    const origMatch = text.match(/\[原分类：([^\]]+)\]/);
    if (origMatch) {
      originalCategory = origMatch[1];
      text = text.replace(/\[原分类：[^\]]+\]/g, '').trim();
    }

    // 行首 [⭐] / [▶]
    let headImportant = false, headCurrent = false;
    const headImp = text.match(/^\[⭐\]\s*/);
    if (headImp) { headImportant = true; text = text.slice(headImp[0].length); }
    const headCur = text.match(/^\[▶\]\s*/);
    if (headCur) { headCurrent = true; text = text.slice(headCur[0].length); }

    // 行尾 [⭐] / [▶]
    const tailImp = text.match(/\[⭐\]$/);
    if (tailImp) { headImportant = true; text = text.slice(0, text.length - tailImp[0].length).trim(); }
    const tailCur = text.match(/\[▶\]$/);
    if (tailCur) { headCurrent = true; text = text.slice(0, text.length - tailCur[0].length).trim(); }

    const task = {
      text: text.trim(),
      completed,
      important: headImportant,
      current: headCurrent,
      originalCategory
    };
    if (mode === 'trash') {
      result.trash.push(task);
    } else if (mode === 'completed') {
      result.completed.push(task);
    } else if (currentCat) {
      currentCat.tasks.push(task);
    }
  }
  return result;
}

function findTask(arr, predicate) {
  return arr.find(predicate);
}

// 文档：1 个完成的任务来自工作 + 1 个删到回收站 + 1 个删且完成的
const DOC = [
  '# 当前任务', '',
  '# 全部任务', '',
  '## 工作', '',
  '- [ ] 工作任务 A', '',
  '## 学习', '',
  '- [ ] 学习任务 A', '',
  '# 已完成任务', '',
  '- [✓] 工作任务 A', '',
  '# 回收站', '',
  '- [ ] 删除的 A', '',
  '- [✓] 已删且已完成的', ''
].join('\n');

async function setupStub(page, md) {
  // 注意：addInitScript 会在每次 reload 时重新执行（闭包 md 会被覆盖回原值）。
  // 所以「换 doc 后再 reload」必须重新调 setupStub(newDoc)，否则 reload 会把
  // window.__todoMd 重置回原 DOC —— 看起来测试通过了其实是测了不同的 doc。
  await page.addInitScript((md) => {
    const noop = () => {};
    const noopUnsub = () => noop;
    window.__writes = [];
    window.__todoMd = md;
    window.api = {
      isDev: false,
      saveFileDialog: async () => null,
      readFile: async () => ({ ok: true, content: window.__todoMd }),
      writeFile: async (path, content) => {
        // 捕获写入：每次 store flush 都会调一次，把最新内容记下来
        window.__writes.push({ path, content });
        return { ok: true };
      },
      fileExists: async () => true,
      createFileIfMissing: async () => ({ ok: true }),
      createSnapshot: async () => ({ ok: true }),
      getDataDir: async () => '/tmp',
      getDefaultDataDir: async () => '/tmp',
      getHomeDir: async () => '/tmp',
      getVersion: async () => '0.0.0-test',
      getElectronVersion: async () => '0.0.0-test',
      openDataDir: async () => true,
      getSettings: async () => ({}),
      saveSettings: async () => true,
      chooseDataDir: async () => null,
      notifyDirtyChanged: noop,
      notifyFlushDone: noop,
      onFlushPendingSave: noopUnsub,
      onMenuCommand: noopUnsub,
      onFileExternalChange: noopUnsub,
      setAlwaysOnTop: async () => true,
      onAlwaysOnTopChanged: noopUnsub,
      minimizeWindow: async () => true,
      toggleMaximizeWindow: async () => false,
      closeWindow: async () => true,
      onMaximizeStateChanged: noopUnsub
    };
  }, md);
}

async function clickSidebarCategory(page, categoryName) {
  const result = await page.evaluate((name) => {
    const items = document.querySelectorAll('.category-item');
    for (const el of items) {
      if (el.textContent.trim().startsWith(name)) {
        el.click();
        return true;
      }
    }
    return false;
  }, categoryName);
  if (!result) throw new Error(`未找到 sidebar 分类：${categoryName}`);
  await page.waitForTimeout(300);
}

async function getMd(page) {
  return await page.evaluate(() => {
    // 找到最近一次写入
    const writes = window.__writes || [];
    return writes.length > 0 ? writes[writes.length - 1].content : null;
  });
}

async function triggerBatch(page, action, opts = {}) {
  // 进批量模式 + 选第一条 + 点对应按钮
  await page.evaluate(() => {
    const btn = document.querySelector('#btn-batch');
    if (btn && !btn.hidden) btn.click();
  });
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    const item = document.querySelector('.task-item');
    if (item) item.click();
  });
  await page.waitForTimeout(150);

  if (action === 'complete') {
    // 直接点完成/取消完成按钮
    await page.evaluate(() => {
      const btn = document.querySelector('.batch-action[data-action="complete"]');
      if (btn) btn.click();
    });
  } else if (action === 'important-set') {
    await page.evaluate(() => {
      const btn = document.querySelector('.batch-action[data-action="important-set"]');
      if (btn) btn.click();
    });
  } else if (action === 'restore') {
    // 点「恢复到分类…」→ 弹菜单 → 点目标
    await page.evaluate(() => {
      const btn = document.querySelector('.batch-action[data-action="move"]');
      if (btn) btn.click();
    });
    await page.waitForTimeout(300);
    await page.evaluate((target) => {
      const items = document.querySelectorAll('#context-menu .context-menu-item');
      for (const el of items) {
        const actionAttr = el.dataset.action || '';
        if (actionAttr === `batch-move:${target}`) {
          el.click();
          return true;
        }
      }
      return false;
    }, opts.target);
  }
  await page.waitForTimeout(400);
}

async function clearWrites(page) {
  await page.evaluate(() => {
    window.__writes = [];
  });
}

async function getTaskCount(page) {
  return await page.evaluate(() => {
    return document.querySelectorAll('.task-item').length;
  });
}

function check(name, cond, info) {
  const tag = cond ? '✓' : '✗';
  console.log(`${tag} ${name}${info ? ` (${info})` : ''}`);
  return cond;
}

let pass = 0, fail = 0;

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1024, height: 768 } });
const page = await context.newPage();

const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (msg) => {
  const t = msg.type();
  if (t === 'error') errors.push(`console.error: ${msg.text()}`);
});

await setupStub(page, DOC);
await page.goto(BASE + '/index.html');
await page.waitForLoadState('domcontentloaded');
await page.waitForTimeout(800);

if (!(await page.evaluate(() => !!document.getElementById('app')))) {
  await browser.close();
  throw new Error('app 未渲染');
}

console.log('\n========== 场景 1：已完成视图批量「取消完成」 ==========');
{
  await clickSidebarCategory(page, '已完成任务');
  // 已完成任务视图下应有 1 条
  const initialCount = await getTaskCount(page);
  if (check('已完成任务视图渲染 1 条任务', initialCount === 1, `actual=${initialCount}`)) pass++; else fail++;

  // batch 按钮可见
  const batchVisible = await page.evaluate(() => !document.querySelector('#btn-batch').hidden);
  if (check('batch 按钮可见', batchVisible)) pass++; else fail++;

  await clearWrites(page);
  await triggerBatch(page, 'complete');

  const md = await getMd(page);
  if (check('批量「取消完成」后产生 writeFile 调用', md !== null)) pass++; else fail++;

  if (md) {
    const parsed = parseMd(md);
    const workCat = parsed.cats.find(c => c.name === '工作');
    if (check('「工作」分类存在', !!workCat)) pass++; else fail++;
    if (check('「工作」里有 1 条任务（原 A 已回来）',
      workCat && workCat.tasks.length === 1,
      `tasks=${JSON.stringify(workCat?.tasks)}`)) pass++; else fail++;
    if (check('回来的任务 completed=false',
      workCat && workCat.tasks[0] && workCat.tasks[0].completed === false,
      JSON.stringify(workCat?.tasks[0]))) pass++; else fail++;
    if (check('已完成任务分类为空',
      parsed.completed.length === 0,
      `completed=${JSON.stringify(parsed.completed)}`)) pass++; else fail++;
  }
}

console.log('\n========== 场景 2：回收站批量恢复（未完成） ==========');
{
  await clickSidebarCategory(page, '回收站');
  const initialCount = await getTaskCount(page);
  if (check('回收站视图渲染 2 条任务', initialCount === 2, `actual=${initialCount}`)) pass++; else fail++;

  // 选第一条（未完成的「删除的 A」）→ 恢复到「工作」
  // 先选中第一条再恢复
  await clearWrites(page);

  await page.evaluate(() => {
    const btn = document.querySelector('#btn-batch');
    if (btn && !btn.hidden) btn.click();
  });
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    const items = document.querySelectorAll('.task-item');
    // 选第一条（未完成的）
    if (items.length > 0) items[0].click();
  });
  await page.waitForTimeout(150);
  // 点「恢复到分类…」
  await page.evaluate(() => {
    const btn = document.querySelector('.batch-action[data-action="move"]');
    if (btn) btn.click();
  });
  await page.waitForTimeout(300);
  // 点「工作」目标
  await page.evaluate(() => {
    const items = document.querySelectorAll('#context-menu .context-menu-item');
    for (const el of items) {
      const a = el.dataset.action || '';
      if (a === 'batch-move:工作') {
        el.click();
        return true;
      }
    }
    return false;
  });
  await page.waitForTimeout(400);

  const md = await getMd(page);
  if (check('批量恢复后产生 writeFile 调用', md !== null)) pass++; else fail++;

  if (md) {
    const parsed = parseMd(md);
    const workCat = parsed.cats.find(c => c.name === '工作');
    if (check('「工作」分类存在', !!workCat)) pass++; else fail++;
    // 工作原本有 A，加上恢复回来的「删除的 A」= 2 条
    if (check('「工作」里有 2 条任务（原 A + 恢复的 删除的 A）',
      workCat && workCat.tasks.length === 2,
      `tasks=${JSON.stringify(workCat?.tasks?.map(t => t.text))}`)) pass++; else fail++;
    const restoredTask = workCat && workCat.tasks.find(t => t.text === '删除的 A');
    if (check('恢复回来的「删除的 A」completed=false',
      restoredTask && restoredTask.completed === false,
      JSON.stringify(restoredTask))) pass++; else fail++;
    if (check('回收站还剩 1 条（已删且完成的）',
      parsed.trash.length === 1,
      `trash=${JSON.stringify(parsed.trash?.map(t => t.text))}`)) pass++; else fail++;
  }
}

console.log('\n========== 场景 3：回收站批量恢复（completed → 已完成任务硬路由） ==========');
{
  // 现在回收站里还剩 1 条「已删且已完成的」
  // 选中这条 → 恢复到「工作」→ 应该被硬路由到「已完成任务」
  // 重要：先确保退出场景 2 残留的 selectionMode（_afterBatchComplete 不退批量）
  // 否则点 batch 按钮会变「退出」语义，菜单根本打不开。
  await page.evaluate(() => {
    if (document.body.dataset.selectionMode === 'true') {
      // 模拟 Esc 退出批量模式
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    }
  });
  await page.waitForTimeout(150);

  await clickSidebarCategory(page, '回收站');
  await clearWrites(page);

  await page.evaluate(() => {
    const btn = document.querySelector('#btn-batch');
    if (btn && !btn.hidden) btn.click();
  });
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    const items = document.querySelectorAll('.task-item');
    // 选第一条（即「已删且已完成的」）
    if (items.length > 0) items[0].click();
  });
  await page.waitForTimeout(150);
  await page.evaluate(() => {
    const btn = document.querySelector('.batch-action[data-action="move"]');
    if (btn) btn.click();
  });
  await page.waitForTimeout(300);
  // 候选列表里不应包含「已完成任务」（已被排除）
  // 但可以选「学习」（仍然是普通分类）
  const moveOptions = await page.evaluate(() => {
    const items = document.querySelectorAll('#context-menu .context-menu-item');
    const opts = [];
    for (const el of items) {
      const a = el.dataset.action || '';
      if (a.startsWith('batch-move:')) opts.push(a.slice(11));
    }
    return opts;
  });
  if (check('回收站恢复菜单不含「已完成任务」',
    !moveOptions.includes('已完成任务'),
    `opts=${JSON.stringify(moveOptions)}`)) pass++; else fail++;
  if (check('回收站恢复菜单不含「回收站」',
    !moveOptions.includes('回收站'),
    `opts=${JSON.stringify(moveOptions)}`)) pass++; else fail++;
  if (check('回收站恢复菜单不含「全部任务」',
    !moveOptions.includes('全部任务'),
    `opts=${JSON.stringify(moveOptions)}`)) pass++; else fail++;

  // 关键：必须在 menu 还开着时立刻点击学习 —— 把「点学习」放紧跟着 move button click，
  // 不穿插任何 page.evaluate，避免异步间隙里 store change 触发 render 把菜单关掉。
  const learnResult = await page.evaluate(async () => {
    const items = document.querySelectorAll('#context-menu .context-menu-item');
    let clicked = false;
    for (const el of items) {
      if (el.dataset.action === 'batch-move:学习') {
        el.click();
        clicked = true;
        break;
      }
    }
    await new Promise(r => setTimeout(r, 500));
    return { clicked, writeCount: window.__writes.length };
  });
  if (!learnResult.clicked) {
    throw new Error('场景 3：找不到 batch-move:学习 菜单项，菜单状态异常');
  }

  const md = await getMd(page);
  if (check('completed 任务恢复后产生 writeFile', md !== null)) pass++; else fail++;

  if (md) {
    const parsed = parseMd(md);
    // completed 任务不应去「学习」，应去「已完成任务」
    const studyCat = parsed.cats.find(c => c.name === '学习');
    const restoredInStudy = studyCat?.tasks?.find(t => t.text === '已删且已完成的');
    if (check('completed 任务不在「学习」（未被改投成功）',
      !restoredInStudy,
      `study=${JSON.stringify(studyCat?.tasks)}`)) pass++; else fail++;

    // 应在「已完成任务」分类里
    const inCompleted = parsed.completed.find(t => t.text === '已删且已完成的');
    if (check('completed 任务被硬路由到「已完成任务」',
      !!inCompleted,
      `completed=${JSON.stringify(parsed.completed.map(t => t.text))}`)) pass++; else fail++;
    if (check('硬路由后任务仍带 completed=true',
      inCompleted && inCompleted.completed === true)) pass++; else fail++;

    // 回收站应为空
    if (check('回收站为空',
      parsed.trash.length === 0,
      `trash=${JSON.stringify(parsed.trash)}`)) pass++; else fail++;
  }
}

console.log('\n========== 场景 4：回收站批量「标重要」→ [⭐] 写入 ==========');
{
  // 重新加载初始文档 —— 必须重新调 setupStub(DOC)，addInitScript 在 reload 时
  // 会用闭包里的 DOC 覆盖 window.__todoMd
  await setupStub(page, DOC);
  await page.evaluate(() => { window.__writes = []; });
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(800);

  if (!(await page.evaluate(() => !!document.getElementById('app')))) {
    await browser.close();
    throw new Error('reload 后 app 未渲染');
  }

  await clickSidebarCategory(page, '回收站');
  await clearWrites(page);

  // 进批量模式，选全部 2 条，标重要
  await page.evaluate(() => {
    const btn = document.querySelector('#btn-batch');
    if (btn && !btn.hidden) btn.click();
  });
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    // 全选
    // 找全选按钮（如果有），否则一条一条点
    const allBtn = document.querySelector('.batch-select-all');
    if (allBtn) {
      allBtn.click();
    } else {
      const items = document.querySelectorAll('.task-item');
      for (const it of items) it.click();
    }
  });
  await page.waitForTimeout(150);
  await page.evaluate(() => {
    const btn = document.querySelector('.batch-action[data-action="important-set"]');
    if (btn) btn.click();
  });
  await page.waitForTimeout(400);

  const md = await getMd(page);
  if (check('回收站批量标重要产生 writeFile', md !== null)) pass++; else fail++;

  if (md) {
    const parsed = parseMd(md);
    const allTrashImportant = parsed.trash.length > 0 && parsed.trash.every(t => t.important);
    if (check('回收站里 2 条任务都带 important=true',
      allTrashImportant,
      `trash=${JSON.stringify(parsed.trash.map(t => ({ text: t.text, imp: t.important })))}`)) pass++; else fail++;
    // 回收站段应包含 [⭐]
    if (check('回收站段 markdown 含 [⭐] 标记', /\[⭐\]/.test(md))) pass++; else fail++;
  }
}

console.log('\n========== 场景 5：切分类自动退出批量模式（不残留） ==========');
{
  // 再次 reload 回到初始文档
  await setupStub(page, DOC);
  await page.evaluate(() => { window.__writes = []; });
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(800);

  if (!(await page.evaluate(() => !!document.getElementById('app')))) {
    await browser.close();
    throw new Error('reload 后 app 未渲染');
  }

  await clickSidebarCategory(page, '已完成任务');
  // 进批量模式
  await page.evaluate(() => {
    const btn = document.querySelector('#btn-batch');
    if (btn && !btn.hidden) btn.click();
  });
  await page.waitForTimeout(200);
  const inSelectionBefore = await page.evaluate(() => document.body.dataset.selectionMode === 'true');
  if (check('切到 已完成 视图后进入批量模式', inSelectionBefore)) pass++; else fail++;

  // 切到「工作」分类（普通子分类）
  await clickSidebarCategory(page, '工作');
  const inSelectionAfter = await page.evaluate(() => document.body.dataset.selectionMode === 'true');
  if (check('切到「工作」后批量模式自动退出', !inSelectionAfter)) pass++; else fail++;
  const batchBarAfter = await page.evaluate(() => {
    const bar = document.querySelector('.batch-action-bar');
    return !bar || bar.hidden === true;
  });
  if (check('切分类后 batch 浮栏已隐藏', batchBarAfter)) pass++; else fail++;

  // 切回「已完成任务」应能重新进入批量模式
  await clickSidebarCategory(page, '已完成任务');
  const batchVisibleAgain = await page.evaluate(() => !document.querySelector('#btn-batch').hidden);
  if (check('重新进入 已完成 视图后 batch 按钮仍可见', batchVisibleAgain)) pass++; else fail++;
}

console.log('\n========== 场景 6：空视图下 batch 按钮隐藏 ==========');
{
  // 文档里把已完成任务和回收站都清空
  const emptyDoc = [
    '# 当前任务', '',
    '# 全部任务', '',
    '## 工作', '',
    '- [ ] 工作任务 A', '',
    '# 已完成任务', '',
    '# 回收站', ''
  ].join('\n');

  // 重新 setupStub 用空 doc —— 见 setupStub 注释（addInitScript 闭包在 reload 时覆盖）
  await setupStub(page, emptyDoc);
  await page.evaluate(() => { window.__writes = []; });
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(800);

  if (!(await page.evaluate(() => !!document.getElementById('app')))) {
    await browser.close();
    throw new Error('reload 后 app 未渲染');
  }

  // 已完成视图：sidebar 里 smart-list item 一直渲染（即使为空），可直接点击
  await clickSidebarCategory(page, '已完成任务');
  const afterCompleted = await page.evaluate(() => ({
    title: document.getElementById('category-title')?.textContent,
    batchHidden: document.querySelector('#btn-batch').hidden,
    taskCount: document.querySelectorAll('.task-item').length
  }));
  const completedBatchHidden = afterCompleted.batchHidden;
  if (check('空 已完成 视图下 batch 按钮隐藏', completedBatchHidden, JSON.stringify(afterCompleted))) pass++; else fail++;

  // 回收站视图：sidebar 在 trash 为空时不渲染 item（设计如此 —— 空回收站无入口）。
  // 用户正常路径下到达空回收站的唯一方式：在回收站里批删所有任务 → _followTrashIfEmptied
  // 会自动切走。所以这个边界场景无法在普通 UI 流里复现，跳过断言。
  // (代码层面 hideBatch 在 visibleTasks.length===0 时一定为 true，见 task-list.js:888-892)
}

console.log('\n========== 无 page error ==========');
if (check('无 page error', errors.length === 0, errors.join('; '))) pass++; else fail++;

await browser.close();

console.log(`\n==========\n通过 ${pass} / 失败 ${fail}\n==========`);
rmSync(tmpDir, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
