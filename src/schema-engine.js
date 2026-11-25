/**
 * src/schema-engine.js
 * 跨聊天「龙血玄黄·数据库（AlbusKen/shujuku）」表规则解析、智能映射与写前体检引擎。
 * 纯 ES Module，无浏览器 DOM 依赖，可直接在 Node.js 单元测试与 SillyTavern 浏览器端复用。
 */

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export const ARCHIVE_FORMAT = 'st-protagonist-carryover-archive';
export const ARCHIVE_VERSION = 1;
export const ACU_CHECKPOINT_FORMAT = 'acu-table-checkpoint';

/** 常见中英文同义列分组（同一组内的列名视为语义等价，支持跨模板自动对齐） */
const COLUMN_SYNONYM_GROUPS = [
  ['人物名称', '姓名', '名称', '名字', '主角名', '角色名', 'char_name', 'name', 'protagonist_name'],
  ['性别', '生理性别', 'gender', 'sex'],
  ['年龄', '年纪', 'age'],
  ['性别/年龄', '性别年龄', 'gender_age'],
  ['外貌特征', '外貌', '外貌描写', '容貌', '外观', '长相', 'appearance'],
  ['穿着打扮', '衣着', '服饰', '穿搭', 'outfit', 'outfit_text'],
  ['职业/身份', '身份', '职业', '身份/职业', '社会身份', '头衔', 'occupation', 'identity', 'identity_text', 'role'],
  ['过往经历', '背景经历', '个人经历', '履历', '背景故事', '经历', 'past_experience', 'background', 'history'],
  ['性格特点', '性格', '性格特征', '性情', 'personality', 'traits'],
  ['近况', '当前状态', '状态', '身心状态', 'current_condition', 'condition', 'status'],
  ['所在地点', '当前地点', '地点', '位置', 'location', 'location_name', 'current_location'],
  ['随身财物', '随身物品', '携带物品', '财物', '装备', 'belongings', 'key_items', '持有的重要物品'],
  ['技能名称', '技能名', '技能', '能力名称', '能力名', 'skill_name', 'ability_name'],
  ['技能类型', '能力类型', '类型', '分类', 'skill_type', 'type'],
  ['等级/阶段', '等级', '阶段', '熟练度', '境界', 'skill_level', 'level', 'stage'],
  ['效果描述', '技能效果', '描述/效果', '效果', '功能描述', '详细描述', '描述', '说明', 'effect_desc', 'description', 'detail_desc'],
  ['物品名称', '物品名', '道具名称', '装备名称', 'item_name'],
  ['数量', '个数', '件数', '持有数量', 'quantity', 'count', 'amount'],
  ['类别', '物品类别', '分类', '道具类型', 'category'],
  ['一句话介绍', '简介', '简述', '概述', 'brief_intro', 'intro'],
  ['是否离场', '在场状态', 'is_absent', 'presence_status'],
  ['人际关系', '关系', '与主角关系', 'relation_text', 'relationship'],
  ['任务名称', '任务名', '事件名称', 'quest_name'],
  ['任务类型', 'quest_type'],
  ['当前进度', '进度', 'current_progress', 'progress'],
  ['概览', '概要', 'summary'],
  ['纪要', '事件内容', 'chronicle_text'],
];

const SYNONYM_MAP = (() => {
  const map = new Map();
  COLUMN_SYNONYM_GROUPS.forEach((group, groupIndex) => {
    for (const token of group) {
      map.set(normalizeToken(token), groupIndex);
    }
  });
  return map;
})();

const COMPOSITE_RULES = [
  {
    combinedSynonyms: ['性别/年龄', '性别年龄', 'gender_age'],
    parts: [
      { key: 'gender', synonyms: ['性别', '生理性别', 'gender', 'sex'] },
      { key: 'age', synonyms: ['年龄', '年纪', 'age'] },
    ],
    joiner: '/',
  },
];

export function normalizeToken(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_（）()【】\[\]：:·—\-]+/g, '');
}

export function deepCloneSafe(value) {
  return JSON.parse(JSON.stringify(value));
}

export function assertSafeJsonObject(value, path = '$') {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      assertSafeJsonObject(value[i], `${path}[${i}]`);
    }
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const key of Object.keys(value)) {
    if (DANGEROUS_KEYS.has(key)) {
      throw new Error(`JSON 包含不安全键名：${path}.${key}`);
    }
    assertSafeJsonObject(value[key], `${path}.${key}`);
  }
}

function stripSqlComments(text) {
  return String(text ?? '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ');
}

function extractCreateTableBody(ddl) {
  const raw = String(ddl ?? '');
  const createMatch = raw.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"'\[]?([A-Za-z_][A-Za-z0-9_]*)[`"'\]]?\s*\(/i);
  if (!createMatch) return { tableName: null, body: null };
  const tableName = createMatch[1];
  const openIndex = raw.indexOf('(', createMatch.index);
  if (openIndex < 0) return { tableName, body: null };

  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = openIndex; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inSingle) {
      if (ch === "'" && raw[i + 1] === "'") { i += 1; continue; }
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === '"' && raw[i + 1] === '"') { i += 1; continue; }
      if (ch === '"') inDouble = false;
      continue;
    }
    if (ch === "'") { inSingle = true; continue; }
    if (ch === '"') { inDouble = true; continue; }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) {
        return { tableName, body: raw.slice(openIndex + 1, i) };
      }
    }
  }
  return { tableName, body: raw.slice(openIndex + 1) };
}

function splitTopLevelSqlClauses(body) {
  const clauses = [];
  let current = '';
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;

  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    const next = body[i + 1];
    if (inLineComment) {
      current += ch;
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (!inSingle && !inDouble && ch === '-' && next === '-') {
      inLineComment = true;
      current += '--';
      i += 1;
      continue;
    }
    if (inSingle) {
      current += ch;
      if (ch === "'" && next === "'") { current += next; i += 1; continue; }
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      current += ch;
      if (ch === '"' && next === '"') { current += next; i += 1; continue; }
      if (ch === '"') inDouble = false;
      continue;
    }
    if (ch === "'") { inSingle = true; current += ch; continue; }
    if (ch === '"') { inDouble = true; current += ch; continue; }
    if (ch === '(') { depth += 1; current += ch; continue; }
    if (ch === ')') { depth = Math.max(0, depth - 1); current += ch; continue; }
    if (ch === ',' && depth === 0) {
      clauses.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) clauses.push(current);
  return clauses;
}

function parseSqlDefault(defSql) {
  const match = defSql.match(/\bDEFAULT\s+('(?:''|[^'])*'|"(?:""|[^"])*"|-?\d+(?:\.\d+)?|NULL|TRUE|FALSE)/i);
  if (!match) return { hasDefault: false, defaultValue: null };
  const token = match[1];
  if (/^NULL$/i.test(token)) return { hasDefault: true, defaultValue: null };
  if (/^TRUE$/i.test(token)) return { hasDefault: true, defaultValue: 'true' };
  if (/^FALSE$/i.test(token)) return { hasDefault: true, defaultValue: 'false' };
  if ((token.startsWith("'") && token.endsWith("'")) || (token.startsWith('"') && token.endsWith('"'))) {
    const quote = token[0];
    return {
      hasDefault: true,
      defaultValue: token.slice(1, -1).replace(new RegExp(`${quote}${quote}`, 'g'), quote),
    };
  }
  return { hasDefault: true, defaultValue: Number(token) };
}

function parseCheckConstraints(defSql, sqlName) {
  const result = {
    enumValues: null,
    minValue: null,
    minExclusive: false,
    globPattern: null,
    singleRowOnly: false,
  };
  if (!defSql) return result;

  if (sqlName === 'row_id' && /CHECK\s*\(\s*row_id\s*=\s*1\s*\)/i.test(defSql)) {
    result.singleRowOnly = true;
  }

  const inMatch = defSql.match(/\bIN\s*\(([^)]+)\)/i);
  if (inMatch) {
    const values = [];
    const litRegex = /'((?:''|[^'])*)'|"((?:""|[^"])*)"|(-?\d+(?:\.\d+)?)/g;
    let m;
    while ((m = litRegex.exec(inMatch[1])) !== null) {
      if (m[1] !== undefined) values.push(m[1].replace(/''/g, "'"));
      else if (m[2] !== undefined) values.push(m[2].replace(/""/g, '"'));
      else if (m[3] !== undefined) values.push(m[3]);
    }
    if (values.length > 0) result.enumValues = values;
  }

  const escapedName = sqlName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const gtMatch = defSql.match(new RegExp(`\\b${escapedName}\\s*(>=|>)\\s*(-?\\d+(?:\\.\\d+)?)`, 'i'));
  if (gtMatch) {
    result.minExclusive = gtMatch[1] === '>';
    result.minValue = Number(gtMatch[2]);
  }

  const globMatch = defSql.match(/\bGLOB\s+'((?:''|[^'])*)'/i);
  if (globMatch) {
    result.globPattern = globMatch[1].replace(/''/g, "'");
  }

  return result;
}

/** 将 SQLite GLOB 表达式转为 RegExp */
export function sqliteGlobToRegExp(pattern) {
  let regex = '^';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '*') {
      regex += '.*';
    } else if (ch === '?') {
      regex += '.';
    } else if (ch === '[') {
      const close = pattern.indexOf(']', i + 1);
      if (close > i + 1) {
        let content = pattern.slice(i + 1, close);
        if (content.startsWith('^') || content.startsWith('!')) {
          content = `^${content.slice(1)}`;
        }
        regex += `[${content}]`;
        i = close;
      } else {
        regex += '\\[';
      }
    } else {
      regex += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  regex += '$';
  return new RegExp(regex);
}

/**
 * 解析龙血玄黄·数据库单张 sheet 的完整表规则（DDL + note + insertNode + content 表头与已有行）
 */
export function parseSheetSchema(sheetKey, sheet) {
  const safeSheet = sheet && typeof sheet === 'object' ? sheet : {};
  const sourceData = safeSheet.sourceData && typeof safeSheet.sourceData === 'object' ? safeSheet.sourceData : {};
  const ddl = typeof sourceData.ddl === 'string' ? sourceData.ddl : '';
  const note = typeof sourceData.note === 'string' ? sourceData.note : '';
  const insertNode = typeof sourceData.insertNode === 'string' ? sourceData.insertNode : '';
  const updateNode = typeof sourceData.updateNode === 'string' ? sourceData.updateNode : '';
  const deleteNode = typeof sourceData.deleteNode === 'string' ? sourceData.deleteNode : '';

  const content = Array.isArray(safeSheet.content) ? safeSheet.content : [];
  const rawHeaders = Array.isArray(content[0]) ? content[0].map(h => String(h ?? '').trim()) : [];
  const hasRowIdColumn = rawHeaders.length > 0 && normalizeToken(rawHeaders[0]) === 'rowid';
  const businessHeaders = hasRowIdColumn ? rawHeaders.slice(1) : rawHeaders.slice();

  const { tableName: ddlTableName, body } = extractCreateTableBody(ddl);
  const ddlCols = [];
  const tableUniqueCols = new Set();
  let ddlSingleRow = false;

  if (body) {
    // 注释 `-- ...` 在 SQL 中属于该行本身的列定义（逗号在注释前面），
    // 因此必须按行提取 sqlName -> comment 映射，避免按逗号切分后注释错位到下一列。
    const ddlCommentsBySqlName = new Map();
    for (const line of body.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('--')) continue;
      const lineMatch = trimmed.match(/^[`"'\[]?([A-Za-z_][A-Za-z0-9_]*)[`"'\]]?\s+.*?--\s*(.+?)\s*,?\s*$/);
      if (lineMatch) {
        ddlCommentsBySqlName.set(lineMatch[1], lineMatch[2].trim());
      }
    }

    const clauses = splitTopLevelSqlClauses(body);
    for (const rawClause of clauses) {
      const cleaned = stripSqlComments(rawClause).trim();
      if (!cleaned) continue;

      if (/^UNIQUE\s*\(([^)]+)\)/i.test(cleaned)) {
        const uMatch = cleaned.match(/^UNIQUE\s*\(([^)]+)\)/i);
        if (uMatch) {
          uMatch[1].split(',').forEach(part => {
            const col = part.trim().replace(/^[`"'\[]|[`"'\]]$/g, '');
            if (col) tableUniqueCols.add(col);
          });
        }
        continue;
      }
      if (/^(?:PRIMARY\s+KEY|FOREIGN\s+KEY|CHECK|CONSTRAINT)\b/i.test(cleaned)) {
        if (/CHECK\s*\(\s*row_id\s*=\s*1\s*\)/i.test(cleaned)) ddlSingleRow = true;
        continue;
      }

      const headMatch = cleaned.match(/^[`"'\[]?([A-Za-z_][A-Za-z0-9_]*)[`"'\]]?(?:\s+([A-Za-z]+))?/);
      if (!headMatch) continue;
      const sqlName = headMatch[1];
      const comment = ddlCommentsBySqlName.get(sqlName) || null;
      const declaredType = headMatch[2] ? headMatch[2].toUpperCase() : 'TEXT';
      const checks = parseCheckConstraints(cleaned, sqlName);
      if (checks.singleRowOnly) ddlSingleRow = true;
      const defInfo = parseSqlDefault(cleaned);
      const isPrimaryKey = /\bPRIMARY\s+KEY\b/i.test(cleaned);
      const isNotNull = /\bNOT\s+NULL\b/i.test(cleaned);
      const isUnique = /\bUNIQUE\b/i.test(cleaned) || tableUniqueCols.has(sqlName);

      ddlCols.push({
        sqlName,
        declaredType,
        comment,
        isPrimaryKey,
        isNotNull,
        isUnique,
        hasDefault: defInfo.hasDefault,
        defaultValue: defInfo.defaultValue,
        enumValues: checks.enumValues,
        minValue: checks.minValue,
        minExclusive: checks.minExclusive,
        globPattern: checks.globPattern,
      });
    }
  }

  const businessDdlCols = ddlCols.filter(c => c.sqlName.toLowerCase() !== 'row_id' && !c.isPrimaryKey);
  const noteUniqueHints = extractUniqueHintsFromNote(note);

  const columns = businessHeaders.map((header, idx) => {
    const ddlCol =
      businessDdlCols.find(c => c.comment && normalizeToken(c.comment) === normalizeToken(header)) ||
      businessDdlCols[idx] ||
      null;

    const inferredUnique =
      Boolean(ddlCol?.isUnique) ||
      Boolean(ddlCol && tableUniqueCols.has(ddlCol.sqlName)) ||
      noteUniqueHints.has(normalizeToken(header));

    return {
      index: idx,
      contentIndex: hasRowIdColumn ? idx + 1 : idx,
      header,
      sqlName: ddlCol?.sqlName || null,
      declaredType: ddlCol?.declaredType || 'TEXT',
      isNotNull: Boolean(ddlCol?.isNotNull),
      isUnique: inferredUnique,
      hasDefault: Boolean(ddlCol?.hasDefault),
      defaultValue: ddlCol?.defaultValue ?? null,
      enumValues: ddlCol?.enumValues || null,
      minValue: ddlCol?.minValue ?? null,
      minExclusive: Boolean(ddlCol?.minExclusive),
      globPattern: ddlCol?.globPattern || null,
      comment: ddlCol?.comment || null,
    };
  });

  const noteSingleRow = /有且仅有一行|仅有一行|只能有一行|单行表/.test(note);
  const insertForbidden = /^禁止/.test(insertNode.trim()) || /禁止新增|禁止插入/.test(insertNode);
  const isSingleRow = ddlSingleRow || noteSingleRow || insertForbidden;

  const existingRows = [];
  for (let rowIndex = 1; rowIndex < content.length; rowIndex += 1) {
    const rawRow = content[rowIndex];
    if (!Array.isArray(rawRow)) continue;
    const values = {};
    let hasContent = false;
    for (const col of columns) {
      const cell = rawRow[col.contentIndex] ?? '';
      const text = cell === null || cell === undefined ? '' : String(cell);
      values[col.header] = text;
      if (text.trim() !== '') hasContent = true;
    }
    if (!hasContent) continue;
    existingRows.push({
      rowIndex,
      rowId: hasRowIdColumn ? String(rawRow[0] ?? rowIndex) : String(rowIndex),
      values,
    });
  }

  const schema = {
    sheetKey,
    uid: String(safeSheet.uid || sheetKey),
    name: String(safeSheet.name || sheetKey),
    ddlTableName,
    hasRowIdColumn,
    isSingleRow,
    columns,
    uniqueColumns: columns.filter(c => c.isUnique).map(c => c.header),
    note,
    noteSummary: summarizeNote(note),
    insertNode,
    updateNode,
    deleteNode,
    existingRows,
  };
  schema.role = classifySheetRole(schema);
  return schema;
}

function extractUniqueHintsFromNote(note) {
  const hints = new Set();
  if (!note) return hints;
  const lines = note.split('\n');
  for (const line of lines) {
    if (/不得与表中已有|不可重复|不得重复|唯一/.test(line)) {
      const colMatch = line.match(/列\d+\s*[:：]\s*([^\s\-—（(]+)/);
      if (colMatch) hints.add(normalizeToken(colMatch[1]));
    }
  }
  return hints;
}

function summarizeNote(note) {
  if (!note) return '';
  const firstLine = note
    .split('\n')
    .map(l => l.trim())
    .find(Boolean);
  if (!firstLine) return '';
  return firstLine.length > 90 ? `${firstLine.slice(0, 89)}…` : firstLine;
}

/** 识别表的业务角色，用于导出默认预选与跨聊天自动配对 */
export function classifySheetRole(schema) {
  const name = String(schema?.name || '');
  const ddl = String(schema?.ddlTableName || '').toLowerCase();

  if (/主角.*信息|主角.*档案|主角.*状态|玩家.*信息|玩家.*档案/.test(name) || /protagonist_info|player_info|mc_info/.test(ddl)) {
    return 'protagonist_info';
  }
  if (/主角.*技能|技能表|能力表|天赋|功法/.test(name) || /protagonist_skills|skills|abilities/.test(ddl)) {
    return 'protagonist_skills';
  }
  if (/背包|物品|装备|道具|行囊/.test(name) || /inventory|items|bag/.test(ddl)) {
    return 'inventory';
  }
  if (/重要角色|重要人物|npc|人际关系/.test(name) || /important_char|important_non_romance|npc/.test(ddl)) {
    return 'important_chars';
  }
  if (/纪要|总结|大事记/.test(name) || /chronicle|summary/.test(ddl)) {
    return 'chronicle';
  }
  if (/任务|事件/.test(name) || /quests|events/.test(ddl)) {
    return 'quests';
  }
  if (/全局数据|全局状态|时间地点/.test(name) || /global_state|global_data/.test(ddl)) {
    return 'global_state';
  }
  if (/选项/.test(name) || /options/.test(ddl)) {
    return 'options';
  }
  return 'custom';
}

export function isDefaultProtagonistRole(role) {
  return role === 'protagonist_info' || role === 'protagonist_skills' || role === 'inventory';
}

/**
 * 解析任意受支持的输入 JSON 字符串：
 * 1) 龙血玄黄 Checkpoint v1 (`format === 'acu-table-checkpoint'`)
 * 2) 龙血玄黄纯表格 JSON (`{ mate, sheet_* }`)
 * 3) 本插件导出的主角传承库/单档案 JSON (`format === 'st-protagonist-carryover-archive'`)
 */
export function parseImportedSourceJson(jsonText) {
  if (typeof jsonText !== 'string' || !jsonText.trim()) {
    throw new Error('导入的 JSON 内容为空。');
  }
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(`JSON 格式无法解析：${err.message}`);
  }
  assertSafeJsonObject(parsed);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('JSON 根节点必须是对象。');
  }

  if (parsed.format === ARCHIVE_FORMAT) {
    const profiles = Array.isArray(parsed.profiles) ? parsed.profiles : parsed.profile ? [parsed.profile] : [];
    if (profiles.length === 0) {
      throw new Error('主角传承档案文件中没有可用的主角记录。');
    }
    return {
      kind: 'carryover_archive',
      profiles: deepCloneSafe(profiles),
    };
  }

  if (parsed.format === ACU_CHECKPOINT_FORMAT) {
    if (!parsed.tableSnapshot || typeof parsed.tableSnapshot !== 'object') {
      throw new Error('Checkpoint 文件缺少 tableSnapshot 表格数据。');
    }
    const sheetKeys = Object.keys(parsed.tableSnapshot).filter(k => k.startsWith('sheet_'));
    if (sheetKeys.length === 0) {
      throw new Error('Checkpoint 文件的 tableSnapshot 中未找到任何表格（sheet_*）。');
    }
    return {
      kind: 'acu_checkpoint',
      createdAt: parsed.createdAt || null,
      presetName: parsed.templateSnapshot?.presetName || '',
      storageMode: parsed.source?.storageMode || 'unknown',
      tableData: deepCloneSafe(parsed.tableSnapshot),
    };
  }

  const directSheetKeys = Object.keys(parsed).filter(k => k.startsWith('sheet_'));
  if (directSheetKeys.length > 0) {
    return {
      kind: 'acu_table_json',
      createdAt: null,
      presetName: '',
      storageMode: 'unknown',
      tableData: deepCloneSafe(parsed),
    };
  }

  throw new Error('未能识别该 JSON 文件：请上传「龙血玄黄·数据库」导出的 Checkpoint / 表格 JSON，或本插件导出的主角传承档案。');
}

/** 从 ACU 的 tableData 提取出供导出界面的结构化表与行视图 */
export function extractSheetsFromTableData(tableData) {
  if (!tableData || typeof tableData !== 'object') return [];
  const entries = Object.entries(tableData)
    .filter(([key, val]) => {
      if (key === 'mate' || !val || typeof val !== 'object' || !Array.isArray(val.content)) return false;
      if (key.startsWith('sheet_')) return true;
      return typeof val.name === 'string' && val.content.length > 0 && Array.isArray(val.content[0]);
    })
    .sort(([, a], [, b]) => (Number(a.orderNo ?? 999) - Number(b.orderNo ?? 999)));

  return entries.map(([sheetKey, sheet]) => parseSheetSchema(sheetKey, sheet));
}

/** 自动猜测主角姓名，用作默认档案名 */
export function inferProtagonistName(selectedTables) {
  for (const tbl of selectedTables || []) {
    if (tbl.role === 'protagonist_info' || /主角|玩家/.test(tbl.name || '')) {
      const firstRow = tbl.rows?.[0];
      if (!firstRow) continue;
      for (const colName of ['人物名称', '姓名', '名称', '名字', '主角名']) {
        const val = String(firstRow[colName] ?? '').trim();
        if (val) return val;
      }
      const firstNonEmpty = Object.values(firstRow).find(v => String(v ?? '').trim());
      if (firstNonEmpty) return String(firstNonEmpty).trim().slice(0, 24);
    }
  }
  return '未命名主角';
}

/** 构造一份待保存的「主角传承档案」对象 */
export function createProtagonistProfile({ id, name, sourceLabel, note, tables }) {
  const now = Date.now();
  const cleanTables = (tables || [])
    .filter(t => Array.isArray(t.rows) && t.rows.length > 0)
    .map(t => ({
      sheetKey: String(t.sheetKey || ''),
      name: String(t.name || '未命名表'),
      role: String(t.role || 'custom'),
      ddlTableName: t.ddlTableName || null,
      isSingleRow: Boolean(t.isSingleRow),
      headers: Array.isArray(t.headers) ? t.headers.map(String) : Object.keys(t.rows[0] || {}),
      columnSqlNames: t.columnSqlNames ? { ...t.columnSqlNames } : {},
      rows: t.rows.map(row => {
        const out = {};
        for (const [k, v] of Object.entries(row || {})) {
          out[String(k)] = v === null || v === undefined ? '' : String(v);
        }
        return out;
      }),
    }));

  return {
    id: id || `pc_${now}_${Math.random().toString(36).slice(2, 8)}`,
    name: String(name || inferProtagonistName(cleanTables)).trim() || '未命名主角',
    sourceLabel: String(sourceLabel || '').trim(),
    note: String(note || '').trim(),
    createdAt: now,
    updatedAt: now,
    tables: cleanTables,
  };
}

function getSynonymGroup(colHeader, sqlName) {
  const byHeader = SYNONYM_MAP.get(normalizeToken(colHeader));
  if (byHeader !== undefined) return byHeader;
  if (sqlName) {
    const bySql = SYNONYM_MAP.get(normalizeToken(sqlName));
    if (bySql !== undefined) return bySql;
  }
  return -1;
}

function isTokenInList(colHeader, sqlName, list) {
  const normH = normalizeToken(colHeader);
  const normS = sqlName ? normalizeToken(sqlName) : '';
  return list.some(item => {
    const n = normalizeToken(item);
    return n === normH || (normS && n === normS);
  });
}

/** 从复合值（如 "男/22"、"女 / 19岁"、"22岁 男"）里拆分性别或年龄 */
export function extractCompositePart(rawValue, partKey) {
  const text = String(rawValue ?? '').trim();
  if (!text) return '';

  const parts = text.split(/[\/／|,，、\s]+/).map(s => s.trim()).filter(Boolean);
  if (partKey === 'gender') {
    const genderToken = parts.find(p => /^(男|女|男性|女性|无性|双性|未知|其他|male|female|nb|other)$/i.test(p));
    if (genderToken) return genderToken.replace(/性$/, m => (genderToken.length === 2 && (genderToken === '男性' || genderToken === '女性') ? '' : m));
    const inlineMatch = text.match(/(男|女)/);
    if (inlineMatch) return inlineMatch[1];
    return parts[0] || '';
  }

  if (partKey === 'age') {
    const numMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:岁|周岁)?/);
    if (numMatch) return numMatch[1];
    return parts[1] || '';
  }

  return text;
}

function scoreTableMatch(srcTable, tgtSchema) {
  let score = 0;
  if (normalizeToken(srcTable.name) === normalizeToken(tgtSchema.name)) score += 100;
  if (srcTable.ddlTableName && tgtSchema.ddlTableName && srcTable.ddlTableName.toLowerCase() === tgtSchema.ddlTableName.toLowerCase()) {
    score += 90;
  }
  if (srcTable.role && srcTable.role !== 'custom' && srcTable.role === tgtSchema.role) {
    score += 80;
  }
  // 计算列重叠度
  const srcHeaders = srcTable.headers || [];
  let overlap = 0;
  for (const tCol of tgtSchema.columns) {
    const tGroup = getSynonymGroup(tCol.header, tCol.sqlName);
    const matched = srcHeaders.some(sHeader => {
      if (normalizeToken(sHeader) === normalizeToken(tCol.header)) return true;
      const sSql = srcTable.columnSqlNames?.[sHeader];
      if (sSql && tCol.sqlName && sSql.toLowerCase() === tCol.sqlName.toLowerCase()) return true;
      const sGroup = getSynonymGroup(sHeader, sSql);
      return tGroup !== -1 && sGroup === tGroup;
    });
    if (matched) overlap += 1;
  }
  if (tgtSchema.columns.length > 0 && overlap > 0) {
    score += Math.round((overlap / tgtSchema.columns.length) * 40);
  }
  return score;
}

/** 为源表和目标表生成默认列映射 */
export function buildDefaultColumnMappings(srcTable, tgtSchema) {
  const srcHeaders = srcTable.headers || [];
  const srcSqlNames = srcTable.columnSqlNames || {};
  const mappings = {};

  for (const tCol of tgtSchema.columns) {
    // 1. 精确表头匹配
    let matchedHeader = srcHeaders.find(h => normalizeToken(h) === normalizeToken(tCol.header));
    let matchReason = matchedHeader ? '列名完全一致' : '';

    // 2. DDL 英文名匹配
    if (!matchedHeader && tCol.sqlName) {
      matchedHeader = srcHeaders.find(h => srcSqlNames[h] && srcSqlNames[h].toLowerCase() === tCol.sqlName.toLowerCase());
      if (matchedHeader) matchReason = `DDL 字段一致 (${tCol.sqlName})`;
    }

    // 3. 同义词表匹配
    if (!matchedHeader) {
      const tGroup = getSynonymGroup(tCol.header, tCol.sqlName);
      if (tGroup !== -1) {
        matchedHeader = srcHeaders.find(h => getSynonymGroup(h, srcSqlNames[h]) === tGroup);
        if (matchedHeader) matchReason = `同义列自动对齐 (${matchedHeader} → ${tCol.header})`;
      }
    }

    if (matchedHeader) {
      mappings[tCol.header] = {
        mode: 'source_column',
        sourceColumn: matchedHeader,
        extractPart: null,
        combineColumns: [],
        joiner: '/',
        constantValue: '',
        matchReason,
      };
      continue;
    }

    // 4. 复合列拆解：源表有「性别/年龄」，目标表拆成「性别」和「年龄」
    let handledComposite = false;
    for (const rule of COMPOSITE_RULES) {
      const targetPart = rule.parts.find(p => isTokenInList(tCol.header, tCol.sqlName, p.synonyms));
      if (targetPart) {
        const combinedSrc = srcHeaders.find(h => isTokenInList(h, srcSqlNames[h], rule.combinedSynonyms));
        if (combinedSrc) {
          mappings[tCol.header] = {
            mode: 'source_column',
            sourceColumn: combinedSrc,
            extractPart: targetPart.key,
            combineColumns: [],
            joiner: rule.joiner,
            constantValue: '',
            matchReason: `从复合列「${combinedSrc}」自动拆分`,
          };
          handledComposite = true;
          break;
        }
      }

      // 5. 复合列合并：源表有「性别」+「年龄」，目标表合并为「性别/年龄」
      if (isTokenInList(tCol.header, tCol.sqlName, rule.combinedSynonyms)) {
        const foundParts = rule.parts
          .map(p => srcHeaders.find(h => isTokenInList(h, srcSqlNames[h], p.synonyms)))
          .filter(Boolean);
        if (foundParts.length >= 2) {
          mappings[tCol.header] = {
            mode: 'combine_columns',
            sourceColumn: '',
            extractPart: null,
            combineColumns: foundParts,
            joiner: rule.joiner,
            constantValue: '',
            matchReason: `由「${foundParts.join(' + ')}」自动合并`,
          };
          handledComposite = true;
          break;
        }
      }
    }
    if (handledComposite) continue;

    // 6. 未找到源列：默认跳过（单行更新保留新聊天原值；新插行若有 DEFAULT 则用默认值）
    mappings[tCol.header] = {
      mode: tCol.hasDefault && tCol.defaultValue !== null ? 'constant' : 'skip',
      sourceColumn: '',
      extractPart: null,
      combineColumns: [],
      joiner: '/',
      constantValue: tCol.hasDefault && tCol.defaultValue !== null ? String(tCol.defaultValue) : '',
      matchReason: tCol.hasDefault && tCol.defaultValue !== null ? `目标表默认值 (${tCol.defaultValue})` : '源表无此列（跳过）',
    };
  }

  return mappings;
}

/**
 * 为整份主角档案与目标聊天数据库生成初始映射方案
 */
export function buildDefaultMappingPlan(profile, targetTableData) {
  const targetSchemas = extractSheetsFromTableData(targetTableData);
  const usedTargets = new Set();

  const tableMappings = (profile?.tables || []).map((srcTable, index) => {
    let bestTarget = null;
    let bestScore = 0;

    for (const tgt of targetSchemas) {
      if (usedTargets.has(tgt.sheetKey)) continue;
      const score = scoreTableMatch(srcTable, tgt);
      if (score > bestScore) {
        bestScore = score;
        bestTarget = tgt;
      }
    }

    // 阈值 >= 40 才自动配对，避免把「主角技能表」误配到「全局数据表」
    const matchedTarget = bestScore >= 40 ? bestTarget : null;
    if (matchedTarget) usedTargets.add(matchedTarget.sheetKey);

    return {
      sourceIndex: index,
      sourceName: srcTable.name,
      sourceRole: srcTable.role,
      targetSheetKey: matchedTarget ? matchedTarget.sheetKey : null,
      duplicateStrategy: matchedTarget?.role === 'inventory' ? 'add_quantity' : 'update',
      singleRowStrategy: 'update_existing',
      columnMappings: matchedTarget ? buildDefaultColumnMappings(srcTable, matchedTarget) : {},
    };
  });

  return {
    targetSchemas,
    tableMappings,
  };
}

function coerceAndValidateCellValue(rawVal, tCol, isInsert) {
  const warnings = [];
  const errors = [];
  let value = rawVal === null || rawVal === undefined ? '' : String(rawVal).trim();

  // 特殊枚举同义转换：是否离场('是'/'否') <-> 在场状态('在场'/'离场')
  if (tCol.enumValues && value !== '' && !tCol.enumValues.includes(value)) {
    const autoEnum = tryTranslateEnumValue(value, tCol.enumValues);
    if (autoEnum !== null) {
      warnings.push(`列「${tCol.header}」已将「${value}」自动适配为合法值「${autoEnum}」`);
      value = autoEnum;
    }
  }

  // 空值检查
  if (value === '') {
    if (tCol.hasDefault && tCol.defaultValue !== null) {
      value = String(tCol.defaultValue);
      warnings.push(`列「${tCol.header}」为空，已使用目标表默认值「${value}」`);
    } else if (tCol.isNotNull && isInsert) {
      errors.push(`列「${tCol.header}」在目标表中为必填（NOT NULL），且没有默认值，请在映射中指定固定值或源列`);
      return { value, warnings, errors };
    } else {
      return { value: '', warnings, errors };
    }
  }

  // 数值类型检查与温和提取
  if (tCol.declaredType === 'INTEGER' || tCol.declaredType === 'INT') {
    if (!/^-?\d+$/.test(value)) {
      const numMatch = value.match(/-?\d+/);
      if (numMatch) {
        const extracted = Number(numMatch[0]);
        warnings.push(`列「${tCol.header}」要求整数，已从「${value}」自动提取 ${extracted}`);
        value = extracted;
      } else {
        errors.push(`列「${tCol.header}」要求整数（INTEGER），当前值「${value}」无法转换`);
        return { value, warnings, errors };
      }
    } else {
      value = Number(value);
    }
  } else if (tCol.declaredType === 'REAL' || tCol.declaredType === 'FLOAT' || tCol.declaredType === 'NUMERIC') {
    if (!/^-?\d+(?:\.\d+)?$/.test(value)) {
      const numMatch = value.match(/-?\d+(?:\.\d+)?/);
      if (numMatch) {
        const extracted = Number(numMatch[0]);
        warnings.push(`列「${tCol.header}」要求数字，已从「${value}」自动提取 ${extracted}`);
        value = extracted;
      } else {
        errors.push(`列「${tCol.header}」要求数字（${tCol.declaredType}），当前值「${value}」无法转换`);
        return { value, warnings, errors };
      }
    } else {
      value = Number(value);
    }
  }

  // 数值下限 CHECK 检查
  if (tCol.minValue !== null && typeof value === 'number') {
    const failed = tCol.minExclusive ? !(value > tCol.minValue) : !(value >= tCol.minValue);
    if (failed) {
      const op = tCol.minExclusive ? '>' : '>=';
      errors.push(`列「${tCol.header}」规则要求 ${op} ${tCol.minValue}，当前值为 ${value}`);
    }
  }

  // 枚举 CHECK(... IN (...)) 检查
  if (tCol.enumValues && tCol.enumValues.length > 0 && !tCol.enumValues.includes(String(value))) {
    errors.push(`列「${tCol.header}」仅允许填写：[${tCol.enumValues.join(' / ')}]，当前值为「${value}」`);
  }

  // GLOB 格式检查
  if (tCol.globPattern && typeof value === 'string' && value !== '') {
    const rx = sqliteGlobToRegExp(tCol.globPattern);
    if (!rx.test(value)) {
      errors.push(`列「${tCol.header}」格式不符合目标表规则（GLOB: ${tCol.globPattern}），当前值为「${value}」`);
    }
  }

  return { value, warnings, errors };
}

function tryTranslateEnumValue(val, allowed) {
  const allowedSet = new Set(allowed);
  if (allowedSet.has('在场') && allowedSet.has('离场')) {
    if (val === '否' || val === '在') return '在场';
    if (val === '是' || val === '不在') return '离场';
  }
  if (allowedSet.has('是') && allowedSet.has('否')) {
    if (val === '离场') return '是';
    if (val === '在场') return '否';
  }
  if (allowedSet.has('主动') && allowedSet.has('被动')) {
    if (/主动|激活|释放/.test(val)) return '主动';
    if (/被动|常驻|天赋/.test(val)) return '被动';
  }
  if (allowedSet.has('主线任务') && allowedSet.has('支线任务')) {
    if (/主线/.test(val)) return '主线任务';
    if (/支线/.test(val)) return '支线任务';
  }
  return null;
}

function evaluateColumnMapping(row, colMap) {
  if (!colMap || colMap.mode === 'skip') return { skipped: true, value: '' };
  if (colMap.mode === 'constant') {
    return { skipped: false, value: String(colMap.constantValue ?? '') };
  }
  if (colMap.mode === 'combine_columns') {
    const cols = Array.isArray(colMap.combineColumns) ? colMap.combineColumns : [];
    const joiner = colMap.joiner ?? '/';
    const pieces = cols.map(c => String(row?.[c] ?? '').trim()).filter(Boolean);
    return { skipped: false, value: pieces.join(joiner) };
  }
  if (colMap.mode === 'source_column' && colMap.sourceColumn) {
    const raw = String(row?.[colMap.sourceColumn] ?? '');
    const extracted = colMap.extractPart ? extractCompositePart(raw, colMap.extractPart) : raw;
    return { skipped: false, value: extracted };
  }
  return { skipped: true, value: '' };
}

function findMatchingExistingRow(tgtSchema, candidateData, batchInsertedKeys) {
  // 优先按 UNIQUE 列查重；若无 UNIQUE 列，在多行表中按第一业务列查重（仅用于提示/去重）
  const keyCols = tgtSchema.uniqueColumns.length > 0
    ? tgtSchema.uniqueColumns
    : (tgtSchema.columns[0] ? [tgtSchema.columns[0].header] : []);

  for (const keyCol of keyCols) {
    const candidateKeyVal = String(candidateData[keyCol] ?? '').trim();
    if (!candidateKeyVal) continue;
    const existing = tgtSchema.existingRows.find(
      r => String(r.values[keyCol] ?? '').trim() === candidateKeyVal
    );
    if (existing) {
      return { matchedBy: keyCol, keyValue: candidateKeyVal, existingRow: existing, inBatch: false };
    }
    const batchKey = `${keyCol}::${candidateKeyVal}`;
    if (batchInsertedKeys.has(batchKey)) {
      return { matchedBy: keyCol, keyValue: candidateKeyVal, existingRow: null, inBatch: true };
    }
  }
  return null;
}

function findQuantityColumn(tgtSchema) {
  return tgtSchema.columns.find(c =>
    getSynonymGroup(c.header, c.sqlName) === SYNONYM_MAP.get(normalizeToken('数量'))
  ) || null;
}

/**
 * 编译跨聊天写入计划 + 写前合规体检 + 溢出未映射数据汇总（纯函数，无副作用）
 */
export function compileWritePlan(profile, targetTableData, mappingPlan) {
  const targetSchemas = extractSheetsFromTableData(targetTableData);
  const targetByKey = new Map(targetSchemas.map(s => [s.sheetKey, s]));

  const operations = [];
  const overflowTables = [];
  let inserts = 0;
  let updates = 0;
  let skips = 0;
  let totalErrors = 0;
  let totalWarnings = 0;

  for (const tblMap of mappingPlan?.tableMappings || []) {
    const srcTable = profile?.tables?.[tblMap.sourceIndex];
    if (!srcTable || !Array.isArray(srcTable.rows) || srcTable.rows.length === 0) continue;

    // 情况 1：用户选择不写回任何目标表（或目标聊天无对应表）→ 整表归入溢出补充提示词
    if (!tblMap.targetSheetKey || !targetByKey.has(tblMap.targetSheetKey)) {
      overflowTables.push({
        name: srcTable.name,
        reason: '目标聊天无对应表格（或选择转提示词注入）',
        headers: srcTable.headers,
        rows: deepCloneSafe(srcTable.rows),
      });
      continue;
    }

    const tgtSchema = targetByKey.get(tblMap.targetSheetKey);
    const colMappings = tblMap.columnMappings || {};

    // 统计哪些源列被消费了，没被消费的列收集进溢出列表
    const consumedSourceCols = new Set();
    for (const cm of Object.values(colMappings)) {
      if (!cm || cm.mode === 'skip') continue;
      if (cm.mode === 'source_column' && cm.sourceColumn) consumedSourceCols.add(cm.sourceColumn);
      if (cm.mode === 'combine_columns' && Array.isArray(cm.combineColumns)) {
        cm.combineColumns.forEach(c => consumedSourceCols.add(c));
      }
    }
    const unmappedSourceCols = (srcTable.headers || []).filter(h => !consumedSourceCols.has(h));
    if (unmappedSourceCols.length > 0) {
      const overflowRows = srcTable.rows
        .map(row => {
          const partial = {};
          let nonEmpty = false;
          for (const col of unmappedSourceCols) {
            const val = String(row[col] ?? '').trim();
            if (val) {
              partial[col] = val;
              nonEmpty = true;
            }
          }
          return nonEmpty ? partial : null;
        })
        .filter(Boolean);

      if (overflowRows.length > 0) {
        overflowTables.push({
          name: `${srcTable.name}（目标表未包含的补充字段）`,
          reason: `目标表「${tgtSchema.name}」没有这些列：${unmappedSourceCols.join('、')}`,
          headers: unmappedSourceCols,
          rows: overflowRows,
        });
      }
    }

    const batchInsertedKeys = new Set();
    const rowsToProcess = tgtSchema.isSingleRow ? srcTable.rows.slice(0, 1) : srcTable.rows;

    if (tgtSchema.isSingleRow && srcTable.rows.length > 1) {
      overflowTables.push({
        name: `${srcTable.name}（超出单行表限制的其余行）`,
        reason: `目标表「${tgtSchema.name}」仅允许 1 行，第 2~${srcTable.rows.length} 行已自动转入补充提示词`,
        headers: srcTable.headers,
        rows: deepCloneSafe(srcTable.rows.slice(1)),
      });
    }

    rowsToProcess.forEach((srcRow, rowIdxInSource) => {
      // 先决定动作类型（update / insert / skip）
      let action = 'insert';
      let targetRowIndex = null;
      const opWarnings = [];
      const opErrors = [];

      if (tgtSchema.isSingleRow) {
        if (tgtSchema.existingRows.length > 0) {
          if (tblMap.singleRowStrategy === 'skip_if_exists') {
            action = 'skip';
            targetRowIndex = tgtSchema.existingRows[0].rowIndex;
            opWarnings.push(`目标单行表「${tgtSchema.name}」已有数据，按策略跳过`);
          } else {
            action = 'update';
            targetRowIndex = tgtSchema.existingRows[0].rowIndex;
          }
        } else {
          action = 'insert';
        }
      }

      // 初步组装原始数据（用于查重与规则体检）
      const rawData = {};
      for (const tCol of tgtSchema.columns) {
        const evalRes = evaluateColumnMapping(srcRow, colMappings[tCol.header]);
        if (!evalRes.skipped) {
          rawData[tCol.header] = evalRes.value;
        }
      }

      // 多行表查重
      let duplicateInfo = null;
      if (!tgtSchema.isSingleRow && tgtSchema.uniqueColumns.length > 0) {
        duplicateInfo = findMatchingExistingRow(tgtSchema, rawData, batchInsertedKeys);
        if (duplicateInfo) {
          if (duplicateInfo.inBatch) {
            action = 'skip';
            opWarnings.push(`本批导出中出现重复唯一键「${duplicateInfo.matchedBy}=${duplicateInfo.keyValue}」，已跳过重复行`);
          } else if (tblMap.duplicateStrategy === 'skip') {
            action = 'skip';
            targetRowIndex = duplicateInfo.existingRow.rowIndex;
            opWarnings.push(`目标表已存在「${duplicateInfo.matchedBy}=${duplicateInfo.keyValue}」，按策略跳过`);
          } else if (tblMap.duplicateStrategy === 'add_quantity') {
            action = 'update';
            targetRowIndex = duplicateInfo.existingRow.rowIndex;
            const qtyCol = findQuantityColumn(tgtSchema);
            if (qtyCol && Object.prototype.hasOwnProperty.call(rawData, qtyCol.header)) {
              const oldNum = Number(String(duplicateInfo.existingRow.values[qtyCol.header] ?? '0').match(/-?\d+(?:\.\d+)?/)?.[0] ?? 0);
              const addNum = Number(String(rawData[qtyCol.header] ?? '0').match(/-?\d+(?:\.\d+)?/)?.[0] ?? 0);
              if (Number.isFinite(oldNum) && Number.isFinite(addNum)) {
                rawData[qtyCol.header] = String(oldNum + addNum);
                opWarnings.push(`物品「${duplicateInfo.keyValue}」已存在，数量将叠加：${oldNum} + ${addNum} = ${oldNum + addNum}`);
              }
            } else {
              opWarnings.push(`「${duplicateInfo.matchedBy}=${duplicateInfo.keyValue}」已存在，将覆盖更新该行`);
            }
          } else {
            action = 'update';
            targetRowIndex = duplicateInfo.existingRow.rowIndex;
            opWarnings.push(`「${duplicateInfo.matchedBy}=${duplicateInfo.keyValue}」已存在，将覆盖更新第 ${targetRowIndex} 行`);
          }
        }
      }

      // 对每个字段执行目标表规则体检
      const validatedData = {};
      const isInsert = action === 'insert';

      if (action !== 'skip') {
        for (const tCol of tgtSchema.columns) {
          const hasMapped = Object.prototype.hasOwnProperty.call(rawData, tCol.header);
          if (!hasMapped) {
            // 未映射该列：update 时保留目标原值安全；insert 时若为 NOT NULL 且无 DEFAULT 则报错
            if (isInsert && tCol.isNotNull) {
              if (tCol.hasDefault && tCol.defaultValue !== null) {
                validatedData[tCol.header] = tCol.defaultValue;
                opWarnings.push(`未映射必填列「${tCol.header}」，新增行已自动填入目标默认值「${tCol.defaultValue}」`);
              } else {
                opErrors.push(`目标表新增行缺少必填列「${tCol.header}」（NOT NULL 且无默认值），请给它绑定源列或填入固定值`);
              }
            }
            continue;
          }

          const check = coerceAndValidateCellValue(rawData[tCol.header], tCol, isInsert);
          opWarnings.push(...check.warnings);
          opErrors.push(...check.errors);
          // update 模式中，如果源值映射结果为空且原本可空但我们不想用空字符串抹掉目标已有内容，仍按用户显式映射写入（已由 skip 控制保留）
          validatedData[tCol.header] = check.value;
        }

        if (Object.keys(validatedData).length === 0 && opErrors.length === 0) {
          action = 'skip';
          opWarnings.push(`该行没有可写入的有效列，已自动跳过`);
        }
      }

      if (action === 'insert' && opErrors.length === 0) {
        for (const uCol of tgtSchema.uniqueColumns) {
          const v = String(validatedData[uCol] ?? '').trim();
          if (v) batchInsertedKeys.add(`${uCol}::${v}`);
        }
      }

      if (action === 'insert') inserts += 1;
      else if (action === 'update') updates += 1;
      else skips += 1;

      totalErrors += opErrors.length;
      totalWarnings += opWarnings.length;

      operations.push({
        sourceTableName: srcTable.name,
        sourceRowIndex: rowIdxInSource,
        targetSheetKey: tgtSchema.sheetKey,
        targetTableName: tgtSchema.name,
        isSingleRow: tgtSchema.isSingleRow,
        action,
        targetRowIndex,
        data: validatedData,
        warnings: opWarnings,
        errors: opErrors,
      });
    });
  }

  const overflowText = formatTablesAsCarryoverText(
    profile?.name || '主角',
    overflowTables,
    profile?.note || '',
    { isOverflowOnly: true }
  );

  return {
    operations,
    overflowTables,
    overflowText,
    summary: {
      totalOps: operations.length,
      inserts,
      updates,
      skips,
      errors: totalErrors,
      warnings: totalWarnings,
      hasOverflow: overflowTables.length > 0,
    },
    canExecute: totalErrors === 0 && (inserts + updates > 0),
  };
}

/** 把主角档案（或未写入目标表的溢出内容）渲染为干净、省 Token 的提示词文本 */
export function formatTablesAsCarryoverText(protagonistName, tables, extraNote = '', options = {}) {
  const sections = [];
  const validTables = (tables || []).filter(t => Array.isArray(t.rows) && t.rows.length > 0);
  const noteTrimmed = String(extraNote || '').trim();

  if (validTables.length === 0 && !noteTrimmed) return '';

  const title = options.isOverflowOnly
    ? `主角「${protagonistName || '主角'}」跨聊天补充传承信息（当前聊天数据库未收录的过往能力/物品/经历）`
    : `主角「${protagonistName || '主角'}」跨聊天传承档案`;

  sections.push(`<主角传承档案>`);
  sections.push(`# ${title}`);

  if (noteTrimmed && !options.isOverflowOnly) {
    sections.push(`## 主角背景与玩家补充说明\n${noteTrimmed}`);
  }

  for (const tbl of validTables) {
    const lines = [`## ${tbl.name}`];
    for (const row of tbl.rows) {
      const pairs = Object.entries(row)
        .filter(([, val]) => String(val ?? '').trim() !== '')
        .map(([k, v]) => `${k}：${String(v).trim()}`);
      if (pairs.length > 0) {
        lines.push(`- ${pairs.join(' ｜ ')}`);
      }
    }
    if (lines.length > 1) sections.push(lines.join('\n'));
  }

  if (noteTrimmed && options.isOverflowOnly) {
    sections.push(`## 玩家补充说明\n${noteTrimmed}`);
  }

  sections.push(`</主角传承档案>`);
  return sections.join('\n\n');
}
