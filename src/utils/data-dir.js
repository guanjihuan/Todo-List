// 数据目录相关 IPC 调用的封装
// 把"调 main 进程 → 失败时 toast"的样板逻辑集中到一处，避免散落在多个 UI 组件里

import { toast } from '../ui/feedback.js';

/**
 * 让系统文件管理器打开数据目录
 * 失败时 toast 错误信息（统一在 3 秒后消失）
 */
export async function openDataDirWithToast() {
  try {
    const result = await window.api.openDataDir();
    if (!result.ok) toast(`打开失败：${result.error}`, 'error', 3000);
    return result;
  } catch (err) {
    toast(`打开失败：${err.message}`, 'error', 3000);
    return { ok: false, error: err.message };
  }
}
