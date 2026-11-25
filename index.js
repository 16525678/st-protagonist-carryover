/**
 * index.js — 主角跨聊天传承（适配龙血玄黄·数据库）统一入口。
 *
 * 双形态兼容：
 * 1. 标准 SillyTavern / TauriTavern 前端扩展（通过 manifest.json 加载在主窗口）
 * 2. 酒馆助手 / Tavern Helper（JS-Slash-Runner）全局脚本（运行在 script iframe，宿主为父/顶层窗口）
 *
 * 特性：
 * - 宿主全局互斥标记，同时装了扩展和脚本也不会重复按钮或双倍注入；
 * - 自动订阅龙血玄黄数据库 registerTableUpdateCallback，并在切聊天后补检（适配 ACU 1200ms 延迟水合）；
 * - 酒馆助手模式下自动向宿主文档注入样式、绑定脚本快捷按钮，并在脚本关闭/重载时确定性清理；
 * - 兼容 ST v1.14–v1.18+ 与 TauriTavern 桌面/手机端。
 */

import {
  claimHostInstance,
  detectRuntimeMode,
  getHostDocument,
  getHostJQuery,
  getHostWindow,
  getSillyTavernContextSafe,
  injectInlineStyles,
  INSTANCE_FLAG,
  isTavernHelperIframeMode,
  releaseHostInstance,
  removeInlineStyles,
  safeGetProp,
  setRuntimeMode,
} from './src/host-env.js';
import {
  collectAcuDiagnostics,
  detectAcuApi,
  getCurrentChatIdentity,
} from './src/acu-adapter.js';
import {
  applyChatPromptInjection,
  clearPromptInjection,
  registerGenerateInterceptor,
  unregisterGenerateInterceptor,
} from './src/prompt-injector.js';
import { getChatBinding } from './src/storage.js';
import { createWorkbenchController } from './src/ui.js';

export const TAVERN_HELPER_BUTTON_NAME = '打开主角传承工作台';

let initialized = false;
let controller = null;
let boundEventSource = null;
let boundChatChangedEvent = null;
let chatChangedHandler = null;
let tavernHelperDisposers = [];
let wandRetryTimer = null;
let bootstrapRetryTimer = null;
let postChatSyncTimers = [];
let subscribedAcuApi = null;
let acuTableUpdateCallback = null;

function clearPostChatSyncTimers() {
  for (const timer of postChatSyncTimers) {
    clearTimeout(timer);
  }
  postChatSyncTimers = [];
}

/** 绑定龙血玄黄数据库的表格更新回调（数据库异步加载或换聊天水合完成后自动同步状态） */
function ensureAcuTableUpdateSubscription() {
  const acu = detectAcuApi();
  if (!acu.available || !acu.capabilities.canSubscribe) return false;
  if (subscribedAcuApi === acu.api && acuTableUpdateCallback) return true;

  detachAcuTableUpdateSubscription();
  const cb = () => {
    try {
      controller?.onAcuTablesUpdated();
    } catch (err) {
      console.warn('[ProtagonistCarryover] ACU table update sync error:', err);
    }
  };
  try {
    acu.api.registerTableUpdateCallback(cb);
    subscribedAcuApi = acu.api;
    acuTableUpdateCallback = cb;
    return true;
  } catch (err) {
    console.warn('[ProtagonistCarryover] registerTableUpdateCallback skipped:', err);
    return false;
  }
}

function detachAcuTableUpdateSubscription() {
  if (subscribedAcuApi && acuTableUpdateCallback) {
    try {
      if (typeof subscribedAcuApi.unregisterTableUpdateCallback === 'function') {
        subscribedAcuApi.unregisterTableUpdateCallback(acuTableUpdateCallback);
      }
    } catch {
      // ignore
    }
  }
  subscribedAcuApi = null;
  acuTableUpdateCallback = null;
}

/**
 * 龙血玄黄数据库在 CHAT_CHANGED 时会先清空内存表，再延迟 1200ms 异步回放与水合。
 * 这里立即响应切聊天（隔离提示词），并在 1.6s / 3.5s 各做一次极轻量补检，
 * 即使遇到未暴露 registerTableUpdateCallback 的旧版数据库也能自动刷新为“已连接”。
 */
function handleChatChangedLifecycle() {
  ensureAcuTableUpdateSubscription();
  controller?.onChatChanged();
  clearPostChatSyncTimers();
  for (const delayMs of [1600, 3500]) {
    const timer = setTimeout(() => {
      ensureAcuTableUpdateSubscription();
      controller?.onAcuTablesUpdated();
    }, delayMs);
    postChatSyncTimers.push(timer);
  }
}

function registerSlashCommandIfSupported(ctx, workbench) {
  try {
    const { SlashCommandParser, SlashCommand } = ctx || {};
    if (!SlashCommandParser?.addCommandObject || !SlashCommand?.fromProps) return;
    if (SlashCommandParser.commands?.['protagonist-carryover']) return;
    SlashCommandParser.addCommandObject(
      SlashCommand.fromProps({
        name: 'protagonist-carryover',
        aliases: ['carryover', 'pc-open'],
        callback: () => {
          ensureAcuTableUpdateSubscription();
          workbench.openWorkbench();
          return '';
        },
        helpString: '打开「主角跨聊天传承」工作台（适配龙血玄黄·数据库）。',
      })
    );
  } catch (err) {
    console.warn('[ProtagonistCarryover] optional slash command registration skipped:', err);
  }
}

/** 在酒馆助手脚本模式下绑定脚本按钮与酒馆助手事件（含 CHAT_CHANGED 兜底） */
function bindTavernHelperHooks(workbench, nativeChatEventBound) {
  try {
    const eventOnFn = globalThis.eventOn;
    const getButtonEventFn = globalThis.getButtonEvent;
    if (typeof eventOnFn === 'function' && typeof getButtonEventFn === 'function') {
      const btnEvent = getButtonEventFn(TAVERN_HELPER_BUTTON_NAME);
      if (btnEvent) {
        const handle = eventOnFn(btnEvent, () => {
          ensureAcuTableUpdateSubscription();
          workbench.openWorkbench();
        });
        if (typeof handle?.stop === 'function') {
          tavernHelperDisposers.push(() => handle.stop());
        }
      }
    }

    // 若原生 ctx.eventSource 未成功绑定 CHAT_CHANGED，则通过酒馆助手全局 eventOn 兜底订阅
    const thChatChanged = globalThis.tavern_events?.CHAT_CHANGED;
    if (!nativeChatEventBound && typeof eventOnFn === 'function' && thChatChanged) {
      const handle = eventOnFn(thChatChanged, () => {
        handleChatChangedLifecycle();
      });
      if (typeof handle?.stop === 'function') {
        tavernHelperDisposers.push(() => handle.stop());
      }
    }
  } catch (err) {
    console.warn('[ProtagonistCarryover] TavernHelper hook binding skipped:', err);
  }
}

/**
 * 启动后短暂轮询（最多 ~20 秒自动停止）：
 * 1. 确保 #extensionsMenu 魔法棒入口与扩展设置抽屉挂载到位；
 * 2. 等待后加载的龙血玄黄数据库（尤其是酒馆助手脚本晚于扩展加载的场景）出现并自动绑定更新回调、刷新抽屉状态。
 */
function scheduleMountRetries(workbench) {
  if (wandRetryTimer) {
    clearInterval(wandRetryTimer);
    wandRetryTimer = null;
  }
  let attempts = 0;
  let lastAcuFound = detectAcuApi().available;
  wandRetryTimer = setInterval(() => {
    attempts += 1;
    const doc = getHostDocument();
    const hasDrawer = Boolean(doc?.getElementById('pc-settings-drawer'));
    const hasWand = Boolean(doc?.getElementById('pc-wand-menu-item'));
    if (!hasDrawer || !hasWand) {
      workbench.mountSettingsDrawer();
    }

    const subscribed = ensureAcuTableUpdateSubscription();
    const acuNow = detectAcuApi().available;
    if (acuNow !== lastAcuFound || attempts === 2 || attempts === 4 || attempts === 8) {
      lastAcuFound = acuNow;
      workbench.onAcuTablesUpdated();
    }

    if (hasDrawer && hasWand && subscribed && attempts >= 4) {
      clearInterval(wandRetryTimer);
      wandRetryTimer = null;
      return;
    }
    if (attempts >= 26) {
      clearInterval(wandRetryTimer);
      wandRetryTimer = null;
    }
  }, 750);
}

/**
 * 幂等启动入口（同时供标准扩展与酒馆助手打包脚本调用）
 * @param {object} [options]
 * @param {'extension'|'tavern-helper'} [options.mode]
 * @param {string} [options.inlineCss] 酒馆助手脚本模式内联注入的 CSS 文本
 */
export function startProtagonistCarryover(options = {}) {
  if (initialized) return true;
  if (options.mode) setRuntimeMode(options.mode);

  const ctx = getSillyTavernContextSafe();
  if (!ctx) return false;

  const mode = detectRuntimeMode();
  if (!claimHostInstance(mode)) {
    return false;
  }

  initialized = true;
  if (bootstrapRetryTimer) {
    clearInterval(bootstrapRetryTimer);
    bootstrapRetryTimer = null;
  }

  if (options.inlineCss) {
    injectInlineStyles(options.inlineCss);
  }

  registerGenerateInterceptor(() => {
    const liveCtx = getSillyTavernContextSafe();
    return getCurrentChatIdentity(liveCtx).bindingKey;
  });

  controller = createWorkbenchController({
    getContext: getSillyTavernContextSafe,
    onBeforeOpen: () => ensureAcuTableUpdateSubscription(),
  });
  controller.mountSettingsDrawer();
  ensureAcuTableUpdateSubscription();
  scheduleMountRetries(controller);

  // 初始化当前聊天的提示词绑定（如果有）
  const identity = getCurrentChatIdentity(ctx);
  const binding = getChatBinding(ctx, identity.bindingKey);
  applyChatPromptInjection(ctx, binding, identity.bindingKey);
  controller.updateSettingsDrawerStatus();

  // 启动后安排两次轻量状态刷新，等待 ACU 完成 1000ms+ 初始水合
  for (const delayMs of [1500, 3500]) {
    const timer = setTimeout(() => {
      ensureAcuTableUpdateSubscription();
      controller?.onAcuTablesUpdated();
    }, delayMs);
    postChatSyncTimers.push(timer);
  }

  // 订阅切换聊天事件（切聊天自动隔离/切换注入 + 延后补检数据库水合）
  let nativeChatEventBound = false;
  const eventSource = ctx.eventSource;
  const eventTypes = ctx.event_types || ctx.eventTypes;
  if (eventSource?.on && eventTypes?.CHAT_CHANGED) {
    chatChangedHandler = () => {
      handleChatChangedLifecycle();
    };
    boundEventSource = eventSource;
    boundChatChangedEvent = eventTypes.CHAT_CHANGED;
    eventSource.on(boundChatChangedEvent, chatChangedHandler);
    nativeChatEventBound = true;
  }

  registerSlashCommandIfSupported(ctx, controller);
  bindTavernHelperHooks(controller, nativeChatEventBound);

  const publicApi = {
    mode,
    openWorkbench: (tab) => {
      ensureAcuTableUpdateSubscription();
      return controller?.openWorkbench(tab);
    },
    closeWorkbench: () => controller?.closeWorkbench(),
    collectDiagnostics: () => collectAcuDiagnostics(getSillyTavernContextSafe()),
    dispose,
  };
  globalThis.ProtagonistCarryover = publicApi;
  const hostWin = getHostWindow();
  if (hostWin && hostWin !== globalThis) {
    try {
      hostWin.ProtagonistCarryover = publicApi;
    } catch {
      // ignore
    }
  }

  // 酒馆助手脚本关闭/重载时会销毁 iframe，监听当前 iframe 卸载事件做彻底清理
  if (isTavernHelperIframeMode() && typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    const onIframeUnload = () => dispose();
    window.addEventListener('pagehide', onIframeUnload, { once: true });
    window.addEventListener('unload', onIframeUnload, { once: true });
    tavernHelperDisposers.push(() => {
      window.removeEventListener('pagehide', onIframeUnload);
      window.removeEventListener('unload', onIframeUnload);
    });
  }

  return true;
}

/** 确定性清理：移除事件监听、ACU 回调、酒馆助手按钮监听、定时器、提示词注入、内联样式与 DOM 节点 */
export function dispose() {
  if (wandRetryTimer) {
    clearInterval(wandRetryTimer);
    wandRetryTimer = null;
  }
  if (bootstrapRetryTimer) {
    clearInterval(bootstrapRetryTimer);
    bootstrapRetryTimer = null;
  }
  clearPostChatSyncTimers();
  detachAcuTableUpdateSubscription();

  if (boundEventSource?.removeListener && boundChatChangedEvent && chatChangedHandler) {
    boundEventSource.removeListener(boundChatChangedEvent, chatChangedHandler);
  }
  boundEventSource = null;
  boundChatChangedEvent = null;
  chatChangedHandler = null;

  for (const stopFn of tavernHelperDisposers) {
    try {
      stopFn();
    } catch {
      // ignore
    }
  }
  tavernHelperDisposers = [];

  clearPromptInjection(getSillyTavernContextSafe());
  unregisterGenerateInterceptor();
  controller?.closeWorkbench();
  controller?.unmountSettingsDrawer();
  controller = null;
  removeInlineStyles();
  releaseHostInstance();
  initialized = false;
}

/** 自动引导（仅在浏览器/酒馆环境运行，Node 单元测试 import 时不误触发） */
export function autoBootstrap(options = {}) {
  const tryStart = () => startProtagonistCarryover(options);

  const startWithBoundedRetry = () => {
    if (tryStart()) return;
    // 若已被另一个实例认领互斥标记，无需重试
    if (safeGetProp(getHostWindow(), INSTANCE_FLAG)) return;
    if (bootstrapRetryTimer) return;
    let retries = 0;
    bootstrapRetryTimer = setInterval(() => {
      retries += 1;
      if (tryStart() || safeGetProp(getHostWindow(), INSTANCE_FLAG) || retries >= 20) {
        clearInterval(bootstrapRetryTimer);
        bootstrapRetryTimer = null;
      }
    }, 500);
  };

  const jq = getHostJQuery();
  if (typeof jq === 'function') {
    jq(() => {
      startWithBoundedRetry();
    });
  } else {
    const doc = getHostDocument();
    if (doc) {
      if (doc.readyState === 'loading') {
        doc.addEventListener('DOMContentLoaded', startWithBoundedRetry, { once: true });
      } else {
        startWithBoundedRetry();
      }
    } else {
      startWithBoundedRetry();
    }
  }

  const earlyCtx = getSillyTavernContextSafe();
  const earlyEventTypes = earlyCtx?.event_types || earlyCtx?.eventTypes;
  if (earlyCtx?.eventSource?.once && earlyEventTypes?.APP_READY) {
    earlyCtx.eventSource.once(earlyEventTypes.APP_READY, () => {
      startWithBoundedRetry();
      controller?.mountSettingsDrawer();
      handleChatChangedLifecycle();
    });
  }
}

// 作为标准扩展直接被加载时自动启动（打包器中会用带 inlineCss 的引导替换此行）
if (typeof window !== 'undefined' && !globalThis.__PC_DISABLE_AUTO_BOOTSTRAP__) {
  autoBootstrap();
}
