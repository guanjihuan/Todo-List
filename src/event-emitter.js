// 简单事件发射器 - 可被多个 store 复用

export class EventEmitter {
  constructor() {
    this._handlers = new Map();
  }

  on(event, handler) {
    if (!this._handlers.has(event)) this._handlers.set(event, new Set());
    this._handlers.get(event).add(handler);
    return () => this.off(event, handler);
  }

  off(event, handler) {
    // 如果传进来的是 once 的原 handler，把对应的 wrapper 也一并解绑 —
    // 避免 wrapper 残留导致触发后又跑一次 handler。
    const wrapper = this._onceWrappers?.get(handler);
    if (wrapper) {
      this._handlers.get(event)?.delete(wrapper);
      this._onceWrappers.delete(handler);
      return;
    }
    this._handlers.get(event)?.delete(handler);
  }

  // 一次性监听：触发一次后自动注销。返回的取消函数可在触发前主动取消。
  //
  // 关键：`off(event, handler)` 拿到的是调用方的原 handler，但 Set 里实际存的是 wrapper。
  // 旧实现下，用 `off` 取消 once 监听不会真的从 Set 里移除 wrapper —— 触发一次后
  // wrapper 还会再触发原 handler（再 + 1 次）。这里走单独的取消路径：
  //   - once 返回的取消函数能正确解绑 wrapper
  //   - off(event, originalHandler) 仅移除 Set 里的 originalHandler（如果被 add 过）
  //   - wrapper 通过弱映射挂在 originalHandler 上，GC 后自动清掉
  once(event, handler) {
    const wrapper = (data) => {
      // 触发时优先用 off 解绑 wrapper —— 避免下面 wrapper 还引用自己导致 Set 删除失败
      this.off(event, wrapper);
      // 同步把 handler 上的 wrapper 引用清掉，方便 once 的取消函数找到它
      if (this._onceWrappers && this._onceWrappers.has(handler)) {
        this._onceWrappers.delete(handler);
      }
      handler(data);
    };
    // 维护「原 handler → wrapper」映射，使 off(handler) 能找到 wrapper 解绑
    if (!this._onceWrappers) this._onceWrappers = new WeakMap();
    this._onceWrappers.set(handler, wrapper);
    return this.on(event, wrapper);
  }

  emit(event, data) {
    this._handlers.get(event)?.forEach(h => {
      try { h(data); }
      catch (e) { console.error(`[Event ${event}]`, e); }
    });
  }
}
