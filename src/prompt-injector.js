/**
 * src/prompt-injector.js
 * 聊天级隔离的三通道互斥提示词注入器（同时兼容标准扩展与酒馆助手 Tavern Helper）：
 * 1. 首选：SillyTavern.getContext().setExtensionPrompt（原生核心接口）
 * 2. 次选：TavernHelper.injectPrompts / uninjectPrompts（酒馆助手原生接口，特别适配旧版 ST + 酒馆助手脚本模式）
 * 3. 兜底：manifest.json 声明的 generate_interceptor（标准扩展模式兜底）
 * 三条通道严格互斥，绝不双倍注入。
 */

import { getHostWindow, getTavernHelperApi } from './host-env.js';

export const EXTENSION_PROMPT_KEY = 'st_protagonist_carryover_prompt';
export const INTERCEPTOR_GLOBAL_NAME = 'ProtagonistCarryover_interceptGeneration';

const fallbackState = {
  enabled: false,
  text: '',
  position: 'in_chat', // 'in_chat' | 'before_prompt'
  depth: 2,
  role: 'system', // 'system' | 'user'
  chatBindingKey: '',
};

let lastChannel = 'idle'; // 'idle' | 'native_setExtensionPrompt' | 'tavern_helper_injectPrompts' | 'generate_interceptor'
let activeTavernHelperDisposer = null;

function resolveNativeEnums(context) {
  const types = context?.extension_prompt_types || context?.extensionPromptTypes || {};
  const roles = context?.extension_prompt_roles || context?.extensionPromptRoles || {};
  return {
    IN_PROMPT: types.IN_PROMPT ?? 0,
    IN_CHAT: types.IN_CHAT ?? 1,
    BEFORE_PROMPT: types.BEFORE_PROMPT ?? 2,
    ROLE_SYSTEM: roles.SYSTEM ?? 0,
    ROLE_USER: roles.USER ?? 1,
    ROLE_ASSISTANT: roles.ASSISTANT ?? 2,
  };
}

function clearTavernHelperInjection() {
  if (typeof activeTavernHelperDisposer === 'function') {
    try {
      activeTavernHelperDisposer();
    } catch {
      // ignore
    }
    activeTavernHelperDisposer = null;
  }
  const th = getTavernHelperApi();
  const uninject = th?.uninjectPrompts || globalThis.uninjectPrompts;
  if (typeof uninject === 'function') {
    try {
      uninject([EXTENSION_PROMPT_KEY]);
    } catch {
      // ignore
    }
  }
}

/** 立即清空当前聊天的所有通道提示词注入 */
export function clearPromptInjection(context) {
  fallbackState.enabled = false;
  fallbackState.text = '';
  fallbackState.chatBindingKey = '';

  if (typeof context?.setExtensionPrompt === 'function') {
    const enums = resolveNativeEnums(context);
    try {
      context.setExtensionPrompt(EXTENSION_PROMPT_KEY, '', enums.IN_CHAT, 0, false, enums.ROLE_SYSTEM);
    } catch (err) {
      console.warn('[ProtagonistCarryover] clear setExtensionPrompt failed:', err);
    }
  }

  clearTavernHelperInjection();
  lastChannel = 'idle';
}

/**
 * 将某个聊天的绑定配置应用到提示词管道（三通道严格互斥）
 */
export function applyChatPromptInjection(context, binding, currentBindingKey) {
  const activeText = binding?.enabled && typeof binding.text === 'string' ? binding.text.trim() : '';
  if (!activeText || !currentBindingKey) {
    clearPromptInjection(context);
    return { active: false, channel: 'idle' };
  }

  const position = binding.position === 'before_prompt' ? 'before_prompt' : 'in_chat';
  const depth = Number.isFinite(Number(binding.depth)) ? Math.max(0, Math.min(99, Math.floor(Number(binding.depth)))) : 2;
  const role = binding.role === 'user' ? 'user' : 'system';

  // 通道 1：SillyTavern 原生 setExtensionPrompt
  if (typeof context?.setExtensionPrompt === 'function') {
    fallbackState.enabled = false;
    fallbackState.text = '';
    fallbackState.chatBindingKey = '';
    clearTavernHelperInjection();

    const enums = resolveNativeEnums(context);
    const nativePosition = position === 'before_prompt' ? enums.IN_PROMPT : enums.IN_CHAT;
    const nativeRole = role === 'user' ? enums.ROLE_USER : enums.ROLE_SYSTEM;

    try {
      context.setExtensionPrompt(EXTENSION_PROMPT_KEY, activeText, nativePosition, depth, false, nativeRole);
      lastChannel = 'native_setExtensionPrompt';
      return { active: true, channel: lastChannel };
    } catch (err) {
      console.warn('[ProtagonistCarryover] setExtensionPrompt threw, trying TavernHelper fallback:', err);
    }
  }

  // 通道 2：酒馆助手 TavernHelper.injectPrompts（注意：position 必须为 'in_chat' 才会发给 AI）
  const th = getTavernHelperApi();
  const injectFn = th?.injectPrompts || globalThis.injectPrompts;
  if (typeof injectFn === 'function') {
    fallbackState.enabled = false;
    fallbackState.text = '';
    fallbackState.chatBindingKey = '';
    clearTavernHelperInjection();

    try {
      const thDepth = position === 'before_prompt' ? 9999 : depth;
      const handle = injectFn(
        [
          {
            id: EXTENSION_PROMPT_KEY,
            position: 'in_chat',
            depth: thDepth,
            role,
            content: activeText,
            should_scan: false,
          },
        ],
        { once: false }
      );
      activeTavernHelperDisposer = typeof handle?.uninject === 'function' ? handle.uninject : null;
      lastChannel = 'tavern_helper_injectPrompts';
      return { active: true, channel: lastChannel };
    } catch (err) {
      console.warn('[ProtagonistCarryover] TavernHelper.injectPrompts threw, falling back to generate_interceptor:', err);
    }
  }

  // 通道 3：扩展 manifest.generate_interceptor 兜底
  fallbackState.enabled = true;
  fallbackState.text = activeText;
  fallbackState.position = position;
  fallbackState.depth = depth;
  fallbackState.role = role;
  fallbackState.chatBindingKey = currentBindingKey;
  lastChannel = 'generate_interceptor';
  return { active: true, channel: lastChannel };
}

export function getActiveInjectionStatus() {
  return {
    channel: lastChannel,
    fallbackActive: fallbackState.enabled,
  };
}

export function getChannelDisplayName(channel) {
  if (channel === 'native_setExtensionPrompt') return 'ST原生通道';
  if (channel === 'tavern_helper_injectPrompts') return '酒馆助手通道';
  if (channel === 'generate_interceptor') return '拦截器兜底';
  return '未启用';
}

/**
 * 注册 manifest.json 声明的 generate_interceptor 全局函数。
 * 挂到宿主窗口 globalThis / hostWin，仅在通道 1 和通道 2 均不可用时激活，自动跳过 quiet 生成。
 */
export function registerGenerateInterceptor(getCurrentBindingKey) {
  const fn = async function protagonistCarryoverInterceptor(chat, _contextSize, _abort, type) {
    if (!fallbackState.enabled || !fallbackState.text) return;
    if (type === 'quiet') return;
    if (!Array.isArray(chat)) return;

    if (typeof getCurrentBindingKey === 'function') {
      const liveKey = getCurrentBindingKey();
      if (!liveKey || liveKey !== fallbackState.chatBindingKey) return;
    }

    const injectedMessage = {
      is_user: fallbackState.role === 'user',
      is_system: fallbackState.role !== 'user',
      name: fallbackState.role === 'user' ? 'User' : 'System',
      send_date: Date.now(),
      mes: fallbackState.text,
    };

    if (fallbackState.position === 'before_prompt') {
      chat.unshift(injectedMessage);
    } else {
      const insertAt = Math.max(0, chat.length - fallbackState.depth);
      chat.splice(insertAt, 0, injectedMessage);
    }
  };

  globalThis[INTERCEPTOR_GLOBAL_NAME] = fn;
  const hostWin = getHostWindow();
  if (hostWin && hostWin !== globalThis) {
    try {
      hostWin[INTERCEPTOR_GLOBAL_NAME] = fn;
    } catch {
      // ignore
    }
  }
}

export function unregisterGenerateInterceptor() {
  clearPromptInjection(null);
  const targets = [globalThis, getHostWindow()].filter(Boolean);
  for (const target of targets) {
    try {
      delete target[INTERCEPTOR_GLOBAL_NAME];
    } catch {
      target[INTERCEPTOR_GLOBAL_NAME] = undefined;
    }
  }
}
