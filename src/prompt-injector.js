/**
 * src/prompt-injector.js
 * 聊天级隔离的提示词注入器。
 * 优先使用 SillyTavern.getContext().setExtensionPrompt；
 * 若宿主版本未在 context 暴露该接口，则自动切换至 manifest 声明的 generate_interceptor 兜底（严格互斥，绝不双倍注入）。
 */

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

let lastChannel = 'idle'; // 'idle' | 'native_setExtensionPrompt' | 'generate_interceptor'

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

/** 立即清空当前聊天的提示词注入 */
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
  lastChannel = 'idle';
}

/**
 * 将某个聊天的绑定配置应用到 SillyTavern 运行时提示词管道
 * @param {object} context SillyTavern.getContext()
 * @param {object|null} binding { enabled, text, position, depth, role, profileId, profileName }
 * @param {string} currentBindingKey 当前聊天标识
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

  if (typeof context?.setExtensionPrompt === 'function') {
    // 原生通道生效时，彻底关闭 generate_interceptor 兜底，保证绝不重复注入
    fallbackState.enabled = false;
    fallbackState.text = '';
    fallbackState.chatBindingKey = '';

    const enums = resolveNativeEnums(context);
    const nativePosition = position === 'before_prompt' ? enums.IN_PROMPT : enums.IN_CHAT;
    const nativeRole = role === 'user' ? enums.ROLE_USER : enums.ROLE_SYSTEM;

    try {
      context.setExtensionPrompt(EXTENSION_PROMPT_KEY, activeText, nativePosition, depth, false, nativeRole);
      lastChannel = 'native_setExtensionPrompt';
      return { active: true, channel: lastChannel };
    } catch (err) {
      console.warn('[ProtagonistCarryover] setExtensionPrompt threw, falling back to generate_interceptor:', err);
    }
  }

  // 兜底通道：通过 manifest.generate_interceptor 注入
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

/**
 * 注册 manifest.json 中声明的 generate_interceptor 全局函数。
 * 注意：仅在原生 setExtensionPrompt 不可用时生效，且自动跳过 quiet 安静模式生成。
 */
export function registerGenerateInterceptor(getCurrentBindingKey) {
  globalThis[INTERCEPTOR_GLOBAL_NAME] = async function protagonistCarryoverInterceptor(chat, _contextSize, _abort, type) {
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
}

export function unregisterGenerateInterceptor() {
  clearPromptInjection(null);
  try {
    delete globalThis[INTERCEPTOR_GLOBAL_NAME];
  } catch {
    globalThis[INTERCEPTOR_GLOBAL_NAME] = undefined;
  }
}
