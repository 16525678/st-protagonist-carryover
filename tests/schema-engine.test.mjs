import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ARCHIVE_FORMAT,
  ACU_CHECKPOINT_FORMAT,
  buildDefaultMappingPlan,
  compileWritePlan,
  createProtagonistProfile,
  extractCompositePart,
  extractSheetsFromTableData,
  parseImportedSourceJson,
  parseSheetSchema,
} from '../src/schema-engine.js';
import { executeCompiledWritePlan } from '../src/acu-adapter.js';
import {
  EXTENSION_PROMPT_KEY,
  INTERCEPTOR_GLOBAL_NAME,
  applyChatPromptInjection,
  clearPromptInjection,
  registerGenerateInterceptor,
  unregisterGenerateInterceptor,
} from '../src/prompt-injector.js';
import {
  getHostRuntimeSummary,
  isTauriTavernHost,
  loadProfiles,
  saveProfiles,
} from '../src/storage.js';

/** 真实还原 AlbusKen/shujuku 原版默认模板（主角信息表 + 主角技能表 + 背包物品表） */
function makeClassicAcuTables() {
  return {
    mate: { type: 'chatSheets', version: 1 },
    sheet_DpKcVGqg: {
      uid: 'sheet_DpKcVGqg',
      name: '主角信息表',
      orderNo: 1,
      sourceData: {
        note: '记录主角的核心身份信息。此表有且仅有一行。',
        insertNode: '禁止操作。',
        ddl: `CREATE TABLE protagonist_info ( -- 主角信息表
  row_id INTEGER PRIMARY KEY, -- 行号
  char_name TEXT NOT NULL, -- 人物名称
  gender_age TEXT, -- 性别/年龄
  appearance TEXT, -- 外貌特征
  occupation TEXT, -- 职业/身份
  past_experience TEXT, -- 过往经历
  personality TEXT -- 性格特点
);`,
      },
      content: [
        ['row_id', '人物名称', '性别/年龄', '外貌特征', '职业/身份', '过往经历', '性格特点'],
        ['1', '林默', '男/22岁', '黑发窄袖长衫，右眉尾有浅疤', '落魄剑修', '曾在青云宗外门苦修五年，后因宗门覆灭流落江湖', '冷静克制，重诺守信'],
      ],
    },
    sheet_lEARaBa8: {
      uid: 'sheet_lEARaBa8',
      name: '主角技能表',
      orderNo: 3,
      sourceData: {
        note: '记录主角获得的所有技能项目。\n- 列0: 技能名称 - 不得与表中已有技能重名。',
        ddl: `CREATE TABLE protagonist_skills ( -- 主角技能表
  row_id INTEGER PRIMARY KEY, -- 行号
  skill_name TEXT NOT NULL UNIQUE, -- 技能名称
  skill_type TEXT NOT NULL CHECK(skill_type IN ('被动', '主动')), -- 技能类型
  skill_level TEXT, -- 等级/阶段
  effect_desc TEXT -- 效果描述
);`,
      },
      content: [
        ['row_id', '技能名称', '技能类型', '等级/阶段', '效果描述'],
        ['1', '青莲剑诀', '主动', 'Lv.3', '凝聚剑气斩出三道青色剑芒'],
        ['2', '静心诀', '被动', 'Lv.2', '危急时刻保持心神清明，抗魅惑'],
      ],
    },
    sheet_in05z9vz: {
      uid: 'sheet_in05z9vz',
      name: '背包物品表',
      orderNo: 4,
      sourceData: {
        note: '记录主角拥有的所有物品、装备。',
        ddl: `CREATE TABLE inventory ( -- 背包物品表
  row_id INTEGER PRIMARY KEY, -- 行号
  item_name TEXT NOT NULL UNIQUE, -- 物品名称
  quantity INTEGER NOT NULL DEFAULT 1 CHECK(quantity > 0), -- 数量
  description TEXT, -- 描述/效果
  category TEXT -- 类别
);`,
      },
      content: [
        ['row_id', '物品名称', '数量', '描述/效果', '类别'],
        ['1', '治疗药水', '3', '恢复50点生命值', '消耗品'],
        ['2', '青霜断剑', '1', '陪伴多年的旧剑，剑身有裂纹', '武器'],
      ],
    },
  };
}

/** 真实还原 AlbusKen/shujuku 恋爱特化默认表（无技能表、拆出性别/年龄、有 NOT NULL/DEFAULT/CHECK(row_id=1)） */
function makeRomanceAcuTables({ withExistingRow = true } = {}) {
  const rows = [
    ['row_id', '姓名', '性别', '年龄', '外貌特征', '身份', '近况', '所在地点', '随身财物'],
  ];
  if (withExistingRow) {
    rows.push(['1', '默认主角', '男', '18', '普通', '学生', '刚开学', '新宿车站', '学生证']);
  }
  return {
    mate: { type: 'chatSheets', version: 1 },
    sheet_protagonist: {
      uid: 'sheet_protagonist',
      name: '主角信息表',
      orderNo: 2,
      sourceData: {
        note: '记录主角的核心身份信息。此表有且仅有一行。',
        insertNode: '禁止。',
        ddl: `CREATE TABLE protagonist_info ( -- 主角信息
  row_id INTEGER PRIMARY KEY CHECK(row_id = 1), -- 行号，仅允许为 1
  name TEXT NOT NULL, -- 姓名
  gender TEXT NOT NULL, -- 性别
  age INTEGER CHECK(age IS NULL OR age >= 0), -- 年龄
  appearance TEXT NOT NULL, -- 外貌特征
  identity_text TEXT NOT NULL, -- 身份
  current_condition TEXT NOT NULL DEFAULT '一切如常', -- 近况
  location_name TEXT NOT NULL, -- 所在地点
  belongings TEXT -- 随身财物
);`,
      },
      content: rows,
    },
  };
}

test('1. 解析 DDL 与 note 规则：正确识别单行表、必填、类型、枚举、唯一键、下限与 GLOB', () => {
  const romance = makeRomanceAcuTables();
  const proSchema = parseSheetSchema('sheet_protagonist', romance.sheet_protagonist);
  assert.equal(proSchema.isSingleRow, true);
  assert.equal(proSchema.ddlTableName, 'protagonist_info');

  const ageCol = proSchema.columns.find(c => c.header === '年龄');
  assert.equal(ageCol.declaredType, 'INTEGER');
  assert.equal(ageCol.minValue, 0);
  assert.equal(ageCol.minExclusive, false);

  const condCol = proSchema.columns.find(c => c.header === '近况');
  assert.equal(condCol.isNotNull, true);
  assert.equal(condCol.hasDefault, true);
  assert.equal(condCol.defaultValue, '一切如常');

  const classic = makeClassicAcuTables();
  const skillSchema = parseSheetSchema('sheet_lEARaBa8', classic.sheet_lEARaBa8);
  assert.equal(skillSchema.isSingleRow, false);
  assert.deepEqual(skillSchema.uniqueColumns, ['技能名称']);
  const typeCol = skillSchema.columns.find(c => c.header === '技能类型');
  assert.deepEqual(typeCol.enumValues, ['被动', '主动']);
});

test('2. 跨模板搬运（原版主角 → 恋爱特化已有行）：同义列对齐、复合列拆分、年龄提取整数、单行表走 updateRow 且剩余表自动溢出', () => {
  const classicSheets = extractSheetsFromTableData(makeClassicAcuTables());
  const profile = createProtagonistProfile({
    name: '林默',
    sourceLabel: '修仙旧档',
    tables: classicSheets.map(s => ({
      sheetKey: s.sheetKey,
      name: s.name,
      role: s.role,
      ddlTableName: s.ddlTableName,
      isSingleRow: s.isSingleRow,
      headers: s.columns.map(c => c.header),
      columnSqlNames: Object.fromEntries(s.columns.filter(c => c.sqlName).map(c => [c.header, c.sqlName])),
      rows: s.existingRows.map(r => r.values),
    })),
  });

  const targetData = makeRomanceAcuTables({ withExistingRow: true });
  const plan = buildDefaultMappingPlan(profile, targetData);
  const compiled = compileWritePlan(profile, targetData, plan);

  // 目标单行表已有第 1 行 → 必须 update，不能 insert（防止触发 CHECK(row_id = 1)）
  assert.equal(compiled.canExecute, true);
  assert.equal(compiled.summary.updates, 1);
  assert.equal(compiled.summary.inserts, 0);
  assert.equal(compiled.summary.errors, 0);

  const op = compiled.operations[0];
  assert.equal(op.action, 'update');
  assert.equal(op.targetRowIndex, 1);
  assert.equal(op.data['姓名'], '林默');
  assert.equal(op.data['性别'], '男');
  assert.equal(op.data['年龄'], 22); // 从 "男/22岁" 拆出并转为 INTEGER 22
  assert.equal(op.data['身份'], '落魄剑修');
  // 所在地点在源表没有，跳过不覆盖新聊天的「新宿车站」
  assert.equal(Object.prototype.hasOwnProperty.call(op.data, '所在地点'), false);

  // 源表的「过往经历」「性格特点」以及目标没有的「主角技能表」「背包物品表」全部自动收纳为补充提示词，零丢失
  assert.equal(compiled.summary.hasOverflow, true);
  assert.match(compiled.overflowText, /过往经历：曾在青云宗外门苦修五年/);
  assert.match(compiled.overflowText, /青莲剑诀/);
  assert.match(compiled.overflowText, /青霜断剑/);
});

test('3. 跨模板搬运（目标单行表为空表）：缺少 NOT NULL 无默认值的「所在地点」必须拦截报错，补填固定值后放行', () => {
  const classicSheets = extractSheetsFromTableData(makeClassicAcuTables());
  const profile = createProtagonistProfile({
    name: '林默',
    tables: [classicSheets[0]].map(s => ({
      sheetKey: s.sheetKey,
      name: s.name,
      role: s.role,
      ddlTableName: s.ddlTableName,
      isSingleRow: s.isSingleRow,
      headers: s.columns.map(c => c.header),
      columnSqlNames: Object.fromEntries(s.columns.filter(c => c.sqlName).map(c => [c.header, c.sqlName])),
      rows: s.existingRows.map(r => r.values),
    })),
  });

  const emptyRomanceTarget = makeRomanceAcuTables({ withExistingRow: false });
  const plan = buildDefaultMappingPlan(profile, emptyRomanceTarget);
  const blocked = compileWritePlan(profile, emptyRomanceTarget, plan);

  assert.equal(blocked.canExecute, false);
  assert.equal(blocked.summary.errors, 1);
  assert.match(blocked.operations[0].errors[0], /所在地点/);

  // 用户在映射面板给「所在地点」填上新世界初始地点后重新体检
  plan.tableMappings[0].columnMappings['所在地点'] = {
    mode: 'constant',
    constantValue: '东京新宿',
  };
  const passed = compileWritePlan(profile, emptyRomanceTarget, plan);
  assert.equal(passed.canExecute, true);
  assert.equal(passed.operations[0].action, 'insert');
  assert.equal(passed.operations[0].data['所在地点'], '东京新宿');
  assert.equal(passed.operations[0].data['近况'], '一切如常'); // DEFAULT 自动生效
});

test('4. 反向跨模板搬运（恋爱版拆列 → 原版合列）：自动将「性别」+「年龄」合并为「性别/年龄」', () => {
  const romanceSheets = extractSheetsFromTableData(makeRomanceAcuTables({ withExistingRow: true }));
  const profile = createProtagonistProfile({
    name: '默认主角',
    tables: romanceSheets.map(s => ({
      sheetKey: s.sheetKey,
      name: s.name,
      role: s.role,
      ddlTableName: s.ddlTableName,
      isSingleRow: s.isSingleRow,
      headers: s.columns.map(c => c.header),
      columnSqlNames: Object.fromEntries(s.columns.filter(c => c.sqlName).map(c => [c.header, c.sqlName])),
      rows: s.existingRows.map(r => r.values),
    })),
  });

  const classicTarget = makeClassicAcuTables();
  const plan = buildDefaultMappingPlan(profile, classicTarget);
  const compiled = compileWritePlan(profile, classicTarget, plan);

  assert.equal(compiled.canExecute, true);
  assert.equal(compiled.operations[0].data['人物名称'], '默认主角');
  assert.equal(compiled.operations[0].data['性别/年龄'], '男/18');
  assert.equal(compiled.operations[0].data['职业/身份'], '学生');
});

test('5. UNIQUE 冲突三种策略（数量累加 / 跳过 / 覆盖更新）与 CHECK 枚举拦截', () => {
  const classic = makeClassicAcuTables();
  const invSchema = parseSheetSchema('sheet_in05z9vz', classic.sheet_in05z9vz);
  const skillSchema = parseSheetSchema('sheet_lEARaBa8', classic.sheet_lEARaBa8);

  const profile = createProtagonistProfile({
    name: '林默',
    tables: [
      {
        sheetKey: invSchema.sheetKey,
        name: invSchema.name,
        role: invSchema.role,
        headers: ['物品名称', '数量', '描述/效果', '类别'],
        rows: [
          { 物品名称: '治疗药水', 数量: '2', '描述/效果': '恢复50点生命值', 类别: '消耗品' },
          { 物品名称: '回城卷轴', 数量: '1', '描述/效果': '传送回安全区', 类别: '消耗品' },
        ],
      },
      {
        sheetKey: skillSchema.sheetKey,
        name: skillSchema.name,
        role: skillSchema.role,
        headers: ['技能名称', '技能类型', '等级/阶段', '效果描述'],
        rows: [
          { 技能名称: '御风步', 技能类型: '神秘光环', '等级/阶段': 'Lv.1', 效果描述: '提速' },
        ],
      },
    ],
  });

  const plan = buildDefaultMappingPlan(profile, classic);
  // 背包默认策略为 add_quantity（数量累加）
  const res = compileWritePlan(profile, classic, plan);

  // 治疗药水原为 3，再带入 2 → 更新为 5；回城卷轴新增
  const potionOp = res.operations.find(o => o.data['物品名称'] === '治疗药水');
  assert.equal(potionOp.action, 'update');
  assert.equal(potionOp.targetRowIndex, 1);
  assert.equal(potionOp.data['数量'], 5);

  const scrollOp = res.operations.find(o => o.data['物品名称'] === '回城卷轴');
  assert.equal(scrollOp.action, 'insert');

  // 技能类型「神秘光环」不在 CHECK(IN ('被动','主动')) 内 → 必须报红拦截
  const badSkillOp = res.operations.find(o => o.data['技能名称'] === '御风步');
  assert.equal(badSkillOp.errors.length, 1);
  assert.match(badSkillOp.errors[0], /被动 \/ 主动/);
  assert.equal(res.canExecute, false);

  // 切换背包策略为 skip → 重名药水被跳过
  plan.tableMappings[0].duplicateStrategy = 'skip';
  const resSkip = compileWritePlan(profile, classic, plan);
  const potionSkipped = resSkip.operations.find(o => o.sourceTableName === '背包物品表' && o.sourceRowIndex === 0);
  assert.equal(potionSkipped.action, 'skip');
});

test('6. Checkpoint v1 / 纯表格 JSON / 主角档案解析与原型污染键拦截', () => {
  const classic = makeClassicAcuTables();
  const checkpointStr = JSON.stringify({
    format: ACU_CHECKPOINT_FORMAT,
    version: 1,
    createdAt: Date.now(),
    source: { storageMode: 'sqlite' },
    tableSnapshot: classic,
    templateSnapshot: { data: classic, presetName: '默认' },
    guideSnapshot: { data: classic },
    integrity: { algorithm: 'fnv1a', payloadHash: 'mock' },
  });
  const parsedCp = parseImportedSourceJson(checkpointStr);
  assert.equal(parsedCp.kind, 'acu_checkpoint');
  assert.equal(extractSheetsFromTableData(parsedCp.tableData).length, 3);

  const parsedRaw = parseImportedSourceJson(JSON.stringify(classic));
  assert.equal(parsedRaw.kind, 'acu_table_json');

  const parsedArchive = parseImportedSourceJson(JSON.stringify({
    format: ARCHIVE_FORMAT,
    version: 1,
    profiles: [createProtagonistProfile({ name: '测试主角', tables: [] })],
  }));
  assert.equal(parsedArchive.kind, 'carryover_archive');
  assert.equal(parsedArchive.profiles.length, 1);

  assert.throws(
    () => parseImportedSourceJson('{"__proto__":{"polluted":true}}'),
    /不安全键名/
  );
});

test('7. acu-adapter 批量写入：检查无 AI 楼层拦截、skipNotify/skipRefresh 参数传递及末尾单次刷新', async () => {
  const calls = [];
  globalThis.window = {
    AutoCardUpdaterAPI: {
      exportTableAsJson: () => makeRomanceAcuTables({ withExistingRow: true }),
      updateRow: async (args) => { calls.push(['updateRow', args]); return true; },
      insertRow: async (args) => { calls.push(['insertRow', args]); return 2; },
      refreshDataAndWorldbook: async () => { calls.push(['refreshDataAndWorldbook']); return true; },
    },
  };

  const classicSheets = extractSheetsFromTableData(makeClassicAcuTables());
  const profile = createProtagonistProfile({
    name: '林默',
    tables: [classicSheets[0]].map(s => ({
      sheetKey: s.sheetKey,
      name: s.name,
      role: s.role,
      headers: s.columns.map(c => c.header),
      rows: s.existingRows.map(r => r.values),
    })),
  });
  const targetData = makeRomanceAcuTables({ withExistingRow: true });
  const plan = buildDefaultMappingPlan(profile, targetData);
  const compiled = compileWritePlan(profile, targetData, plan);

  // 无 AI 楼层时应安全拒绝
  const blocked = await executeCompiledWritePlan(compiled, { chat: [] });
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /AI 消息楼层/);
  assert.equal(calls.length, 0);

  // 有开场白（AI 楼层）时执行批量写入并单次刷新世界书
  const receipt = await executeCompiledWritePlan(compiled, { chat: [{ is_user: false, mes: '开场白' }] });
  assert.equal(receipt.ok, true);
  assert.equal(receipt.succeeded, 1);
  assert.equal(receipt.refreshed, true);
  assert.equal(calls[0][0], 'updateRow');
  assert.equal(calls[0][1].skipNotify, true);
  assert.equal(calls[0][1].skipRefresh, true);
  assert.equal(calls[1][0], 'refreshDataAndWorldbook');

  delete globalThis.window;
});

test('8. 提示词注入器：原生 setExtensionPrompt 优先且与 generate_interceptor 严格互斥、切聊天自动隔离', async () => {
  let activeChatKey = 'char:Alice::chat1';
  registerGenerateInterceptor(() => activeChatKey);

  // 场景 A：宿主支持 setExtensionPrompt → 走原生，interceptor 绝不双倍注入
  const nativeCalls = [];
  const nativeCtx = {
    extension_prompt_types: { IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2 },
    extension_prompt_roles: { SYSTEM: 0, USER: 1 },
    setExtensionPrompt: (...args) => nativeCalls.push(args),
  };

  const resNative = applyChatPromptInjection(
    nativeCtx,
    { enabled: true, text: '<主角传承档案>林默</主角传承档案>', position: 'in_chat', depth: 2, role: 'system' },
    activeChatKey
  );
  assert.equal(resNative.channel, 'native_setExtensionPrompt');
  assert.equal(nativeCalls[0][0], EXTENSION_PROMPT_KEY);
  assert.equal(nativeCalls[0][2], 1); // IN_CHAT

  const mockChatA = [{ is_user: false, mes: 'hi' }];
  await globalThis[INTERCEPTOR_GLOBAL_NAME](mockChatA, 1000, () => {}, 'normal');
  assert.equal(mockChatA.length, 1); // 未重复注入

  // 场景 B：宿主无 setExtensionPrompt → 自动降级到 generate_interceptor，跳过 quiet，切聊天不串台
  const legacyCtx = {};
  const resFallback = applyChatPromptInjection(
    legacyCtx,
    { enabled: true, text: '<主角传承档案>林默</主角传承档案>', position: 'in_chat', depth: 1, role: 'system' },
    activeChatKey
  );
  assert.equal(resFallback.channel, 'generate_interceptor');

  const mockChatQuiet = [{ is_user: false, mes: 'hi' }];
  await globalThis[INTERCEPTOR_GLOBAL_NAME](mockChatQuiet, 1000, () => {}, 'quiet');
  assert.equal(mockChatQuiet.length, 1); // quiet 跳过

  const mockChatNormal = [{ is_user: false, mes: 'm0' }, { is_user: true, mes: 'm1' }];
  await globalThis[INTERCEPTOR_GLOBAL_NAME](mockChatNormal, 1000, () => {}, 'normal');
  assert.equal(mockChatNormal.length, 3);
  assert.match(mockChatNormal[1].mes, /林默/);

  // 切到另一个未绑定的聊天 → interceptor 自动不生效
  activeChatKey = 'char:Bob::chat2';
  const mockChatOther = [{ is_user: false, mes: 'other' }];
  await globalThis[INTERCEPTOR_GLOBAL_NAME](mockChatOther, 1000, () => {}, 'normal');
  assert.equal(mockChatOther.length, 1);

  clearPromptInjection(nativeCtx);
  unregisterGenerateInterceptor();
});

test('9. 复合列解析工具 extractCompositePart 覆盖常见中文写法', () => {
  assert.equal(extractCompositePart('男/22岁', 'gender'), '男');
  assert.equal(extractCompositePart('男/22岁', 'age'), '22');
  assert.equal(extractCompositePart('女性，19周岁', 'gender'), '女');
  assert.equal(extractCompositePart('女性，19周岁', 'age'), '19');
});

test('10. 放宽后 DDL 仍按 note 识别单行/唯一键；GLOB、数值下限与在场状态枚举自动适配', () => {
  // 模拟 AlbusKen/shujuku 放宽 DDL 后的表（无 UNIQUE/CHECK，全靠 note 与 insertNode 约束）
  const relaxedTarget = {
    sheet_inv: {
      uid: 'sheet_inv',
      name: '背包物品表',
      sourceData: {
        note: '记录主角拥有的所有物品。\n- 列0: 物品名称 - 不得与表中已有物品重名。',
        ddl: 'CREATE TABLE inventory (\n  row_id INTEGER PRIMARY KEY,\n  item_name TEXT,\n  quantity TEXT\n);',
      },
      content: [
        ['row_id', '物品名称', '数量'],
        ['1', '治疗药水', '4'],
      ],
    },
    sheet_npc: {
      uid: 'sheet_npc',
      name: '重要角色表',
      sourceData: {
        ddl: `CREATE TABLE important_non_romance (
  row_id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE, -- 姓名
  presence_status TEXT NOT NULL CHECK(presence_status IN ('在场', '离场')), -- 在场状态
  code_tag TEXT CHECK(code_tag GLOB 'AM[0-9][0-9][0-9][0-9]') -- 编号
);`,
      },
      content: [['row_id', '姓名', '在场状态', '编号']],
    },
  };

  const relaxedInvSchema = parseSheetSchema('sheet_inv', relaxedTarget.sheet_inv);
  assert.deepEqual(relaxedInvSchema.uniqueColumns, ['物品名称']);

  const profile = createProtagonistProfile({
    name: '测试主角',
    tables: [
      {
        sheetKey: 'sheet_src_npc',
        name: '重要角色表',
        role: 'important_chars',
        headers: ['姓名', '是否离场', '编号'],
        rows: [
          { 姓名: '艾莉丝', 是否离场: '否', 编号: 'AM0001' },
          { 姓名: '坏编号角色', 是否离场: '是', 编号: 'BAD99' },
        ],
      },
    ],
  });

  const plan = buildDefaultMappingPlan(profile, relaxedTarget);
  const compiled = compileWritePlan(profile, relaxedTarget, plan);

  // 第 1 行：是否离场='否' 自动翻译成 在场状态='在场'，AM0001 通过 GLOB 校验
  assert.equal(compiled.operations[0].errors.length, 0);
  assert.equal(compiled.operations[0].data['在场状态'], '在场');

  // 第 2 行：BAD99 触发 GLOB 校验失败拦截
  assert.equal(compiled.operations[1].errors.length, 1);
  assert.match(compiled.operations[1].errors[0], /GLOB/);
});

test('11. TauriTavern 宿主检测与原生 extension.store 读写优先级及降级', async () => {
  const ttMem = new Map();
  globalThis.__TAURITAVERN__ = {
    api: {
      extension: {
        store: {
          setJson: async ({ namespace, key, value }) => {
            ttMem.set(`${namespace}:${key}`, value);
          },
          tryGetJson: async ({ namespace, key }) => {
            const k = `${namespace}:${key}`;
            return ttMem.has(k) ? { found: true, value: ttMem.get(k) } : { found: false };
          },
        },
      },
    },
  };

  assert.equal(isTauriTavernHost(), true);
  assert.match(getHostRuntimeSummary().hostLabel, /TauriTavern/);

  // 模拟手机窄屏视口检测
  globalThis.window = { innerWidth: 390 };
  assert.match(getHostRuntimeSummary().hostLabel, /手机端/);
  globalThis.window = { innerWidth: 1440 };
  assert.match(getHostRuntimeSummary().hostLabel, /桌面端/);
  delete globalThis.window;

  const mockCtx = { extensionSettings: {}, saveSettingsDebounced: () => {} };
  const sample = [createProtagonistProfile({ name: 'TT主角', tables: [] })];
  const writeRes = await saveProfiles(mockCtx, sample);
  assert.equal(writeRes.backend, 'tauritavern-store');

  const loaded = await loadProfiles(mockCtx);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].name, 'TT主角');

  // 清除 TT 全局对象后自动降级到 extensionSettings
  delete globalThis.__TAURITAVERN__;
  assert.equal(isTauriTavernHost(), false);
  const fallbackWrite = await saveProfiles(mockCtx, sample);
  assert.equal(fallbackWrite.backend, 'extensionSettings');
  const fallbackLoaded = await loadProfiles(mockCtx);
  assert.equal(fallbackLoaded[0].name, 'TT主角');
});


