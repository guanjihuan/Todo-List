// 一次性检查：所有相对 import 的具名导出是否真实存在。
// 渲染进程的 UI 文件不会被 node 测试加载，语法正确但 import 了不存在的名字时
// 只会在 Electron 里白屏 —— 这个脚本用来提前抓出来。
//
// 用法：node scripts/check-imports.mjs

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// UI 模块在模块作用域就会碰 document / window（注册全局监听等），
// 所以先塞一个最小 DOM 桩 —— 我们只关心 import 能不能解析，不跑实际逻辑。
const noop = () => {};
const stubEl = new Proxy({}, {
  get: (t, k) => (k === 'style' || k === 'dataset' || k === 'classList')
    ? stubEl
    : (k in t ? t[k] : noop),
  set: () => true
});
globalThis.document = new Proxy({}, {
  get: (t, k) => {
    if (k === 'body' || k === 'documentElement' || k === 'head') return stubEl;
    if (k === 'querySelectorAll') return () => [];
    if (k === 'getElementById' || k === 'querySelector') return () => null;
    if (k === 'createElement') return () => stubEl;
    return noop;
  }
});
globalThis.window = new Proxy({}, {
  get: (t, k) => (k === 'matchMedia')
    ? () => ({ matches: false, addEventListener: noop, addListener: noop })
    : (k === 'innerWidth' || k === 'innerHeight') ? 1000 : noop,
  set: () => true
});
// Node 21+ 把 navigator 变成自带 getter 的全局（只读），直接赋值会抛
// "Cannot set property navigator of #<Object> which has only a getter"。
// 用 defineProperty 走 configurable 通道，原模块（toolbar.js）只是读 navigator.platform。
if (!Object.getOwnPropertyDescriptor(globalThis, 'navigator')?.configurable) {
  // 极小概率：未来 Node 把 navigator 锁成 non-configurable —— 退到 try/catch 兜底
  try { globalThis.navigator = { platform: 'Win32', userAgent: 'node' }; } catch {}
} else {
  Object.defineProperty(globalThis, 'navigator', {
    value: { platform: 'Win32', userAgent: 'node' },
    writable: true,
    configurable: true
  });
}
globalThis.localStorage = { getItem: () => null, setItem: noop, removeItem: noop };

const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.js')) files.push(p);
  }
})('src');

let bad = 0;
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');

  // 三类 import 都要扫：
  //   1) 具名  import { a, b as c } from 'x'
  //   2) 默认  import X from 'x'         → 检查 mod.default 存在
  //   3) 命名空间 import * as X from 'x' → 默认通过，无需检查具体名字
  //
  // 旧实现只匹配单行的具名 import，多行 import（跨行排版的 { a, b }）会被
  // 静悄悄放过 —— 那恰好是 UI 文件里最常见的风格。
  const namedRe = /import\s*\{([\s\S]*?)\}\s*from\s*['"]([^'"]+)['"]/g;
  const defaultRe = /import\s+(\w+)\s+from\s*['"]([^'"]+)['"]/g;
  const nsRe = /import\s*\*\s*as\s+(\w+)\s+from\s*['"]([^'"]+)['"]/g;

  const seenSpecs = new Set();
  const tryLoad = async (spec, fromFile) => {
    if (!spec.startsWith('.')) return null;
    const target = path.resolve(path.dirname(fromFile), spec);
    const key = `${fromFile}::${spec}`;
    if (seenSpecs.has(key)) return null;
    seenSpecs.add(key);
    if (!fs.existsSync(target)) {
      console.log(`NO FILE: ${fromFile} -> ${spec}`);
      bad++;
      return null;
    }
    return await import(pathToFileURL(target).href);
  };

  // 1) 具名导入
  let m;
  while ((m = namedRe.exec(src))) {
    const spec = m[2];
    const mod = await tryLoad(spec, f);
    if (!mod) continue;
    // 拆具名列表，容忍换行、尾随逗号、as 重命名。
    // 关键：检查 `n in mod` 时必须用**源导出名**（即 `as` 之前的部分），
    // 不是局部名 —— 模块导出的永远是源名，重命名只在当前模块内可见。
    // 旧实现用 .pop() 取到的是局部名（'bar'），对 `{ foo as bar }` 永远
    // 找不到 'bar'，把这次正常的 rename 误报为 MISSING EXPORT。
    const names = m[1]
      .split(',')
      .map(s => {
        const parts = s.trim().split(/\s+as\s+/);
        return (parts[0] || '').trim();
      })
      .filter(Boolean);
    for (const n of names) {
      if (!(n in mod)) {
        console.log(`MISSING EXPORT: ${n}  (${f} <- ${spec})`);
        bad++;
      }
    }
  }

  // 2) 默认导入
  while ((m = defaultRe.exec(src))) {
    // 跳过已经匹配的具名导入（regex 共享游标，靠 lookahead 排除具名）
    if (/\{[\s\S]*\}\s*from\s*['"]/.test(src.slice(m.index, m.index + m[0].length + 50))) continue;
    const localName = m[1];
    const spec = m[2];
    const mod = await tryLoad(spec, f);
    if (!mod) continue;
    if (!('default' in mod) || mod.default === undefined) {
      console.log(`MISSING DEFAULT: ${localName}  (${f} <- ${spec})`);
      bad++;
    }
  }

  // 3) 命名空间 import：仅当模块本身不存在时才算失败 —— 不去校验具体成员。
  while ((m = nsRe.exec(src))) {
    const spec = m[2];
    await tryLoad(spec, f);
  }
}

console.log(bad === 0
  ? `✓ 所有 import 均可解析（${files.length} 个文件）`
  : `✗ ${bad} 处问题`);
process.exit(bad > 0 ? 1 : 0);
