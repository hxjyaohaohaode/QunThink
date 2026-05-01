import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import axios from 'axios';

process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'session';
process.env.MIMO_API_KEY = 'test-mimo-key';
process.env.DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-chat-tts-data-'));
process.env.AUTH_DB_PATH = path.join(process.env.DATA_DIR, 'auth.json');

const { initDatabase } = await import('../src/models/db.js');
const { initAuthDb } = await import('../src/models/authDb.js');
const { createTestApp } = await import('./helpers/createTestApp.js');
const supertest = (await import('supertest')).default;

await initDatabase();
await initAuthDb();

const request = supertest(createTestApp());

function uniqueUsername(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function registerAndGetSession() {
  const username = uniqueUsername('ttscase');
  const response = await request
    .post('/api/auth/register')
    .send({
      username,
      password: 'Passw0rd123',
      nickname: 'TTS Case'
    });

  assert.equal(response.status, 201);
  return response.headers['set-cookie'];
}

test('TTS synthesis persists metadata and transcript is searchable', async () => {
  const originalAxiosPost = axios.post;

  try {
    axios.post = async (url) => {
      assert.match(url, /chat\/completions$/);
      return {
        data: {
          choices: [
            {
              message: {
                audio: {
                  data: Buffer.alloc(512, 1).toString('base64'),
                  format: 'wav'
                }
              }
            }
          ]
        },
        headers: {
          'content-type': 'application/json'
        }
      };
    };

    const cookies = await registerAndGetSession();

    const groupsResponse = await request
      .get('/api/groups')
      .set('Cookie', cookies);
    assert.equal(groupsResponse.status, 200);
    const groupId = groupsResponse.body[0].id;

    const sendResponse = await request
      .post(`/api/groups/${groupId}/messages`)
      .set('Cookie', cookies)
      .send({
        content: '请把这段文字转成语音并保存',
        metadata: { traceId: 'tts-001' }
      });

    assert.equal(sendResponse.status, 201);
    const messageId = sendResponse.body.id;

    const ttsResponse = await request
      .post('/api/tts/synthesize')
      .set('Cookie', cookies)
      .send({
        text: '你好，这是一段可搜索的测试语音内容。',
        voice: 'mimo_default',
        tone: 'normal',
        messageId
      });

    assert.equal(ttsResponse.status, 200);
    assert.equal(ttsResponse.body.success, true);
    assert.equal(ttsResponse.body.transcript, '你好，这是一段可搜索的测试语音内容。');
    assert.match(ttsResponse.body.audio_url, /\/api\/tts\/audio\/.+\.wav$/);

    const messagesResponse = await request
      .get(`/api/groups/${groupId}/messages`)
      .set('Cookie', cookies);

    assert.equal(messagesResponse.status, 200);
    const savedMessage = messagesResponse.body.messages.find(message => message.id === messageId);
    assert.ok(savedMessage);
    assert.equal(savedMessage.metadata.tts.transcript, '你好，这是一段可搜索的测试语音内容。');
    assert.equal(savedMessage.metadata.tts.audioUrl, ttsResponse.body.audio_url);

    const searchResponse = await request
      .get('/api/search')
      .set('Cookie', cookies)
      .query({
        q: '可搜索的测试语音',
        type: 'messages',
        groupId
      });

    assert.equal(searchResponse.status, 200);
    assert.ok(searchResponse.body.messages.some(message => (
      message.id === messageId && message.match_type === 'tts_transcript'
    )));
  } finally {
    axios.post = originalAxiosPost;
  }
});
