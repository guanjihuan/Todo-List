// 属性测试（随机操作压测）：验证「任何操作序列都不会让任务凭空消失」。
//
// 静态审查能发现"这行代码看起来不对"，但发现不了"这三个操作按这个顺序做就丢数据"。
// 这个脚本随机组合 增/删/恢复/移动/重排/改名/删分类/清除已完成/往返 等操作，
// 每一步都断言两条不变量：
//
//   不变量 A（不丢任务）：任务文本的多重集只能因「新增」而变大，
//     其余任何操作都必须保持总量不变 —— 删除只是搬到回收站，不是丢弃。
//   不变量 B（结构安全）：serialize() → parseMarkdown() 往返后任务多重集不变。
//     这是真正的验收标准，因为 Markdown 才是真相之源。往返会抓到
//     「回收站 h1 排到子分类前面 → 后面的 ## 被写到容器外 → 下次加载静默丢任务」这类结构损坏。
//
// 用法：node scripts/check-trash-fuzz.mjs [轮数]

import { TaskStore, TRASH_NAME, UNCATEGORIZED_NAME, OTHER_TASKS_NAME } from '../src/task-store.js';
import { parseMarkdown, CategoryKind } from '../src/markdown-parser.js';

// 确定性伪随机（可复现：失败时能贴出种子重跑）
let seed = Number(process.argv[3]) || 12345;
function rnd() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}
const pick = arr => arr[Math.floor(rnd() * arr.length)];
const chance = p => rnd() < p;

function makeStore() {
  const store = new TaskStore();
  store.loadDefault(null);
  store._autoSave = Object.assign(() => {}, { cancel() {}, flush() {} });
  return store;
}

function multiset(categories) {
  const m = new Map();
  for (const cat of categories) {
    for (const t of cat.tasks || []) {
      m.set(t.text, (m.get(t.text) || 0) + 1);
    }
  }
  return m;
}
function msEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}
function msDiff(a, b) {
  const keys = new Set([...a.keys(), ...b.keys()]);
  const out = [];
  for (const k of keys) {
    const x = a.get(k) || 0, y = b.get(k) || 0;
    if (x !== y) out.push(`"${k}": ${x} → ${y}`);
  }
  return out.join('; ');
}

// 结构不变式：回收站必须是最后一个；所有子分类必须排在容器之后
function structureProblems(store) {
  const probs = [];
  const cats = store.categories;
  const trashIdx = cats.findIndex(c => c.kind === CategoryKind.TRASH);
  if (trashIdx >= 0 && trashIdx !== cats.length - 1) {
    probs.push(`回收站不在末位（index ${trashIdx} / 共 ${cats.length}）`);
  }
  if (cats.filter(c => c.kind === CategoryKind.TRASH).length > 1) {
    probs.push('存在多个回收站分类');
  }
  const containerIdx = cats.findIndex(c => c.kind === CategoryKind.OTHER_TASKS);
  if (containerIdx >= 0) {
    cats.forEach((c, i) => {
      if (c.parentOtherTasks && i < containerIdx) {
        probs.push(`子分类「${c.name}」(${i}) 排在容器 (${containerIdx}) 之前`);
      }
    });
  }
  return probs;
}

let counter = 0;
const ops = [
  // 新增任务（唯一允许让总量变大的操作）
  function addTask(store) {
    const targets = store.categories.filter(
      c => c.kind !== CategoryKind.OTHER_TASKS && c.kind !== CategoryKind.TRASH
    );
    if (!targets.length) return 0;
    const cat = pick(targets);
    const text = `任务${++counter}`;
    return store.addTask(cat.name, text) ? 1 : 0;
  },
  // 删除任务（应该搬进回收站，总量不变）
  function deleteTask(store) {
    const targets = store.categories.filter(
      c => c.kind !== CategoryKind.OTHER_TASKS && c.kind !== CategoryKind.TRASH && c.tasks.length
    );
    if (!targets.length) return 0;
    const cat = pick(targets);
    store.deleteTask(cat.name, pick(cat.tasks).id);
    return 0;
  },
  // 试图删除回收站里的任务（必须无效果）
  function deleteFromTrash(store) {
    const trash = store.getTrashCategory();
    if (!trash || !trash.tasks.length) return 0;
    store.deleteTask(TRASH_NAME, pick(trash.tasks).id);
    return 0;
  },
  // 恢复
  function restore(store) {
    const trash = store.getTrashCategory();
    if (!trash || !trash.tasks.length) return 0;
    const id = pick(trash.tasks).id;
    if (chance(0.5)) store.restoreTask(id);
    else {
      const targets = store.categories.filter(
        c => c.kind !== CategoryKind.OTHER_TASKS && c.kind !== CategoryKind.TRASH
      );
      if (targets.length) store.restoreTask(id, pick(targets).name);
    }
    return 0;
  },
  // 移动任务（含移进/移出回收站）
  function moveTask(store) {
    const from = store.categories.filter(c => c.tasks.length);
    if (!from.length) return 0;
    const src = pick(from);
    const dsts = store.categories.filter(c => c.name !== src.name);
    if (!dsts.length) return 0;
    store.moveTask(src.name, pick(src.tasks).id, pick(dsts).name);
    return 0;
  },
  // 勾选
  function toggle(store) {
    const cats = store.categories.filter(c => c.tasks.length);
    if (!cats.length) return 0;
    const cat = pick(cats);
    store.toggleTask(cat.name, pick(cat.tasks).id);
    return 0;
  },
  // 清除已完成（应搬进回收站）
  function clearCompleted(store) {
    if (chance(0.5)) store.clearCompleted();
    else {
      const cats = store.categories;
      store.clearCompleted(pick(cats).name);
    }
    return 0;
  },
  // 新建子分类
  function addSub(store) {
    store.addSubCategory(`分类${++counter}`);
    return 0;
  },
  // 删除子分类（任务应迁到「未分类」）
  function delSub(store) {
    const subs = store.getSubCategories().filter(c => c.name !== UNCATEGORIZED_NAME);
    if (!subs.length) return 0;
    store.deleteCategory(pick(subs).name);
    return 0;
  },
  // 试图删除/改名回收站（必须无效果）
  //
  // 关键：要把「被拒绝」这个语义在测试里也表达出来。如果某天有人不小心把这些
  // 操作改成「返回一个非 falsy 值」，但 fuzz 测试只默默调用、不 assert，
  // 回归就会被静悄悄放过。所以这里显式断言每个调用都返回 falsy —— 失败时
  // 还能指出是哪条规则被突破。
  function attackTrash(store) {
    const attempts = [
      ['deleteCategory', store.deleteCategory(TRASH_NAME)],
      ['renameCategory', store.renameCategory(TRASH_NAME, `伪装${++counter}`)],
      ['addSubCategory', store.addSubCategory(pick(['回收站', 'trash', '垃圾桶', 'bin', 'Recycle Bin']))],
      ['addTask', store.addTask(TRASH_NAME, `偷渡${++counter}`)]
    ];
    for (const [name, ret] of attempts) {
      if (ret) {
        rejectedCalls.push({ step: currentStep, name, ret });
      }
    }
    return 0;
  },
  // 改名子分类
  function renameSub(store) {
    const subs = store.getSubCategories();
    if (!subs.length) return 0;
    store.renameCategory(pick(subs).name, `改名${++counter}`);
    return 0;
  },
  // 子分类重排（最容易破坏数组顺序的操作）
  function reorderSub(store) {
    const n = store.getSubCategories().length;
    if (n < 2) return 0;
    store.reorderSubCategory(
      Math.floor(rnd() * n),
      Math.floor(rnd() * n),
      chance(0.5)
    );
    return 0;
  },
  // 任务重排
  function reorderTask(store) {
    const cats = store.categories.filter(c => c.tasks.length > 1);
    if (!cats.length) return 0;
    const cat = pick(cats);
    const n = cat.tasks.length;
    store.reorderTask(cat.name, Math.floor(rnd() * n), Math.floor(rnd() * n));
    return 0;
  },
  // 走一次完整的 Markdown 往返（模拟保存后重新加载）
  function reload(store) {
    const md = store.serialize();
    store.loadFromContent(md, null);
    store._autoSave = Object.assign(() => {}, { cancel() {}, flush() {} });
    return 0;
  }
];

const ROUNDS = Number(process.argv[2]) || 4000;
const store = makeStore();
let expected = multiset(store.categories);
let fails = 0;

// 不变量 D：回收站保护 —— 任何「试图修改回收站」的入口都必须返回 falsy。
// 收集所有「成功穿透」的尝试，最后统一报告。
let rejectedCalls = [];
let currentStep = 0;

for (let i = 0; i < ROUNDS; i++) {
  currentStep = i;
  const op = pick(ops);
  const before = multiset(store.categories);
  const added = op(store);

  // ---- 不变量 A：除「新增」外总量不变 ----
  const after = multiset(store.categories);
  const beforeTotal = [...before.values()].reduce((a, b) => a + b, 0);
  const afterTotal = [...after.values()].reduce((a, b) => a + b, 0);
  if (afterTotal !== beforeTotal + added) {
    console.log(`\n✗ [第 ${i} 步 / ${op.name}] 任务总量异常：${beforeTotal} → ${afterTotal}（预期 +${added}）`);
    console.log(`   差异：${msDiff(before, after)}`);
    fails++;
    if (fails > 3) break;
  }

  // ---- 不变量 B：结构安全 ----
  const probs = structureProblems(store);
  if (probs.length) {
    console.log(`\n✗ [第 ${i} 步 / ${op.name}] 结构损坏：${probs.join(' | ')}`);
    console.log(`   顺序：${store.categories.map(c => `${c.name}(${c.kind})`).join(' → ')}`);
    fails++;
    if (fails > 3) break;
  }

  // ---- 不变量 C：Markdown 往返不丢任务 ----
  const rt = multiset(parseMarkdown(store.serialize()));
  if (!msEqual(after, rt)) {
    console.log(`\n✗ [第 ${i} 步 / ${op.name}] Markdown 往返后任务变化：`);
    console.log(`   差异：${msDiff(after, rt)}`);
    console.log(`   顺序：${store.categories.map(c => `${c.name}(${c.kind})`).join(' → ')}`);
    console.log(`--- 序列化结果 ---\n${store.serialize()}`);
    fails++;
    if (fails > 3) break;
  }
}

const final = multiset(store.categories);
const total = [...final.values()].reduce((a, b) => a + b, 0);
const trash = store.getTrashCategory();

console.log(`\n${'─'.repeat(52)}`);
console.log(`随机操作 ${ROUNDS} 步（种子 ${process.argv[3] || 12345}）`);
console.log(`最终：${store.categories.length} 个分类 / ${total} 个任务 / 回收站 ${trash ? trash.tasks.length : 0} 项`);

if (rejectedCalls.length) {
  console.log(`\n✗ 回收站保护被绕过 ${rejectedCalls.length} 次：`);
  // 最多展示前 5 条 —— 再多就只是噪声，第一条才是真正的回归信号
  for (const r of rejectedCalls.slice(0, 5)) {
    console.log(`   - 第 ${r.step} 步：${r.name} 返回了 ${JSON.stringify(r.ret)}`);
  }
  if (rejectedCalls.length > 5) console.log(`   ... 以及另外 ${rejectedCalls.length - 5} 条`);
  fails += rejectedCalls.length;
}

console.log(fails === 0 ? '✓ 全程无任务丢失、无结构损坏、往返一致、回收站保护生效' : `✗ ${fails} 处失败`);
process.exit(fails > 0 ? 1 : 0);
