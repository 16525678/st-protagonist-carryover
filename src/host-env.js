/**
 * src/host-env.js
 * 统一宿主窗口、文档与运行模式桥接层。
 * 同时兼容：
 * 1. SillyTavern / TauriTavern 标准前端扩展模式（运行在宿主主窗口 window）
 * 2. 酒馆助手 / Tavern Helper（JS-Slash-Runner）脚本模式（运行在 script iframe，宿主为 window.parent）
 */

export const INSTANCE_FLAG = '__ST_PROTAGONIST_CARRYOVER_LOADED__';
export const INLINE_STYLE_ID = 'pc-carryover-inline-style';

let forcedRuntimeMode = null; // 'extension' | 'tavern-helper' | null

/** 由打包入口或测试显式指定运行模式 */
export function setRuntimeMode(mode) {
  forcedRuntimeMode = mode === 'tavern-helper' || mode === 'extension' ? mode : null;
}

/** 检测当前运行模式：'tavern-helper'（iframe 脚本）或 'extension'（主窗口扩展） */
export function detectRuntimeMode() {
  if (forcedRuntimeMode) return forcedRuntimeMode;
  try {
    if (typeof window !== 'undefined' && typeof window.parent !== 'undefined' && window.parent !== window) {
      // 确认能访问父窗口 document（同源酒馆助手 script iframe）
      void window.parent.document;
      return 'tavern-helper';
    }
  } catch {
    return 'tavern-helper';
  }
  return 'extension';
}

export function isTavernHelperIframeMode() {
  return detectRuntimeMode() === 'tavern-helper';
}

/** 获取酒馆/TauriTavern 主窗口引用（iframe 模式下为 window.parent） */
export function getHostWindow() {
  if (typeof window === 'undefined') return globalThis;
  if (isTavernHelperIframeMode()) {
    try {
      if (window.parent && window.parent !== window) {
        return window.parent;
      }
    } catch {
      return window;
    }
  }
  return window;
}

/** 获取酒馆/TauriTavern 主文档引用（确保弹窗、样式、魔法棒入口挂载到可见宿主页面） */
export function getHostDocument() {
  try {
    const win = getHostWindow();
    if (win?.document) return win.document;
  } catch {
    // ignore
  }
  return typeof document !== 'undefined' ? document : null;
}

/** 获取 SillyTavern 全局对象 */
export function getSillyTavernGlobal() {
  const hostWin = getHostWindow();
  return hostWin?.SillyTavern || globalThis.SillyTavern || null;
}

/** 安全获取 SillyTavern.getContext() */
export function getSillyTavernContextSafe() {
  try {
    const st = getSillyTavernGlobal();
    if (typeof st?.getContext === 'function') {
      return st.getContext();
    }
  } catch (err) {
    console.error('[ProtagonistCarryover] SillyTavern.getContext() failed:', err);
  }
  return null;
}

/** 获取酒馆助手（TavernHelper / JS-Slash-Runner）公开 API */
export function getTavernHelperApi() {
  const hostWin = getHostWindow();
  const th = globalThis.TavernHelper || (typeof window !== 'undefined' ? window.TavernHelper : null) || hostWin?.TavernHelper || null;
  return th && typeof th === 'object' ? th : null;
}

/** 获取宿主窗口的 toastr 通知接口 */
export function getHostToastr() {
  const hostWin = getHostWindow();
  return hostWin?.toastr || globalThis.toastr || null;
}

/** 获取宿主窗口的 jQuery */
export function getHostJQuery() {
  const hostWin = getHostWindow();
  return hostWin?.jQuery || hostWin?.$ || globalThis.jQuery || globalThis.$ || null;
}

/** 酒馆助手脚本模式：将样式注入宿主主文档 <head>（扩展模式已由 manifest.css 加载） */
export function injectInlineStyles(cssText) {
  if (!cssText) return false;
  const doc = getHostDocument();
  if (!doc?.head) return false;
  if (doc.getElementById(INLINE_STYLE_ID)) return true;

  // 若标准扩展已通过 <link> 加载过 style.css，避免重复注入
  const links = doc.querySelectorAll('link[rel="stylesheet"]');
  for (const link of links) {
    if (String(link.getAttribute('href') || '').includes('st-protagonist-carryover/style.css')) {
      return true;
    }
  }

  const styleEl = doc.createElement('style');
  styleEl.id = INLINE_STYLE_ID;
  styleEl.textContent = cssText;
  doc.head.appendChild(styleEl);
  return true;
}

export function removeInlineStyles() {
  const doc = getHostDocument();
  doc?.getElementById(INLINE_STYLE_ID)?.remove();
}

/**
 * 宿主全局互斥标记：防止同时安装「酒馆扩展」和「酒馆助手脚本」造成重复挂载与双倍注入。
 * 返回 true 表示认领成功（首个实例）；返回 false 表示已有实例运行。
 */
export function claimHostInstance(ownerLabel) {
  const hostWin = getHostWindow();
  if (!hostWin) return true;
  if (hostWin[INSTANCE_FLAG]) {
    console.warn(
      `[ProtagonistCarryover] 检测到已有实例（${String(hostWin[INSTANCE_FLAG])}）运行，当前 ${ownerLabel} 已自动跳过，避免重复按钮或双倍注入。`
    );
    return false;
  }
  hostWin[INSTANCE_FLAG] = ownerLabel || detectRuntimeMode();
  return true;
}

export function releaseHostInstance() {
  const hostWin = getHostWindow();
  if (!hostWin) return;
  try {
    delete hostWin[INSTANCE_FLAG];
  } catch {
    hostWin[INSTANCE_FLAG] = false;
  }
}
