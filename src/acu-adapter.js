/**
 * src/acu-adapter.js
 * 与「龙血玄黄·数据库（AlbusKen/shujuku）」运行时的安全对接层。
 * 通过公开全局对象 window.AutoCardUpdaterAPI 读写表格，不触碰数据库内部私有状态。
 */

import { extractSheetsFromTableData, deepCloneSafe } from './schema-engine.js';

function getTopWindow() {
  try {
    if (typeof window !== 'undefined' && window.parent && window.parent !== window && window.parent.AutoCardUpdaterAPI) {
      return window.parent;
    }
  } catch {
    // 跨域 iframe 忽略
  }
  return typeof window !== 'undefined' ? window : globalThis;
}

/** 检测龙血玄黄·数据库公开 API 是否已就绪 */
export function detectAcuApi() {
  const win = getTopWindow();
  const api = win?.AutoCardUpdaterAPI || null;
  if (!api || typeof api !== 'object') {
    return {
      available: false,
      api: null,
      capabilities: {
        canRead: false,
        canWrite: false,
        canRefresh: false,
        canReadContext: false,
      },
    };
  }
  return {
    available: true,
    api,
    capabilities: {
      canRead: typeof api.exportTableAsJson === 'function',
      canWrite: typeof api.updateRow === 'function' && typeof api.insertRow === 'function',
      canRefresh: typeof api.refreshDataAndWorldbook === 'function',
      canReadContext: typeof api.getTableHistoryContext === 'function',
    },
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
  const currentChar = (charId !== undefined && charId !== null && characters[Number(charId)])
    ? characters[Number(charId)]
    : null;
  const characterName = String(currentChar?.name || '').trim();

  let bindingKey = '';
  if (chatId) {
    bindingKey = groupId ? `group:${groupId}::${chatId}` : `char:${characterName || charId || 'unknown'}::${chatId}`;
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

/** 实时读取当前聊天龙血玄黄数据库的全部表格 */
export function readCurrentChatAcuTables(stContext) {
  const acu = detectAcuApi();
  const floorState = inspectCurrentChatFloorState(stContext);
  const identity = getCurrentChatIdentity(stContext);

  if (!acu.available || !acu.capabilities.canRead) {
    return {
      ok: false,
      reason: '未检测到「龙血玄黄·数据库」（window.AutoCardUpdaterAPI.exportTableAsJson 不可用）。请确认已安装并启用数据库，或改用上传 Checkpoint JSON 文件。',
      acu,
      floorState,
      identity,
      tableData: null,
      sheets: [],
    };
  }

  let rawData;
  try {
    rawData = acu.api.exportTableAsJson();
  } catch (err) {
    return {
      ok: false,
      reason: `读取数据库表格时报错：${err?.message || String(err)}`,
      acu,
      floorState,
      identity,
      tableData: null,
      sheets: [],
    };
  }

  if (!rawData || typeof rawData !== 'object') {
    return {
      ok: false,
      reason: '当前聊天还没有初始化数据库表格数据。',
      acu,
      floorState,
      identity,
      tableData: null,
      sheets: [],
    };
  }

  const tableData = deepCloneSafe(rawData);
  const sheets = extractSheetsFromTableData(tableData);
  if (sheets.length === 0) {
    return {
      ok: false,
      reason: '当前聊天数据库尚未加载出任何表格（请先打开具体角色聊天并让数据库完成初始化）。',
      acu,
      floorState,
      identity,
      tableData,
      sheets: [],
    };
  }

  return {
    ok: true,
    reason: '',
    acu,
    floorState,
    identity,
    tableData,
    sheets,
  };
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
      refreshed = Boolean(await acu.api.refreshDataAndWorldbook());
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
