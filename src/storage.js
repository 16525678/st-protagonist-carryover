/**
 * src/storage.js
 * 主角传承库与聊天级绑定状态的持久化管理（同时适配 TauriTavern、SillyTavern 与酒馆助手脚本模式）。
 *
 * 存储优先级（自动降级）：
 * 1. TauriTavern 原生持久化：hostWindow.__TAURITAVERN__.api.extension.store (setJson / tryGetJson)
 * 2. SillyTavern 内置大容量库：SillyTavern.libs.localforage (IndexedDB)
 * 3. SillyTavern 通用扩展设置：SillyTavern.getContext().extensionSettings + saveSettingsDebounced
 */

import {
  ARCHIVE_FORMAT,
  ARCHIVE_VERSION,
  assertSafeJsonObject,
  deepCloneSafe,
} from './schema-engine.js';
import {
  collectCandidateWindows,
  detectRuntimeMode,
  getHostDocument,
  getHostWindow,
  getSillyTavernGlobal,
  getTavernHelperApi,
  safeGetProp,
} from './host-env.js';

export const MODULE_NAME = 'st_protagonist_carryover';
const TT_STORE_NAMESPACE = 'st-protagonist-carryover';
const TT_STORE_PROFILES_KEY = 'profiles_v1';
const LOCALFORAGE_PROFILES_KEY = `${MODULE_NAME}_profiles_v1`;

const DEFAULT_SETTINGS = Object.freeze({
  schemaVersion: 1,
  chatBindings: {},
  fallbackProfiles: [],
  defaultPromptPosition: 'in_chat',
  defaultPromptDepth: 2,
  defaultPromptRole: 'system',
});

function findTauriTavernGlobal() {
  const { windows } = collectCandidateWindows();
  for (const { win } of windows) {
    const tt = safeGetProp(win, '__TAURITAVERN__');
    if (tt && typeof tt === 'object') return tt;
  }
  return null;
}

/** 检测当前宿主是否为 TauriTavern（Rust + 系统 WebView） */
export function isTauriTavernHost() {
  return Boolean(findTauriTavernGlobal());
}

function getTauriTavernStore() {
  try {
    const tt = findTauriTavernGlobal();
    const store = tt?.api?.extension?.store;
    if (store && typeof store.setJson === 'function' && typeof store.tryGetJson === 'function') {
      return store;
    }
  } catch {
    // 忽略
  }
  return null;
}

function getLocalForage() {
  try {
    const lf = getSillyTavernGlobal()?.libs?.localforage;
    if (lf && typeof lf.getItem === 'function' && typeof lf.setItem === 'function') {
      return lf;
    }
  } catch {
    // 忽略
  }
  return null;
}

export function isMobileViewport() {
  try {
    const win = getHostWindow();
    if (!win) return false;
    if (typeof win.matchMedia === 'function') {
      if (win.matchMedia('(max-width: 768px)').matches) return true;
    }
    return Number(win.innerWidth || 0) > 0 && Number(win.innerWidth) <= 768;
  } catch {
    return false;
  }
}

export function getHostRuntimeSummary() {
  const isTT = isTauriTavernHost();
  const isMobile = isMobileViewport();
  const runtimeMode = detectRuntimeMode();
  const hasTavernHelper = Boolean(getTavernHelperApi());
  const hasTtStore = Boolean(getTauriTavernStore());
  const hasLf = Boolean(getLocalForage());
  const modeBadge = runtimeMode === 'tavern-helper' ? '酒馆助手脚本' : '酒馆扩展';

  return {
    isTauriTavern: isTT,
    isMobile,
    runtimeMode,
    hasTavernHelper,
    hostLabel: `${isTT ? 'TauriTavern' : 'SillyTavern'} · ${isMobile ? '手机端' : '桌面端'} · ${modeBadge}`,
    storageLabel: hasTtStore
      ? 'TT原生存储'
      : hasLf
        ? 'IndexedDB'
        : 'extensionSettings',
  };
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
  const ttStore = getTauriTavernStore();
  if (ttStore) {
    try {
      const res = await ttStore.tryGetJson({
        namespace: TT_STORE_NAMESPACE,
        key: TT_STORE_PROFILES_KEY,
      });
      if (res?.found && Array.isArray(res.value)) {
        return deepCloneSafe(res.value);
      }
    } catch (err) {
      console.warn('[ProtagonistCarryover] TauriTavern store read failed, falling back:', err);
    }
  }

  const lf = getLocalForage();
  if (lf) {
    try {
      const saved = await lf.getItem(LOCALFORAGE_PROFILES_KEY);
      if (Array.isArray(saved) && saved.length > 0) {
        if (ttStore) {
          ttStore.setJson({
            namespace: TT_STORE_NAMESPACE,
            key: TT_STORE_PROFILES_KEY,
            value: deepCloneSafe(saved),
          }).catch(() => {});
        }
        return deepCloneSafe(saved);
      }
    } catch (err) {
      console.warn('[ProtagonistCarryover] localforage read failed, falling back:', err);
    }
  }

  const settings = getExtensionSettings(context);
  if (settings.fallbackProfiles.length > 0) {
    const migrated = deepCloneSafe(settings.fallbackProfiles);
    if (ttStore) {
      ttStore.setJson({
        namespace: TT_STORE_NAMESPACE,
        key: TT_STORE_PROFILES_KEY,
        value: migrated,
      }).catch(() => {});
    } else if (lf) {
      lf.setItem(LOCALFORAGE_PROFILES_KEY, migrated).catch(() => {});
    }
    return migrated;
  }
  return [];
}

/** 保存全部主角传承档案列表 */
export async function saveProfiles(context, profiles) {
  const clean = deepCloneSafe(Array.isArray(profiles) ? profiles : []);

  const ttStore = getTauriTavernStore();
  if (ttStore) {
    try {
      await ttStore.setJson({
        namespace: TT_STORE_NAMESPACE,
        key: TT_STORE_PROFILES_KEY,
        value: clean,
      });
      const lf = getLocalForage();
      if (lf) lf.setItem(LOCALFORAGE_PROFILES_KEY, clean).catch(() => {});
      return { backend: 'tauritavern-store' };
    } catch (err) {
      console.warn('[ProtagonistCarryover] TauriTavern store write failed, falling back:', err);
    }
  }

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

/** 在宿主窗口/Tauri WebView 中触发 JSON 文件下载（兼容酒馆助手 iframe） */
export function triggerJsonDownload(filename, jsonString) {
  const doc = getHostDocument();
  const win = getHostWindow();
  if (!doc || !win) return;
  const BlobCtor = win.Blob || globalThis.Blob;
  const UrlApi = win.URL || globalThis.URL;
  const blob = new BlobCtor([jsonString], { type: 'application/json;charset=utf-8' });
  const url = UrlApi.createObjectURL(blob);
  const link = doc.createElement('a');
  link.href = url;
  link.download = filename;
  doc.body.appendChild(link);
  link.click();
  doc.body.removeChild(link);
  setTimeout(() => UrlApi.revokeObjectURL(url), 1000);
}

/** 手机端 WebView & 酒馆助手 iframe 友好的剪贴板复制 */
export async function copyTextToClipboard(text) {
  const str = String(text ?? '');
  const win = getHostWindow();
  const doc = getHostDocument();
  try {
    const nav = win?.navigator || globalThis.navigator;
    if (nav?.clipboard?.writeText) {
      await nav.clipboard.writeText(str);
      return true;
    }
  } catch {
    // 降级到传统选区复制
  }
  try {
    if (!doc?.body) return false;
    const ta = doc.createElement('textarea');
    ta.value = str;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    ta.style.top = '0';
    doc.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, str.length);
    const ok = doc.execCommand('copy');
    doc.body.removeChild(ta);
    return Boolean(ok);
  } catch {
    return false;
  }
}
