/**
 * scripts/build-tavern-helper-script.mjs
 * 零外部依赖的确定性打包脚本：
 * 将项目源码（index.js + src/*.js + style.css）封装为可直接导入「酒馆助手 / Tavern Helper」
 * 全局脚本库的离线单文件 JSON（酒馆助手脚本-主角跨聊天传承.json）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const SCRIPT_ID = 'a7f3c910-4b2e-4f1a-9d6c-8e21b5c0a901';
const OUTPUT_FILENAME = '酒馆助手脚本-主角跨聊天传承.json';

const MODULE_ORDER = [
  'src/host-env.js',
  'src/schema-engine.js',
  'src/acu-adapter.js',
  'src/prompt-injector.js',
  'src/storage.js',
  'src/ui.js',
  'index.js',
];

function resolveModuleKey(fromKey, specifier) {
  const fromDir = path.posix.dirname(fromKey);
  const joined = path.posix.normalize(path.posix.join(fromDir, specifier));
  return joined.replace(/^\.\//, '');
}

function transformEsmToFactory(moduleKey, source) {
  const exportedNames = [];

  // 1. 转换所有 import { ... } from './...';
  let code = source.replace(
    /^import\s*\{([\s\S]*?)\}\s*from\s*['"]([^'"]+)['"]\s*;?\s*$/gm,
    (_match, namesBlock, specifier) => {
      const targetKey = resolveModuleKey(moduleKey, specifier);
      const cleanedNames = namesBlock
        .replace(/\/\/[^\n]*/g, '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
        .map(part => {
          const aliasMatch = part.match(/^(\w+)\s+as\s+(\w+)$/);
          return aliasMatch ? `${aliasMatch[1]}: ${aliasMatch[2]}` : part;
        })
        .join(', ');
      return `const { ${cleanedNames} } = __require(${JSON.stringify(targetKey)});`;
    }
  );

  // 2. 转换 export const / let / var
  code = code.replace(/^export\s+(const|let|var)\s+([A-Za-z_$][\w$]*)/gm, (_match, decl, name) => {
    exportedNames.push(name);
    return `${decl} ${name}`;
  });

  // 3. 转换 export [async] function
  code = code.replace(/^export\s+(async\s+)?function\s+([A-Za-z_$][\w$]*)/gm, (_match, asyncKw, name) => {
    exportedNames.push(name);
    return `${asyncKw || ''}function ${name}`;
  });

  // 4. 在 index.js 打包副本里禁用尾部扩展模式自动启动，改为由外层带 inlineCss 启动
  if (moduleKey === 'index.js') {
    code = code.replace(
      /if\s*\(typeof window !== 'undefined' && !globalThis\.__PC_DISABLE_AUTO_BOOTSTRAP__\)\s*\{\s*autoBootstrap\(\);\s*\}/,
      '// autoBootstrap invoked by Tavern Helper bundle wrapper with inlineCss'
    );
  }

  const exportLines = exportedNames.map(name => `exports.${name} = ${name};`).join('\n');
  return `  ${JSON.stringify(moduleKey)}: function(exports, __require) {\n${code}\n${exportLines}\n  }`;
}

export function buildTavernHelperScript({ write = true } = {}) {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const cssText = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');

  const factoryEntries = MODULE_ORDER.map(key => {
    const src = fs.readFileSync(path.join(ROOT, key), 'utf8');
    return transformEsmToFactory(key, src);
  });

  const banner = [
    '// ==UserScript==',
    `// @name         ${manifest.display_name}`,
    '// @namespace    https://github.com/16525678/st-protagonist-carryover',
    `// @version      ${manifest.version}`,
    '// @description  从龙血玄黄·数据库导出主角并按目标聊天表规则继承到新聊天（支持酒馆助手 / SillyTavern / TauriTavern 桌面与手机端）',
    `// @author       ${manifest.author}`,
    '// @match        */*',
    '// @grant        none',
    '// ==/UserScript==',
  ].join('\n');

  const bundleJs = `${banner}
(function() {
  'use strict';
  const EMBEDDED_STYLE_CSS = ${JSON.stringify(cssText)};
  const __factories = {
${factoryEntries.join(',\n')}
  };
  const __cache = Object.create(null);
  function __require(id) {
    if (__cache[id]) return __cache[id];
    const factory = __factories[id];
    if (!factory) throw new Error('[ProtagonistCarryover] Missing bundled module: ' + id);
    const exports = {};
    __cache[id] = exports;
    factory(exports, __require);
    return exports;
  }
  const entry = __require('index.js');
  entry.autoBootstrap({ mode: 'tavern-helper', inlineCss: EMBEDDED_STYLE_CSS });
})();
`;

  // 语法自检：确保产物 JS 100% 合法可解析
  new Function(bundleJs);

  const scriptJson = {
    type: 'script',
    enabled: true,
    name: manifest.display_name,
    id: SCRIPT_ID,
    content: bundleJs,
    info: `主角跨聊天传承 v${manifest.version}（适配龙血玄黄·数据库，离线自包含酒馆助手脚本，兼容桌面端与手机端 SillyTavern / TauriTavern）。源码仓库：${manifest.homePage || ''}`,
    button: {
      enabled: true,
      buttons: [
        {
          name: '打开主角传承工作台',
          visible: true,
        },
      ],
    },
    data: {},
    export_with: {
      data: true,
      button: true,
    },
  };

  const outPath = path.join(ROOT, OUTPUT_FILENAME);
  if (write) {
    fs.writeFileSync(outPath, `${JSON.stringify(scriptJson, null, 2)}\n`, 'utf8');
  }

  return {
    outPath,
    version: manifest.version,
    bundleBytes: Buffer.byteLength(bundleJs, 'utf8'),
    jsonBytes: Buffer.byteLength(JSON.stringify(scriptJson, null, 2), 'utf8'),
    scriptJson,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const result = buildTavernHelperScript({ write: true });
  console.log(
    JSON.stringify(
      {
        ok: true,
        outPath: result.outPath,
        version: result.version,
        bundleBytes: result.bundleBytes,
        jsonBytes: result.jsonBytes,
      },
      null,
      2
    )
  );
}
