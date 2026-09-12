// 任务级 diff / merge 工具
//
// 用途：当「内存中的 store.categories」与「磁盘解析出的 categories」不一致时，
// 给冲突解决 UI 提供按任务粒度的合并能力：
//   - 找出只在内存里的任务（用户新增的）
//   - 找出只在磁盘里的任务（用户在外部编辑器新增的）
//   - 找出文本相同但状态不同的任务（用户改了标记 vs 文件改了标记）
//   - 找出文本被修改的任务（用户重命名 vs 文件重命名）
//
// 关键约定：
//   - taskKey = `${catName}::${text}` —— 用「逻辑分类 + 文本」作为身份标识。
//     **不**用 task.id（id 是运行时句柄,跨 reload 重新分配,无法跨两侧稳定）。
//     **不**用 taskIdx（任务在分类内的位置 —— 默认 newTaskPosition='front'，
//     用户在 UI 加一条任务会让其下所有任务 idx 都 +1，原本同一条任务在 A/B
//     两侧的 key 会分叉，触发「onlyInA + onlyInB 各报一次 → 默认合并重复」）。
//     文本变了就是另一条任务。
//   - container（kind=OTHER_TASKS）/ today 两类**不**参与 diff：结构性容器。
//   - COMPLETED / TRASH **参与** diff —— 但 effective cat name 用 task.originalCategory
//     （v3.4 不变量：completed=true 任务的逻辑归属）。这样磁盘里 [ ] 任务和内存里
//     同文本的 [✓] 任务（搬到 COMPLETED）能落到同一 key，进 modified 走 OR 合并，
//     否则用户的勾选会被磁盘 [ ] 版本静默撤销（H4 历史 bug）。
//   - 顶层 categories 顺序不在 diff 范围内 —— 顺序由 _normalizeOrder 保证,
//     merge 后跑一次 normalize 即可。
//
// 纯函数:无 DOM 依赖、无 store 依赖、可独立单测。

import { CategoryKind } from '../markdown-parser.js';

/**
 * 把 categories 数组展平成 Map<taskKey, {task, cat, catIdx, taskIdx, realCat}>
 *
 * `realCat` 在 COMPLETED / TRASH 任务下指向 task 实际所在的容器（保留 cat.kind
 * 用于 applyResolutions 决定最终落点）；其他情况等于 cat。
 *
 * @param {Array} categories - store 风格的 categories 数组
 * @returns {Map<string, {task: object, cat: object, catIdx: number, taskIdx: number, realCat: object}>}
 */
export function categoriesToMap(categories) {
  const map = new Map();
  if (!Array.isArray(categories)) return map;
  // 两遍扫描：先处理状态容器（COMPLETED/TRASH），再处理其它分类。
  // 原因：v3.4 不变量要求「completed=true / 在回收站」的任务只在状态容器里。
  // 但磁盘/内存过渡期可能同时存在 NORMAL 副本 + 状态容器副本，按 key 去重时
  // 必须让状态容器副本赢（它是用户当前位置的真相）—— 否则 diff 看不出勾选/回收
  // 动作，会误判为 unchanged（H4 / H5 历史 bug 的根源之一）。
  const passes = [
    cats => cats.filter(c => c && (c.kind === CategoryKind.COMPLETED || c.kind === CategoryKind.TRASH)),
    cats => cats.filter(c => c && c.kind !== CategoryKind.COMPLETED && c.kind !== CategoryKind.TRASH
      && c.kind !== CategoryKind.OTHER_TASKS && c.kind !== CategoryKind.TODAY),
  ];
  for (const pick of passes) {
    const filtered = pick(categories);
    for (let catIdx = 0; catIdx < filtered.length; catIdx++) {
      const cat = filtered[catIdx];
      const catName = (cat.name || '').trim() || '__anon__';
      const tasks = Array.isArray(cat.tasks) ? cat.tasks : [];
      // COMPLETED / TRASH 是「状态容器」—— 任务的逻辑归属在 originalCategory。
      // key 用 effective name（原分类）以匹配磁盘侧同文本 [ ] 任务。
      const isStateContainer = cat.kind === CategoryKind.COMPLETED || cat.kind === CategoryKind.TRASH;
      for (let taskIdx = 0; taskIdx < tasks.length; taskIdx++) {
        const task = tasks[taskIdx];
        if (!task || typeof task.text !== 'string') continue;
        // effective cat name：state container 下用 originalCategory（v3.4 标记），
        // 其他场景直接用 cat.name（orphan 时回退 '__anon__'）。
        let effectiveCatName = catName;
        if (isStateContainer) {
          effectiveCatName = (task.originalCategory || '').trim() || '__anon__';
        }
        // v3.7+ 修复（HIGH data-loss vector）：当 effectiveCatName 落到 '__anon__'
        // 兜底串（state container 下 originalCategory 为空 / 普通 orphan 分类无名），
        // 同 cat 内多条任务 text 相同时会撞同一个 key —— `if (!map.has(key))` 让首条
        // 胜出，后续条**静默被吞**。后果是冲突合并时这些任务根本不进 diff，
        // applyResolutions 看不到它们，存盘后用户丢任务。
        //
        // 修法：effectiveCatName 是 '__anon__' 时把 taskIdx 拼进 key，让每条任务
        // 都有独立身份。normal path 下 effectiveCatName 是真名（同 cat 内 text 撞
        // key 是用户真实的「同 text 不同任务」歧义，应让首条胜出保持原行为）。
        const isAnonEffective = effectiveCatName === '__anon__';
        const key = isAnonEffective
          ? makeTaskKey(`__anon_${catIdx}_${taskIdx}`, task.text)
          : makeTaskKey(effectiveCatName, task.text);
        // 同 key 重复时保留首次出现 —— 状态容器在第一遍已写入，第二遍普通
        // cat 的同 key 任务自动让位（不会覆盖）。
        // effectiveCatName 存到 entry 里 —— diffCategories 要用它在跨分类
        // 移动判定时区分「同 effective 分类（NORMAL↔COMPLETED 算同逻辑位置）」
        // vs「真·跨分类移动（NORMAL「工作」→ NORMAL「学习」）」。
        if (!map.has(key)) {
          map.set(key, { task, cat, catIdx, taskIdx, realCat: cat, effectiveCatName });
        }
      }
    }
  }
  return map;
}

/**
 * 构造 task key。
 *
 * key 组成 = `${catName}::${text}`（带长度前缀防撞）：
 *   - catName：effective 分类身份（state container 下用 originalCategory）
 *   - text：任务文本（trim 过）
 *
 * 长度前缀（每个字段前 `${length}:`）防止 `${catName='a'}::${text='::b'}` 与
 * `${catName='a::'}::${text='b'}` 这类无前缀时碰撞。
 *
 * 历史注：早期版本 key 包含 idxInCat —— 意图是区分「同 cat 内 A 侧第 2 条 vs
 * B 侧第 3 条」这种位置漂移。但默认 newTaskPosition='front'，用户加任务会让
 * 其下所有 idx +1，原本同一条任务在 A/B 两侧 key 分叉 → onlyInA + onlyInB
 * 各报一次 → 默认 'a'/'b' 各加一份 → 重复。v4 修复：去掉 idxInCat。
 *
 * @param {string} catName
 * @param {string} text
 * @param {number} [_idxInCat] - 已忽略，保留参数兼容旧调用
 */
export function makeTaskKey(catName, text, _idxInCat) {
  // 长度前缀防撞 —— 没长度前缀时 (catName='abc', text='::x') 与 (catName='abc::', text='x')
  // 都拼成 'abc::::x'，Map 当成同 key → 两条不同的任务在合并时互相错位、数据互窜。
  const safeText = (text || '').trim();
  return `${catName.length}:${catName}::${safeText.length}:${safeText}`;
}

/**
 * 比较两条 task 是否「实质相同」（text 字段相同即可,状态不同算 modified）
 * @param {object} a
 * @param {object} b
 */
export function tasksTextuallyEqual(a, b) {
  if (!a || !b) return false;
  return (a.text || '').trim() === (b.text || '').trim();
}

/**
 * 比较两条 task 的「状态字段」（completed / important / current）
 * @returns {boolean} 三个布尔位完全相等
 */
export function tasksStateEqual(a, b) {
  if (!a || !b) return false;
  return Boolean(a.completed) === Boolean(b.completed)
      && Boolean(a.important) === Boolean(b.important)
      && Boolean(a.current) === Boolean(b.current);
}

/**
 * 计算两个 categories 之间的任务级 diff。
 *
 * 同 key 出现在不同「实际 cat」的几种场景：
 *   1) effectiveCatName 一致 + catA.kind === catB.kind —— 同一逻辑位置，
 *      只看状态字段（典型 modified / unchanged）
 *   2) effectiveCatName 一致 + 一边是 COMPLETED/TRASH 另一边不是 —— 这是
 *      用户的「勾选 / 取消勾选 / 回收 / 恢复」动作。**不进** onlyInA + onlyInB
 *      （那样会让磁盘 [ ] 副本和内存 [✓] 副本同时进合并结果，触发重复 / 撤销）。
 *      走 modified（state-only：真实状态字段会被 OR 合并）+ applyResolutions
 *      里的「state container move」分支移除源 cat、追加到目标 cat。
 *   3) effectiveCatName 不一致 + 两边都是普通 cat —— 用户把任务从一个
 *      分类拖到另一个（旧分类 onlyInA / 新分类 onlyInB），让用户按 onlyInA
 *      / onlyInB 各走一遍即可，避免误报 modified 让用户对同一条任务的搬迁
 *      选两次边。
 *
 * @param {Array} catsA - 「A 侧」的 categories（如磁盘解析结果）
 * @param {Array} catsB - 「B 侧」的 categories（如内存里的 store.categories）
 * @returns {{
 *   onlyInA: Array<{key, task, cat}>,
 *   onlyInB: Array<{key, task, cat}>,
 *   modified: Array<{key, taskA, taskB, catA, catB, stateOnly: boolean, stateContainerMove: boolean}>,
 *   unchanged: Array<{key, taskA, taskB, catA, catB}>
 * }}
 */
export function diffCategories(catsA, catsB) {
  const mapA = categoriesToMap(catsA);
  const mapB = categoriesToMap(catsB);

  const onlyInA = [];
  const onlyInB = [];
  const modified = [];
  const unchanged = [];

  for (const [key, entryA] of mapA.entries()) {
    const entryB = mapB.get(key);
    if (!entryB) {
      onlyInA.push({ key, task: entryA.task, cat: entryA.cat });
      continue;
    }
    const sameLogicalCat = entryA.effectiveCatName === entryB.effectiveCatName;
    const sameKind = entryA.realCat.kind === entryB.realCat.kind;
    // 场景 1: 同 effective 分类 + 同 kind → 同一逻辑位置，仅看状态字段
    if (sameLogicalCat && sameKind) {
      if (tasksStateEqual(entryA.task, entryB.task)) {
        unchanged.push({ key, taskA: entryA.task, taskB: entryB.task, catA: entryA.cat, catB: entryB.cat });
      } else {
        modified.push({
          key,
          taskA: entryA.task,
          taskB: entryB.task,
          catA: entryA.cat,
          catB: entryB.cat,
          stateOnly: true,
          stateContainerMove: false,
        });
      }
      continue;
    }
    // 场景 2: effective 分类一致，但一边进了状态容器 —— 勾选 / 取消 / 回收 / 恢复。
    // 走 modified（applyResolutions 处理「源 cat 移除 + 目标 cat 追加」）。
    if (sameLogicalCat) {
      modified.push({
        key,
        taskA: entryA.task,
        taskB: entryB.task,
        catA: entryA.cat,
        catB: entryB.cat,
        stateOnly: !tasksStateEqual(entryA.task, entryB.task),
        stateContainerMove: true,
      });
      continue;
    }
    // 场景 3: 真·跨分类移动（NORMAL「工作」 → NORMAL「学习」）。
    // 双向报告，让旧分类走 onlyInA、新分类走 onlyInB。
    onlyInA.push({ key, task: entryA.task, cat: entryA.cat });
    onlyInB.push({ key, task: entryB.task, cat: entryB.cat });
  }
  for (const [key, entryB] of mapB.entries()) {
    if (!mapA.has(key)) {
      onlyInB.push({ key, task: entryB.task, cat: entryB.cat });
    }
  }

  return { onlyInA, onlyInB, modified, unchanged };
}

/**
 * 解析用户选择 → 应用到 categories。
 *
 * @param {Array} baseCategories - 起始 categories（如磁盘解析结果）
 * @param {object} diff - diffCategories() 的输出
 * @param {object} resolutions - 用户对每个差异条目的选择：
 *   key → 'a' | 'b' | 'both' | 'skip'
 *   'a'   = 用 A 侧（文件版）任务
 *   'b'   = 用 B 侧（内存版）任务
 *   'both'= 两边都保留（适用于 onlyInA 和 onlyInB）
 *   'skip'= 丢弃（不写入结果）
 * @returns {Array} 合并后的 categories（仍是合法格式,需跑一次 _normalizeOrder）
 */
export function applyResolutions(baseCategories, diff, resolutions) {
  // 浅拷贝 categories + 每个 cat 的 tasks 数组（不深拷 task 对象 —— store 拿过去直接用）
  const out = baseCategories.map(cat => ({
    ...cat,
    tasks: Array.isArray(cat.tasks) ? cat.tasks.slice() : [],
  }));

  const findOrCreateCat = (catName, kind, sourceMeta) => {
    // 两边都 trim —— categoriesToMap 已经把 name.trim() 用作 key，但 item.cat.name
    // 是原始（未 trim）值透传过来的；若 c.name 是 trim 版而 catName 是带空白的，
    // 这里就会漏匹配 → 静默创建重复分类。
    const targetName = (catName || '').trim();
    let target = out.find(c => (c.name || '').trim() === targetName);
    if (!target) {
      target = {
        name: targetName,
        kind: kind || CategoryKind.NORMAL,
        isSpecial: false,
        // 透传源 cat 的 meta —— 普通分类通常 meta=null 不影响，但「未分类」
        // 等保留分类可能在 writer/reader 间携带 description 等元数据；新建
        // 时不能用 null 静默覆盖，否则下游渲染会丢字段。
        meta: sourceMeta || null,
        parentOtherTasks: true,
        tasks: [],
      };
      out.push(target);
    }
    return target;
  };

  // 1) 处理 onlyInA（A 独有,「文件里有但内存里没有」）
  for (const item of diff.onlyInA) {
    const choice = resolutions[item.key] || 'a'; // 默认「用文件」(新增的任务当然要)
    if (choice === 'skip') continue;
    if (choice === 'a' || choice === 'both') {
      const cat = findOrCreateCat(item.cat.name, item.cat.kind, item.cat.meta);
      // 避免重复（task 对象引用比较即可 —— 同对象不会出现在同 cat 两次）
      if (!cat.tasks.includes(item.task)) {
        cat.tasks.push(item.task);
      }
    }
    // 'b' 在 onlyInA 场景下无意义 —— B 没有这条任务,忽略
  }

  // 2) 处理 onlyInB（B 独有,「内存里有但文件里没有」—— 用户自己加的）
  for (const item of diff.onlyInB) {
    const choice = resolutions[item.key] || 'b'; // 默认「用本地」(用户加的任务当然要)
    if (choice === 'skip') continue;
    if (choice === 'b' || choice === 'both') {
      const cat = findOrCreateCat(item.cat.name, item.cat.kind, item.cat.meta);
      if (!cat.tasks.includes(item.task)) {
        cat.tasks.push(item.task);
      }
    }
    // 'a' 在 onlyInB 场景下无意义 —— A 没有这条任务,忽略
  }

  // 3) 处理 modified（两边都有但状态不同 —— OR 合并状态）
  for (const item of diff.modified) {
    const choice = resolutions[item.key] || 'both'; // 默认「两边都保留」(OR 合并)
    if (choice === 'skip') continue;

    // 3a) 状态容器移动：一边 NORMAL 一边 COMPLETED/TRASH（如用户勾选 / 取消勾选 /
    //     回收 / 恢复）。必须显式「从源 cat 移除、追加到目标 cat」——
    //     否则 baseCategories 里源 cat 的 [ ] 副本会和追加到目标 cat 的
    //     [✓]/[trash] 副本共存，产生重复 + 撤销用户操作的语义错位。
    if (item.stateContainerMove) {
      const targetCat = findOrCreateCat(item.catB.name, item.catB.kind, item.catB.meta);
      const mergedTask = mergeTaskStates(item.taskA, item.taskB);
      // 'a' 在 state container 移动下语义是「保留磁盘侧位置」—— 即不应用用户
      // 的勾选 / 回收操作，保留磁盘 [ ] 版本。所以**必须用 taskA**（磁盘侧）
      // 而非 mergedTask（OR 合并会带上用户态）。mergeTaskStates 在这里会用
      // taskB.completed=true 把"用户撤销勾选"偷偷回写成 [✓]，违反 'a' 语义。
      if (choice === 'a') {
        const sourceCat = out.find(c => (c.name || '').trim() === (item.catA.name || '').trim());
        if (sourceCat) {
          const srcIdx = sourceCat.tasks.findIndex(t => t.text.trim() === item.taskA.text.trim());
          if (srcIdx >= 0) sourceCat.tasks[srcIdx] = item.taskA;
          else sourceCat.tasks.push(item.taskA);
        }
        continue;
      }
      // 'b' 或 'both' → 移到目标 cat（用户当前位置）：从源 cat 移除、追加到目标 cat。
      const sourceCat = out.find(c => (c.name || '').trim() === (item.catA.name || '').trim());
      if (sourceCat) {
        const srcIdx = sourceCat.tasks.findIndex(t => t.text.trim() === item.taskA.text.trim());
        if (srcIdx >= 0) sourceCat.tasks.splice(srcIdx, 1);
      }
      const tgtIdx = targetCat.tasks.findIndex(t => t.text.trim() === item.taskB.text.trim());
      if (tgtIdx >= 0) {
        targetCat.tasks[tgtIdx] = mergedTask;
      } else {
        targetCat.tasks.push(mergedTask);
      }
      continue;
    }

    // 3b) 普通 modified（同 cat 内状态不同 —— OR 合并状态）
    const cat = findOrCreateCat(item.catB.name, item.catB.kind, item.catB.meta);
    // 找到同 text 的位置（baseCategories 里有,map 里有对应 entry）。
    // 但 taskB 来自 B 侧（内存），可能 baseCategories 里没有这个 cat（用户新建的分类）
    // → findOrCreateCat 创建了一个空 cat.tasks，findIndex 返回 -1。这种情况下
    // 不能静默丢弃，否则用户的本地任务在合并后凭空消失 —— 应该按 choice 直接 push。
    const idx = cat.tasks.findIndex(t => t.text.trim() === item.taskB.text.trim());
    if (idx >= 0) {
      if (choice === 'a') {
        cat.tasks[idx] = item.taskA;
      } else if (choice === 'b') {
        cat.tasks[idx] = item.taskB;
      } else if (choice === 'both') {
        // 两边都保留 —— 标记位合并(任一为 true 则 true),文本相同的只保留一份
        cat.tasks[idx] = mergeTaskStates(item.taskA, item.taskB);
      }
    } else {
      // idx < 0 的兜底：cat 在 baseCategories 里不存在（taskB 来自用户新建的 cat），
      // 按 choice 直接追加一份（'both' 时取 OR 合并态）。
      if (choice === 'a') {
        cat.tasks.push(item.taskA);
      } else if (choice === 'b') {
        cat.tasks.push(item.taskB);
      } else if (choice === 'both') {
        cat.tasks.push(mergeTaskStates(item.taskA, item.taskB));
      }
    }
  }

  return out;
}

/**
 * 把两条同文本任务的状态字段按 OR 合并,文本取 trim 后更长的那份(避免误删)。
 *
 * 字段白名单（防止泄漏运行时字段）：
 *   - 显式只透传 { text, important, completed, current, originalCategory }
 *   - **不**透传 task.id（运行时句柄,A/B 两侧的 id 可能不同,合并后必须由 store 重新分配）
 *   - **不**透传 _skipReload / _pickerAttempts / createdAt / updatedAt（内部状态,合并结果不能污染）
 *
 * current 特殊处理（v4 修复）：
 *   - 「当前任务」是单值指针（同一时刻只能有一条 `[▶]`）
 *   - 仅一边 current=true → 保留用户的标记（OR）—— 修复历史 bug：旧版无条件置
 *     false，导致「用户在 UI 标了 [▶]、磁盘还没同步」合并后丢失当前任务标记
 *   - 两边都 current=true → 仍是矛盾状态，强制 false，让用户手动重新指定
 *     （理论上不会到这里 —— tasksStateEqual 在两边 current 都 true 时判相等，
 *     进 unchanged 不进 modified；留兜底防 bypass）
 *
 * @param {object} taskA
 * @param {object} taskB
 * @returns {object} 一条新的任务对象
 */
export function mergeTaskStates(taskA, taskB) {
  const text = (taskB.text || '').trim() || (taskA.text || '').trim();
  const aCurrent = Boolean(taskA.current);
  const bCurrent = Boolean(taskB.current);
  // 仅一边 true → OR 保留；两边都 true → 矛盾，强制 false
  const mergedCurrent = (aCurrent !== bCurrent) && (aCurrent || bCurrent);
  return {
    text,
    important: Boolean(taskA.important) || Boolean(taskB.important),
    completed: Boolean(taskA.completed) || Boolean(taskB.completed),
    current: mergedCurrent,
    // originalCategory 任一非空就用那个（双方都有时优先 taskA —— 文件侧是真相之源）
    originalCategory: taskA.originalCategory || taskB.originalCategory || null,
  };
}

/**
 * 为 diff 结果生成「默认选择」:
 *   - onlyInA → 默认 'a'（保留文件侧新增）
 *   - onlyInB → 默认 'b'（保留本地侧新增）
 *   - modified → 默认 'both'（OR 合并状态）—— 用户大概率「两边都想要」，避免
 *     自动选边丢标记位；冲突的 current 字段在 mergeTaskStates 里统一置 false
 *
 * 用户可以在 UI 里逐条改成其他选项。
 *
 * @param {object} diff - diffCategories() 输出
 * @returns {object} resolutions 初始值,key → 'a'|'b'|'both'|'skip'
 */
export function defaultResolutions(diff) {
  const res = {};
  for (const item of diff.onlyInA) res[item.key] = 'a';
  for (const item of diff.onlyInB) res[item.key] = 'b';
  for (const item of diff.modified) res[item.key] = 'both';
  return res;
}

/**
 * 列举 diff 里的「无歧义」改动 —— 即仅一边有的任务 + modified 的统计。
 * 给 UI 显示「共 N 处差异」用。
 *
 * @param {object} diff
 * @returns {{ total: number, addedByFile: number, addedByMine: number, conflicting: number }}
 */
export function summarizeDiff(diff) {
  return {
    total: diff.onlyInA.length + diff.onlyInB.length + diff.modified.length,
    addedByFile: diff.onlyInA.length,
    addedByMine: diff.onlyInB.length,
    conflicting: diff.modified.length,
  };
}
