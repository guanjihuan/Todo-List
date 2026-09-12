// 共享工具函数

/**
 * 转义 HTML 特殊字符
 * @param {*} s
 * @returns {string}
 */
export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 转义 HTML 字符（用于 HTML 属性，已包含双引号转义）
 * @param {*} s
 * @returns {string}
 */
export function escapeAttr(s) {
  return escapeHtml(s);
}

/**
 * 中西文之间的「间隙元素」。
 *
 * 为什么不直接插入空格：任务文本在双击编辑时是把 textContent 灌回 input 的，
 * 真插入空格会污染用户的原始内容（保存后就多出一堆空格）。空标签不产生任何
 * textContent，也不影响复制粘贴，只在视觉上把两侧撑开。
 *
 * 为什么用 padding 而不是 inline-block/margin：已完成任务的 .task-text 带
 * line-through，CSS 规定祖先的 text-decoration 不会画过 inline-block 这类
 * 原子行内盒（删除线会断成一截一截），而 margin 区域同样不画；padding 区域
 * 会被画到，所以删除线保持连续。见 .cjk-gap 的样式定义。
 */
export const CJK_GAP_HTML = '<span class="cjk-gap"></span>';

// 汉字、假名、CJK 部首等「需要留白」的字符。
// 刻意不含 U+3000-303F（。，、「」等 CJK 标点）和全角字符：它们自带字面宽度，
// 再加间隙反而更难看。
const CJK_CHAR = /[⺀-⻿⼀-⿟぀-ゟ゠-ヺー-ヿ㐀-䶿一-鿿豈-﫿]/;
// 西文一侧只认字母和数字，标点（如 "中文."）不留白。
const LATIN_CHAR = /[0-9A-Za-z]/;

/**
 * 判断两个相邻字符之间是否需要插入间隙。
 * @param {string} prev 左侧字符（可为空串）
 * @param {string} next 右侧字符（可为空串）
 * @returns {boolean}
 */
export function needsCjkGap(prev, next) {
  if (!prev || !next) return false;
  if (CJK_CHAR.test(prev) && LATIN_CHAR.test(next)) return true;
  if (LATIN_CHAR.test(prev) && CJK_CHAR.test(next)) return true;
  return false;
}

/**
 * 转义 HTML，并在中西文边界插入间隙元素。
 *
 * 注意：拆分必须在转义之前做。先转义的话 "&amp;" 里的字母会被当成西文，
 * 间隙元素就插到实体内部去了。
 *
 * 只处理字符串内部的边界；首字符与前一段文本之间的边界由调用方用
 * needsCjkGap + CJK_GAP_HTML 处理（这样间隙才能落在 <mark> 外面，
 * 不会被高亮背景染色）。
 *
 * @param {*} s
 * @returns {string}
 */
export function escapeHtmlAutospace(s) {
  const text = String(s ?? '');
  if (text.length < 2) return escapeHtml(text);

  let out = '';
  let start = 0;
  for (let i = 1; i < text.length; i++) {
    if (needsCjkGap(text[i - 1], text[i])) {
      out += escapeHtml(text.slice(start, i)) + CJK_GAP_HTML;
      start = i;
    }
  }
  return out + escapeHtml(text.slice(start));
}

/**
 * 路径缩短：保留末尾两段路径，中间用 …/ 表示
 * @param {string} p
 * @param {number} max
 * @returns {string}
 */
export function shortenPath(p, max = 42) {
  if (!p) return '';
  if (p.length <= max) return p;
  const parts = p.split(/[\\/]/);
  if (parts.length <= 2) return p;
  return '…/' + parts.slice(-2).join('/');
}

/**
 * 把绝对路径转成 `~/...` 显示形式 —— 在用户主目录内的路径用 `~/` 前缀，
 * 在主目录外的保持原样。
 *
 * 用途：「恢复默认」「默认数据目录」这类 UI 提示不能把带用户名的绝对路径写死
 * （硬编码 `C:\Users\<name>\...` 在别人机器 / CI 上展示不友好，也会泄用户名）。
 * 统一显示成 `~/TodoList/todo.md` 风格，跨用户一致。
 *
 * 注意：大小写不敏感比较 —— Windows (NTFS) / macOS (APFS/HFS+) 默认
 * 大小写不敏感，但 home 路径与传入路径在 toLowerCase 后应一致；保留原大小写
 * 输出，只对比较做归一化。
 *
 * @param {string} absPath 绝对路径
 * @param {string|null|undefined} home 用户主目录（来自 app:get-home-dir IPC）
 * @returns {string}
 */
export function displayPath(absPath, home) {
  if (!absPath) return '';
  if (!home) return absPath;
  // 归一化斜杠 + 去掉末尾分隔符（home 在 Windows 上可能是 C:\Users\guan 或 C:\Users\guan\）
  const norm = (s) => String(s).replace(/\\/g, '/').replace(/\/+$/, '');
  const np = norm(absPath);
  const nh = norm(home);
  const npLow = np.toLowerCase();
  const nhLow = nh.toLowerCase();
  if (npLow === nhLow) return '~';
  if (npLow.startsWith(nhLow + '/')) return '~/' + np.slice(nh.length + 1);
  return absPath;
}
