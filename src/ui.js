/**
 * src/ui.js
 * 桌面端 + 手机端（TauriTavern / SillyTavern）双端高性能工作台。
 *
 * 性能与双端体验核心设计：
 * 1. 零输入框浏览：表格行默认渲染为极轻量静态文本，按需点「编辑」才为该行挂载 <input>，彻底消除手机 WebView 滑动卡顿与误弹输入法；
 * 2. 双端自适应布局：宽屏（>768px）保持桌面表格与三栏映射对照；窄屏（≤768px）自动切换为全屏抽屉 + 竖排卡片流 + 单列大触控区；
 * 3. 统一事件委托 + 局部 DOM 补丁：.pc-body 仅挂载 3 个持久化监听器，勾选/展开/改映射均原地更新，0 跳顶、0 整页重绘；
 * 4. 手机 WebView 友好：支持魔法棒一键打开、剪贴板复制/粘贴 JSON 导入导出，以及弹窗打开时锁定底层聊天滚动防穿透；
 * 5. 所有动态数据拼装 HTML 均经过 escapeHtml 转义（防 XSS）。
 */

import {
  buildDefaultColumnMappings,
  buildDefaultMappingPlan,
  compileWritePlan,
  createProtagonistProfile,
  deepCloneSafe,
  extractSheetsFromTableData,
  formatTablesAsCarryoverText,
  inferProtagonistName,
  isDefaultProtagonistRole,
  parseImportedSourceJson,
} from './schema-engine.js';
import {
  executeCompiledWritePlan,
  getCurrentChatIdentity,
  probeAcuStatusLight,
  readCurrentChatAcuTables,
} from './acu-adapter.js';
import {
  applyChatPromptInjection,
  clearPromptInjection,
  getActiveInjectionStatus,
  getChannelDisplayName,
} from './prompt-injector.js';
import {
  getHostDocument,
  getHostToastr,
  getHostWindow,
} from './host-env.js';
import {
  copyTextToClipboard,
  deleteProfile,
  getChatBinding,
  getExtensionSettings,
  getHostRuntimeSummary,
  isMobileViewport,
  loadProfiles,
  serializeProfilesArchive,
  setChatBinding,
  triggerJsonDownload,
  upsertProfile,
} from './storage.js';

const MODAL_ID = 'pc-workbench-overlay';
const DRAWER_ID = 'pc-settings-drawer';
const WAND_ITEM_ID = 'pc-wand-menu-item';
const LOCK_SCROLL_CLASS = 'pc-lock-scroll';

function getPageSizeRows() {
  return isMobileViewport() ? 15 : 30;
}

function getPageSizeOps() {
  return isMobileViewport() ? 15 : 30;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatTime(ts) {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return '';
  }
}

function notifyToast(type, message) {
  try {
    const toastrApi = getHostToastr();
    if (typeof toastrApi?.[type] === 'function') {
      toastrApi[type](message, '主角跨聊天传承');
      return;
    }
  } catch {
    // ignore
  }
  console.log(`[ProtagonistCarryover][${type}]`, message);
}

/** 创建可挂载、可清理的双端工作台控制器 */
export function createWorkbenchController({ getContext }) {
  const state = {
    activeTab: 'export', // 'export' | 'inherit' | 'library'
    profiles: [],
    exportDraft: null,
    showPasteBox: false,
    pasteText: '',
    selectedProfileId: '',
    inheritMode: 'db', // 'db' | 'prompt'
    targetReadResult: null,
    mappingPlan: null,
    alsoInjectOverflow: true,
    showAllOps: false,
    lastWriteReceipt: null,
    promptDraftText: '',
    promptPosition: 'in_chat',
    promptDepth: 2,
    promptRole: 'system',
    promptDraftProfileId: '',
  };

  let modalEl = null;
  let preflightDebounceTimer = null;
  let lastRenderedMobile = isMobileViewport();
  let resizeHandler = null;

  function getBodyEl() {
    return modalEl?.querySelector('.pc-body') || null;
  }

  function setBackgroundScrollLock(locked) {
    try {
      const doc = getHostDocument();
      doc?.documentElement?.classList.toggle(LOCK_SCROLL_CLASS, locked);
      doc?.body?.classList.toggle(LOCK_SCROLL_CLASS, locked);
    } catch {
      // ignore
    }
  }

  async function refreshProfiles() {
    state.profiles = await loadProfiles(getContext());
    if (!state.selectedProfileId && state.profiles.length > 0) {
      state.selectedProfileId = state.profiles[0].id;
    } else if (state.selectedProfileId && !state.profiles.some(p => p.id === state.selectedProfileId)) {
      state.selectedProfileId = state.profiles[0]?.id || '';
    }
  }

  function getSelectedProfile() {
    return state.profiles.find(p => p.id === state.selectedProfileId) || null;
  }

  function buildExportDraftFromSheets(sheets, sourceLabel, editingProfile = null) {
    const mobile = isMobileViewport();
    const pageLimit = getPageSizeRows();
    const draftSheets = sheets.map(schema => {
      const defaultSelected = editingProfile ? true : isDefaultProtagonistRole(schema.role);
      const columnSqlNames = {};
      for (const col of schema.columns || []) {
        if (col.sqlName) columnSqlNames[col.header] = col.sqlName;
      }
      const headers = (schema.columns || []).map(c => c.header);
      const rows = (schema.existingRows || []).map(r => ({
        selected: true,
        editing: false,
        values: { ...r.values },
      }));
      // 手机端默认只展开第 1 张单行主角表，避免初次进入塞满多张长表
      const defaultExpanded = editingProfile
        ? true
        : defaultSelected && rows.length > 0 && (!mobile || schema.role === 'protagonist_info');
      return {
        sheetKey: schema.sheetKey,
        name: schema.name,
        role: schema.role,
        ddlTableName: schema.ddlTableName,
        isSingleRow: schema.isSingleRow,
        headers,
        columnSqlNames,
        selected: defaultSelected && rows.length > 0,
        expanded: defaultExpanded,
        visibleLimit: pageLimit,
        rows,
      };
    });

    const preselectedTables = draftSheets
      .filter(s => s.selected)
      .map(s => ({ name: s.name, role: s.role, rows: s.rows.filter(r => r.selected).map(r => r.values) }));

    return {
      editingProfileId: editingProfile?.id || null,
      sourceLabel: editingProfile?.sourceLabel || sourceLabel || '',
      name: editingProfile?.name || inferProtagonistName(preselectedTables),
      note: editingProfile?.note || '',
      sheets: draftSheets,
    };
  }

  function buildExportDraftFromProfile(profile) {
    const pageLimit = getPageSizeRows();
    const draftSheets = (profile.tables || []).map((t, idx) => ({
      sheetKey: t.sheetKey,
      name: t.name,
      role: t.role,
      ddlTableName: t.ddlTableName,
      isSingleRow: t.isSingleRow,
      headers: [...(t.headers || [])],
      columnSqlNames: { ...(t.columnSqlNames || {}) },
      selected: true,
      expanded: idx === 0 || !isMobileViewport(),
      visibleLimit: pageLimit,
      rows: (t.rows || []).map(row => ({
        selected: true,
        editing: false,
        values: { ...row },
      })),
    }));
    return {
      editingProfileId: profile.id,
      sourceLabel: profile.sourceLabel || '',
      name: profile.name || '',
      note: profile.note || '',
      sheets: draftSheets,
    };
  }

  function refreshTargetContextForInherit({ resetMapping = false } = {}) {
    const ctx = getContext();
    state.targetReadResult = readCurrentChatAcuTables(ctx);
    state.showAllOps = false;
    const profile = getSelectedProfile();
    const settings = getExtensionSettings(ctx);
    const identity = state.targetReadResult.identity;
    const binding = getChatBinding(ctx, identity.bindingKey);

    if (!state.targetReadResult.ok && state.inheritMode === 'db') {
      state.inheritMode = 'prompt';
    }

    if (profile && state.targetReadResult.ok) {
      if (resetMapping || !state.mappingPlan) {
        state.mappingPlan = buildDefaultMappingPlan(profile, state.targetReadResult.tableData);
      }
    } else if (!state.targetReadResult.ok) {
      state.mappingPlan = null;
    }

    if (binding && binding.profileId === state.selectedProfileId && binding.text) {
      state.promptDraftText = binding.text;
      state.promptPosition = binding.position || settings.defaultPromptPosition || 'in_chat';
      state.promptDepth = binding.depth ?? settings.defaultPromptDepth ?? 2;
      state.promptRole = binding.role || settings.defaultPromptRole || 'system';
      state.promptDraftProfileId = profile?.id || '';
    } else if (profile && state.promptDraftProfileId !== profile.id) {
      state.promptDraftText = formatTablesAsCarryoverText(profile.name, profile.tables, profile.note);
      state.promptPosition = settings.defaultPromptPosition || 'in_chat';
      state.promptDepth = settings.defaultPromptDepth ?? 2;
      state.promptRole = settings.defaultPromptRole || 'system';
      state.promptDraftProfileId = profile.id;
    }
  }

  /** 刷新设置面板抽屉内的状态摘要（极轻量探针，零解析开销） */
  function updateSettingsDrawerStatus() {
    const doc = getHostDocument();
    const drawer = doc?.getElementById(DRAWER_ID);
    if (!drawer) return;
    const ctx = getContext();
    const identity = getCurrentChatIdentity(ctx);
    const binding = getChatBinding(ctx, identity.bindingKey);
    const injStatus = getActiveInjectionStatus();
    const probe = probeAcuStatusLight();
    const runtime = getHostRuntimeSummary();

    const statusEl = drawer.querySelector('[data-pc-drawer-status]');
    const clearBtn = drawer.querySelector('[data-pc-drawer-clear]');
    if (!statusEl) return;

    const dbText = probe.ok
      ? `已检测到龙血玄黄数据库（${probe.sheetCount} 张表）`
      : '当前聊天未检测到龙血玄黄数据库（可用导入 / 提示词注入）';

    const bindText = binding?.enabled
      ? `当前聊天已开启注入：<strong>${escapeHtml(binding.profileName || '未命名主角')}</strong>（${escapeHtml(getChannelDisplayName(injStatus.channel))}）`
      : '当前聊天未绑定主角提示词注入';

    statusEl.innerHTML = `
      <div class="pc-drawer-line">运行：<span>${escapeHtml(runtime.hostLabel)} · ${escapeHtml(runtime.storageLabel)}</span></div>
      <div class="pc-drawer-line">聊天：<span>${escapeHtml(identity.displayLabel)}</span></div>
      <div class="pc-drawer-line">数据库：<span>${escapeHtml(dbText)}</span></div>
      <div class="pc-drawer-line">注入：<span>${bindText}</span></div>
    `;
    if (clearBtn) {
      clearBtn.style.display = binding?.enabled ? '' : 'none';
    }
  }

  /** 在聊天输入框旁的魔法棒菜单（#extensionsMenu）注入一键入口，手机端与酒馆助手模式均 1 点即开 */
  function mountWandMenuButton() {
    const doc = getHostDocument();
    const win = getHostWindow();
    if (!doc || doc.getElementById(WAND_ITEM_ID)) return;
    const menu = doc.getElementById('extensionsMenu');
    if (!menu) return;

    const item = doc.createElement('div');
    item.id = WAND_ITEM_ID;
    item.className = 'list-group-item flex-container flexGap5 interactable';
    item.setAttribute('tabindex', '0');
    item.innerHTML = `
      <div class="fa-fw fa-solid fa-user-astronaut extensionsMenuExtensionButton"></div>
      <span>主角跨聊天传承</span>
    `;
    item.addEventListener('click', () => {
      const wandBtn = doc.getElementById('extensionsMenuButton');
      const wandMenu = doc.getElementById('extensionsMenu');
      const styleFn = win?.getComputedStyle || globalThis.getComputedStyle;
      if (wandBtn && wandMenu && typeof styleFn === 'function' && styleFn(wandMenu).display !== 'none') {
        wandBtn.click();
      }
      openWorkbench();
    });
    menu.appendChild(item);
  }

  function mountSettingsDrawer() {
    mountWandMenuButton();

    const doc = getHostDocument();
    if (!doc) return;
    if (doc.getElementById(DRAWER_ID)) {
      updateSettingsDrawerStatus();
      return;
    }
    const container =
      doc.getElementById('extensions_settings2') ||
      doc.getElementById('extensions_settings');
    if (!container) return;

    const wrapper = doc.createElement('div');
    wrapper.id = DRAWER_ID;
    wrapper.className = 'pc-extension-settings';
    wrapper.innerHTML = `
      <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
          <b>主角跨聊天传承（龙血玄黄数据库）</b>
          <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
          <div class="pc-drawer-status" data-pc-drawer-status>正在检测当前聊天状态…</div>
          <div class="pc-drawer-actions">
            <button type="button" class="menu_button pc-btn-primary" data-pc-open-workbench>打开主角传承工作台</button>
            <button type="button" class="menu_button" data-pc-drawer-clear style="display:none;">关闭当前聊天注入</button>
          </div>
          <hr class="sysHR" />
        </div>
      </div>
    `;

    wrapper.querySelector('[data-pc-open-workbench]')?.addEventListener('click', () => {
      openWorkbench();
    });
    wrapper.querySelector('[data-pc-drawer-clear]')?.addEventListener('click', () => {
      const ctx = getContext();
      const identity = getCurrentChatIdentity(ctx);
      setChatBinding(ctx, identity.bindingKey, null);
      clearPromptInjection(ctx);
      updateSettingsDrawerStatus();
      notifyToast('info', '已关闭并清除当前聊天的主角提示词注入。');
    });

    container.appendChild(wrapper);
    updateSettingsDrawerStatus();
  }

  function unmountSettingsDrawer() {
    const doc = getHostDocument();
    doc?.getElementById(DRAWER_ID)?.remove();
    doc?.getElementById(WAND_ITEM_ID)?.remove();
  }

  async function openWorkbench(initialTab) {
    await refreshProfiles();
    if (initialTab) state.activeTab = initialTab;
    state.showPasteBox = false;
    if (state.activeTab === 'inherit') {
      refreshTargetContextForInherit({ resetMapping: true });
    }
    ensureModalElement();
    renderCurrentTab({ resetScroll: true });
  }

  function closeWorkbench() {
    if (preflightDebounceTimer) {
      clearTimeout(preflightDebounceTimer);
      preflightDebounceTimer = null;
    }
    const win = getHostWindow();
    if (resizeHandler && win?.removeEventListener) {
      win.removeEventListener('resize', resizeHandler);
      resizeHandler = null;
    }
    setBackgroundScrollLock(false);
    if (modalEl) {
      modalEl.remove();
      modalEl = null;
    }
    updateSettingsDrawerStatus();
  }

  function ensureModalElement() {
    const doc = getHostDocument();
    const win = getHostWindow();
    if (!doc?.body) return null;
    if (modalEl && doc.body.contains(modalEl)) return modalEl;
    doc.getElementById(MODAL_ID)?.remove();
    const runtime = getHostRuntimeSummary();
    lastRenderedMobile = runtime.isMobile;

    modalEl = doc.createElement('div');
    modalEl.id = MODAL_ID;
    modalEl.className = 'pc-overlay';
    modalEl.innerHTML = `
      <div class="pc-modal" role="dialog" aria-modal="true" aria-label="主角跨聊天传承工作台">
        <div class="pc-header">
          <div class="pc-title-wrap">
            <h3 class="pc-title">主角跨聊天传承</h3>
            <span class="pc-subtitle" data-pc-runtime-subtitle>${escapeHtml(runtime.hostLabel)} · ${escapeHtml(runtime.storageLabel)}</span>
          </div>
          <button type="button" class="pc-close-btn" data-pc-close title="关闭" aria-label="关闭">✕</button>
        </div>
        <div class="pc-tabs">
          <button type="button" class="pc-tab" data-pc-tab="export">1. 导出主角</button>
          <button type="button" class="pc-tab" data-pc-tab="inherit">2. 继承到聊天</button>
          <button type="button" class="pc-tab" data-pc-tab="library">3. 传承库 (0)</button>
        </div>
        <div class="pc-body"></div>
      </div>
    `;

    modalEl.addEventListener('click', (evt) => {
      if (evt.target === modalEl) closeWorkbench();
    });
    modalEl.querySelector('[data-pc-close]')?.addEventListener('click', closeWorkbench);
    modalEl.querySelectorAll('.pc-tabs [data-pc-tab]').forEach(btn => {
      btn.addEventListener('click', () => {
        switchTab(btn.dataset.pcTab);
      });
    });

    const bodyEl = modalEl.querySelector('.pc-body');
    bodyEl.addEventListener('click', handleBodyClick);
    bodyEl.addEventListener('dblclick', handleBodyDblClick);
    bodyEl.addEventListener('change', handleBodyChange);
    bodyEl.addEventListener('input', handleBodyInput);

    // 旋转屏幕或跨桌面/手机断点缩放时无缝切换布局（不丢草稿状态）
    if (win?.addEventListener) {
      resizeHandler = () => {
        const nowMobile = isMobileViewport();
        if (nowMobile !== lastRenderedMobile && modalEl) {
          lastRenderedMobile = nowMobile;
          const rt = getHostRuntimeSummary();
          const sub = modalEl.querySelector('[data-pc-runtime-subtitle]');
          if (sub) sub.textContent = `${rt.hostLabel} · ${rt.storageLabel}`;
          renderCurrentTab({ resetScroll: false });
        }
      };
      win.addEventListener('resize', resizeHandler, { passive: true });
    }

    doc.body.appendChild(modalEl);
    setBackgroundScrollLock(true);
    return modalEl;
  }

  function updateTabHeaderBar() {
    if (!modalEl) return;
    modalEl.querySelectorAll('.pc-tabs [data-pc-tab]').forEach(btn => {
      btn.classList.toggle('is-active', btn.dataset.pcTab === state.activeTab);
      if (btn.dataset.pcTab === 'library') {
        btn.textContent = `3. 传承库 (${state.profiles.length})`;
      }
    });
  }

  function switchTab(nextTab) {
    state.activeTab = nextTab;
    state.showPasteBox = false;
    state.lastWriteReceipt = null;
    if (state.activeTab === 'inherit') {
      refreshTargetContextForInherit({ resetMapping: true });
    }
    renderCurrentTab({ resetScroll: true });
  }

  function renderCurrentTab({ resetScroll = false } = {}) {
    const bodyEl = getBodyEl();
    if (!bodyEl) return;
    const savedScrollTop = resetScroll ? 0 : bodyEl.scrollTop;
    updateTabHeaderBar();

    bodyEl.innerHTML =
      state.activeTab === 'export'
        ? renderExportTab()
        : state.activeTab === 'inherit'
          ? renderInheritTab()
          : renderLibraryTab();

    bodyEl.scrollTop = savedScrollTop;
  }

  function renderPasteImportBoxHtml() {
    if (!state.showPasteBox) return '';
    return `
      <div class="pc-card pc-paste-box">
        <div class="pc-paste-head">
          <strong>粘贴 JSON 导入（手机端免翻文件夹）</strong>
          <button type="button" class="pc-link-btn" data-pc-close-paste>收起</button>
        </div>
        <div class="pc-muted pc-mb-xs">支持直接粘贴龙血玄黄 Checkpoint JSON、表格 JSON，或本插件复制出来的主角档案 JSON。</div>
        <textarea class="text_pole pc-textarea-sm" data-pc-paste-input placeholder="在这里长按粘贴 JSON 文本…">${escapeHtml(state.pasteText)}</textarea>
        <div class="pc-toolbar-btns pc-mt-sm">
          <button type="button" class="menu_button pc-btn-primary" data-pc-parse-paste>解析并导入</button>
        </div>
      </div>
    `;
  }

  /* ===================== Tab 1: 导出主角（双端零输入框浏览 + 单行按需编辑） ===================== */
  function renderDesktopRowHtml(s, sIdx, r, rIdx) {
    const isEditing = Boolean(r.editing && s.selected && r.selected);
    const cells = s.headers
      .map((h, cIdx) => {
        const val = r.values[h] ?? '';
        if (isEditing) {
          return `<td><input type="text" class="pc-cell-input" data-pc-cell="${sIdx}:${rIdx}:${cIdx}" value="${escapeHtml(val)}" /></td>`;
        }
        return `<td data-pc-dbl-edit="${sIdx}:${rIdx}"><div class="pc-cell-text" title="${escapeHtml(val)}">${escapeHtml(val || '—')}</div></td>`;
      })
      .join('');

    return `
      <tr data-pc-row-item="${sIdx}:${rIdx}" class="${r.selected ? '' : 'pc-row-dim'} ${isEditing ? 'pc-row-editing' : ''}">
        <td class="pc-col-check">
          <input type="checkbox" class="pc-checkbox" data-pc-row-toggle="${sIdx}:${rIdx}" ${r.selected ? 'checked' : ''} ${s.selected ? '' : 'disabled'} />
        </td>
        ${cells}
        <td class="pc-col-act">
          <button type="button" class="pc-mini-btn" data-pc-row-edit="${sIdx}:${rIdx}" ${s.selected && r.selected ? '' : 'disabled'}>
            ${isEditing ? '✓ 完成' : '✏️ 改'}
          </button>
        </td>
      </tr>
    `;
  }

  function renderMobileRowCardHtml(s, sIdx, r, rIdx) {
    const isEditing = Boolean(r.editing && s.selected && r.selected);
    const firstHeader = s.headers[0] || '';
    const titleText = String(r.values[firstHeader] ?? '').trim() || `第 ${rIdx + 1} 行`;

    let bodyHtml = '';
    if (isEditing) {
      bodyHtml = `
        <div class="pc-row-edit-fields">
          ${s.headers
            .map(
              (h, cIdx) => `
            <label class="pc-field">
              <span>${escapeHtml(h)}</span>
              <input type="text" class="text_pole pc-mobile-input" data-pc-cell="${sIdx}:${rIdx}:${cIdx}" value="${escapeHtml(r.values[h] ?? '')}" />
            </label>
          `
            )
            .join('')}
        </div>
      `;
    } else {
      const kvItems = s.headers
        .slice(1)
        .map(h => {
          const v = String(r.values[h] ?? '').trim();
          if (!v) return '';
          return `<div class="pc-kv-line"><span class="pc-kv-k">${escapeHtml(h)}：</span><span class="pc-kv-v">${escapeHtml(v)}</span></div>`;
        })
        .filter(Boolean)
        .join('');
      bodyHtml = kvItems ? `<div class="pc-row-card-kv">${kvItems}</div>` : '';
    }

    return `
      <div class="pc-row-card ${r.selected ? '' : 'pc-row-dim'} ${isEditing ? 'pc-row-editing' : ''}" data-pc-row-item="${sIdx}:${rIdx}">
        <div class="pc-row-card-head">
          <label class="pc-check-label pc-row-card-title">
            <input type="checkbox" class="pc-checkbox" data-pc-row-toggle="${sIdx}:${rIdx}" ${r.selected ? 'checked' : ''} ${s.selected ? '' : 'disabled'} />
            <span>${escapeHtml(titleText)}</span>
          </label>
          <button type="button" class="pc-mini-btn" data-pc-row-edit="${sIdx}:${rIdx}" ${s.selected && r.selected ? '' : 'disabled'}>
            ${isEditing ? '✓ 完成' : '✏️ 编辑'}
          </button>
        </div>
        ${bodyHtml}
      </div>
    `;
  }

  function renderSheetRowsBodyHtml(s, sIdx) {
    if (!s.expanded) return '';
    if (s.rows.length === 0) {
      return `<div class="pc-muted pc-pad-sm">这张表目前是空的（暂无数据行）。</div>`;
    }
    const mobile = isMobileViewport();
    const pageStep = getPageSizeRows();
    const limit = Math.min(s.rows.length, s.visibleLimit || pageStep);
    const remaining = s.rows.length - limit;

    const pagerHtml =
      remaining > 0
        ? `<div class="pc-pager">
            <span class="pc-muted">已显示前 ${limit} / ${s.rows.length} 行（其余保持勾选）</span>
            <div class="pc-toolbar-btns">
              <button type="button" class="pc-link-btn" data-pc-sheet-more="${sIdx}">再加载 ${Math.min(remaining, pageStep)} 行</button>
              <button type="button" class="pc-link-btn" data-pc-sheet-all="${sIdx}">展开全部</button>
            </div>
          </div>`
        : '';

    if (mobile) {
      const cards = [];
      for (let rIdx = 0; rIdx < limit; rIdx += 1) {
        cards.push(renderMobileRowCardHtml(s, sIdx, s.rows[rIdx], rIdx));
      }
      return `<div class="pc-row-card-list">${cards.join('')}</div>${pagerHtml}`;
    }

    const rowsHtml = [];
    for (let rIdx = 0; rIdx < limit; rIdx += 1) {
      rowsHtml.push(renderDesktopRowHtml(s, sIdx, s.rows[rIdx], rIdx));
    }

    return `
      <div class="pc-table-scroll">
        <table class="pc-data-table">
          <thead>
            <tr>
              <th style="width:36px;">选</th>
              ${s.headers.map(h => `<th>${escapeHtml(h)}</th>`).join('')}
              <th style="width:74px;">微调</th>
            </tr>
          </thead>
          <tbody>${rowsHtml.join('')}</tbody>
        </table>
      </div>
      ${pagerHtml}
    `;
  }

  function renderExportTab() {
    const draft = state.exportDraft;
    const topBar = `
      <div class="pc-card pc-toolbar">
        <div class="pc-toolbar-info">
          <strong>第一步：选择要提取主角的数据来源</strong>
          <div class="pc-muted">在旧聊天里直接读表，或通过文件 / 粘贴 JSON 导入。</div>
        </div>
        <div class="pc-toolbar-btns">
          <button type="button" class="menu_button pc-btn-primary" data-pc-read-current>从当前聊天数据库读取</button>
          <label class="menu_button pc-file-btn">
            上传 JSON 文件
            <input type="file" accept=".json,application/json" data-pc-upload-source hidden />
          </label>
          <button type="button" class="menu_button" data-pc-open-paste>📋 粘贴 JSON</button>
        </div>
      </div>
      ${renderPasteImportBoxHtml()}
    `;

    if (!draft) {
      return `
        ${topBar}
        <div class="pc-empty">
          <p>还没有读取数据。请在旧聊天中点击上方 <b>「从当前聊天数据库读取」</b>，或上传/粘贴一份 <code>TavernDB_checkpoint_*.json</code>。</p>
          <p class="pc-muted">默认只显示轻量文字不弹键盘，需要改哪一行再点「✏️ 编辑」即可，手机端也非常流畅。</p>
        </div>
      `;
    }

    const { selectedSheetsCount, selectedRowTotal } = computeExportSelectionStats();

    const sheetCards = draft.sheets
      .map((s, sIdx) => {
        const isRecommended = isDefaultProtagonistRole(s.role);
        const checkedRowsCount = s.rows.filter(r => r.selected).length;
        return `
          <div class="pc-card pc-sheet-card ${s.selected ? 'is-selected' : ''}" data-pc-sheet-card="${sIdx}">
            <div class="pc-sheet-head">
              <label class="pc-check-label">
                <input type="checkbox" class="pc-checkbox" data-pc-sheet-toggle="${sIdx}" ${s.selected ? 'checked' : ''} ${s.rows.length === 0 ? 'disabled' : ''} />
                <strong>${escapeHtml(s.name)}</strong>
              </label>
              <div class="pc-badges">
                ${isRecommended ? '<span class="pc-badge pc-badge-info">主角核心</span>' : ''}
                ${s.isSingleRow ? '<span class="pc-badge">单行</span>' : '<span class="pc-badge">多行</span>'}
                <span class="pc-badge" data-pc-sheet-count="${sIdx}">${checkedRowsCount}/${s.rows.length}行</span>
                <button type="button" class="pc-link-btn pc-touch-btn" data-pc-sheet-expand="${sIdx}">
                  ${s.expanded ? '收起 ▲' : '展开 ▼'}
                </button>
              </div>
            </div>
            <div data-pc-sheet-body="${sIdx}">${renderSheetRowsBodyHtml(s, sIdx)}</div>
          </div>
        `;
      })
      .join('');

    return `
      ${topBar}
      <div class="pc-card">
        <div class="pc-form-grid">
          <label class="pc-field">
            <span>主角档案名称</span>
            <input type="text" class="text_pole" data-pc-draft-name value="${escapeHtml(draft.name)}" placeholder="例如：林默（修仙世界通关档）" />
          </label>
          <label class="pc-field">
            <span>来源备注</span>
            <input type="text" class="text_pole" data-pc-draft-source value="${escapeHtml(draft.sourceLabel)}" placeholder="来源聊天或存档名" />
          </label>
        </div>
        <label class="pc-field pc-mt-sm">
          <span>跨世界补充说明（可选，会随提示词带给新世界 AI）</span>
          <textarea class="text_pole pc-textarea-sm" data-pc-draft-note placeholder="例如：刚从上一局穿越而来，保留战斗本能与随身玉佩。">${escapeHtml(draft.note)}</textarea>
        </label>
      </div>
      <div class="pc-section-title">勾选要带走的表和行（需要改字时点行上的「✏️ 编辑」）</div>
      ${sheetCards}
      <div class="pc-footer-bar pc-sticky-footer">
        <span class="pc-muted" data-pc-export-stats>已选 ${selectedSheetsCount} 表 / ${selectedRowTotal} 行</span>
        <button type="button" class="menu_button pc-btn-primary" data-pc-save-profile ${selectedRowTotal === 0 ? 'disabled' : ''}>
          ${draft.editingProfileId ? '保存修改' : '保存到传承库'}
        </button>
      </div>
    `;
  }

  function computeExportSelectionStats() {
    const sheets = state.exportDraft?.sheets || [];
    let selectedSheetsCount = 0;
    let selectedRowTotal = 0;
    for (const s of sheets) {
      if (!s.selected) continue;
      selectedSheetsCount += 1;
      for (const r of s.rows) {
        if (r.selected) selectedRowTotal += 1;
      }
    }
    return { selectedSheetsCount, selectedRowTotal };
  }

  function patchExportCounts(sIdx) {
    const bodyEl = getBodyEl();
    const s = state.exportDraft?.sheets[sIdx];
    if (!bodyEl || !s) return;
    const countEl = bodyEl.querySelector(`[data-pc-sheet-count="${sIdx}"]`);
    if (countEl) {
      const checked = s.rows.filter(r => r.selected).length;
      countEl.textContent = `${checked}/${s.rows.length}行`;
    }
    const { selectedSheetsCount, selectedRowTotal } = computeExportSelectionStats();
    const statsEl = bodyEl.querySelector('[data-pc-export-stats]');
    if (statsEl) {
      statsEl.textContent = `已选 ${selectedSheetsCount} 表 / ${selectedRowTotal} 行`;
    }
    const saveBtn = bodyEl.querySelector('[data-pc-save-profile]');
    if (saveBtn) {
      saveBtn.disabled = selectedRowTotal === 0;
    }
  }

  function patchSheetBody(sIdx) {
    const bodyEl = getBodyEl();
    const s = state.exportDraft?.sheets[sIdx];
    if (!bodyEl || !s) return;
    const container = bodyEl.querySelector(`[data-pc-sheet-body="${sIdx}"]`);
    if (container) container.innerHTML = renderSheetRowsBodyHtml(s, sIdx);
    const btn = bodyEl.querySelector(`[data-pc-sheet-expand="${sIdx}"]`);
    if (btn) btn.textContent = s.expanded ? '收起 ▲' : '展开 ▼';
  }

  /** 局部补丁：只替换单行 DOM（切换浏览态 <-> 编辑态，绝不碰其他行） */
  function patchSingleRow(sIdx, rIdx) {
    const bodyEl = getBodyEl();
    const s = state.exportDraft?.sheets[sIdx];
    const r = s?.rows[rIdx];
    if (!bodyEl || !s || !r) return;
    const rowEl = bodyEl.querySelector(`[data-pc-row-item="${sIdx}:${rIdx}"]`);
    if (!rowEl) return;

    const html = isMobileViewport()
      ? renderMobileRowCardHtml(s, sIdx, r, rIdx)
      : renderDesktopRowHtml(s, sIdx, r, rIdx);
    const doc = getHostDocument();
    if (!doc) return;
    const tpl = doc.createElement('template');
    tpl.innerHTML = html.trim();
    const nextEl = tpl.content.firstElementChild;
    if (nextEl) {
      rowEl.replaceWith(nextEl);
    }
  }

  /* ===================== Tab 2: 继承到当前聊天（响应式网格映射，手机零横滑） ===================== */
  function renderInheritTab() {
    if (state.profiles.length === 0) {
      return `
        <div class="pc-empty">
          <p>「主角传承库」里还没有保存任何主角。</p>
          <button type="button" class="menu_button pc-btn-primary" data-pc-jump-tab="export">先去导出一位主角 →</button>
        </div>
      `;
    }

    const profile = getSelectedProfile();
    if (!state.targetReadResult) {
      refreshTargetContextForInherit({ resetMapping: true });
    }
    const readRes = state.targetReadResult;
    const identity = readRes.identity;
    const binding = getChatBinding(getContext(), identity.bindingKey);

    const profileOptions = state.profiles
      .map(p => `<option value="${escapeHtml(p.id)}" ${p.id === state.selectedProfileId ? 'selected' : ''}>${escapeHtml(p.name)}（${p.tables.length}张表）</option>`)
      .join('');

    const statusBanner = `
      <div class="pc-card pc-status-card">
        <div class="pc-status-row">
          <label class="pc-inline-field pc-grow">
            <span>继承主角：</span>
            <select class="text_pole pc-grow" data-pc-select-profile>${profileOptions}</select>
          </label>
          <button type="button" class="menu_button" data-pc-refresh-target>刷新检测</button>
        </div>
        <div class="pc-status-meta" data-pc-inherit-status-meta>
          ${renderInheritStatusMetaHtml(identity, readRes, binding)}
        </div>
      </div>
    `;

    const modeSwitcher = `
      <div class="pc-mode-switch">
        <button type="button" class="pc-mode-btn ${state.inheritMode === 'db' ? 'is-active' : ''}" data-pc-inherit-mode="db">
          模式 A：写回当前数据库（跨规则适配）
        </button>
        <button type="button" class="pc-mode-btn ${state.inheritMode === 'prompt' ? 'is-active' : ''}" data-pc-inherit-mode="prompt">
          模式 B：纯提示词注入（通用跨卡）
        </button>
      </div>
    `;

    const bodyHtml =
      state.inheritMode === 'db'
        ? renderDbWritebackSection(profile, readRes)
        : renderPromptInjectSection(profile, identity, binding);

    return `${statusBanner}${modeSwitcher}<div data-pc-inherit-mode-host class="pc-stack">${bodyHtml}</div>`;
  }

  function renderInheritStatusMetaHtml(identity, readRes, binding) {
    return `
      <span>聊天：<b>${escapeHtml(identity.displayLabel)}</b></span>
      <span>数据库：${readRes.ok ? `<b class="pc-ok">已连接 (${readRes.sheets.length}表)</b>` : `<b class="pc-warn">未检测到</b>`}</span>
      <span>AI楼层：${readRes.floorState.hasAiFloor ? `<b class="pc-ok">${readRes.floorState.aiFloorCount}条</b>` : `<b class="pc-err">无开场白</b>`}</span>
      <span>注入：${binding?.enabled ? `<b class="pc-ok">已开 (${escapeHtml(binding.profileName || '')})</b>` : `<span class="pc-muted">未开</span>`}</span>
    `;
  }

  function renderColumnValueControlHtml(srcTable, tgtSchema, tCol, cm, mIdx, cIdx) {
    if (cm.mode === 'source_column') {
      const srcOpts = [
        '<option value="">-- 选择源列 --</option>',
        ...srcTable.headers.map(h => `<option value="${escapeHtml(h)}" ${h === cm.sourceColumn ? 'selected' : ''}>${escapeHtml(h)}</option>`),
      ].join('');
      const partBadge = cm.extractPart ? `<span class="pc-mini-hint">自动提取：${cm.extractPart === 'gender' ? '性别' : '年龄'}</span>` : '';
      return `<div class="pc-val-inline"><select class="text_pole pc-select-full" data-pc-col-src="${mIdx}:${cIdx}">${srcOpts}</select>${partBadge}</div>`;
    }
    if (cm.mode === 'combine_columns') {
      const cbs = srcTable.headers
        .map(
          h => `<label class="pc-chip"><input type="checkbox" data-pc-col-combine="${mIdx}:${cIdx}" value="${escapeHtml(h)}" ${(cm.combineColumns || []).includes(h) ? 'checked' : ''} />${escapeHtml(h)}</label>`
        )
        .join('');
      return `<div class="pc-combine-wrap">${cbs}<input type="text" class="text_pole pc-joiner-input" data-pc-col-joiner="${mIdx}:${cIdx}" value="${escapeHtml(cm.joiner ?? '/')}" title="连接符号" /></div>`;
    }
    if (cm.mode === 'constant') {
      if (tCol.enumValues && tCol.enumValues.length > 0) {
        const enumOpts = [
          '<option value="">-- 选择合法值 --</option>',
          ...tCol.enumValues.map(v => `<option value="${escapeHtml(v)}" ${String(cm.constantValue) === v ? 'selected' : ''}>${escapeHtml(v)}</option>`),
        ].join('');
        return `<select class="text_pole pc-select-full" data-pc-col-const="${mIdx}:${cIdx}">${enumOpts}</select>`;
      }
      return `<input type="text" class="text_pole pc-select-full" data-pc-col-const="${mIdx}:${cIdx}" value="${escapeHtml(cm.constantValue ?? '')}" placeholder="输入固定填入的值" />`;
    }
    return `<span class="pc-muted">${tgtSchema.isSingleRow && tgtSchema.existingRows.length > 0 ? '保留新聊天此列原值' : '不写入此列'}</span>`;
  }

  function renderMapCardInnerHtml(profile, readRes, tblMap, mIdx) {
    const srcTable = profile.tables[tblMap.sourceIndex];
    const tgtSchema = tblMap.targetSheetKey ? readRes.sheets.find(s => s.sheetKey === tblMap.targetSheetKey) : null;

    if (!tgtSchema) {
      return `<div class="pc-muted pc-pad-sm">这张源表内容不会丢失：执行时会汇总进下方「跨聊天补充提示词」，可一键注入新聊天 AI。</div>`;
    }

    const ruleBadges = [
      `<span class="pc-badge pc-badge-info">${tgtSchema.isSingleRow ? '单行表（仅1行）' : '多行表'}</span>`,
      tgtSchema.uniqueColumns.length > 0 ? `<span class="pc-badge pc-badge-warn">唯一键：${escapeHtml(tgtSchema.uniqueColumns.join('、'))}</span>` : '',
      tgtSchema.columns.some(c => c.isNotNull) ? `<span class="pc-badge">含必填</span>` : '',
      tgtSchema.columns.some(c => c.enumValues) ? `<span class="pc-badge">含枚举</span>` : '',
    ].join('');

    const strategyControl = tgtSchema.isSingleRow
      ? `<label class="pc-inline-field">
          <span>已有第1行时：</span>
          <select class="text_pole pc-select-sm" data-pc-single-strategy="${mIdx}">
            <option value="update_existing" ${tblMap.singleRowStrategy === 'update_existing' ? 'selected' : ''}>更新覆盖（只改映射列）</option>
            <option value="skip_if_exists" ${tblMap.singleRowStrategy === 'skip_if_exists' ? 'selected' : ''}>跳过不覆盖</option>
          </select>
        </label>`
      : `<label class="pc-inline-field">
          <span>重名冲突时：</span>
          <select class="text_pole pc-select-sm" data-pc-dup-strategy="${mIdx}">
            <option value="update" ${tblMap.duplicateStrategy === 'update' ? 'selected' : ''}>覆盖更新已有行</option>
            <option value="skip" ${tblMap.duplicateStrategy === 'skip' ? 'selected' : ''}>跳过保留原行</option>
            <option value="add_quantity" ${tblMap.duplicateStrategy === 'add_quantity' ? 'selected' : ''}>数量累加（背包）</option>
          </select>
        </label>`;

    // 使用响应式网格列表（桌面 3 列对齐、手机自动竖排单列卡片，彻底消除左右横滑）
    const colRows = tgtSchema.columns
      .map((tCol, cIdx) => {
        const cm = tblMap.columnMappings[tCol.header] || { mode: 'skip', sourceColumn: '', constantValue: '', combineColumns: [] };
        const tags = [];
        if (tCol.isNotNull) tags.push('<span class="pc-tag pc-tag-req">必填</span>');
        if (tCol.isUnique) tags.push('<span class="pc-tag pc-tag-uniq">唯一</span>');
        if (tCol.declaredType && tCol.declaredType !== 'TEXT') tags.push(`<span class="pc-tag">${escapeHtml(tCol.declaredType)}</span>`);
        if (tCol.enumValues) tags.push(`<span class="pc-tag pc-tag-enum">仅限:${escapeHtml(tCol.enumValues.join('/'))}</span>`);
        if (tCol.minValue !== null) tags.push(`<span class="pc-tag">${tCol.minExclusive ? '>' : '>='}${tCol.minValue}</span>`);
        if (tCol.hasDefault && tCol.defaultValue !== null) tags.push(`<span class="pc-tag">默认:${escapeHtml(tCol.defaultValue)}</span>`);

        return `
          <div class="pc-map-row">
            <div class="pc-map-col-meta">
              <div class="pc-col-name">${escapeHtml(tCol.header)}</div>
              ${tags.length ? `<div class="pc-col-tags">${tags.join('')}</div>` : ''}
            </div>
            <div class="pc-map-col-mode">
              <select class="text_pole pc-select-full" data-pc-col-mode="${mIdx}:${cIdx}">
                <option value="source_column" ${cm.mode === 'source_column' ? 'selected' : ''}>读取源列</option>
                <option value="combine_columns" ${cm.mode === 'combine_columns' ? 'selected' : ''}>合并多列</option>
                <option value="constant" ${cm.mode === 'constant' ? 'selected' : ''}>填入固定值</option>
                <option value="skip" ${cm.mode === 'skip' ? 'selected' : ''}>跳过不写</option>
              </select>
            </div>
            <div class="pc-map-col-val" data-pc-col-val-cell="${mIdx}:${cIdx}">
              ${renderColumnValueControlHtml(srcTable, tgtSchema, tCol, cm, mIdx, cIdx)}
            </div>
          </div>
        `;
      })
      .join('');

    return `
      <div class="pc-rule-bar">
        <div class="pc-badges">${ruleBadges}</div>
        ${strategyControl}
      </div>
      ${tgtSchema.noteSummary ? `<details class="pc-note-details"><summary>目标表规则说明：${escapeHtml(tgtSchema.noteSummary)}</summary><pre class="pc-note-pre">${escapeHtml(tgtSchema.note)}</pre></details>` : ''}
      <div class="pc-map-list">
        <div class="pc-map-row pc-map-row-header">
          <div>目标聊天的列与规则</div>
          <div>写入方式</div>
          <div>来源列 / 数值</div>
        </div>
        ${colRows}
      </div>
    `;
  }

  function renderPreflightSectionHtml(profile, readRes) {
    const compiled = compileWritePlan(profile, readRes.tableData, state.mappingPlan);
    const totalOps = compiled.operations.length;
    const limit = state.showAllOps ? totalOps : Math.min(totalOps, getPageSizeOps());

    const opPreviewRows = compiled.operations
      .slice(0, limit)
      .map(op => {
        const actionLabel = op.action === 'insert' ? '新增行' : op.action === 'update' ? `更新第 ${op.targetRowIndex} 行` : '跳过';
        const statusCls = op.errors.length > 0 ? 'pc-op-err' : op.warnings.length > 0 ? 'pc-op-warn' : 'pc-op-ok';
        const previewPairs = Object.entries(op.data)
          .map(([k, v]) => `<span><b>${escapeHtml(k)}:</b> ${escapeHtml(v)}</span>`)
          .join(' · ');
        const msgs = [
          ...op.errors.map(e => `<div class="pc-err-line">⛔ ${escapeHtml(e)}</div>`),
          ...op.warnings.map(w => `<div class="pc-warn-line">⚠️ ${escapeHtml(w)}</div>`),
        ].join('');
        return `
          <div class="pc-op-item ${statusCls}">
            <div class="pc-op-head">
              <b>${escapeHtml(op.targetTableName)}</b>
              <span class="pc-badge">${actionLabel}</span>
            </div>
            ${previewPairs ? `<div class="pc-op-data">${previewPairs}</div>` : ''}
            ${msgs}
          </div>
        `;
      })
      .join('');

    const moreOpsHtml =
      totalOps > limit
        ? `<div class="pc-pager"><span class="pc-muted">已预览前 ${limit} / ${totalOps} 条操作</span><button type="button" class="pc-link-btn" data-pc-show-all-ops>展开全部 ${totalOps} 条</button></div>`
        : '';

    const overflowBox = compiled.summary.hasOverflow
      ? `
        <div class="pc-card pc-overflow-card">
          <div class="pc-overflow-head">
            <strong>未写入目标表的剩余主角信息（防丢失）</strong>
            <label class="pc-check-label">
              <input type="checkbox" class="pc-checkbox" data-pc-toggle-overflow ${state.alsoInjectOverflow ? 'checked' : ''} />
              写表后自动作为「补充提示词」注入当前聊天
            </label>
          </div>
          <div class="pc-muted pc-mb-xs">原因：${compiled.overflowTables.map(t => `${escapeHtml(t.name)}（${escapeHtml(t.reason)}）`).join('；')}</div>
          <pre class="pc-overflow-pre">${escapeHtml(compiled.overflowText)}</pre>
        </div>
      `
      : '';

    const receiptBox = state.lastWriteReceipt
      ? `
        <div class="pc-card ${state.lastWriteReceipt.ok ? 'pc-receipt-ok' : 'pc-receipt-err'}">
          <strong>最近一次写入回执：</strong>
          成功 ${state.lastWriteReceipt.succeeded} 行，失败 ${state.lastWriteReceipt.failed} 行，跳过 ${state.lastWriteReceipt.skipped} 行
          ${state.lastWriteReceipt.refreshed ? '（已刷新世界书）' : ''}
          ${state.lastWriteReceipt.error ? `<div class="pc-err-line">${escapeHtml(state.lastWriteReceipt.error)}</div>` : ''}
          <ul class="pc-receipt-list">
            ${state.lastWriteReceipt.results
              .slice(0, 50)
              .map(r => `<li class="${r.ok ? 'pc-ok' : 'pc-err'}">[${escapeHtml(r.tableName)}] ${escapeHtml(r.detail)}</li>`)
              .join('')}
          </ul>
        </div>
      `
      : '';

    const canClickExecute = compiled.canExecute && readRes.floorState.hasAiFloor;

    return `
      <div class="pc-card pc-preflight-card">
        <div class="pc-preflight-summary">
          <strong>写前规则体检：</strong>
          <span class="pc-ok">新增 ${compiled.summary.inserts}</span> ·
          <span class="pc-ok">更新 ${compiled.summary.updates}</span> ·
          <span class="pc-muted">跳过 ${compiled.summary.skips}</span> ·
          <span class="${compiled.summary.warnings > 0 ? 'pc-warn' : 'pc-muted'}">提示 ${compiled.summary.warnings}</span> ·
          <span class="${compiled.summary.errors > 0 ? 'pc-err' : 'pc-ok'}">错误 ${compiled.summary.errors}</span>
        </div>
        <div class="pc-op-list">${opPreviewRows || '<div class="pc-muted">当前没有计划写表的行（已转入补充提示词）。</div>'}${moreOpsHtml}</div>
      </div>
      ${overflowBox}
      ${receiptBox}
      <div class="pc-footer-bar pc-sticky-footer">
        <span class="pc-muted pc-footer-hint">
          ${!readRes.floorState.hasAiFloor
            ? '⛔ 无 AI 开场白楼层，请改用「模式 B」'
            : compiled.summary.errors > 0
              ? '⛔ 请先解决上方红色错误再写入'
              : compiled.summary.inserts + compiled.summary.updates === 0 && compiled.summary.hasOverflow
                ? '可直接注入补充提示词'
                : '体检通过，不会改动其他表'}
        </span>
        <div class="pc-toolbar-btns">
          ${compiled.summary.inserts + compiled.summary.updates === 0 && compiled.summary.hasOverflow
            ? `<button type="button" class="menu_button pc-btn-primary" data-pc-apply-overflow-only>注入补充提示词</button>`
            : `<button type="button" class="menu_button pc-btn-primary" data-pc-execute-db ${canClickExecute ? '' : 'disabled'}>确认写回数据库</button>`}
        </div>
      </div>
    `;
  }

  function renderDbWritebackSection(profile, readRes) {
    if (!readRes.ok) {
      return `
        <div class="pc-empty">
          <p>${escapeHtml(readRes.reason)}</p>
          <p class="pc-muted">如果当前角色卡没用龙血玄黄数据库，直接切到「模式 B：纯提示词注入」即可！</p>
          <button type="button" class="menu_button pc-btn-primary" data-pc-inherit-mode="prompt">切换到纯提示词注入</button>
        </div>
      `;
    }

    if (!state.mappingPlan) {
      state.mappingPlan = buildDefaultMappingPlan(profile, readRes.tableData);
    }

    const mappingCards = state.mappingPlan.tableMappings
      .map((tblMap, mIdx) => {
        const srcTable = profile.tables[tblMap.sourceIndex];
        const targetOptions = [
          `<option value="" ${!tblMap.targetSheetKey ? 'selected' : ''}>不写表（转入补充提示词）</option>`,
          ...readRes.sheets.map(
            s => `<option value="${escapeHtml(s.sheetKey)}" ${s.sheetKey === tblMap.targetSheetKey ? 'selected' : ''}>${escapeHtml(s.name)}（${s.isSingleRow ? '单行' : '多行'}·${s.existingRows.length}行）</option>`
          ),
        ].join('');

        return `
          <div class="pc-card pc-map-card" data-pc-map-card="${mIdx}">
            <div class="pc-map-head">
              <div class="pc-map-src-title">
                <span class="pc-src-pill">源表：${escapeHtml(srcTable.name)}（${srcTable.rows.length}行）</span>
                <span class="pc-arrow">→</span>
              </div>
              <select class="text_pole pc-map-target-select" data-pc-target-sheet="${mIdx}">${targetOptions}</select>
            </div>
            <div data-pc-map-inner="${mIdx}">${renderMapCardInnerHtml(profile, readRes, tblMap, mIdx)}</div>
          </div>
        `;
      })
      .join('');

    return `
      <div class="pc-section-title">跨表规则映射（已按当前聊天表结构自动对齐）</div>
      ${mappingCards}
      <div data-pc-preflight-host class="pc-stack">${renderPreflightSectionHtml(profile, readRes)}</div>
    `;
  }

  function patchPreflightOnly() {
    const bodyEl = getBodyEl();
    const host = bodyEl?.querySelector('[data-pc-preflight-host]');
    const profile = getSelectedProfile();
    if (!host || !profile || !state.targetReadResult?.ok) return;
    host.innerHTML = renderPreflightSectionHtml(profile, state.targetReadResult);
  }

  function schedulePreflightPatch() {
    if (preflightDebounceTimer) clearTimeout(preflightDebounceTimer);
    preflightDebounceTimer = setTimeout(() => {
      preflightDebounceTimer = null;
      patchPreflightOnly();
    }, 150);
  }

  function renderPromptInjectSection(profile, identity, binding) {
    const isBoundHere = Boolean(binding?.enabled);
    return `
      <div class="pc-card">
        <div class="pc-muted pc-mb-sm">
          不改任何数据库表格，直接把主角档案绑定到 <b>当前聊天（${escapeHtml(identity.displayLabel)}）</b>；切去其他聊天自动清空，绝不串台。
        </div>
        <div class="pc-form-grid pc-grid-3">
          <label class="pc-field">
            <span>注入位置</span>
            <select class="text_pole" data-pc-prompt-pos>
              <option value="in_chat" ${state.promptPosition === 'in_chat' ? 'selected' : ''}>聊天内深度 @D（推荐）</option>
              <option value="before_prompt" ${state.promptPosition === 'before_prompt' ? 'selected' : ''}>提示词顶部</option>
            </select>
          </label>
          <label class="pc-field">
            <span>深度（仅 @D 生效）</span>
            <input type="number" min="0" max="99" class="text_pole" data-pc-prompt-depth value="${escapeHtml(state.promptDepth)}" />
          </label>
          <label class="pc-field">
            <span>注入角色</span>
            <select class="text_pole" data-pc-prompt-role>
              <option value="system" ${state.promptRole === 'system' ? 'selected' : ''}>System（推荐）</option>
              <option value="user" ${state.promptRole === 'user' ? 'selected' : ''}>User</option>
            </select>
          </label>
        </div>
        <div class="pc-prompt-head pc-mt-sm">
          <span>最终注入文本（可直接手改）：</span>
          <button type="button" class="pc-link-btn pc-touch-btn" data-pc-regen-prompt>重新生成</button>
        </div>
        <textarea class="text_pole pc-textarea-lg" data-pc-prompt-text>${escapeHtml(state.promptDraftText)}</textarea>
        <div class="pc-footer-bar pc-sticky-footer pc-mt-sm">
          <span class="pc-muted pc-footer-hint">${isBoundHere ? `已生效：${escapeHtml(binding.profileName || '')}` : '尚未应用'}</span>
          <div class="pc-toolbar-btns">
            ${isBoundHere ? `<button type="button" class="menu_button" data-pc-clear-prompt>取消绑定</button>` : ''}
            <button type="button" class="menu_button pc-btn-primary" data-pc-apply-prompt ${!identity.bindingKey ? 'disabled' : ''}>
              应用到当前聊天
            </button>
          </div>
        </div>
      </div>
    `;
  }

  /* ===================== Tab 3: 主角传承库（含手机剪贴板导入/导出） ===================== */
  function renderLibraryTab() {
    const topBar = `
      <div class="pc-card pc-toolbar">
        <div class="pc-toolbar-info">
          <strong>已保存主角（共 ${state.profiles.length} 份）</strong>
          <div class="pc-muted">支持文件备份，手机端也可用「复制 / 粘贴 JSON」跨设备秒传。</div>
        </div>
        <div class="pc-toolbar-btns">
          <label class="menu_button pc-file-btn">
            导入 JSON 文件
            <input type="file" accept=".json,application/json" data-pc-import-archive hidden />
          </label>
          <button type="button" class="menu_button" data-pc-open-paste>📋 粘贴 JSON</button>
          <button type="button" class="menu_button" data-pc-copy-all ${state.profiles.length === 0 ? 'disabled' : ''}>📋 复制全部</button>
          <button type="button" class="menu_button" data-pc-export-all ${state.profiles.length === 0 ? 'disabled' : ''}>⬇️ 下载备份</button>
        </div>
      </div>
      ${renderPasteImportBoxHtml()}
    `;

    if (state.profiles.length === 0) {
      return `${topBar}<div class="pc-empty">暂无已保存的主角。请先去「1. 导出主角」抓取一份！</div>`;
    }

    const cards = state.profiles
      .map(p => {
        const tableSummary = (p.tables || [])
          .map(t => `${escapeHtml(t.name)}(${t.rows.length}行)`)
          .join(' · ');
        return `
          <div class="pc-card pc-lib-card">
            <div class="pc-lib-main">
              <div class="pc-lib-name">${escapeHtml(p.name)}</div>
              <div class="pc-muted">来源：${escapeHtml(p.sourceLabel || '未标注')} ｜ ${escapeHtml(formatTime(p.updatedAt))}</div>
              <div class="pc-lib-summary">${tableSummary || '无表格数据'}</div>
              ${p.note ? `<div class="pc-lib-note">备注：${escapeHtml(p.note)}</div>` : ''}
            </div>
            <div class="pc-lib-actions">
              <button type="button" class="menu_button pc-btn-primary" data-pc-lib-inherit="${escapeHtml(p.id)}">继承到当前聊天</button>
              <button type="button" class="menu_button" data-pc-lib-edit="${escapeHtml(p.id)}">编辑</button>
              <button type="button" class="menu_button" data-pc-lib-copy="${escapeHtml(p.id)}">📋 复制</button>
              <button type="button" class="menu_button" data-pc-lib-export="${escapeHtml(p.id)}">⬇️ 下载</button>
              <button type="button" class="menu_button pc-btn-danger" data-pc-lib-delete="${escapeHtml(p.id)}">删除</button>
            </div>
          </div>
        `;
      })
      .join('');

    return `${topBar}${cards}`;
  }

  async function importFromJsonString(text, sourceName) {
    const parsed = parseImportedSourceJson(text);
    if (parsed.kind === 'carryover_archive') {
      for (const p of parsed.profiles) {
        await upsertProfile(getContext(), p);
      }
      await refreshProfiles();
      state.showPasteBox = false;
      state.pasteText = '';
      notifyToast('success', `已导入 ${parsed.profiles.length} 份主角传承档案。`);
      switchTab('library');
      return;
    }
    const sheets = extractSheetsFromTableData(parsed.tableData);
    state.exportDraft = buildExportDraftFromSheets(sheets, sourceName || 'JSON导入');
    state.showPasteBox = false;
    state.pasteText = '';
    state.activeTab = 'export';
    notifyToast('success', `已解析 ${sourceName || 'JSON'}，共 ${sheets.length} 张表。`);
    renderCurrentTab({ resetScroll: false });
  }

  /* ===================== 统一事件委托（零重绑、零跳顶） ===================== */
  function handleBodyDblClick(evt) {
    const td = evt.target.closest('[data-pc-dbl-edit]');
    if (!td) return;
    const [sIdx, rIdx] = td.dataset.pcDblEdit.split(':').map(Number);
    const s = state.exportDraft?.sheets[sIdx];
    const r = s?.rows[rIdx];
    if (!s || !r || !s.selected || !r.selected) return;
    r.editing = true;
    patchSingleRow(sIdx, rIdx);
  }

  async function handleBodyClick(evt) {
    const target = evt.target.closest('button');
    if (!target) return;

    if (target.dataset.pcJumpTab) {
      switchTab(target.dataset.pcJumpTab);
      return;
    }

    if (target.hasAttribute('data-pc-open-paste')) {
      state.showPasteBox = !state.showPasteBox;
      renderCurrentTab({ resetScroll: false });
      return;
    }

    if (target.hasAttribute('data-pc-close-paste')) {
      state.showPasteBox = false;
      renderCurrentTab({ resetScroll: false });
      return;
    }

    if (target.hasAttribute('data-pc-parse-paste')) {
      try {
        await importFromJsonString(state.pasteText, '粘贴的 JSON');
      } catch (err) {
        notifyToast('error', err?.message || String(err));
      }
      return;
    }

    // Tab 1 buttons
    if (target.hasAttribute('data-pc-read-current')) {
      const readRes = readCurrentChatAcuTables(getContext());
      if (!readRes.ok) {
        notifyToast('warning', readRes.reason);
        return;
      }
      state.exportDraft = buildExportDraftFromSheets(readRes.sheets, readRes.identity.displayLabel);
      notifyToast('success', `已读取当前聊天数据库，共 ${readRes.sheets.length} 张表。`);
      renderCurrentTab({ resetScroll: false });
      return;
    }

    if (target.dataset.pcSheetExpand !== undefined) {
      const sIdx = Number(target.dataset.pcSheetExpand);
      const s = state.exportDraft?.sheets[sIdx];
      if (!s) return;
      s.expanded = !s.expanded;
      patchSheetBody(sIdx);
      return;
    }

    if (target.dataset.pcSheetMore !== undefined) {
      const sIdx = Number(target.dataset.pcSheetMore);
      const s = state.exportDraft?.sheets[sIdx];
      if (!s) return;
      s.visibleLimit = (s.visibleLimit || getPageSizeRows()) + getPageSizeRows();
      patchSheetBody(sIdx);
      return;
    }

    if (target.dataset.pcSheetAll !== undefined) {
      const sIdx = Number(target.dataset.pcSheetAll);
      const s = state.exportDraft?.sheets[sIdx];
      if (!s) return;
      s.visibleLimit = s.rows.length;
      patchSheetBody(sIdx);
      return;
    }

    if (target.dataset.pcRowEdit !== undefined) {
      const [sIdx, rIdx] = target.dataset.pcRowEdit.split(':').map(Number);
      const s = state.exportDraft?.sheets[sIdx];
      const r = s?.rows[rIdx];
      if (!s || !r) return;
      r.editing = !r.editing;
      patchSingleRow(sIdx, rIdx);
      return;
    }

    if (target.hasAttribute('data-pc-save-profile')) {
      if (!state.exportDraft) return;
      const selectedTables = state.exportDraft.sheets
        .filter(s => s.selected)
        .map(s => ({
          sheetKey: s.sheetKey,
          name: s.name,
          role: s.role,
          ddlTableName: s.ddlTableName,
          isSingleRow: s.isSingleRow,
          headers: s.headers,
          columnSqlNames: s.columnSqlNames,
          rows: s.rows.filter(r => r.selected).map(r => deepCloneSafe(r.values)),
        }))
        .filter(t => t.rows.length > 0);

      if (selectedTables.length === 0) {
        notifyToast('warning', '请至少勾选 1 行主角数据再保存。');
        return;
      }

      const profile = createProtagonistProfile({
        id: state.exportDraft.editingProfileId || undefined,
        name: state.exportDraft.name,
        sourceLabel: state.exportDraft.sourceLabel,
        note: state.exportDraft.note,
        tables: selectedTables,
      });

      const saved = await upsertProfile(getContext(), profile);
      state.profiles = saved.profiles;
      state.selectedProfileId = saved.profile.id;
      state.exportDraft.editingProfileId = saved.profile.id;
      notifyToast('success', `主角「${saved.profile.name}」已保存到传承库！现在可以切到新聊天继承了。`);
      switchTab('inherit');
      return;
    }

    // Tab 2 buttons
    if (target.hasAttribute('data-pc-refresh-target')) {
      state.lastWriteReceipt = null;
      refreshTargetContextForInherit({ resetMapping: true });
      renderCurrentTab({ resetScroll: false });
      return;
    }

    if (target.dataset.pcInheritMode) {
      state.inheritMode = target.dataset.pcInheritMode;
      const profile = getSelectedProfile();
      if (state.inheritMode === 'db' && state.targetReadResult?.ok && !state.mappingPlan && profile) {
        state.mappingPlan = buildDefaultMappingPlan(profile, state.targetReadResult.tableData);
      }
      const bodyEl = getBodyEl();
      bodyEl?.querySelectorAll('.pc-mode-btn').forEach(btn => {
        btn.classList.toggle('is-active', btn.dataset.pcInheritMode === state.inheritMode);
      });
      const host = bodyEl?.querySelector('[data-pc-inherit-mode-host]');
      if (host && profile && state.targetReadResult) {
        const identity = state.targetReadResult.identity;
        const binding = getChatBinding(getContext(), identity.bindingKey);
        host.innerHTML =
          state.inheritMode === 'db'
            ? renderDbWritebackSection(profile, state.targetReadResult)
            : renderPromptInjectSection(profile, identity, binding);
      }
      return;
    }

    if (target.hasAttribute('data-pc-show-all-ops')) {
      state.showAllOps = true;
      patchPreflightOnly();
      return;
    }

    if (target.hasAttribute('data-pc-apply-overflow-only')) {
      const profile = getSelectedProfile();
      const ctx = getContext();
      if (!profile || !state.targetReadResult?.ok) return;
      const compiled = compileWritePlan(profile, state.targetReadResult.tableData, state.mappingPlan);
      applyOverflowBinding(ctx, profile, compiled.overflowText);
      notifyToast('success', `已将主角「${profile.name}」的补充传承信息注入当前聊天。`);
      patchInheritStatusMeta();
      patchPreflightOnly();
      return;
    }

    if (target.hasAttribute('data-pc-execute-db')) {
      const profile = getSelectedProfile();
      const ctx = getContext();
      if (!profile || !state.targetReadResult?.ok || !state.mappingPlan) return;
      target.disabled = true;
      target.textContent = '正在写入…';
      const compiled = compileWritePlan(profile, state.targetReadResult.tableData, state.mappingPlan);
      const receipt = await executeCompiledWritePlan(compiled, ctx);
      state.lastWriteReceipt = receipt;

      if (receipt.succeeded > 0 && state.alsoInjectOverflow && compiled.summary.hasOverflow && compiled.overflowText) {
        applyOverflowBinding(ctx, profile, compiled.overflowText);
      }

      if (receipt.ok) {
        notifyToast('success', `主角「${profile.name}」已成功写入当前聊天数据库（${receipt.succeeded} 行）！`);
      } else if (receipt.partial) {
        notifyToast('warning', receipt.error);
      } else {
        notifyToast('error', receipt.error || '写入失败，请查看下方回执明细。');
      }

      state.targetReadResult = readCurrentChatAcuTables(ctx);
      updateSettingsDrawerStatus();
      patchInheritStatusMeta();
      patchPreflightOnly();
      return;
    }

    if (target.hasAttribute('data-pc-regen-prompt')) {
      const profile = getSelectedProfile();
      if (!profile) return;
      state.promptDraftText = formatTablesAsCarryoverText(profile.name, profile.tables, profile.note);
      const ta = getBodyEl()?.querySelector('[data-pc-prompt-text]');
      if (ta) ta.value = state.promptDraftText;
      return;
    }

    if (target.hasAttribute('data-pc-apply-prompt')) {
      const profile = getSelectedProfile();
      const ctx = getContext();
      const identity = getCurrentChatIdentity(ctx);
      if (!identity.bindingKey) {
        notifyToast('warning', '请先打开一个具体聊天再应用注入。');
        return;
      }
      const text = String(state.promptDraftText || '').trim();
      if (!text) {
        notifyToast('warning', '注入文本为空，请先填写或重新生成。');
        return;
      }
      const binding = {
        enabled: true,
        mode: 'full_prompt',
        profileId: profile?.id || '',
        profileName: profile?.name || '主角',
        text,
        position: state.promptPosition,
        depth: state.promptDepth,
        role: state.promptRole,
      };
      setChatBinding(ctx, identity.bindingKey, binding);
      const res = applyChatPromptInjection(ctx, binding, identity.bindingKey);
      updateSettingsDrawerStatus();
      notifyToast('success', `已将主角「${binding.profileName}」注入当前聊天（${getChannelDisplayName(res.channel)}）。`);
      patchInheritStatusMeta();
      const host = getBodyEl()?.querySelector('[data-pc-inherit-mode-host]');
      if (host) host.innerHTML = renderPromptInjectSection(profile, identity, binding);
      return;
    }

    if (target.hasAttribute('data-pc-clear-prompt')) {
      const ctx = getContext();
      const identity = getCurrentChatIdentity(ctx);
      setChatBinding(ctx, identity.bindingKey, null);
      clearPromptInjection(ctx);
      updateSettingsDrawerStatus();
      notifyToast('info', '已取消当前聊天的主角提示词绑定。');
      patchInheritStatusMeta();
      const host = getBodyEl()?.querySelector('[data-pc-inherit-mode-host]');
      if (host) host.innerHTML = renderPromptInjectSection(getSelectedProfile(), identity, null);
      return;
    }

    // Tab 3 buttons
    if (target.hasAttribute('data-pc-copy-all')) {
      if (state.profiles.length === 0) return;
      const ok = await copyTextToClipboard(serializeProfilesArchive(state.profiles));
      notifyToast(ok ? 'success' : 'warning', ok ? '已复制全部主角档案 JSON 到剪贴板！' : '复制失败，请改用「下载备份」。');
      return;
    }

    if (target.hasAttribute('data-pc-export-all')) {
      if (state.profiles.length === 0) return;
      const json = serializeProfilesArchive(state.profiles);
      triggerJsonDownload(`protagonist_carryover_all_${Date.now()}.json`, json);
      notifyToast('success', '已触发备份文件下载（若手机端拦截下载，请点「📋 复制全部」）。');
      return;
    }

    if (target.dataset.pcLibInherit) {
      state.selectedProfileId = target.dataset.pcLibInherit;
      switchTab('inherit');
      return;
    }

    if (target.dataset.pcLibEdit) {
      const profile = state.profiles.find(p => p.id === target.dataset.pcLibEdit);
      if (!profile) return;
      state.exportDraft = buildExportDraftFromProfile(profile);
      switchTab('export');
      return;
    }

    if (target.dataset.pcLibCopy) {
      const profile = state.profiles.find(p => p.id === target.dataset.pcLibCopy);
      if (!profile) return;
      const ok = await copyTextToClipboard(serializeProfilesArchive([profile]));
      notifyToast(ok ? 'success' : 'warning', ok ? `已复制「${profile.name}」的 JSON 到剪贴板！` : '复制失败，请改用下载。');
      return;
    }

    if (target.dataset.pcLibExport) {
      const profile = state.profiles.find(p => p.id === target.dataset.pcLibExport);
      if (!profile) return;
      const safeName = profile.name.replace(/[\\/:*?"<>|]+/g, '_') || 'protagonist';
      triggerJsonDownload(`protagonist_${safeName}.json`, serializeProfilesArchive([profile]));
      return;
    }

    if (target.dataset.pcLibDelete) {
      const id = target.dataset.pcLibDelete;
      const profile = state.profiles.find(p => p.id === id);
      if (!profile) return;
      const confirmFn = getHostWindow()?.confirm || globalThis.confirm;
      if (typeof confirmFn === 'function' && !confirmFn(`确定要从传承库删除主角「${profile.name}」吗？（不会影响已写入任何聊天的记录）`)) {
        return;
      }
      state.profiles = await deleteProfile(getContext(), id);
      if (state.selectedProfileId === id) {
        state.selectedProfileId = state.profiles[0]?.id || '';
      }
      notifyToast('info', `已删除主角「${profile.name}」。`);
      renderCurrentTab({ resetScroll: false });
    }
  }

  async function handleBodyChange(evt) {
    const el = evt.target;
    if (!el) return;

    if (el.hasAttribute('data-pc-upload-source') || el.hasAttribute('data-pc-import-archive')) {
      const file = el.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        await importFromJsonString(text, file.name);
      } catch (err) {
        notifyToast('error', err?.message || String(err));
      }
      return;
    }

    // Tab 1: 勾选整张表（纯原地 DOM 补丁）
    if (el.dataset.pcSheetToggle !== undefined) {
      const sIdx = Number(el.dataset.pcSheetToggle);
      const s = state.exportDraft?.sheets[sIdx];
      if (!s) return;
      s.selected = el.checked;
      if (!s.selected) {
        s.rows.forEach(r => { r.editing = false; });
      }
      const card = getBodyEl()?.querySelector(`[data-pc-sheet-card="${sIdx}"]`);
      card?.classList.toggle('is-selected', s.selected);
      if (s.selected && !s.expanded && !isMobileViewport()) {
        s.expanded = true;
        patchSheetBody(sIdx);
      } else if (s.expanded) {
        patchSheetBody(sIdx);
      }
      patchExportCounts(sIdx);
      return;
    }

    // Tab 1: 勾选单行（0.05ms 纯原地状态切换）
    if (el.dataset.pcRowToggle !== undefined) {
      const [sIdx, rIdx] = el.dataset.pcRowToggle.split(':').map(Number);
      const s = state.exportDraft?.sheets[sIdx];
      const r = s?.rows[rIdx];
      if (!s || !r) return;
      r.selected = el.checked;
      if (!r.selected && r.editing) {
        r.editing = false;
        patchSingleRow(sIdx, rIdx);
      } else {
        const rowEl = el.closest('[data-pc-row-item]');
        rowEl?.classList.toggle('pc-row-dim', !r.selected);
        const editBtn = rowEl?.querySelector('[data-pc-row-edit]');
        if (editBtn) editBtn.disabled = !(s.selected && r.selected);
      }
      patchExportCounts(sIdx);
      return;
    }

    // Tab 2: 切换主角档案
    if (el.hasAttribute('data-pc-select-profile')) {
      state.selectedProfileId = el.value;
      state.lastWriteReceipt = null;
      refreshTargetContextForInherit({ resetMapping: true });
      renderCurrentTab({ resetScroll: false });
      return;
    }

    // Tab 2: 切换目标映射表（只重绘当前这 1 张卡片 + 体检区）
    if (el.dataset.pcTargetSheet !== undefined) {
      const mIdx = Number(el.dataset.pcTargetSheet);
      const tblMap = state.mappingPlan?.tableMappings[mIdx];
      const profile = getSelectedProfile();
      if (!tblMap || !profile || !state.targetReadResult?.ok) return;
      const newKey = el.value || null;
      tblMap.targetSheetKey = newKey;
      const tgtSchema = state.targetReadResult.sheets.find(s => s.sheetKey === newKey) || null;
      tblMap.columnMappings = tgtSchema
        ? buildDefaultColumnMappings(profile.tables[tblMap.sourceIndex], tgtSchema)
        : {};
      const inner = getBodyEl()?.querySelector(`[data-pc-map-inner="${mIdx}"]`);
      if (inner) inner.innerHTML = renderMapCardInnerHtml(profile, state.targetReadResult, tblMap, mIdx);
      patchPreflightOnly();
      return;
    }

    if (el.dataset.pcSingleStrategy !== undefined) {
      const mIdx = Number(el.dataset.pcSingleStrategy);
      if (state.mappingPlan?.tableMappings[mIdx]) {
        state.mappingPlan.tableMappings[mIdx].singleRowStrategy = el.value;
        patchPreflightOnly();
      }
      return;
    }

    if (el.dataset.pcDupStrategy !== undefined) {
      const mIdx = Number(el.dataset.pcDupStrategy);
      if (state.mappingPlan?.tableMappings[mIdx]) {
        state.mappingPlan.tableMappings[mIdx].duplicateStrategy = el.value;
        patchPreflightOnly();
      }
      return;
    }

    if (el.dataset.pcColMode !== undefined) {
      const [mIdx, cIdx] = el.dataset.pcColMode.split(':').map(Number);
      const tblMap = state.mappingPlan?.tableMappings[mIdx];
      const profile = getSelectedProfile();
      const tgtSchema = state.targetReadResult?.sheets.find(s => s.sheetKey === tblMap?.targetSheetKey);
      const tCol = tgtSchema?.columns[cIdx];
      if (!tblMap || !profile || !tCol) return;
      const prev = tblMap.columnMappings[tCol.header] || {};
      const nextCm = {
        mode: el.value,
        sourceColumn: prev.sourceColumn || '',
        extractPart: null,
        combineColumns: Array.isArray(prev.combineColumns) ? prev.combineColumns : [],
        joiner: prev.joiner ?? '/',
        constantValue: prev.constantValue ?? '',
      };
      tblMap.columnMappings[tCol.header] = nextCm;
      const valCell = getBodyEl()?.querySelector(`[data-pc-col-val-cell="${mIdx}:${cIdx}"]`);
      if (valCell) {
        valCell.innerHTML = renderColumnValueControlHtml(profile.tables[tblMap.sourceIndex], tgtSchema, tCol, nextCm, mIdx, cIdx);
      }
      patchPreflightOnly();
      return;
    }

    if (el.dataset.pcColSrc !== undefined) {
      const [mIdx, cIdx] = el.dataset.pcColSrc.split(':').map(Number);
      const tblMap = state.mappingPlan?.tableMappings[mIdx];
      const tgtSchema = state.targetReadResult?.sheets.find(s => s.sheetKey === tblMap?.targetSheetKey);
      const colHeader = tgtSchema?.columns[cIdx]?.header;
      if (!tblMap || !colHeader) return;
      tblMap.columnMappings[colHeader].sourceColumn = el.value;
      tblMap.columnMappings[colHeader].extractPart = null;
      el.closest('[data-pc-col-val-cell]')?.querySelector('.pc-mini-hint')?.remove();
      patchPreflightOnly();
      return;
    }

    if (el.dataset.pcColConst !== undefined) {
      const [mIdx, cIdx] = el.dataset.pcColConst.split(':').map(Number);
      const tblMap = state.mappingPlan?.tableMappings[mIdx];
      const tgtSchema = state.targetReadResult?.sheets.find(s => s.sheetKey === tblMap?.targetSheetKey);
      const colHeader = tgtSchema?.columns[cIdx]?.header;
      if (!tblMap || !colHeader) return;
      tblMap.columnMappings[colHeader].constantValue = el.value;
      patchPreflightOnly();
      return;
    }

    if (el.dataset.pcColCombine !== undefined) {
      const [mIdx, cIdx] = el.dataset.pcColCombine.split(':').map(Number);
      const tblMap = state.mappingPlan?.tableMappings[mIdx];
      const tgtSchema = state.targetReadResult?.sheets.find(s => s.sheetKey === tblMap?.targetSheetKey);
      const colHeader = tgtSchema?.columns[cIdx]?.header;
      if (!tblMap || !colHeader) return;
      const list = new Set(tblMap.columnMappings[colHeader].combineColumns || []);
      if (el.checked) list.add(el.value);
      else list.delete(el.value);
      tblMap.columnMappings[colHeader].combineColumns = [...list];
      patchPreflightOnly();
      return;
    }

    if (el.dataset.pcColJoiner !== undefined) {
      const [mIdx, cIdx] = el.dataset.pcColJoiner.split(':').map(Number);
      const tblMap = state.mappingPlan?.tableMappings[mIdx];
      const tgtSchema = state.targetReadResult?.sheets.find(s => s.sheetKey === tblMap?.targetSheetKey);
      const colHeader = tgtSchema?.columns[cIdx]?.header;
      if (!tblMap || !colHeader) return;
      tblMap.columnMappings[colHeader].joiner = el.value;
      patchPreflightOnly();
      return;
    }

    if (el.hasAttribute('data-pc-toggle-overflow')) {
      state.alsoInjectOverflow = el.checked;
      return;
    }

    if (el.hasAttribute('data-pc-prompt-pos')) {
      state.promptPosition = el.value;
      return;
    }

    if (el.hasAttribute('data-pc-prompt-role')) {
      state.promptRole = el.value;
    }
  }

  function handleBodyInput(evt) {
    const el = evt.target;
    if (!el) return;

    if (el.hasAttribute('data-pc-paste-input')) {
      state.pasteText = el.value;
      return;
    }
    if (el.hasAttribute('data-pc-draft-name')) {
      if (state.exportDraft) state.exportDraft.name = el.value;
      return;
    }
    if (el.hasAttribute('data-pc-draft-source')) {
      if (state.exportDraft) state.exportDraft.sourceLabel = el.value;
      return;
    }
    if (el.hasAttribute('data-pc-draft-note')) {
      if (state.exportDraft) state.exportDraft.note = el.value;
      return;
    }
    if (el.dataset.pcCell !== undefined) {
      const [sIdx, rIdx, cIdx] = el.dataset.pcCell.split(':').map(Number);
      const sheet = state.exportDraft?.sheets[sIdx];
      if (!sheet?.rows[rIdx]) return;
      sheet.rows[rIdx].values[sheet.headers[cIdx]] = el.value;
      return;
    }
    if (el.dataset.pcColConst !== undefined && el.tagName !== 'SELECT') {
      const [mIdx, cIdx] = el.dataset.pcColConst.split(':').map(Number);
      const tblMap = state.mappingPlan?.tableMappings[mIdx];
      const tgtSchema = state.targetReadResult?.sheets.find(s => s.sheetKey === tblMap?.targetSheetKey);
      const colHeader = tgtSchema?.columns[cIdx]?.header;
      if (!tblMap || !colHeader) return;
      tblMap.columnMappings[colHeader].constantValue = el.value;
      schedulePreflightPatch();
      return;
    }
    if (el.hasAttribute('data-pc-prompt-depth')) {
      state.promptDepth = Number(el.value || 0);
      return;
    }
    if (el.hasAttribute('data-pc-prompt-text')) {
      state.promptDraftText = el.value;
    }
  }

  function patchInheritStatusMeta() {
    const metaEl = getBodyEl()?.querySelector('[data-pc-inherit-status-meta]');
    if (!metaEl || !state.targetReadResult) return;
    const ctx = getContext();
    const identity = state.targetReadResult.identity;
    const binding = getChatBinding(ctx, identity.bindingKey);
    metaEl.innerHTML = renderInheritStatusMetaHtml(identity, state.targetReadResult, binding);
  }

  function applyOverflowBinding(ctx, profile, overflowText) {
    const identity = getCurrentChatIdentity(ctx);
    if (!identity.bindingKey || !overflowText) return;
    const settings = getExtensionSettings(ctx);
    const binding = {
      enabled: true,
      mode: 'overflow_prompt',
      profileId: profile.id,
      profileName: `${profile.name}（补充传承）`,
      text: overflowText,
      position: settings.defaultPromptPosition || 'in_chat',
      depth: settings.defaultPromptDepth ?? 2,
      role: settings.defaultPromptRole || 'system',
    };
    setChatBinding(ctx, identity.bindingKey, binding);
    applyChatPromptInjection(ctx, binding, identity.bindingKey);
    updateSettingsDrawerStatus();
  }

  function onChatChanged() {
    const ctx = getContext();
    const identity = getCurrentChatIdentity(ctx);
    const binding = getChatBinding(ctx, identity.bindingKey);
    applyChatPromptInjection(ctx, binding, identity.bindingKey);
    updateSettingsDrawerStatus();
    if (modalEl && state.activeTab === 'inherit') {
      state.lastWriteReceipt = null;
      refreshTargetContextForInherit({ resetMapping: true });
      renderCurrentTab({ resetScroll: true });
    }
  }

  return {
    mountSettingsDrawer,
    unmountSettingsDrawer,
    openWorkbench,
    closeWorkbench,
    onChatChanged,
    updateSettingsDrawerStatus,
  };
}
