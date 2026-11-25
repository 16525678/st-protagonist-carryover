/**
 * src/host-env.js
 * 统一宿主窗口、文档与运行模式桥接层。
 * 同时兼容：
 * 1. SillyTavern / TauriTavern 标准前端扩展模式（运行在宿主主窗口 window）
 * 2. 酒馆助手 / Tavern Helper（JS-Slash-Runner）脚本模式（运行在 script iframe，宿主为父级/顶层窗口）
 *
 * 所有跨窗口属性读写均受 try/catch 保护，避免跨域或严格 iframe 沙箱抛出 SecurityError。
 */

export const INSTANCE_FLAG = '__ST_PROTAGONIST_CARRYOVER_LOADED__';
export const INLINE_STYLE_ID = 'pc-carryover-inline-style';

let forcedRuntimeMode = null; // 'extension' | 'tavern-helper' | null

/** 由打包入口或测试显式指定运行模式 */
export function setRuntimeMode(mode) {
  forcedRuntimeMode = mode === 'tavern-helper' || mode === 'extension' ? mode : null;
}

/** 安全读取任意窗口/对象属性，绝不因跨域 SecurityError 抛错 */
export function safeGetProp(obj, prop) {
  if (!obj) return undefined;
  try {
    return obj[prop];
  } catch {
    return undefined;
  }
}

/** 安全写入任意窗口/对象属性 */
export function safeSetProp(obj, prop, value) {
  if (!obj) return false;
  try {
    obj[prop] = value;
    return true;
  } catch {
    return false;
  }
}

function isWindowReadable(win) {
  if (!win) return false;
  try {
    // 尝试读取一个标准属性以确认未被同源策略阻断
    void win.document;
    void win.AutoCardUpdaterAPI;
    return true;
  } catch {
    return false;
  }
}

/** 检测当前运行模式：'tavern-helper'（iframe 脚本）或 'extension'（主窗口扩展） */
export function detectRuntimeMode() {
  if (forcedRuntimeMode) return forcedRuntimeMode;
  try {
    if (typeof window !== 'undefined' && typeof window.parent !== 'undefined' && window.parent !== window) {
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

/**
 * 扫描当前运行环境可触达的全部同源窗口：
 * - 当前 window 沿 parent 链向上直到 top（支持多层嵌套 iframe）
 * - globalThis
 * - 宿主顶层窗口下可访问的同源子 frames（最多扫描 24 个，防止遍历开销）
 * 同时记录是否被跨域/iframe sandbox 拦截，供诊断面板精准展示。
 */
export function collectCandidateWindows() {
  const seen = new Set();
  const ancestors = [];
  let parentAccessBlocked = false;
  let topAccessBlocked = false;
  let blockedFrameCount = 0;

  if (typeof window !== 'undefined' && window) {
    let cur = window;
    let depth = 0;
    while (cur && depth < 8) {
      const label = depth === 0 ? 'window' : depth === 1 ? 'window.parent' : `window.parent^${depth}`;
      if (!seen.has(cur)) {
        seen.add(cur);
        ancestors.push({ win: cur, label });
      }
      let nextParent = null;
      try {
        nextParent = cur.parent;
      } catch {
        parentAccessBlocked = true;
        break;
      }
      if (!nextParent || nextParent === cur) break;
      if (!isWindowReadable(nextParent)) {
        parentAccessBlocked = true;
        break;
      }
      cur = nextParent;
      depth += 1;
    }

    try {
      const topWin = window.top;
      if (topWin && !seen.has(topWin)) {
        if (isWindowReadable(topWin)) {
          seen.add(topWin);
          ancestors.push({ win: topWin, label: 'window.top' });
        } else {
          topAccessBlocked = true;
        }
      } else if (topWin && ancestors.length > 1 && ancestors[ancestors.length - 1].win === topWin) {
        ancestors[ancestors.length - 1].label = 'window.top';
      }
    } catch {
      topAccessBlocked = true;
    }
  }

  // 在 iframe 模式下优先检查最外层可访问的宿主窗口，扩展模式下当前 window 本身就是最外层
  const ordered = isTavernHelperIframeMode() ? [...ancestors].reverse() : [...ancestors];

  if (typeof globalThis !== 'undefined' && globalThis && !seen.has(globalThis)) {
    seen.add(globalThis);
    ordered.push({ win: globalThis, label: 'globalThis' });
  }

  // 扫描宿主同源子 frames（例如同源酒馆助手脚本各自独立的 iframe）
  const frameRoot = ordered[0]?.win || null;
  let sameOriginFramesScanned = 0;
  if (frameRoot) {
    try {
      const frames = frameRoot.frames;
      const len = Math.min(Number(frames?.length || 0), 24);
      for (let i = 0; i < len; i += 1) {
        let child = null;
        try {
          child = frames[i];
        } catch {
          blockedFrameCount += 1;
          continue;
        }
        if (!child || seen.has(child)) continue;
        if (!isWindowReadable(child)) {
          blockedFrameCount += 1;
          continue;
        }
        seen.add(child);
        sameOriginFramesScanned += 1;
        ordered.push({ win: child, label: `frame[${i}]` });
      }
    } catch {
      // ignore
    }
  }

  return {
    windows: ordered,
    parentAccessBlocked,
    topAccessBlocked,
    blockedFrameCount,
    sameOriginFramesScanned,
  };
}

/** 获取酒馆/TauriTavern 主窗口引用（iframe 模式下沿 parent 链取最外层可读宿主窗口，不可读则安全回退到 window） */
export function getHostWindow() {
  if (typeof window === 'undefined') return globalThis;
  if (!isTavernHelperIframeMode()) return window;

  const { windows } = collectCandidateWindows();
  // 优先选带宿主特征（SillyTavern / __TAURITAVERN__ / AutoCardUpdaterAPI / #chat）的祖先窗口
  const ancestorOnly = windows.filter(w => !w.label.startsWith('frame[') && w.label !== 'globalThis');
  for (const entry of ancestorOnly) {
    if (
      safeGetProp(entry.win, 'SillyTavern') ||
      safeGetProp(entry.win, '__TAURITAVERN__') ||
      safeGetProp(entry.win, 'AutoCardUpdaterAPI')
    ) {
      return entry.win;
    }
  }
  return ancestorOnly[0]?.win || window;
}

/** 获取酒馆/TauriTavern 主文档引用（确保弹窗、样式、魔法棒入口挂载到可见宿主页面） */
export function getHostDocument() {
  const win = getHostWindow();
  const hostDoc = safeGetProp(win, 'document');
  if (hostDoc) return hostDoc;
  return typeof document !== 'undefined' ? document : null;
}

function isFlatSillyTavernContext(obj) {
  if (!obj || typeof obj !== 'object') return false;
  return Boolean(
    Array.isArray(safeGetProp(obj, 'chat')) ||
      safeGetProp(obj, 'chatId') !== undefined ||
      safeGetProp(obj, 'eventSource') ||
      safeGetProp(obj, 'extensionSettings')
  );
}

/** 获取 SillyTavern 全局对象（优先找带 getContext 的宿主骨架，次选酒馆助手扁平对象） */
export function getSillyTavernGlobal() {
  const { windows } = collectCandidateWindows();
  let flatFallback = null;
  for (const { win } of windows) {
    const st = safeGetProp(win, 'SillyTavern');
    if (!st || typeof st !== 'object') continue;
    if (typeof safeGetProp(st, 'getContext') === 'function') {
      return st;
    }
    if (!flatFallback && isFlatSillyTavernContext(st)) {
      flatFallback = st;
    }
  }
  return flatFallback;
}

/** 安全获取当前 SillyTavern 上下文（同时兼容主窗口 getContext() 与酒馆助手 iframe 扁平 SillyTavern 对象） */
export function getSillyTavernContextSafe() {
  const { windows } = collectCandidateWindows();
  let flatFallback = null;

  for (const { win } of windows) {
    const st = safeGetProp(win, 'SillyTavern');
    if (!st || typeof st !== 'object') continue;
    const getCtx = safeGetProp(st, 'getContext');
    if (typeof getCtx === 'function') {
      try {
        const ctx = getCtx.call(st);
        if (ctx && typeof ctx === 'object') return ctx;
      } catch (err) {
        console.error('[ProtagonistCarryover] SillyTavern.getContext() failed:', err);
      }
    }
    if (!flatFallback && isFlatSillyTavernContext(st)) {
      flatFallback = st;
    }
  }
  return flatFallback;
}

/** 获取酒馆助手（TavernHelper / JS-Slash-Runner）公开 API */
export function getTavernHelperApi() {
  const direct = safeGetProp(globalThis, 'TavernHelper');
  if (direct && typeof direct === 'object') return direct;
  const { windows } = collectCandidateWindows();
  for (const { win } of windows) {
    const th = safeGetProp(win, 'TavernHelper');
    if (th && typeof th === 'object') return th;
  }
  return null;
}

/** 获取宿主窗口的 toastr 通知接口 */
export function getHostToastr() {
  const hostWin = getHostWindow();
  return safeGetProp(hostWin, 'toastr') || safeGetProp(globalThis, 'toastr') || null;
}

/** 获取宿主窗口的 jQuery */
export function getHostJQuery() {
  const hostWin = getHostWindow();
  return (
    safeGetProp(hostWin, 'jQuery') ||
    safeGetProp(hostWin, '$') ||
    safeGetProp(globalThis, 'jQuery') ||
    safeGetProp(globalThis, '$') ||
    null
  );
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
  const existing = safeGetProp(hostWin, INSTANCE_FLAG);
  if (existing) {
    console.warn(
      `[ProtagonistCarryover] 检测到已有实例（${String(existing)}）运行，当前 ${ownerLabel} 已自动跳过，避免重复按钮或双倍注入。`
    );
    return false;
  }
  safeSetProp(hostWin, INSTANCE_FLAG, ownerLabel || detectRuntimeMode());
  return true;
}

export function releaseHostInstance() {
  const hostWin = getHostWindow();
  if (!hostWin) return;
  try {
    delete hostWin[INSTANCE_FLAG];
  } catch {
    safeSetProp(hostWin, INSTANCE_FLAG, false);
  }
}
