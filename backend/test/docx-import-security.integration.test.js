import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import http from 'node:http';
import https from 'node:https';

// Install the guard before importing the application or its DOCX parser.
const require = createRequire(import.meta.url);
const originalLoad = Module._load;
const cliAttempts = [];
Module._load = function (specifier, parent) {
  if (/^(argparse|sprintf-js)(\/|$)/.test(specifier)) {
    cliAttempts.push({ specifier, parent: parent?.filename });
    throw new Error('CLI-only dependency attempted in DOCX HTTP API');
  }
  return originalLoad.apply(this, arguments);
};
const outboundAttempts = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  outboundAttempts.push(String(url));
  throw new Error('External requests disabled for isolated DOCX regression');
};
const savedRequests = new Map();
for (const transport of [http, https]) {
  savedRequests.set(transport, transport.request);
  transport.request = function (options) {
    const hostname = typeof options === 'string' || options instanceof URL
      ? new URL(options).hostname : options?.hostname || options?.host || 'localhost';
    if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname)) {
      outboundAttempts.push(String(hostname));
      throw new Error('External requests disabled for isolated DOCX regression');
    }
    return savedRequests.get(transport).apply(this, arguments);
  };
}

process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'session';
process.env.DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'qunthink-docx-security-'));
process.env.AUTH_DB_PATH = path.join(process.env.DATA_DIR, 'auth.json');
const { initDatabase } = await import('../src/models/db.js');
const { initAuthDb } = await import('../src/models/authDb.js');
const { createTestApp } = await import('./helpers/createTestApp.js');
const { docxFixture, DOCX_MIME } = await import('./helpers/docxFixture.js');
await initDatabase();
await initAuthDb();
const request = require('supertest')(createTestApp());

test.after(async () => {
  Module._load = originalLoad;
  globalThis.fetch = originalFetch;
  for (const [transport, original] of savedRequests) transport.request = original;
  delete Object.prototype.qunthinkDocxRegressionMarker;
  await fs.rm(process.env.DATA_DIR, { recursive: true, force: true });
});

test('authenticated DOCX uploads preserve text, reject invalid archives, and never load CLI dependencies or pollute prototypes', async () => {
  const unauthorized = await request.post('/api/files/upload').field('group_id', 'none')
    .attach('files', docxFixture('auth guard'), { filename: 'auth.docx', contentType: DOCX_MIME });
  assert.equal(unauthorized.status, 401);

  const registered = await request.post('/api/auth/register').send({
    username: 'docx_security_regression', password: 'LocalTest123!', nickname: 'DOCX regression'
  });
  assert.equal(registered.status, 201);
  const cookie = registered.headers['set-cookie'];
  const groups = await request.get('/api/groups').set('Cookie', cookie);
  assert.equal(groups.status, 200);
  const groupId = groups.body[0].id;
  const cases = [
    ['normal', docxFixture('Normal document'), 'Normal document'],
    ['empty', docxFixture(), ''],
    ['unicode', docxFixture('群想 文档测试 🐱 café Ελληνικά'), '群想 文档测试 🐱 café Ελληνικά'],
    ['precision', docxFixture('%.101f %.101e %.101g %.0g'), '%.101f %.101e %.101g %.0g'],
    ['missing-document', docxFixture('', { omitDocument: true }), '[Word文档解析失败]'],
    ['prototype-style', docxFixture('Safe styles', { styleMarker: 'qunthinkDocxRegressionMarker' }), 'Safe styles'],
    ['unmatched-field', docxFixture('', { bodyXml: '<w:p><w:r><w:fldChar w:fldCharType="end"/><w:fldChar w:fldCharType="separate"/><w:t>Surviving field text</w:t></w:r></w:p>' }), 'Surviving field text']
  ];
  for (const [name, buffer, expected] of cases) {
    assert(buffer.length < 4096);
    assert.equal(Object.hasOwn(Object.prototype, 'qunthinkDocxRegressionMarker'), false);
    const uploaded = await request.post('/api/files/upload').set('Cookie', cookie)
      .field('group_id', groupId)
      .attach('files', buffer, { filename: `${name}-%.101f.docx`, contentType: DOCX_MIME });
    assert.equal(uploaded.status, 201, `${name}: ${JSON.stringify(uploaded.body)}`);
    const content = await request.get(`/api/files/${uploaded.body.file.id}/content`)
      .set('Cookie', cookie).query({ group_id: groupId });
    assert.equal(content.status, 200);
    assert.equal(content.body.content.trim(), expected, name);
    assert.equal(Object.hasOwn(Object.prototype, 'qunthinkDocxRegressionMarker'), false, name);
  }
  const invalid = await request.post('/api/files/upload').set('Cookie', cookie)
    .field('group_id', groupId)
    .attach('files', Buffer.from('not a zip'), { filename: 'broken.docx', contentType: DOCX_MIME });
  assert.equal(invalid.status, 400);
  assert.equal((await request.get('/api/health').set('Cookie', cookie)).status, 200);
  assert.deepEqual(cliAttempts, []);
  assert.deepEqual(Object.keys(require.cache).filter(name => /[\\/](argparse|sprintf-js)[\\/]/.test(name)), []);
  assert.deepEqual(outboundAttempts, []);
});
