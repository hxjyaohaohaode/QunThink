import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'session';
process.env.DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'qunthink-multipart-security-'));
process.env.AUTH_DB_PATH = path.join(process.env.DATA_DIR, 'auth.json');
const { initDatabase } = await import('../src/models/db.js');
const { initAuthDb } = await import('../src/models/authDb.js');
const { createTestApp } = await import('./helpers/createTestApp.js');
const request = (await import('supertest')).default(createTestApp());
await initDatabase();
await initAuthDb();
const registered = await request.post('/api/auth/register').send({ username: 'multipart_security', password: 'FixtureOnly123', nickname: 'Fixture' });
assert.equal(registered.status, 201);
const cookies = registered.headers['set-cookie'];
const boundary = 'qunthink-security-boundary';

for (const [label, disposition, tail] of [
  ['missing field name', 'filename="sample.txt"', `hello\r\n--${boundary}--\r\n`],
  ['empty field name', 'name=""; filename="sample.txt"', `hello\r\n--${boundary}--\r\n`],
  ['truncated file body', 'name="files"; filename="sample.txt"', 'hello'],
]) {
  test(`authenticated upload rejects ${label} without crashing or leaving files`, async () => {
    const body = `--${boundary}\r\nContent-Disposition: form-data; ${disposition}\r\nContent-Type: text/plain\r\n\r\n${tail}`;
    const response = await request.post('/api/files/upload').set('Cookie', cookies)
      .set('Content-Type', `multipart/form-data; boundary=${boundary}`).send(body).timeout(3000);
    assert.equal(response.status, 400);
    assert.equal((await request.get('/api/health')).status, 200);
    const files = await fs.readdir(path.join(process.env.DATA_DIR, 'uploads'), { recursive: true }).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    assert.equal(files.filter(name => name.endsWith('.txt')).length, 0);
  });
}

test.after(async () => { await fs.rm(process.env.DATA_DIR, { recursive: true, force: true }); });
