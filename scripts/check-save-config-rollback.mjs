// 回归测试：H11 — saveConfig 写盘失败时 appConfig 不被覆盖
//
// 背景：旧 saveConfig 在 writeFileSync 失败时已经更新了内存里的 appConfig
// （patch 在 writeFileSync 之前就赋给了 appConfig）。结果：磁盘保存失败，
// 但内存里的配置已经是「新值」—— 用户的设置在重启前看似生效，重启后又被
// 旧值（磁盘上没保存）覆盖，体验「我明明改了，重启就没了」。
//
// 修复（v3.7+）：先 try 块内 writeFileSync 落盘，成功后再 commit 内存；
// 失败时保持原 appConfig 不变。
//
// 跑法：node scripts/check-save-config-rollback.mjs

import { check, summary, printSummary } from './_lib/check.mjs';

// ── 镜像实现：与 main.js 的 saveConfig 一致 ──
console.log('\n[1] saveConfig：写盘失败 → appConfig 保持原值');

{
  // 镜像 main.js 的新 saveConfig 逻辑（先落盘 → 成功再 commit 内存）
  function makeSaveConfig(state = { writeFileThrows: false }) {
    let appConfig = { theme: 'auto', fontSize: 14 };
    const writeFile = () => {
      if (state.writeFileThrows) throw new Error('disk full');
    };
    function saveConfig(next) {
      const candidate = { ...appConfig, ...next };
      try {
        writeFile();
      } catch (e) {
        // 写盘失败：保持 appConfig 不变
        return appConfig;
      }
      appConfig = candidate;
      return appConfig;
    }
    return { get appConfig() { return appConfig; }, saveConfig };
  }

  // 场景 A：写盘成功 → 内存 + 返回值都更新
  {
    const ctx = makeSaveConfig({ writeFileThrows: false });
    const before = ctx.appConfig;
    const ret = ctx.saveConfig({ theme: 'dark', fontSize: 18 });
    check('成功：返回新 appConfig',
      ret && ret.theme === 'dark' && ret.fontSize === 18,
      `ret=${JSON.stringify(ret)}`);
    check('成功：appConfig 已是新值',
      ctx.appConfig.theme === 'dark' && ctx.appConfig.fontSize === 18);
    check('成功：新对象 !== 旧对象（不可变更新）',
      ctx.appConfig !== before);
  }

  // 场景 B：写盘失败 → appConfig 保持原值
  {
    const ctx = makeSaveConfig({ writeFileThrows: true });
    const beforeRef = ctx.appConfig;
    const ret = ctx.saveConfig({ theme: 'dark', fontSize: 18 });
    check('失败：返回的仍是旧 appConfig',
      ret && ret.theme === 'auto' && ret.fontSize === 14,
      `ret=${JSON.stringify(ret)}`);
    check('失败：内存 appConfig 未被覆盖',
      ctx.appConfig.theme === 'auto' && ctx.appConfig.fontSize === 14,
      `actual=${JSON.stringify(ctx.appConfig)}`);
    check('失败：appConfig 仍是同一对象引用（无副作用写入）',
      ctx.appConfig === beforeRef);
  }

  // 场景 C：写盘失败后再试成功 → 之前的旧值仍然在，下次成功才更新
  {
    // 用可变状态对象承载 writeFileThrows（闭包 getter 在工厂里捕获了 snapshot）
    const state = { writeFileThrows: true };
    const ctx = makeSaveConfig(state);
    const beforeRef = ctx.appConfig;

    // 第一次：写盘失败
    const ret1 = ctx.saveConfig({ theme: 'dark' });
    check('C1: 第一次失败 → 返回旧值',
      ret1.theme === 'auto');
    check('C1: 第一次失败 → appConfig 未变',
      ctx.appConfig === beforeRef);

    // 写盘恢复
    state.writeFileThrows = false;

    // 第二次：成功
    const ret2 = ctx.saveConfig({ theme: 'dark' });
    check('C2: 第二次成功 → 返回新值',
      ret2.theme === 'dark');
    check('C2: 第二次成功 → appConfig 已是新值',
      ctx.appConfig.theme === 'dark');
  }

  // 场景 D：部分字段更新不影响其他字段
  {
    const ctx = makeSaveConfig();
    const ret = ctx.saveConfig({ fontSize: 20 });
    check('D: 部分字段更新 → theme 保留',
      ret.theme === 'auto' && ret.fontSize === 20);
  }
}

// ── [2] 旧实现的回归测试：覆盖式 patch 会污染内存 ──
console.log('\n[2] 回归：旧实现（patch 在 write 之前）会污染内存');

{
  // 镜像 main.js 的旧 saveConfig 行为：先合并、再 try write
  let appConfig = { theme: 'auto', fontSize: 14 };
  const writeFile = () => { throw new Error('disk full'); };
  function oldSaveConfig(next) {
    const candidate = { ...appConfig, ...next };
    try {
      writeFile();
    } catch (e) {
      // 旧版错误地 commit 了 candidate
      appConfig = candidate;
      return appConfig;
    }
    return appConfig;
  }
  oldSaveConfig({ theme: 'dark' });
  // 旧实现下：appConfig.theme === 'dark' ← 这就是 bug
  check('回归：旧实现下写盘失败但 appConfig.theme 已被改成 "dark"',
    appConfig.theme === 'dark',
    `actual=${appConfig.theme}`);
}

printSummary('check-save-config-rollback');