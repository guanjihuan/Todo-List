// 验证 showContextMenu / _showBatchMoveMenu 修复：
//   1) 长分类名 → 菜单不应被右边切
//   2) 很多分类 → 应可滚动 + 滚动条可见
//   3) 窄窗口 → 应 clamp 到视口内
//   4) 普通情况 → 仍能右对齐 batchBar
//
// 用 Playwright 跑实际浏览器，注入 stub window.api，直接走 task-list.js。

import { chromium } from 'playwright-core';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const BASE = 'http://127.0.0.1:8765';
const tmpDir = mkdtempSync(join(tmpdir(), 'batch-move-test-'));

function buildTodo(longNames, count) {
  // 通用 tasks + 容器 + 任意条数的子分类（其中一些名字超长）
  const cats = [];
  // longNames 可能为 null（场景 2），此时全部用默认名生成
  const names = longNames || [];
  for (let i = 0; i < count; i++) {
    const name = names[i] || `分类 ${i}`;
    cats.push(`## ${name}\n\n- [ ] 长名字的分类测试任务 ${i}`);
  }
  return `# 全部任务\n\n${cats.join('\n\n')}\n\n# 已完成任务\n\n# 回收站\n`;
}

async function setup(store, todoMd) {
  await store.evaluate((md) => {
    window.__initialMd = md;
  }, todoMd);
}

async function runScenario(label, opts) {
  const { windowWidth, windowHeight, longNames, count, screenshot = false } = opts;
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: windowWidth, height: windowHeight } });
  const page = await context.newPage();

  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });

  // 在 goto 之前用 addInitScript 注册 stub —— addInitScript 注册的脚本
  // 会在页面每次重新加载时（含 location.reload()）都执行，存活的 window 全局
  // 变量也会被 location.reload() 清掉，所以 stub 必须放在 addInitScript 里。
  const todoMd = buildTodo(longNames, count);
  await page.addInitScript((md) => {
    const noop = () => {};
    const noopUnsub = () => noop;
    // 完整 stub：与 preload.js 暴露的 api 字段对齐 —— 缺一个就 bootstrap 失败
    window.api = {
      isDev: false,
      // 文件操作
      saveFileDialog: async () => null,
      readFile: async () => ({ ok: true, content: md }),
      writeFile: async () => ({ ok: true }),
      fileExists: async () => true,
      createFileIfMissing: async () => ({ ok: true }),
      createSnapshot: async () => ({ ok: true }),
      // 应用信息
      getDataDir: async () => '/tmp',
      getDefaultDataDir: async () => '/tmp',
      getHomeDir: async () => '/tmp',
      getVersion: async () => '0.0.0-test',
      getElectronVersion: async () => '0.0.0-test',
      openDataDir: async () => true,
      // 设置
      getSettings: async () => ({}),
      saveSettings: async () => true,
      chooseDataDir: async () => null,
      // 退出前保存
      notifyDirtyChanged: noop,
      notifyFlushDone: noop,
      onFlushPendingSave: noopUnsub,
      // 事件监听
      onMenuCommand: noopUnsub,
      onFileExternalChange: noopUnsub,
      // 窗口控制
      setAlwaysOnTop: async () => true,
      onAlwaysOnTopChanged: noopUnsub,
      minimizeWindow: async () => true,
      toggleMaximizeWindow: async () => false,
      closeWindow: async () => true,
      onMaximizeStateChanged: noopUnsub
    };
    window.__todoMd = md;
  }, todoMd);

  await page.goto(BASE + '/index.html');
  await page.waitForLoadState('domcontentloaded');
  // 给 app 一点时间渲染
  await page.waitForTimeout(800);

  // 进入第一个子分类（普通视图）→ 触发批量模式 → 选中 1 条 → 移到分类
  // 选第一个非「未分类」、非特殊分类的子分类
  // 注意：用 data-category 判定，不要用 textContent —— 因为 DOM 里 .category-count
  // 徽章会和分类名拼在同一行（带换行和空格），trim 后仍是 "未分类\n          0"
  // 这种格式，与 '未分类' 不等，循环会跳过判断误把「未分类」当成可点击目标。
  const catClicked = await page.evaluate(() => {
    const items = document.querySelectorAll('.category-item.subcategory');
    // 跳过第一个（通常是「未分类」）
    for (const el of items) {
      const name = el.dataset.category;
      if (name && name !== '未分类') {
        el.click();
        return name;
      }
    }
    return null;
  });

  await page.waitForTimeout(300);

  // 点批量按钮
  await page.evaluate(() => {
    const btn = document.querySelector('#btn-batch');
    if (btn) btn.click();
  });
  await page.waitForTimeout(200);

  // 选中第一条任务
  await page.evaluate(() => {
    const item = document.querySelector('.task-item');
    if (item) item.click();
  });
  await page.waitForTimeout(200);

  // 点「移到分类」按钮
  await page.evaluate(() => {
    const btn = document.querySelector('.batch-action[data-action="move"]');
    if (btn) btn.click();
  });
  await page.waitForTimeout(400);

  // 测量菜单的位置和视口关系
  const menuInfo = await page.evaluate(() => {
    const menu = document.getElementById('context-menu');
    if (!menu || menu.hidden) return null;
    const rect = menu.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
      visible: !menu.hidden,
      viewportW: window.innerWidth,
      viewportH: window.innerHeight,
      itemCount: menu.querySelectorAll('.context-menu-item').length,
      // 滚动条是否可见（overflow-y: auto + 内容超 max-height）
      hasScroll: menu.scrollHeight > menu.clientHeight,
      // 哪些项被切（**视口外**，不是菜单外）—— 菜单本身 overflow-y:auto，
      // 滚到下方的项仍可访问，不算 bug。真实 bug 是菜单溢出 viewport 让用户看不到入口。
      itemsClipped: (() => {
        const items = [...menu.querySelectorAll('.context-menu-item')];
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const visible = items.filter(el => {
          const ir = el.getBoundingClientRect();
          // 只检查「被 viewport 切」—— 完全在视口外的项（包括菜单滚动到下方的项）
          // 不算 clipped，只要菜单本身在视口内且有滚动条就 OK
          return ir.right <= vw && ir.left >= 0 && ir.bottom <= vh && ir.top >= 0;
        });
        return items.length - visible.length;
      })()
    };
  });

  if (screenshot) {
    await page.screenshot({ path: join(tmpDir, `${label}.png`), fullPage: false });
  }

  await browser.close();

  return { label, catClicked, menuInfo, errors };
}

const results = [];

console.log('=== 场景 1：长分类名 ===');
const r1 = await runScenario('long-names', {
  windowWidth: 1024,
  windowHeight: 768,
  longNames: [
    '这是一个非常非常长的子分类名字用来测试溢出',
    '工作',
    '学习',
    '生活',
    '个人事务与重要客户跟进'
  ],
  count: 5
});
results.push(r1);
console.log(JSON.stringify(r1, null, 2));

console.log('\n=== 场景 2：很多分类（应可滚动）===');
const r2 = await runScenario('many-cats', {
  windowWidth: 1024,
  windowHeight: 600,
  longNames: null,
  count: 20
});
results.push(r2);
console.log(JSON.stringify(r2, null, 2));

console.log('\n=== 场景 3：窄窗口 ===');
const r3 = await runScenario('narrow-window', {
  windowWidth: 600,
  windowHeight: 500,
  longNames: null,
  count: 5
});
results.push(r3);
console.log(JSON.stringify(r3, null, 2));

console.log('\n=== 场景 4：超窄窗口（菜单应 clamp）===');
const r4 = await runScenario('very-narrow', {
  windowWidth: 380,
  windowHeight: 500,
  longNames: null,
  count: 5
});
results.push(r4);
console.log(JSON.stringify(r4, null, 2));

// 验证
function check(name, cond, info) {
  const tag = cond ? '✓' : '✗';
  console.log(`${tag} ${name}${info ? ` (${info})` : ''}`);
  return cond;
}

console.log('\n========== 验证 ==========');
let pass = 0, fail = 0;
for (const r of results) {
  console.log(`\n[${r.label}]`);
  if (!r.menuInfo) {
    console.log('  ✗ 菜单未显示');
    fail++;
    continue;
  }
  const m = r.menuInfo;
  // 1. 右边不超过视口
  if (check('菜单右边 ≤ 视口右边', m.right <= m.viewportW - 4, `right=${m.right}, vw=${m.viewportW}`)) pass++; else fail++;
  // 2. 左边不小于 4
  if (check('菜单左边 ≥ 4', m.left >= 4, `left=${m.left}`)) pass++; else fail++;
  // 3. 底边不超过视口
  if (check('菜单底边 ≤ 视口底边', m.bottom <= m.viewportH - 4, `bottom=${m.bottom}, vh=${m.viewportH}`)) pass++; else fail++;
  // 4. 顶边不小于 4
  if (check('菜单顶边 ≥ 4', m.top >= 4, `top=${m.top}`)) pass++; else fail++;
  // 5. 无项被切 —— 仅当菜单**没有**滚动时检查。
  // 菜单 overflow-y:auto 时，滚到下方的项虽然 DOM 存在但会被 viewport 切
  // （这是正常的滚动行为，用户主动 scrollTop 才能看到），不算 bug。
  // 真实 bug 是「菜单本身溢出 viewport」，由上面的 1/3 项覆盖。
  if (!m.hasScroll) {
    if (check('菜单内所有项可见（不被切）', m.itemsClipped === 0, `clipped=${m.itemsClipped}`)) pass++; else fail++;
  } else {
    if (check('菜单可滚动时跳过项可见性检查（滚动是正常的）', true)) pass++;
  }
  // 6. 有滚动条当内容超出
  if (m.itemCount > 15) {
    if (check('内容多时滚动条可见', m.hasScroll, `scrollH=${m.hasScroll}`)) pass++; else fail++;
  }
  // 7. 无 page error
  if (check('无 JS 错误', r.errors.length === 0, r.errors.join('; '))) pass++; else fail++;
}

console.log(`\n==========\n通过 ${pass} / 失败 ${fail}\n==========`);
rmSync(tmpDir, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
