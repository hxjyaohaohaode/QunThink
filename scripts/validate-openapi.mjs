#!/usr/bin/env node
/**
 * OpenAPI 契约校验脚本（真实实现，替代旧的"字符串片段包含"伪校验）
 *
 * 校验内容：
 *   结构校验（失败退出码 1）：
 *     - YAML 可解析；openapi/info/paths/components 字段存在
 *     - 所有本地 $ref（#/...）可解析到文档内部
 *     - 每个 path 至少包含一个 operation
 *     - operationId 全局唯一
 *   漂移交叉校验（仅警告，退出码 0）：
 *     - 扫描 backend/src/routes/*.js 与 backend/src/index.js 的真实路由，
 *       与 openapi.paths 对比，输出：
 *       「实现有而文档缺失」「文档有而实现缺失」两类清单。
 *       dev-only 路由（如 POST /api/auth/register）在白名单中放行。
 *
 * 用法：node scripts/validate-openapi.mjs （需先 cd backend && npm i 安装 yaml）
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '..');
// yaml 声明在 backend 的 devDependencies 中，这里从 backend 解析依赖，
// 使脚本可以在仓库任意目录（含根目录，与 CI 一致）直接运行。
const requireFromBackend = createRequire(path.join(rootDir, 'backend', 'package.json'));
const { parse } = requireFromBackend('yaml');
const openApiPath = path.join(rootDir, 'openapi', 'openapi.yaml');
const routesDir = path.join(rootDir, 'backend', 'src', 'routes');
const indexJsPath = path.join(rootDir, 'backend', 'src', 'index.js');

/** 路由文件 -> Express 挂载前缀（backend/src/index.js 中 app.use 的真实配置） */
const ROUTER_MOUNT_PREFIXES = {
  'apiconfig.js': '/api/user',
  'tts.js': '/api/tts'
};
const DEFAULT_PREFIX = '/api';

/** dev-only / 特殊白名单：实现存在但生产环境不注册，允许文档不收录或收录标注 */
const IMPL_ONLY_WHITELIST = new Set([
  // auth.js: 仅 NODE_ENV != production 时注册，生产 404（文档已单独标注 x-dev-only）
  'POST /api/auth/register'
]);

const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch']);

let structuralErrors = [];
const driftWarnings = [];

function fail(message) {
  structuralErrors.push(message);
}

// ---------------------------------------------------------------------------
// 1. 解析 YAML 与基本结构
// ---------------------------------------------------------------------------
if (!fs.existsSync(openApiPath)) {
  console.error(`❌ OpenAPI 文档不存在: ${openApiPath}`);
  process.exit(1);
}

let doc;
try {
  doc = parse(fs.readFileSync(openApiPath, 'utf8'));
} catch (err) {
  console.error('❌ OpenAPI YAML 解析失败:', err.message);
  process.exit(1);
}

for (const field of ['openapi', 'info', 'paths', 'components']) {
  if (doc?.[field] === undefined) {
    fail(`缺少顶层字段: ${field}`);
  }
}
if (!doc || !doc.paths) {
  console.error('❌ OpenAPI 文档结构不完整，无法继续校验。');
  for (const e of structuralErrors) console.error(`  - ${e}`);
  process.exit(1);
}
if (!doc.info || typeof doc.info !== 'object') fail('info 必须是对象');
if (!doc.components || typeof doc.components !== 'object') fail('components 必须是对象');

// ---------------------------------------------------------------------------
// 2. $ref 可解析性
// ---------------------------------------------------------------------------
function resolveLocalRef(ref) {
  if (typeof ref !== 'string') return false;
  if (!ref.startsWith('#/')) return false; // 外部引用视为错误
  let node = doc;
  for (const seg of ref.slice(2).split('/')) {
    const key = seg.replace(/~1/g, '/').replace(/~0/g, '~');
    if (node === null || typeof node !== 'object' || !(key in node)) return false;
    node = node[key];
  }
  return true;
}

const refSet = new Set();
(function walkRefs(node) {
  if (Array.isArray(node)) {
    for (const item of node) walkRefs(item);
    return;
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string') {
        refSet.add(value);
      } else {
        walkRefs(value);
      }
    }
  }
})(doc);

for (const ref of refSet) {
  if (!resolveLocalRef(ref)) {
    fail(`无法解析的 $ref: ${ref}`);
  }
}

// ---------------------------------------------------------------------------
// 3. path 至少一个 operation + operationId 唯一
// ---------------------------------------------------------------------------
const operationIds = new Map(); // id -> path
for (const [pathKey, pathItem] of Object.entries(doc.paths)) {
  if (!pathItem || typeof pathItem !== 'object') {
    fail(`path "${pathKey}" 不是对象`);
    continue;
  }
  const ops = Object.keys(pathItem).filter((k) => HTTP_METHODS.has(k));
  if (ops.length === 0) {
    fail(`path "${pathKey}" 未定义任何 operation`);
  }
  for (const method of ops) {
    const op = pathItem[method];
    const opId = op?.operationId;
    if (typeof opId !== 'string' || opId.length === 0) {
      fail(`${method.toUpperCase()} ${pathKey} 缺少 operationId`);
      continue;
    }
    if (operationIds.has(opId)) {
      fail(`operationId 重复: "${opId}" (${operationIds.get(opId)} 与 ${pathKey})`);
    } else {
      operationIds.set(opId, pathKey);
    }
  }
}

// ---------------------------------------------------------------------------
// 4. 扫描后端真实路由
// ---------------------------------------------------------------------------
function normalizeExpressPath(routePath, prefix) {
  let p = routePath.trim();
  p = p.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
  if (prefix && !p.startsWith(prefix)) {
    p = prefix.endsWith('/') ? `${prefix}${p.slice(1)}` : `${prefix}${p}`;
  }
  if (!p.startsWith('/')) p = `/${p}`;
  return p;
}

function extractRoutesFromFile(filePath, mountPrefix, useApiLiteralOnly) {
  const results = [];
  const content = fs.readFileSync(filePath, 'utf8');
  const pattern = useApiLiteralOnly
    ? /\bapp\.(get|post|put|delete|patch)\(\s*['"`](\/api[^'"`]*)['"`]/g
    : /\brouter\.(get|post|put|delete|patch)\(\s*['"`]([^'"`]+)['"`]/g;
  let match;
  while ((match = pattern.exec(content)) !== null) {
    const method = match[1].toUpperCase();
    const rawPath = match[2];
    const fullPath = useApiLiteralOnly ? rawPath : normalizeExpressPath(rawPath, mountPrefix);
    results.push(`${method} ${fullPath}`);
  }
  return results;
}

const implRoutes = new Set();

if (fs.existsSync(indexJsPath)) {
  for (const route of extractRoutesFromFile(indexJsPath, DEFAULT_PREFIX, true)) {
    implRoutes.add(route);
  }
} else {
  fail(`未找到后端入口文件: ${indexJsPath}`);
}

if (fs.existsSync(routesDir)) {
  for (const fileName of fs.readdirSync(routesDir).filter((f) => f.endsWith('.js'))) {
    const prefix = ROUTER_MOUNT_PREFIXES[fileName] ?? DEFAULT_PREFIX;
    for (const route of extractRoutesFromFile(path.join(routesDir, fileName), prefix, false)) {
      implRoutes.add(route);
    }
  }
} else {
  fail(`未找到路由目录: ${routesDir}`);
}

// 收集文档中的 operation 集合（与 impl 相同的 "METHOD /path" 形式）
const docOps = new Set();
for (const [pathKey, pathItem] of Object.entries(doc.paths)) {
  for (const method of Object.keys(pathItem).filter((k) => HTTP_METHODS.has(k))) {
    docOps.add(`${method.toUpperCase()} ${pathKey}`);
  }
}

// ---------------------------------------------------------------------------
// 5. 交叉对比（漂移仅警告）
// ---------------------------------------------------------------------------
const missingInDoc = [...implRoutes]
  .filter((r) => !docOps.has(r))
  .filter((r) => !IMPL_ONLY_WHITELIST.has(r))
  .sort();
const extraInDoc = [...docOps]
  .filter((r) => !implRoutes.has(r))
  .filter((r) => ![...IMPL_ONLY_WHITELIST].some((w) => r === w))
  .sort();

if (missingInDoc.length > 0) {
  driftWarnings.push(`【实现有而文档缺失】${missingInDoc.length} 个:`);
  for (const r of missingInDoc) driftWarnings.push(`  - ${r}`);
}
if (extraInDoc.length > 0) {
  driftWarnings.push(`【文档有而实现缺失】${extraInDoc.length} 个:`);
  for (const r of extraInDoc) driftWarnings.push(`  - ${r}`);
}

// ---------------------------------------------------------------------------
// 6. 输出与退出码
// ---------------------------------------------------------------------------
console.log(`OpenAPI 版本: ${doc.openapi ?? '(缺失)'}`);
console.log(`文档 paths: ${Object.keys(doc.paths).length}, operations: ${docOps.size}`);
console.log(`实现路由: ${implRoutes.size}（含白名单 ${IMPL_ONLY_WHITELIST.size} 条）`);

if (structuralErrors.length > 0) {
  console.error(`\n❌ 结构校验失败，共 ${structuralErrors.length} 处：`);
  for (const e of structuralErrors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log('\n✅ 结构校验通过（YAML 解析 / 顶层字段 / $ref 解析 / path 操作覆盖 / operationId 唯一）');

if (driftWarnings.length > 0) {
  console.warn('\n⚠️  发现文档与实现的漂移（仅警告，不影响退出码）：');
  for (const w of driftWarnings) console.warn(w);
} else {
  console.log('✅ 无漂移：文档与后端实现的路由清单完全一致');
}

process.exit(0);
