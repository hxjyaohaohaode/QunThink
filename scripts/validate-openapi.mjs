import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const rootDir = path.resolve(process.cwd());
const openApiPath = path.join(rootDir, 'openapi', 'openapi.yaml');

if (!fs.existsSync(openApiPath)) {
  console.error('OpenAPI 文档不存在:', openApiPath);
  process.exit(1);
}

const content = fs.readFileSync(openApiPath, 'utf8');

const requiredSnippets = [
  'openapi: 3.1.0',
  '/api/auth/register:',
  '/api/auth/login:',
  '/api/auth/me:',
  '/api/groups:',
  '/api/groups/{groupId}/messages:',
  '/api/files/upload:',
  '/api/files/{id}/download:'
];

const missingSnippets = requiredSnippets.filter((snippet) => !content.includes(snippet));

if (missingSnippets.length > 0) {
  console.error('OpenAPI 缺少关键路径或版本信息:');
  for (const snippet of missingSnippets) {
    console.error(`- ${snippet}`);
  }
  process.exit(1);
}

console.log('OpenAPI 基础校验通过');
