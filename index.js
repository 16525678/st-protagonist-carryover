/**
 * index.js — 主角跨聊天传承（适配龙血玄黄·数据库）统一入口。
 *
 * 双形态兼容：
 * 1. 标准 SillyTavern / TauriTavern 前端扩展（通过 manifest.json 加载在主窗口）
 * 2. 酒馆助手 / Tavern Helper（JS-Slash-Runner）全局脚本（运行在 script iframe，宿主为 window.parent）
 *
 * 特性：
 * - 宿主全局互斥标记，同时装了扩展和脚本也不会重复按钮或双倍注入；
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
  isTavernHelperIframeMode,
  releaseHostInstance,
  removeInlineStyles,
  setRuntimeMode,
} from './src/host-env.js';
import { getCurrentChatIdentity } from './src/acu-adapter.js';
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

/** 在酒馆助手脚本模式下绑定脚本按钮与酒馆助手事件（如 CHAT_CHANGED） */
function bindTavernHelperHooks(workbench) {
  try {
    const eventOnFn = globalThis.eventOn;
    const getButtonEventFn = globalThis.getButtonEvent;
    if (typeof eventOnFn === 'function' && typeof getButtonEventFn === 'function') {
      const btnEvent = getButtonEventFn(TAVERN_HELPER_BUTTON_NAME);
      if (btnEvent) {
        const handle = eventOnFn(btnEvent, () => {
          workbench.openWorkbench();
        });
        if (typeof handle?.stop === 'function') {
          tavernHelperDisposers.push(() => handle.stop());
        }
      }
    }
  } catch (err) {
    console.warn('[ProtagonistCarryover] TavernHelper button hook skipped:', err);
  }
}

/** 部分移动端/酒馆助手启动时 #extensionsMenu 稍晚就绪，做短暂轮询挂载（最多 15 秒自动停止） */
function scheduleMountRetries(workbench) {
  if (wandRetryTimer) {
    clearInterval(wandRetryTimer);
    wandRetryTimer = null;
  }
  let attempts = 0;
  wandRetryTimer = setInterval(() => {
    attempts += 1;
    const doc = getHostDocument();
    const hasDrawer = Boolean(doc?.getElementById('pc-settings-drawer'));
    const hasWand = Boolean(doc?.getElementById('pc-wand-menu-item'));
    if (!hasDrawer || !hasWand) {
      workbench.mountSettingsDrawer();
    }
    if ((hasDrawer && hasWand) || attempts >= 20) {
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

  if (options.inlineCss) {
    injectInlineStyles(options.inlineCss);
  }

  registerGenerateInterceptor(() => {
    const liveCtx = getSillyTavernContextSafe();
    return getCurrentChatIdentity(liveCtx).bindingKey;
  });

  controller = createWorkbenchController({ getContext: getSillyTavernContextSafe });
  controller.mountSettingsDrawer();
  scheduleMountRetries(controller);

  // 初始化当前聊天的提示词绑定（如果有）
  const identity = getCurrentChatIdentity(ctx);
  const binding = getChatBinding(ctx, identity.bindingKey);
  applyChatPromptInjection(ctx, binding, identity.bindingKey);
  controller.updateSettingsDrawerStatus();

  // 订阅切换聊天事件（切聊天自动隔离/切换注入）
  const eventSource = ctx.eventSource;
  const eventTypes = ctx.event_types || ctx.eventTypes;
  if (eventSource?.on && eventTypes?.CHAT_CHANGED) {
    chatChangedHandler = () => {
      controller?.onChatChanged();
    };
    boundEventSource = eventSource;
    boundChatChangedEvent = eventTypes.CHAT_CHANGED;
    eventSource.on(boundChatChangedEvent, chatChangedHandler);
  }

  registerSlashCommandIfSupported(ctx, controller);
  bindTavernHelperHooks(controller);

  const publicApi = {
    mode,
    openWorkbench: (tab) => controller?.openWorkbench(tab),
    closeWorkbench: () => controller?.closeWorkbench(),
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

/** 确定性清理：移除事件监听、酒馆助手按钮监听、定时器、提示词注入、内联样式与 DOM 节点 */
export function dispose() {
  if (wandRetryTimer) {
    clearInterval(wandRetryTimer);
    wandRetryTimer = null;
  }

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
  const jq = getHostJQuery();

  if (typeof jq === 'function') {
    jq(() => {
      tryStart();
    });
  } else {
    const doc = getHostDocument();
    if (doc) {
      if (doc.readyState === 'loading') {
        doc.addEventListener('DOMContentLoaded', tryStart, { once: true });
      } else {
        tryStart();
      }
    }
  }

  const earlyCtx = getSillyTavernContextSafe();
  const earlyEventTypes = earlyCtx?.event_types || earlyCtx?.eventTypes;
  if (earlyCtx?.eventSource?.once && earlyEventTypes?.APP_READY) {
    earlyCtx.eventSource.once(earlyEventTypes.APP_READY, () => {
      tryStart();
      controller?.mountSettingsDrawer();
      controller?.onChatChanged();
    });
  }
}

// 作为标准扩展直接被加载时自动启动（打包器中会用带 inlineCss 的引导替换此行）
if (typeof window !== 'undefined' && !globalThis.__PC_DISABLE_AUTO_BOOTSTRAP__) {
  autoBootstrap();
}
