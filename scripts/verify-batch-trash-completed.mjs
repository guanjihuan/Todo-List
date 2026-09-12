// 验证「已完成任务」智能视图 + 「回收站」视图的批量功能入口：
//   1) 「已完成任务」视图：批量按钮可见，进入批量模式 → 「移到分类」按钮被隐藏，
//      「移到回收站」+「完成」（=取消完成）按钮可用
//   2) 「回收站」视图：批量按钮可见，进入批量模式 → 「移到回收站」按钮被隐藏，
//      「移到分类」按钮 label 变为「恢复到分类…」
//
// 与 verify-batch-move-menu.mjs 同款 Playwright + stub window.api 套路。

import { chromium } from 'playwright-core';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const BASE = 'http://127.0.0.1:8765';
const tmpDir = mkdtempSync(join(tmpdir(), 'batch-tc-test-'));

const DOC = [
  '# 当前任务', '',
  '- [ ] 普通任务', '',
  '# 全部任务', '',
  '## 工作', '',
  '- [ ] 工作任务 A', '',
  '- [ ] 工作任务 B', '',
  '- [▶] 当前工作任务', '',
  '- [⭐] 重要工作任务', '',
  '## 学习', '',
  '- [ ] 学习任务 A', '',
  '- [▶] 当前学习任务', '',
  '- [⭐] 重要学习任务', '',
  '## 未分类', '',
  '- [ ] 杂事 A', '',
  '# 已完成任务', '',
  '- [✓] 工作任务 A（已完成）', '',
  '- [✓] 学习任务 A（已完成）', '',
  '- [✓] 工作任务 B（已完成）', '',
  '# 回收站', '',
  '- [ ] 删除的 A', '',
  '- [✓] 已删且已完成的', ''
].join('\n');

async function setupStub(page, md) {
  await page.addInitScript((md) => {
    const noop = () => {};
    const noopUnsub = () => noop;
    window.api = {
      isDev: false,
      saveFileDialog: async () => null,
      readFile: async () => ({ ok: true, content: md }),
      writeFile: async () => ({ ok: true }),
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
    window.__todoMd = md;
  }, md);
}

async function clickSidebarCategory(page, categoryName) {
  const result = await page.evaluate((name) => {
    // 找 sidebar 里文本匹配的 category-item
    const items = document.querySelectorAll('.category-item');
    for (const el of items) {
      if (el.textContent.trim().startsWith(name)) {
        el.click();
        return true;
      }
    }
    return false;
  }, categoryName);
  if (!result) {
    throw new Error(`未找到 sidebar 分类：${categoryName}`);
  }
  await page.waitForTimeout(300);
}

async function enterBatchMode(page) {
  await page.evaluate(() => {
    const btn = document.querySelector('#btn-batch');
    if (btn && !btn.hidden) btn.click();
  });
  await page.waitForTimeout(200);
}

async function selectAllVisible(page) {
  await page.evaluate(() => {
    // 选第一条任务
    const item = document.querySelector('.task-item');
    if (item) item.click();
  });
  await page.waitForTimeout(150);
}

async function snapshotBar(page) {
  return await page.evaluate(() => {
    const bar = document.querySelector('.batch-action-bar');
    if (!bar) return { exists: false };
    const result = { exists: true };
    const collect = (sel) => {
      const el = bar.querySelector(sel);
      if (!el) return null;
      const label = el.querySelector('span');
      return {
        hidden: el.hidden,
        disabled: el.disabled,
        label: label ? label.textContent.trim() : '',
        title: el.title
      };
    };
    result.move = collect('.batch-action[data-action="move"]');
    result.top = collect('.batch-action[data-action="top"]');
    result.bottom = collect('.batch-action[data-action="bottom"]');
    result.importantSet = collect('.batch-action[data-action="important-set"]');
    result.importantUnset = collect('.batch-action[data-action="important-unset"]');
    result.currentSet = collect('.batch-action[data-action="current-set"]');
    result.currentUnset = collect('.batch-action[data-action="current-unset"]');
    result.complete = collect('.batch-action[data-action="complete"]');
    result.delete = collect('.batch-action[data-action="delete"]');
    return result;
  });
}

async function runScenario({ label, sidebarCategory, expectBatchVisible, expectMove, expectDelete, expectCompleteLabel }) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1024, height: 768 } });
  const page = await context.newPage();

  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });

  await setupStub(page, DOC);
  await page.goto(BASE + '/index.html');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(800);

  // 确认 app 已渲染
  const hasApp = await page.evaluate(() => !!document.getElementById('app'));
  if (!hasApp) {
    await browser.close();
    throw new Error(`[${label}] app 未渲染（#app 不存在）`);
  }

  await clickSidebarCategory(page, sidebarCategory);

  // 验证批量按钮可见性
  const batchBtnInfo = await page.evaluate(() => {
    const btn = document.querySelector('#btn-batch');
    if (!btn) return null;
    return { hidden: btn.hidden, exists: true };
  });

  if (!expectBatchVisible && batchBtnInfo && !batchBtnInfo.hidden) {
    await browser.close();
    throw new Error(`[${label}] 期望 batch 按钮隐藏，但显示出来了`);
  }
  if (expectBatchVisible && batchBtnInfo && batchBtnInfo.hidden) {
    await browser.close();
    throw new Error(`[${label}] 期望 batch 按钮可见，但被隐藏了`);
  }

  await enterBatchMode(page);
  await selectAllVisible(page);

  const bar = await snapshotBar(page);

  await browser.close();

  return { label, sidebarCategory, batchBtnInfo, bar, errors };
}

console.log('=== 场景 1：「已完成任务」视图 ===');
const r1 = await runScenario({
  label: 'completed-view',
  sidebarCategory: '已完成任务',
  expectBatchVisible: true,
  expectMove: { hidden: true },                  // 移到分类应隐藏
  expectDelete: { hidden: false, disabled: false }, // 移到回收站应可用
  expectCompleteLabel: '取消完成'
});

console.log(JSON.stringify(r1, null, 2));

console.log('\n=== 场景 2：「回收站」视图 ===');
const r2 = await runScenario({
  label: 'trash-view',
  sidebarCategory: '回收站',
  expectBatchVisible: true,
  expectMove: { hidden: false, label: '恢复到分类…' }, // 改成「恢复到分类…」
  expectDelete: { hidden: true },                   // 移到回收站应隐藏
  expectCompleteLabel: '完成'
});

console.log(JSON.stringify(r2, null, 2));

console.log('\n=== 场景 3：「当前任务」视图 ===');
const r3 = await runScenario({
  label: 'current-view',
  sidebarCategory: '当前任务',
  expectBatchVisible: true,
  expectMove: { hidden: false },                     // 移到分类应可用
  expectDelete: { hidden: false, disabled: false },   // 移到回收站应可用
  expectCompleteLabel: '完成'
});

console.log(JSON.stringify(r3, null, 2));

console.log('\n=== 场景 4：「重要任务」视图 ===');
const r4 = await runScenario({
  label: 'important-view',
  sidebarCategory: '重要任务',
  expectBatchVisible: true,
  expectMove: { hidden: false },                     // 移到分类应可用
  expectDelete: { hidden: false, disabled: false },   // 移到回收站应可用
  expectCompleteLabel: '完成'
});

console.log(JSON.stringify(r4, null, 2));

console.log('\n=== 场景 5：「全部任务」视图 ===');
const r5 = await runScenario({
  label: 'allTasks-view',
  sidebarCategory: '全部任务',
  expectBatchVisible: true,
  expectMove: { hidden: false },                     // 移到分类应可用
  expectDelete: { hidden: false, disabled: false },   // 移到回收站应可用
  expectCompleteLabel: '完成'
});

console.log(JSON.stringify(r5, null, 2));

// 验证
function check(name, cond, info) {
  const tag = cond ? '✓' : '✗';
  console.log(`${tag} ${name}${info ? ` (${info})` : ''}`);
  return cond;
}

console.log('\n========== 验证 ==========');
let pass = 0, fail = 0;

// 场景 1：已完成视图
console.log('\n[1] 「已完成任务」视图：批量按钮可见 + 按钮正确');
{
  const bar = r1.bar;
  if (check('batch 按钮可见', r1.batchBtnInfo && !r1.batchBtnInfo.hidden)) pass++; else fail++;
  if (check('无 page error', r1.errors.length === 0, r1.errors.join('; '))) pass++; else fail++;
  if (check('「移到分类」按钮隐藏（无意义）',
    bar.move && bar.move.hidden === true,
    JSON.stringify(bar.move))) pass++; else fail++;
  if (check('「移到回收站」按钮显示且可用',
    bar.delete && bar.delete.hidden === false && bar.delete.disabled === false,
    JSON.stringify(bar.delete))) pass++; else fail++;
  if (check('「完成」按钮 label = 「取消完成」',
    bar.complete && bar.complete.label === '取消完成',
    JSON.stringify(bar.complete))) pass++; else fail++;
  if (check('「置顶」按钮禁用（智能列表）',
    bar.top && bar.top.disabled === true,
    JSON.stringify(bar.top))) pass++; else fail++;
  if (check('「置底」按钮禁用（智能列表）',
    bar.bottom && bar.bottom.disabled === true,
    JSON.stringify(bar.bottom))) pass++; else fail++;
}

// 场景 2：回收站视图
console.log('\n[2] 「回收站」视图：批量按钮可见 + 按钮正确');
{
  const bar = r2.bar;
  if (check('batch 按钮可见', r2.batchBtnInfo && !r2.batchBtnInfo.hidden)) pass++; else fail++;
  if (check('无 page error', r2.errors.length === 0, r2.errors.join('; '))) pass++; else fail++;
  if (check('「移到分类」按钮显示，label = 「恢复到分类…」',
    bar.move && bar.move.hidden === false && bar.move.label === '恢复到分类…',
    JSON.stringify(bar.move))) pass++; else fail++;
  if (check('「移到回收站」按钮隐藏（已在回收站）',
    bar.delete && bar.delete.hidden === true,
    JSON.stringify(bar.delete))) pass++; else fail++;
  if (check('「完成」按钮 label = 「完成」（保留默认）',
    bar.complete && bar.complete.label === '完成',
    JSON.stringify(bar.complete))) pass++; else fail++;
  if (check('「标重要」按钮可用',
    bar.importantSet && bar.importantSet.disabled === false)) pass++; else fail++;
  // 选中的任务无重要标记 → 「取消重要」应禁用（无意义）
  if (check('「取消重要」按钮禁用（任务未标重要）',
    bar.importantUnset && bar.importantUnset.disabled === true)) pass++; else fail++;
  if (check('「标当前」按钮可用',
    bar.currentSet && bar.currentSet.disabled === false)) pass++; else fail++;
  // 选中的任务无当前标记 → 「取消当前」应禁用
  if (check('「取消当前」按钮禁用（任务未标当前）',
    bar.currentUnset && bar.currentUnset.disabled === true)) pass++; else fail++;
}

// 场景 3：当前任务视图
console.log('\n[3] 「当前任务」视图：批量按钮可见 + 按钮正确');
{
  const bar = r3.bar;
  if (check('batch 按钮可见', r3.batchBtnInfo && !r3.batchBtnInfo.hidden)) pass++; else fail++;
  if (check('无 page error', r3.errors.length === 0, r3.errors.join('; '))) pass++; else fail++;
  if (check('「移到分类」按钮显示且可用',
    bar.move && bar.move.hidden === false && bar.move.disabled === false,
    JSON.stringify(bar.move))) pass++; else fail++;
  if (check('「移到回收站」按钮显示且可用',
    bar.delete && bar.delete.hidden === false && bar.delete.disabled === false,
    JSON.stringify(bar.delete))) pass++; else fail++;
  if (check('「完成」按钮 label = 「完成」',
    bar.complete && bar.complete.label === '完成',
    JSON.stringify(bar.complete))) pass++; else fail++;
  if (check('「置顶」按钮禁用（智能列表跨分类）',
    bar.top && bar.top.disabled === true,
    JSON.stringify(bar.top))) pass++; else fail++;
  if (check('「置底」按钮禁用（智能列表跨分类）',
    bar.bottom && bar.bottom.disabled === true,
    JSON.stringify(bar.bottom))) pass++; else fail++;
}

// 场景 4：重要任务视图
console.log('\n[4] 「重要任务」视图：批量按钮可见 + 按钮正确');
{
  const bar = r4.bar;
  if (check('batch 按钮可见', r4.batchBtnInfo && !r4.batchBtnInfo.hidden)) pass++; else fail++;
  if (check('无 page error', r4.errors.length === 0, r4.errors.join('; '))) pass++; else fail++;
  if (check('「移到分类」按钮显示且可用',
    bar.move && bar.move.hidden === false && bar.move.disabled === false,
    JSON.stringify(bar.move))) pass++; else fail++;
  if (check('「移到回收站」按钮显示且可用',
    bar.delete && bar.delete.hidden === false && bar.delete.disabled === false,
    JSON.stringify(bar.delete))) pass++; else fail++;
  if (check('「置顶」按钮禁用（智能列表跨分类）',
    bar.top && bar.top.disabled === true,
    JSON.stringify(bar.top))) pass++; else fail++;
  if (check('「置底」按钮禁用（智能列表跨分类）',
    bar.bottom && bar.bottom.disabled === true,
    JSON.stringify(bar.bottom))) pass++; else fail++;
}

// 场景 5：全部任务视图
console.log('\n[5] 「全部任务」视图：批量按钮可见 + 按钮正确');
{
  const bar = r5.bar;
  if (check('batch 按钮可见', r5.batchBtnInfo && !r5.batchBtnInfo.hidden)) pass++; else fail++;
  if (check('无 page error', r5.errors.length === 0, r5.errors.join('; '))) pass++; else fail++;
  if (check('「移到分类」按钮显示且可用',
    bar.move && bar.move.hidden === false && bar.move.disabled === false,
    JSON.stringify(bar.move))) pass++; else fail++;
  if (check('「移到回收站」按钮显示且可用',
    bar.delete && bar.delete.hidden === false && bar.delete.disabled === false,
    JSON.stringify(bar.delete))) pass++; else fail++;
  if (check('「置顶」按钮禁用（智能列表跨分类）',
    bar.top && bar.top.disabled === true,
    JSON.stringify(bar.top))) pass++; else fail++;
  if (check('「置底」按钮禁用（智能列表跨分类）',
    bar.bottom && bar.bottom.disabled === true,
    JSON.stringify(bar.bottom))) pass++; else fail++;
}

console.log(`\n==========\n通过 ${pass} / 失败 ${fail}\n==========`);
rmSync(tmpDir, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
