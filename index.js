/**
 * index.js — 主角跨聊天传承（适配龙血玄黄·数据库）SillyTavern UI Extension 入口。
 *
 * 兼容路径：
 * - 仅使用稳定的 SillyTavern.getContext()，不使用脆弱的相对路径内部 import；
 * - 幂等初始化（jQuery ready + APP_READY 兜底），兼容 ST v1.14–v1.18+；
 * - 所有事件监听器、DOM 节点、提示词注入与拦截器均配对确定性清理函数 dispose()。
 */

import { getCurrentChatIdentity } from './src/acu-adapter.js';
import {
  applyChatPromptInjection,
  clearPromptInjection,
  registerGenerateInterceptor,
  unregisterGenerateInterceptor,
} from './src/prompt-injector.js';
import { getChatBinding } from './src/storage.js';
import { createWorkbenchController } from './src/ui.js';

let initialized = false;
let controller = null;
let boundEventSource = null;
let boundChatChangedEvent = null;
let chatChangedHandler = null;

function getStContextSafe() {
  try {
    if (typeof globalThis.SillyTavern?.getContext === 'function') {
      return globalThis.SillyTavern.getContext();
    }
  } catch (err) {
    console.error('[ProtagonistCarryover] SillyTavern.getContext() failed:', err);
  }
  return null;
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

function initOnce() {
  if (initialized) return;
  const ctx = getStContextSafe();
  if (!ctx) return;

  initialized = true;

  registerGenerateInterceptor(() => {
    const liveCtx = getStContextSafe();
    return getCurrentChatIdentity(liveCtx).bindingKey;
  });

  controller = createWorkbenchController({ getContext: getStContextSafe });
  controller.mountSettingsDrawer();

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

  globalThis.ProtagonistCarryover = {
    openWorkbench: (tab) => controller?.openWorkbench(tab),
    closeWorkbench: () => controller?.closeWorkbench(),
    dispose,
  };
}

/** 确定性清理：移除事件监听、清空提示词注入、卸载 UI 与拦截器 */
export function dispose() {
  if (boundEventSource?.removeListener && boundChatChangedEvent && chatChangedHandler) {
    boundEventSource.removeListener(boundChatChangedEvent, chatChangedHandler);
  }
  boundEventSource = null;
  boundChatChangedEvent = null;
  chatChangedHandler = null;

  clearPromptInjection(getStContextSafe());
  unregisterGenerateInterceptor();
  controller?.closeWorkbench();
  controller?.unmountSettingsDrawer();
  controller = null;
  initialized = false;
}

// 幂等引导：兼容 v1.14–v1.18+ 的模块加载时序
if (typeof globalThis.jQuery === 'function') {
  globalThis.jQuery(() => {
    initOnce();
  });
} else if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initOnce, { once: true });
  } else {
    initOnce();
  }
}

const earlyCtx = getStContextSafe();
const earlyEventTypes = earlyCtx?.event_types || earlyCtx?.eventTypes;
if (earlyCtx?.eventSource?.once && earlyEventTypes?.APP_READY) {
  earlyCtx.eventSource.once(earlyEventTypes.APP_READY, () => {
    initOnce();
    controller?.mountSettingsDrawer();
    controller?.onChatChanged();
  });
}
