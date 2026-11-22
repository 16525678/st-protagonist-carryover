/**
 * src/storage.js
 * 主角传承库与聊天级绑定状态的持久化管理。
 * 优先使用 SillyTavern.libs.localforage（IndexedDB，大容量、不撑爆 settings.json）；
 * 不可用时自动降级到 SillyTavern.getContext().extensionSettings + saveSettingsDebounced。
 */

import {
  ARCHIVE_FORMAT,
  ARCHIVE_VERSION,
  assertSafeJsonObject,
  deepCloneSafe,
} from './schema-engine.js';

export const MODULE_NAME = 'st_protagonist_carryover';
const LOCALFORAGE_PROFILES_KEY = `${MODULE_NAME}_profiles_v1`;

const DEFAULT_SETTINGS = Object.freeze({
  schemaVersion: 1,
  chatBindings: {},
  fallbackProfiles: [],
  defaultPromptPosition: 'in_chat',
  defaultPromptDepth: 2,
  defaultPromptRole: 'system',
});

function getLocalForage() {
  try {
    const lf = globalThis?.SillyTavern?.libs?.localforage;
    if (lf && typeof lf.getItem === 'function' && typeof lf.setItem === 'function') {
      return lf;
    }
  } catch {
    // 忽略
  }
  return null;
}

export function getExtensionSettings(context) {
  const root = context?.extensionSettings;
  if (!root || typeof root !== 'object') {
    return deepCloneSafe(DEFAULT_SETTINGS);
  }
  if (!root[MODULE_NAME] || typeof root[MODULE_NAME] !== 'object') {
    root[MODULE_NAME] = deepCloneSafe(DEFAULT_SETTINGS);
  }
  const settings = root[MODULE_NAME];
  for (const [key, defVal] of Object.entries(DEFAULT_SETTINGS)) {
    if (!Object.prototype.hasOwnProperty.call(settings, key)) {
      settings[key] = deepCloneSafe(defVal);
    }
  }
  if (!settings.chatBindings || typeof settings.chatBindings !== 'object') {
    settings.chatBindings = {};
  }
  if (!Array.isArray(settings.fallbackProfiles)) {
    settings.fallbackProfiles = [];
  }
  return settings;
}

function saveSettings(context) {
  if (typeof context?.saveSettingsDebounced === 'function') {
    context.saveSettingsDebounced();
  }
}

/** 读取所有已保存的主角传承档案 */
export async function loadProfiles(context) {
  const lf = getLocalForage();
  if (lf) {
    try {
      const saved = await lf.getItem(LOCALFORAGE_PROFILES_KEY);
      if (Array.isArray(saved)) {
        return deepCloneSafe(saved);
      }
      // 首次从 fallbackProfiles 迁移（如果此前在无 localforage 环境存过）
      const settings = getExtensionSettings(context);
      if (settings.fallbackProfiles.length > 0) {
        await lf.setItem(LOCALFORAGE_PROFILES_KEY, deepCloneSafe(settings.fallbackProfiles));
        return deepCloneSafe(settings.fallbackProfiles);
      }
      return [];
    } catch (err) {
      console.warn('[ProtagonistCarryover] localforage read failed, falling back to extensionSettings:', err);
    }
  }
  const settings = getExtensionSettings(context);
  return deepCloneSafe(settings.fallbackProfiles);
}

/** 保存全部主角传承档案列表 */
export async function saveProfiles(context, profiles) {
  const clean = deepCloneSafe(Array.isArray(profiles) ? profiles : []);
  const lf = getLocalForage();
  if (lf) {
    try {
      await lf.setItem(LOCALFORAGE_PROFILES_KEY, clean);
      return { backend: 'localforage' };
    } catch (err) {
      console.warn('[ProtagonistCarryover] localforage write failed, falling back to extensionSettings:', err);
    }
  }
  const settings = getExtensionSettings(context);
  settings.fallbackProfiles = clean;
  saveSettings(context);
  return { backend: 'extensionSettings' };
}

/** 新增或按 id 覆盖更新单份主角档案 */
export async function upsertProfile(context, profile) {
  const profiles = await loadProfiles(context);
  const idx = profiles.findIndex(p => p.id === profile.id);
  const nextProfile = deepCloneSafe({ ...profile, updatedAt: Date.now() });
  if (idx >= 0) {
    nextProfile.createdAt = profiles[idx].createdAt || nextProfile.createdAt;
    profiles[idx] = nextProfile;
  } else {
    profiles.unshift(nextProfile);
  }
  await saveProfiles(context, profiles);
  return { profile: nextProfile, profiles };
}

/** 删除单份主角档案 */
export async function deleteProfile(context, profileId) {
  const profiles = await loadProfiles(context);
  const filtered = profiles.filter(p => p.id !== profileId);
  await saveProfiles(context, filtered);
  return filtered;
}

/** 读取某个聊天绑定的提示词注入配置 */
export function getChatBinding(context, bindingKey) {
  if (!bindingKey) return null;
  const settings = getExtensionSettings(context);
  return settings.chatBindings[bindingKey] ? deepCloneSafe(settings.chatBindings[bindingKey]) : null;
}

/** 写入或更新某个聊天的提示词注入配置 */
export function setChatBinding(context, bindingKey, binding) {
  if (!bindingKey) return;
  const settings = getExtensionSettings(context);
  if (!binding) {
    delete settings.chatBindings[bindingKey];
  } else {
    settings.chatBindings[bindingKey] = deepCloneSafe({
      ...binding,
      updatedAt: Date.now(),
    });
  }
  saveSettings(context);
}

/** 将一份或多份主角档案封装为可分享/备份的标准 JSON 字符串 */
export function serializeProfilesArchive(profiles) {
  const list = Array.isArray(profiles) ? profiles : [profiles];
  const payload = {
    format: ARCHIVE_FORMAT,
    version: ARCHIVE_VERSION,
    exportedAt: new Date().toISOString(),
    profiles: deepCloneSafe(list),
  };
  assertSafeJsonObject(payload);
  return JSON.stringify(payload, null, 2);
}

/** 在浏览器中触发 JSON 文件下载 */
export function triggerJsonDownload(filename, jsonString) {
  const blob = new Blob([jsonString], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
