/**
 * src/acu-adapter.js
 * 与「龙血玄黄·数据库（AlbusKen/shujuku）」运行时的安全对接层。
 *
 * 特性：
 * 1. 多窗口穿透扫描：自动覆盖 window / parent 链 / top / 同源子 frames，兼容扩展模式、酒馆助手 iframe 模式与 TauriTavern；
 * 2. 四态精准识别：明确区分「已连上并有表」「已连上但暂未加载表」「聊天楼层兜底只读存档」「未发现接口」，不再笼统报“未检测到”；
 * 3. 自动触发刷新与历史快照兜底：显式读取时若发现接口已挂载但尚未水合，自动尝试 refreshDataAndWorldbook() 与 exportTableSnapshotsAtMessages()；
 * 4. 聊天楼层直读兜底：即使实时接口未就绪，也可扫描 chat[i] 上的 TavernDB_ACU_* 字段导出主角（严格标注只读，不冒充可写回）；
 * 5. 一键零隐私泄露诊断报告：只采集窗口/接口/字段名等元信息，方便手机端一键复制定位问题。
 */

import { extractSheetsFromTableData } from './schema-engine.js';
import {
  collectCandidateWindows,
  detectRuntimeMode,
  getTavernHelperApi,
  safeGetProp,
} from './host-env.js';

const FLOOR_ACU_FIELDS = [
  'TavernDB_ACU_IsolatedData',
  'TavernDB_ACU_IndependentData',
  'TavernDB_ACU_Data',
  'TavernDB_ACU_SummaryData',
];

const SUSPECTED_DB_GLOBAL_PATTERN =
  /AutoCard|ACU|TavernDB|Shujuku|Database|MemoryTable|TableManager|Unbirth|st_memory|TableAPI/i;

function safeJsonParse(raw) {
  if (typeof raw !== 'string') return raw;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function isSheetEntry(key, val) {
  if (key === 'mate' || !val || typeof val !== 'object' || Array.isArray(val)) return false;
  if (!Array.isArray(val.content)) return false;
  if (key.startsWith('sheet_')) return true;
  return typeof val.name === 'string' && val.content.length > 0 && Array.isArray(val.content[0]);
}

function countSheetsInObject(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return 0;
  let count = 0;
  for (const key of Object.keys(obj)) {
    if (isSheetEntry(key, obj[key])) count += 1;
  }
  return count;
}

/** 规范化 exportTableAsJson() 或快照返回值（兼容对象、JSON 字符串、外层包装对象） */
export function normalizeAcuTablePayload(raw) {
  const parsed = typeof raw === 'string' ? safeJsonParse(raw) : raw;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  if (countSheetsInObject(parsed) > 0) return parsed;
  if (parsed.tableSnapshot && countSheetsInObject(parsed.tableSnapshot) > 0) return parsed.tableSnapshot;
  if (parsed.data && countSheetsInObject(parsed.data) > 0) return parsed.data;
  if (parsed.tables && countSheetsInObject(parsed.tables) > 0) return parsed.tables;
  return parsed;
}

/** 检测龙血玄黄·数据库公开 API 是否已就绪（多窗口安全穿透扫描） */
export function detectAcuApi() {
  const scan = collectCandidateWindows();
  let foundApi = null;
  let sourceWindowLabel = '';
  let hasAcuInstanceFlag = false;
  let hasV2UiApi = false;

  for (const { win, label } of scan.windows) {
    if (!hasAcuInstanceFlag && safeGetProp(win, '__ACU_STAR_DB_III_LOADED__')) {
      hasAcuInstanceFlag = true;
    }
    if (!hasV2UiApi && safeGetProp(win, 'AutoCardUpdaterV2API')) {
      hasV2UiApi = true;
    }
    if (!foundApi) {
      const candidate = safeGetProp(win, 'AutoCardUpdaterAPI');
      if (candidate && typeof candidate === 'object') {
        foundApi = candidate;
        sourceWindowLabel = label;
      }
    }
  }

  const scanMeta = {
    scannedLabels: scan.windows.map(w => w.label),
    parentAccessBlocked: scan.parentAccessBlocked,
    topAccessBlocked: scan.topAccessBlocked,
    blockedFrameCount: scan.blockedFrameCount,
    sameOriginFramesScanned: scan.sameOriginFramesScanned,
  };

  if (!foundApi) {
    return {
      available: false,
      api: null,
      sourceWindowLabel: '',
      hasAcuInstanceFlag,
      hasV2UiApi,
      scanMeta,
      capabilities: {
        canRead: false,
        canWrite: false,
        canRefresh: false,
        canReadContext: false,
        canSubscribe: false,
        canUnsubscribe: false,
        canReadHistorySnapshots: false,
      },
    };
  }

  return {
    available: true,
    api: foundApi,
    sourceWindowLabel,
    hasAcuInstanceFlag,
    hasV2UiApi,
    scanMeta,
    capabilities: {
      canRead: typeof safeGetProp(foundApi, 'exportTableAsJson') === 'function',
      canWrite:
        typeof safeGetProp(foundApi, 'updateRow') === 'function' &&
        typeof safeGetProp(foundApi, 'insertRow') === 'function',
      canRefresh: typeof safeGetProp(foundApi, 'refreshDataAndWorldbook') === 'function',
      canReadContext: typeof safeGetProp(foundApi, 'getTableHistoryContext') === 'function',
      canSubscribe: typeof safeGetProp(foundApi, 'registerTableUpdateCallback') === 'function',
      canUnsubscribe: typeof safeGetProp(foundApi, 'unregisterTableUpdateCallback') === 'function',
      canReadHistorySnapshots: typeof safeGetProp(foundApi, 'exportTableSnapshotsAtMessages') === 'function',
    },
  };
}

function mergeSheetRecords(target, sourceObj) {
  if (!sourceObj || typeof sourceObj !== 'object' || Array.isArray(sourceObj)) return false;
  let mergedAny = false;
  for (const [key, val] of Object.entries(sourceObj)) {
    if (isSheetEntry(key, val)) {
      target[key] = val;
      mergedAny = true;
    }
  }
  return mergedAny;
}

function pickIsolatedSlot(container, preferredIsolationKey) {
  if (!container || typeof container !== 'object' || Array.isArray(container)) {
    return { key: '', tagData: null };
  }
  const preferred = String(preferredIsolationKey ?? '');
  if (Object.prototype.hasOwnProperty.call(container, preferred) && container[preferred]) {
    return { key: preferred, tagData: container[preferred] };
  }
  if (Object.prototype.hasOwnProperty.call(container, '') && container['']) {
    return { key: '', tagData: container[''] };
  }
  for (const key of Object.keys(container)) {
    const val = container[key];
    if (val && typeof val === 'object') {
      return { key, tagData: val };
    }
  }
  return { key: '', tagData: null };
}

/**
 * 从聊天消息楼层（chat[i].TavernDB_ACU_*）中只读提取最近的龙血玄黄数据库表快照。
 * 用于实时 API 未水合或被沙箱隔绝时，仍能让用户在「导出主角」里顺利导出主角数据。
 */
export function extractAcuTableDataFromChatFloors(stContext, preferredIsolationKey = '') {
  const chat = Array.isArray(stContext?.chat) ? stContext.chat : [];
  const merged = {};
  const matchedFloors = [];
  const matchedFieldsSet = new Set();
  let hasIncrementalLogOps = false;
  let isolationKeyUsed = String(preferredIsolationKey ?? '');

  for (let i = 0; i < chat.length; i += 1) {
    const msg = chat[i];
    if (!msg || typeof msg !== 'object') continue;
    let floorHit = false;

    // 1. V2 / V1 隔离容器 TavernDB_ACU_IsolatedData
    if (msg.TavernDB_ACU_IsolatedData !== undefined && msg.TavernDB_ACU_IsolatedData !== null) {
      const container = safeJsonParse(msg.TavernDB_ACU_IsolatedData);
      const { key, tagData } = pickIsolatedSlot(container, preferredIsolationKey);
      if (tagData && typeof tagData === 'object') {
        matchedFieldsSet.add('TavernDB_ACU_IsolatedData');
        floorHit = true;
        isolationKeyUsed = key;

        // V2 full checkpoint / transition checkpoint
        const frame = tagData.storageFrame;
        if (frame && typeof frame === 'object') {
          if (mergeSheetRecords(merged, frame.checkpoint?.data)) {
            hasIncrementalLogOps = false;
          }
          if (frame.perSheetCheckpoints && typeof frame.perSheetCheckpoints === 'object') {
            for (const [sKey, cp] of Object.entries(frame.perSheetCheckpoints)) {
              if (cp && typeof cp === 'object' && isSheetEntry(sKey, cp.data)) {
                merged[sKey] = cp.data;
              }
            }
          }
          if (Array.isArray(frame.logEntries)) {
            for (const entry of frame.logEntries) {
              const ops = [
                ...(Array.isArray(entry?.operations) ? entry.operations : []),
                ...(Array.isArray(entry?.patches) ? entry.patches : []),
              ];
              for (const op of ops) {
                if (!op || typeof op !== 'object') continue;
                if (op.kind === 'data_replace' && op.data) {
                  if (mergeSheetRecords(merged, op.data)) {
                    hasIncrementalLogOps = false;
                  }
                } else if (op.kind === 'sheet_replace' && op.sheetKey && isSheetEntry(op.sheetKey, op.sheet)) {
                  merged[op.sheetKey] = op.sheet;
                } else if (
                  op.kind === 'sql_batch' ||
                  op.kind === 'sql_sheet_batch' ||
                  op.kind === 'table_edit_dsl' ||
                  op.kind === 'row_upsert' ||
                  op.kind === 'row_delete'
                ) {
                  hasIncrementalLogOps = true;
                }
              }
            }
          }
        }
        if (tagData.compatTransitionCheckpoint?.data) {
          if (mergeSheetRecords(merged, tagData.compatTransitionCheckpoint.data)) {
            hasIncrementalLogOps = false;
          }
        }
        if (tagData.spv79TransitionCheckpoint?.data) {
          if (mergeSheetRecords(merged, tagData.spv79TransitionCheckpoint.data)) {
            hasIncrementalLogOps = false;
          }
        }
        // V1 legacy independentData
        if (tagData.independentData) {
          mergeSheetRecords(merged, tagData.independentData);
        }
      }
    }

    // 2. 传统直存字段（旧版或独立字段）
    for (const field of ['TavernDB_ACU_IndependentData', 'TavernDB_ACU_Data', 'TavernDB_ACU_SummaryData']) {
      if (msg[field] !== undefined && msg[field] !== null) {
        const parsed = safeJsonParse(msg[field]);
        if (parsed && typeof parsed === 'object') {
          matchedFieldsSet.add(field);
          floorHit = true;
          mergeSheetRecords(merged, parsed);
        }
      }
    }

    if (floorHit) matchedFloors.push(i);
  }

  const sheetCount = countSheetsInObject(merged);
  return {
    found: sheetCount > 0,
    sheetCount,
    matchedFloors,
    matchedFields: [...matchedFieldsSet],
    hasIncrementalLogOps,
    isolationKeyUsed,
    tableData: sheetCount > 0 ? merged : null,
  };
}

/** 快速检查聊天楼层是否存在 ACU 字段（供抽屉极轻量探针使用，不解析完整表格） */
function quickCountAcuFloors(stContext) {
  const chat = Array.isArray(stContext?.chat) ? stContext.chat : [];
  let floorMatchCount = 0;
  for (let i = chat.length - 1; i >= 0; i -= 1) {
    const msg = chat[i];
    if (!msg || typeof msg !== 'object') continue;
    for (const field of FLOOR_ACU_FIELDS) {
      if (msg[field] !== undefined && msg[field] !== null) {
        floorMatchCount += 1;
        break;
      }
    }
  }
  return floorMatchCount;
}

/**
 * 极轻量四态探针（供侧边栏抽屉与顶部状态栏显示，零卡顿）：
 * - 'ready'：实时接口已就绪且有表（可导出、可写回）
 * - 'api_empty'：实时接口已发现，但当前聊天暂未加载出表（还在初始化或尚未建表）
 * - 'floor_fallback'：实时接口未发现，但当前聊天楼层有 ACU 存档（可直接导出主角）
 * - 'api_missing'：未发现接口且楼层无 ACU 存档
 */
export function probeAcuStatusLight(stContext) {
  const acu = detectAcuApi();
  if (acu.available && acu.capabilities.canRead) {
    try {
      const normalized = normalizeAcuTablePayload(acu.api.exportTableAsJson());
      const sheetCount = countSheetsInObject(normalized);
      if (sheetCount > 0) {
        return {
          ok: true,
          canExport: true,
          canWrite: acu.capabilities.canWrite,
          status: 'ready',
          sheetCount,
          apiAvailable: true,
          sourceWindowLabel: acu.sourceWindowLabel,
          hasFloorData: false,
          floorMatchCount: 0,
          hasAcuInstanceFlag: acu.hasAcuInstanceFlag,
          hasV2UiApi: acu.hasV2UiApi,
        };
      }
    } catch {
      // fall through to api_empty / floor check
    }
    const floorMatchCount = stContext ? quickCountAcuFloors(stContext) : 0;
    return {
      ok: false,
      canExport: floorMatchCount > 0,
      canWrite: false,
      status: 'api_empty',
      sheetCount: 0,
      apiAvailable: true,
      sourceWindowLabel: acu.sourceWindowLabel,
      hasFloorData: floorMatchCount > 0,
      floorMatchCount,
      hasAcuInstanceFlag: acu.hasAcuInstanceFlag,
      hasV2UiApi: acu.hasV2UiApi,
    };
  }

  const floorMatchCount = stContext ? quickCountAcuFloors(stContext) : 0;
  if (floorMatchCount > 0) {
    const floorSnap = extractAcuTableDataFromChatFloors(stContext);
    if (floorSnap.found) {
      return {
        ok: false,
        canExport: true,
        canWrite: false,
        status: 'floor_fallback',
        sheetCount: floorSnap.sheetCount,
        apiAvailable: false,
        sourceWindowLabel: '',
        hasFloorData: true,
        floorMatchCount,
        hasAcuInstanceFlag: acu.hasAcuInstanceFlag,
        hasV2UiApi: acu.hasV2UiApi,
      };
    }
  }

  return {
    ok: false,
    canExport: false,
    canWrite: false,
    status: 'api_missing',
    sheetCount: 0,
    apiAvailable: false,
    sourceWindowLabel: '',
    hasFloorData: floorMatchCount > 0,
    floorMatchCount,
    hasAcuInstanceFlag: acu.hasAcuInstanceFlag,
    hasV2UiApi: acu.hasV2UiApi,
  };
}

/** 读取当前聊天是否至少有一条 AI 消息（龙血玄黄 V2 持久化需要挂载到最新 AI 楼层） */
export function inspectCurrentChatFloorState(stContext) {
  const chat = Array.isArray(stContext?.chat) ? stContext.chat : [];
  let aiFloorCount = 0;
  let lastAiIndex = -1;
  for (let i = 0; i < chat.length; i += 1) {
    const msg = chat[i];
    if (msg && !msg.is_user && !msg.is_system) {
      aiFloorCount += 1;
      lastAiIndex = i;
    }
  }
  return {
    totalMessages: chat.length,
    aiFloorCount,
    lastAiIndex,
    hasAiFloor: aiFloorCount > 0,
  };
}

/** 获取当前聊天的稳定标识（用于聊天级提示词隔离与来源标注） */
export function getCurrentChatIdentity(stContext) {
  const acu = detectAcuApi();
  let acuHistory = null;
  if (acu.capabilities.canReadContext) {
    try {
      acuHistory = acu.api.getTableHistoryContext() || null;
    } catch {
      acuHistory = null;
    }
  }

  const chatId = String(stContext?.chatId || acuHistory?.chatId || '').trim();
  const groupId = stContext?.groupId ?? acuHistory?.groupId ?? null;
  const charId = stContext?.characterId;
  const characters = Array.isArray(stContext?.characters) ? stContext.characters : [];
  const currentChar =
    charId !== undefined && charId !== null && characters[Number(charId)]
      ? characters[Number(charId)]
      : null;
  const characterName = String(currentChar?.name || '').trim();

  let bindingKey = '';
  if (chatId) {
    bindingKey = groupId
      ? `group:${groupId}::${chatId}`
      : `char:${characterName || charId || 'unknown'}::${chatId}`;
  }

  return {
    chatId,
    groupId,
    characterId: charId ?? null,
    characterName,
    isolationKey: String(acuHistory?.isolationKey || ''),
    bindingKey,
    displayLabel: [characterName, chatId].filter(Boolean).join(' / ') || '未打开聊天',
  };
}

/** 实时同步读取当前聊天龙血玄黄数据库的全部表格（带聊天楼层只读兜底与四态原因区分） */
export function readCurrentChatAcuTables(stContext) {
  const acu = detectAcuApi();
  const floorState = inspectCurrentChatFloorState(stContext);
  const identity = getCurrentChatIdentity(stContext);

  let liveError = '';
  if (acu.available && acu.capabilities.canRead) {
    try {
      const normalized = normalizeAcuTablePayload(acu.api.exportTableAsJson());
      const sheets = normalized ? extractSheetsFromTableData(normalized) : [];
      if (sheets.length > 0) {
        return {
          ok: true,
          canExport: true,
          canWrite: acu.capabilities.canWrite,
          status: 'ready',
          source: 'live_api',
          readOnlyFallback: false,
          reason: '',
          acu,
          floorState,
          identity,
          tableData: normalized,
          sheets,
          floorFallbackMeta: null,
        };
      }
    } catch (err) {
      liveError = err?.message || String(err);
    }
  }

  // 实时 API 未就绪或暂未加载出表时，尝试从当前聊天消息楼层的 TavernDB_ACU_* 字段只读提取
  const floorSnap = extractAcuTableDataFromChatFloors(stContext, identity.isolationKey);
  if (floorSnap.found) {
    const sheets = extractSheetsFromTableData(floorSnap.tableData);
    if (sheets.length > 0) {
      const incrementalHint = floorSnap.hasIncrementalLogOps
        ? '（检测到楼层含增量 SQL/日志记录，当前展示最近一次完整快照；若需最新逐行变动请先触发数据库刷新）'
        : '';
      return {
        ok: true,
        canExport: true,
        canWrite: false,
        status: acu.available ? 'api_empty_with_floor' : 'floor_fallback',
        source: 'chat_floor_fallback',
        readOnlyFallback: true,
        reason: acu.available
          ? `已连上数据库接口（${acu.sourceWindowLabel}），但实时内存表尚未加载完；已先从聊天楼层读出 ${sheets.length} 张只读存档表${incrementalHint}。若要写回数据库，请点「触发数据库刷新」。`
          : `未检测到实时数据库接口，但已从当前聊天楼层直接读出 ${sheets.length} 张数据库存档表（可直接导出主角；写回数据库需先启用龙血玄黄数据库）${incrementalHint}。`,
        acu,
        floorState,
        identity,
        tableData: floorSnap.tableData,
        sheets,
        floorFallbackMeta: floorSnap,
      };
    }
  }

  if (acu.available) {
    return {
      ok: false,
      canExport: false,
      canWrite: false,
      status: 'api_empty',
      source: 'none',
      readOnlyFallback: false,
      reason: liveError
        ? `已检测到龙血玄黄·数据库接口（${acu.sourceWindowLabel}），但读取表格时报错：${liveError}`
        : `已检测到龙血玄黄·数据库接口（${acu.sourceWindowLabel}），但当前聊天暂未加载出任何表格（切聊天后数据库需要约 1～2 秒加载，或本聊天尚未初始化数据库表）。请点击「触发数据库刷新」重试。`,
      acu,
      floorState,
      identity,
      tableData: null,
      sheets: [],
      floorFallbackMeta: null,
    };
  }

  const sandboxHint = acu.scanMeta.parentAccessBlocked
    ? '（检测到父窗口访问被 iframe 沙箱拦截，脚本可能无法读取主窗口上的 AutoCardUpdaterAPI；建议改用标准扩展安装或直接粘贴/上传 Checkpoint JSON）'
    : acu.hasAcuInstanceFlag || acu.hasV2UiApi
      ? '（检测到龙血玄黄部分标记但未暴露 AutoCardUpdaterAPI，请展开下方「检测诊断」查看详情）'
      : '请确认已安装并启用「龙血玄黄·数据库（AlbusKen/shujuku）」，或展开下方「检测诊断」排查。';

  return {
    ok: false,
    canExport: false,
    canWrite: false,
    status: 'api_missing',
    source: 'none',
    readOnlyFallback: false,
    reason: `未检测到「龙血玄黄·数据库」公开接口（AutoCardUpdaterAPI）。${sandboxHint}`,
    acu,
    floorState,
    identity,
    tableData: null,
    sheets: [],
    floorFallbackMeta: null,
  };
}

function withTimeout(promise, ms) {
  let timer = null;
  const timeoutPromise = new Promise(resolve => {
    timer = setTimeout(() => resolve({ __pcTimeout: true }), ms);
  });
  return Promise.race([
    Promise.resolve(promise).finally(() => {
      if (timer) clearTimeout(timer);
    }),
    timeoutPromise,
  ]);
}

/**
 * 异步智能读取（供用户点击「从当前聊天数据库读取」或「刷新检测」时调用）：
 * 1. 先同步读实时 API；
 * 2. 若接口已挂载但返回空表，主动触发一次 refreshDataAndWorldbook({ awaitFrontendReadback: false }) 后重读；
 * 3. 若仍为空且接口支持 exportTableSnapshotsAtMessages，则尝试按最新 AI 楼层读取历史快照；
 * 4. 若上下文 chat 为空且存在 TavernHelper.getChatMessages，则尝试拉取聊天消息扫描楼层存档；
 * 5. 保留最佳可用结果（live_api > history_snapshot_api > chat_floor_fallback）。
 */
export async function readCurrentChatAcuTablesAsync(
  stContext,
  {
    triggerRefreshIfEmpty = true,
    allowHistorySnapshotApi = true,
    allowTavernHelperMessages = true,
    refreshTimeoutMs = 8000,
  } = {}
) {
  let result = readCurrentChatAcuTables(stContext);
  if (result.source === 'live_api' && result.sheets.length > 0) {
    return result;
  }

  let triggeredRefresh = false;
  if (result.acu.available && triggerRefreshIfEmpty && result.acu.capabilities.canRefresh) {
    try {
      await withTimeout(
        result.acu.api.refreshDataAndWorldbook({ awaitFrontendReadback: false }),
        refreshTimeoutMs
      );
      triggeredRefresh = true;
      const afterRefresh = readCurrentChatAcuTables(stContext);
      if (afterRefresh.source === 'live_api' && afterRefresh.sheets.length > 0) {
        return { ...afterRefresh, triggeredRefresh: true };
      }
      if (!result.ok || afterRefresh.ok) {
        result = { ...afterRefresh, triggeredRefresh: true };
      }
    } catch (err) {
      console.warn('[ProtagonistCarryover] refreshDataAndWorldbook during read failed:', err);
    }
  }

  if (
    result.source !== 'live_api' &&
    result.acu.available &&
    allowHistorySnapshotApi &&
    result.acu.capabilities.canReadHistorySnapshots &&
    result.floorState.lastAiIndex >= 0
  ) {
    try {
      const histRes = await withTimeout(
        result.acu.api.exportTableSnapshotsAtMessages([result.floorState.lastAiIndex]),
        refreshTimeoutMs
      );
      const snapRaw = histRes?.success ? histRes.snapshots?.[0]?.data : null;
      const normalized = normalizeAcuTablePayload(snapRaw);
      const sheets = normalized ? extractSheetsFromTableData(normalized) : [];
      if (sheets.length > 0) {
        return {
          ok: true,
          canExport: true,
          canWrite: result.acu.capabilities.canWrite,
          status: 'ready',
          source: 'history_snapshot_api',
          readOnlyFallback: false,
          triggeredRefresh,
          reason: '',
          acu: result.acu,
          floorState: result.floorState,
          identity: result.identity,
          tableData: normalized,
          sheets,
          floorFallbackMeta: null,
        };
      }
    } catch (err) {
      console.warn('[ProtagonistCarryover] exportTableSnapshotsAtMessages fallback failed:', err);
    }
  }

  // 若 stContext.chat 为空（部分酒馆助手沙箱场景），尝试经 TavernHelper.getChatMessages 读取楼层
  if (
    !result.ok &&
    allowTavernHelperMessages &&
    result.floorState.totalMessages === 0
  ) {
    const th = getTavernHelperApi();
    if (typeof th?.getChatMessages === 'function') {
      try {
        const lastId = typeof th.getLastMessageId === 'function' ? Number(th.getLastMessageId()) : 0;
        const range = Number.isFinite(lastId) && lastId >= 0 ? `0-${lastId}` : '0-{{lastMessageId}}';
        const messages = await withTimeout(th.getChatMessages(range), 5000);
        if (Array.isArray(messages) && messages.length > 0) {
          const floorSnap = extractAcuTableDataFromChatFloors({ chat: messages }, result.identity.isolationKey);
          if (floorSnap.found) {
            const sheets = extractSheetsFromTableData(floorSnap.tableData);
            if (sheets.length > 0) {
              return {
                ok: true,
                canExport: true,
                canWrite: false,
                status: result.acu.available ? 'api_empty_with_floor' : 'floor_fallback',
                source: 'chat_floor_fallback',
                readOnlyFallback: true,
                triggeredRefresh,
                reason: `已通过酒馆助手消息接口从聊天楼层直接读出 ${sheets.length} 张数据库存档表（可直接导出主角）。`,
                acu: result.acu,
                floorState: inspectCurrentChatFloorState({ chat: messages }),
                identity: result.identity,
                tableData: floorSnap.tableData,
                sheets,
                floorFallbackMeta: floorSnap,
              };
            }
          }
        }
      } catch (err) {
        console.warn('[ProtagonistCarryover] TavernHelper.getChatMessages fallback failed:', err);
      }
    }
  }

  return { ...result, triggeredRefresh };
}

/** 采集零隐私泄露的数据库检测诊断快照（仅检查结构与键名，绝不读取聊天正文或密钥值） */
export function collectAcuDiagnostics(stContext) {
  const acu = detectAcuApi();
  const floorState = inspectCurrentChatFloorState(stContext);
  const identity = getCurrentChatIdentity(stContext);
  const scan = collectCandidateWindows();

  let exportReturnType = 'unavailable';
  let exportTopKeys = [];
  let exportSheetCount = 0;
  let exportError = '';

  if (acu.available && acu.capabilities.canRead) {
    try {
      const raw = acu.api.exportTableAsJson();
      exportReturnType = raw === null ? 'null' : Array.isArray(raw) ? 'array' : typeof raw;
      const normalized = normalizeAcuTablePayload(raw);
      if (normalized && typeof normalized === 'object') {
        exportTopKeys = Object.keys(normalized).slice(0, 12);
        exportSheetCount = countSheetsInObject(normalized);
      }
    } catch (err) {
      exportReturnType = 'error';
      exportError = err?.message || String(err);
    }
  }

  const floorSnap = extractAcuTableDataFromChatFloors(stContext, identity.isolationKey);

  // 扫描各窗口上疑似数据库相关的全局变量键名（只读键名，不读任何值）
  const suspectedDbKeys = new Set();
  for (const { win, label } of scan.windows) {
    try {
      const keys = Object.keys(win);
      for (const k of keys) {
        if (SUSPECTED_DB_GLOBAL_PATTERN.test(k)) {
          suspectedDbKeys.add(`${label}.${k}`);
          if (suspectedDbKeys.size >= 20) break;
        }
      }
    } catch {
      // ignore
    }
    if (suspectedDbKeys.size >= 20) break;
  }

  let verdict = '';
  if (acu.available && exportSheetCount > 0) {
    verdict = `检测正常：已在 ${acu.sourceWindowLabel} 找到 AutoCardUpdaterAPI，并读出 ${exportSheetCount} 张表。`;
  } else if (acu.available && exportSheetCount === 0) {
    verdict = floorSnap.found
      ? `已找到 AutoCardUpdaterAPI（${acu.sourceWindowLabel}），但实时内存表目前为空；已在聊天楼层发现 ${floorSnap.sheetCount} 张存档表。请点「触发数据库刷新」同步内存表，或直接导出楼层存档。`
      : `已找到 AutoCardUpdaterAPI（${acu.sourceWindowLabel}），但 exportTableAsJson() 返回空（${exportReturnType}，键数 ${exportTopKeys.length}）。通常是因为切换聊天后数据库还在加载（约 1~2 秒），或当前聊天尚未初始化数据库表格。`;
  } else if (scan.parentAccessBlocked) {
    verdict =
      '未能访问父窗口（被 iframe 同源/沙箱策略拦截），脚本无法直接读取宿主主窗口挂载的 AutoCardUpdaterAPI。建议改用标准扩展安装，或使用「上传/粘贴 Checkpoint JSON」。';
  } else if (floorSnap.found) {
    verdict = `所有可访问窗口均未找到 AutoCardUpdaterAPI，但当前聊天楼层存在龙血玄黄存档（${floorSnap.sheetCount} 张表）。请确认数据库扩展/脚本是否已启用；导出主角可直接使用楼层存档。`;
  } else if (suspectedDbKeys.size > 0) {
    verdict = `未找到 AutoCardUpdaterAPI，但发现了疑似其他数据库全局键：${[...suspectedDbKeys].join(', ')}。请复制本诊断信息发给作者以适配该版本/分支。`;
  } else {
    verdict =
      '未在任何可访问窗口找到 AutoCardUpdaterAPI，且当前聊天楼层不含 TavernDB_ACU_* 字段。请确认：① 已安装并勾选启用「龙血玄黄·数据库」；② 当前打开的是已使用该数据库的聊天（若使用的是其他表格插件，暂需导出 JSON 或使用纯提示词注入）。';
  }

  return {
    timestamp: new Date().toISOString(),
    runtimeMode: detectRuntimeMode(),
    isTauriTavern: Boolean(scan.windows.some(w => Boolean(safeGetProp(w.win, '__TAURITAVERN__')))),
    scannedWindows: scan.windows.map(w => w.label),
    parentAccessBlocked: scan.parentAccessBlocked,
    topAccessBlocked: scan.topAccessBlocked,
    blockedFrameCount: scan.blockedFrameCount,
    stContextPresent: Boolean(stContext),
    chatId: identity.chatId || '(空)',
    characterName: identity.characterName || '(无)',
    totalMessages: floorState.totalMessages,
    aiFloorCount: floorState.aiFloorCount,
    acuApiFound: acu.available,
    acuApiWindow: acu.sourceWindowLabel || '(无)',
    acuCapabilities: acu.capabilities,
    hasAcuInstanceFlag: acu.hasAcuInstanceFlag,
    hasV2UiApi: acu.hasV2UiApi,
    exportReturnType,
    exportTopKeys,
    exportSheetCount,
    exportError,
    floorMatchedCount: floorSnap.matchedFloors.length,
    floorMatchedFields: floorSnap.matchedFields,
    floorSheetCount: floorSnap.sheetCount,
    hasIncrementalLogOps: floorSnap.hasIncrementalLogOps,
    suspectedDbKeys: [...suspectedDbKeys],
    verdict,
  };
}

/** 将诊断快照格式化为便于手机端复制粘贴的纯文本 */
export function formatAcuDiagnosticsText(diag) {
  if (!diag) return '';
  const caps = diag.acuCapabilities || {};
  const enabledCaps = Object.entries(caps)
    .filter(([, v]) => Boolean(v))
    .map(([k]) => k);
  const lines = [
    `=== 主角跨聊天传承 · 数据库检测诊断 ===`,
    `时间: ${diag.timestamp}`,
    `运行环境: ${diag.isTauriTavern ? 'TauriTavern' : 'SillyTavern'} / 模式=${diag.runtimeMode}`,
    `扫描窗口: ${diag.scannedWindows.join(', ') || '(无)'} (父拦截=${diag.parentAccessBlocked}, 顶层拦截=${diag.topAccessBlocked}, 跳过跨域子框=${diag.blockedFrameCount})`,
    `聊天上下文: context=${diag.stContextPresent ? '有' : '无'}, chatId=${diag.chatId}, 角色=${diag.characterName}, 总楼层=${diag.totalMessages}, AI楼层=${diag.aiFloorCount}`,
    `AutoCardUpdaterAPI: ${diag.acuApiFound ? `已找到 @ ${diag.acuApiWindow}` : '未找到'}`,
    `ACU辅助标记: __ACU_STAR_DB_III_LOADED__=${diag.hasAcuInstanceFlag}, AutoCardUpdaterV2API=${diag.hasV2UiApi}`,
    `可用方法: ${enabledCaps.join(', ') || '(无)'}`,
    `exportTableAsJson(): 类型=${diag.exportReturnType}, 有效表数=${diag.exportSheetCount}, 顶层键=[${diag.exportTopKeys.join(', ')}]${diag.exportError ? `, 报错=${diag.exportError}` : ''}`,
    `聊天楼层存档: 命中楼层=${diag.floorMatchedCount}, 字段=[${diag.floorMatchedFields.join(', ')}], 提取表数=${diag.floorSheetCount}, 含增量日志=${diag.hasIncrementalLogOps}`,
    `其他疑似DB全局键: ${diag.suspectedDbKeys.join(', ') || '(无)'}`,
    `结论: ${diag.verdict}`,
  ];
  return lines.join('\n');
}

/**
 * 执行经过 schema-engine 校验后的写入计划。
 * 使用 skipNotify + skipRefresh 批量写入，末尾只调用一次 refreshDataAndWorldbook() 同步世界书与前端。
 */
export async function executeCompiledWritePlan(compiledPlan, stContext) {
  const acu = detectAcuApi();
  if (!acu.available || !acu.capabilities.canWrite) {
    return {
      ok: false,
      error: '当前页面未检测到龙血玄黄·数据库写入接口（AutoCardUpdaterAPI.updateRow / insertRow 不可用）。',
      results: [],
      succeeded: 0,
      failed: 0,
      skipped: 0,
      refreshed: false,
    };
  }

  const floorState = inspectCurrentChatFloorState(stContext);
  if (!floorState.hasAiFloor) {
    return {
      ok: false,
      error: '当前聊天还没有任何 AI 消息楼层（连开场白都没有），数据库无法落盘保存。请先有一条角色开场白或 AI 回复后再写表，或改用「纯提示词注入」。',
      results: [],
      succeeded: 0,
      failed: 0,
      skipped: 0,
      refreshed: false,
    };
  }

  if (!compiledPlan || compiledPlan.summary.errors > 0) {
    return {
      ok: false,
      error: '写入计划中仍有未处理的红色规则错误，已拦截写入以保护目标数据库。',
      results: [],
      succeeded: 0,
      failed: 0,
      skipped: 0,
      refreshed: false,
    };
  }

  const results = [];
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;

  for (const op of compiledPlan.operations) {
    if (op.action === 'skip') {
      skipped += 1;
      results.push({
        tableName: op.targetTableName,
        action: 'skip',
        ok: true,
        detail: op.warnings[0] || '按规则跳过',
      });
      continue;
    }

    try {
      if (op.action === 'update') {
        const ok = await acu.api.updateRow({
          tableName: op.targetTableName,
          rowIndex: op.targetRowIndex,
          data: op.data,
          skipNotify: true,
          skipRefresh: true,
        });
        if (ok) {
          succeeded += 1;
          results.push({
            tableName: op.targetTableName,
            action: 'update',
            rowIndex: op.targetRowIndex,
            ok: true,
            detail: `已更新第 ${op.targetRowIndex} 行`,
          });
        } else {
          failed += 1;
          results.push({
            tableName: op.targetTableName,
            action: 'update',
            rowIndex: op.targetRowIndex,
            ok: false,
            detail: '数据库拒绝了该行更新（可能目标行/列已加锁，或目标 SQLite 约束未通过，可打开浏览器控制台查看数据库日志）',
          });
        }
      } else if (op.action === 'insert') {
        const newRowIndex = await acu.api.insertRow({
          tableName: op.targetTableName,
          data: op.data,
          skipNotify: true,
          skipRefresh: true,
        });
        if (typeof newRowIndex === 'number' && newRowIndex >= 1) {
          succeeded += 1;
          results.push({
            tableName: op.targetTableName,
            action: 'insert',
            rowIndex: newRowIndex,
            ok: true,
            detail: `已新增至第 ${newRowIndex} 行`,
          });
        } else {
          failed += 1;
          results.push({
            tableName: op.targetTableName,
            action: 'insert',
            ok: false,
            detail: '数据库拒绝了新增该行（可能触发了 UNIQUE/CHECK/NOT NULL 约束，或缺少可保存的 AI 楼层）',
          });
        }
      }
    } catch (err) {
      failed += 1;
      results.push({
        tableName: op.targetTableName,
        action: op.action,
        ok: false,
        detail: `调用异常：${err?.message || String(err)}`,
      });
    }
  }

  let refreshed = false;
  if (succeeded > 0 && acu.capabilities.canRefresh) {
    try {
      refreshed = Boolean(await acu.api.refreshDataAndWorldbook({ awaitFrontendReadback: false }));
    } catch (err) {
      console.warn('[ProtagonistCarryover] refreshDataAndWorldbook failed:', err);
    }
  }

  return {
    ok: failed === 0 && succeeded > 0,
    partial: failed > 0 && succeeded > 0,
    error: failed > 0 ? `共 ${succeeded} 行成功，${failed} 行失败，请查看下方明细。` : '',
    results,
    succeeded,
    failed,
    skipped,
    refreshed,
  };
}
