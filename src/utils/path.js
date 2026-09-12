// 平台感知的路径处理工具
//
// 单独成模块的原因：
//   1) 这段逻辑需要被单测覆盖（scripts/check-external-change-path.mjs），
//      留在 app.js 里没法独立 import —— ES module + DOM 依赖下 Node 拉不起来
//   2) 路径比较是低层工具，未来 sidebar / settings 等文件路径相关逻辑也可能复用
//      （目前先在 app.js 的外部修改冲突检测里用，未来搬不搬再说）

/**
 * 平台感知的多段路径拼接 —— 渲染端默认输出正斜杠（与主进程 path.resolve 区分）。
 *
 * 与 Node 内置 path.join 的区别：
 *   1) 跨平台统一正斜杠：渲染端的所有路径（store.filePath 等）都用 `/`，
 *      让 pathsEqual 在 Windows 上能跟主进程 `path.resolve` 的反斜杠输出做比较
 *   2) UNC 路径（`\\server\share`）保留前导 `//` —— path.join 会把它折叠成单斜杠
 *   3) 过滤掉空段（避免 `joinPath('a', '', 'b')` 出来 `a//b`）
 *
 * 之前是 src/app.js 第 60 行本地函数，只在那里用。但配合 pathsEqual 形成"拼 + 比"
 * 一对，挪到 utils 让 check-external-change-path.mjs 也能复用、并防止"只测了比较没测
 * 拼接"的盲区。
 *
 * @param {...string} parts
 * @returns {string}
 */
export function joinPath(...parts) {
  const joined = parts
    .filter(Boolean)
    .join('/')
    .replace(/\\/g, '/');
  // UNC 路径（\\server\share）转成 //server/share 后，前导的双斜杠有语义，
  // 不能被下面的 /\/+/g 折叠掉 —— 否则会变成 /server/share，指向本地根目录。
  const isUnc = joined.startsWith('//');
  const normalized = joined
    .replace(/\/+/g, '/')
    .replace(/\/$/, '');
  return isUnc ? '/' + normalized : normalized;
}

/**
 * 平台感知的路径相等比较。
 *
 * 背景：渲染端的 store.filePath 由 joinPath 拼出（正斜杠 `~/TodoList/todo.md`），
 * 主进程发来的 changedPath 走 path.resolve（Windows 上是反斜杠 `C:\Users\<user>\TodoList\todo.md`）。
 * 直接 `!==` 比较在 Windows 上永远不等，resolveExternalChangeConflict 提前 return，
 * 外部修改的 toast / reload 全部静默被吞 —— 用户看到的就是「改了文件，软件没反应」。
 *
 * 同时 Windows / macOS 默认是大小写不敏感的文件系统，再补一层 lowercase 比较：
 *   - Windows：NTFS 默认大小写不敏感
 *   - macOS：APFS / HFS+ 默认大小写不敏感（用户可改，但极少）
 *   - Linux：默认大小写敏感
 *
 * 不依赖 process.platform（contextIsolation 下 renderer 拿不到完整的 process），
 * 改用路径格式自识别「盘符:」开头的当作 Windows，再用 navigator.platform 探测 macOS。
 * 这条路径只在 renderer 跑，navigator 一定有。
 *
 * @param {string|null|undefined} a
 * @param {string|null|undefined} b
 * @returns {boolean}
 */
export function pathsEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  // 0) 尾斜杠归一化：避免 `c:/foo/` 与 `c:/foo` 不等（Windows 上一边带尾斜杠一边不带很常见）
  const trimTrailingSlash = (s) => s.replace(/[\/\\]+$/, '');
  // UNC 路径（//server/share 或 \\server\share）不能 trim 前导双斜杠 —— 那是有语义的
  const isUnc = (s) => /^[\/\\]{2}/.test(s);
  const normalizePath = (s) => {
    const trimmed = trimTrailingSlash(s);
    return isUnc(s) ? '/' + trimmed.replace(/^[\/\\]+/, '').replace(/\\/g, '/') : trimmed.replace(/\\/g, '/');
  };
  const aN = normalizePath(a);
  const bN = normalizePath(b);
  if (aN === bN) return true;
  // UNC 与非 UNC 不可能相等（语义不同：一个指向网络共享,一个指向本地根）
  if (isUnc(a) !== isUnc(b)) return false;
  // 2) 大小写不敏感文件系统：
  //    - Windows（NTFS）：用路径是否带盘符识别，无需依赖 process.platform
  //    - macOS（APFS / HFS+）：通过 navigator.platform / userAgent 探测
  const looksLikeWindowsPath = /^[a-z]:\//i.test(aN) || /^[a-z]:\//i.test(bN);
  if (looksLikeWindowsPath) {
    return aN.toLowerCase() === bN.toLowerCase();
  }
  // macOS 探测：renderer 唯一可用的平台信息是 navigator.platform / userAgent
  // （contextIsolation 下 process 不可见）。这条在浏览器环境恒为 false，
  // 单测里可以塞 globalThis.navigator 模拟。
  if (typeof navigator !== 'undefined') {
    const platform = (navigator.platform || '').toLowerCase();
    const ua = (navigator.userAgent || '').toLowerCase();
    if (platform.includes('mac') || /iphone|ipad|ipod/.test(ua)) {
      return aN.toLowerCase() === bN.toLowerCase();
    }
  }
  // 3) 其他 POSIX（Linux 等）：保守认为大小写敏感
  return false;
}
