import { mockProviderDns } from './helpers/mockProviderDns.js';
mockProviderDns(['api.xiaomimimo.com']);
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import axios from 'axios';
import crypto from 'node:crypto';

process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'session';
process.env.MIMO_API_KEY = 'test-mimo-key';
process.env.QUNTHINK_SHARED_PROVIDER_KEYS = '1';
process.env.DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-chat-tts-data-'));
process.env.AUTH_DB_PATH = path.join(process.env.DATA_DIR, 'auth.json');

const { initDatabase, getUserDb, withWriteLock, clearUserDbCache } = await import('../src/models/db.js');
const { initAuthDb } = await import('../src/models/authDb.js');
const { createTestApp } = await import('./helpers/createTestApp.js');
const { drainTtsPendingDeletes } = await import('../src/services/ttsDeletion.js');
const { cleanupOldTTSFiles } = await import('../src/services/scheduler/ttsCleanup.js');
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

function testWav() {
  const wav = Buffer.alloc(44 + 512);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVE', 8);
  wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(512, 40);
  return wav;
}

test('TTS synthesis persists metadata and transcript is searchable', async () => {
  const originalAxiosPost = axios.post;
  let validAudio = true;
  let responseFormat = 'wav';
  let providerCalls = 0;

  try {
    axios.post = async (url) => {
      providerCalls += 1;
      assert.match(url, /chat\/completions$/);
      return {
        data: {
          choices: [
            {
              message: {
                audio: {
                  data: (validAudio ? testWav() : Buffer.alloc(512, 1)).toString('base64'),
                  format: responseFormat
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
    const catalogResponse = await request.get('/api/user/model-catalog').set('Cookie', cookies);
    assert.equal(catalogResponse.status, 200);
    assert.equal(catalogResponse.body.defaults.tts, null);
    assert.equal((await request.post('/api/tts/synthesize').set('Cookie', cookies).send({
      clientRequestId: crypto.randomUUID(),
      text: '没有默认模型时不能擅自选择供应商', voice: 'mimo_default', tone: 'normal'
    })).status, 409);
    const catalog = catalogResponse.body;
    catalog.defaults.tts = 'mimo_tts';
    assert.equal((await request.put('/api/user/model-catalog').set('Cookie', cookies).send(catalog)).status, 200);
    assert.equal((await request.post('/api/tts/synthesize').set('Cookie', cookies).send({
      clientRequestId: crypto.randomUUID(),
      text: '未经语音验证的默认模型不能调用', voice: 'mimo_default', tone: 'normal'
    })).status, 409);
    validAudio = false;
    assert.equal((await request.post('/api/user/model-catalog/test').set('Cookie', cookies)
      .send({ clientRequestId: crypto.randomUUID(), modelId: 'mimo_tts', capability: 'tts' })).status, 502);
    validAudio = true;
    const probe = await request.post('/api/user/model-catalog/test').set('Cookie', cookies)
      .send({ clientRequestId: crypto.randomUUID(), modelId: 'mimo_tts', capability: 'tts' });
    assert.equal(probe.status, 200);
    assert.equal(probe.body.capability, 'tts');
    const callsBeforeMissingMessage = providerCalls;
    for (const invalidSelection of [
      { voice: 'unverified_voice', tone: 'normal' },
      { voice: 'mimo_default', tone: 'emotional' },
      { voice: 'mimo_default', tone: 'normal', speed: 1.7 }
    ]) {
      assert.equal((await request.post('/api/tts/synthesize').set('Cookie', cookies).send({
        clientRequestId: crypto.randomUUID(), text: '未验证的语音参数不得计费调用', ...invalidSelection
      })).status, 400);
    }
    assert.equal(providerCalls, callsBeforeMissingMessage);
    assert.equal((await request.post('/api/tts/synthesize').set('Cookie', cookies).send({
      clientRequestId: crypto.randomUUID(),
      text: '不存在的消息不应产生收费调用', voice: 'mimo_default', tone: 'normal',
      messageId: '11111111-1111-4111-8111-111111111111'
    })).status, 404);
    assert.equal(providerCalls, callsBeforeMissingMessage);
    validAudio = false;
    const invalidAudioId = crypto.randomUUID();
    const invalidAudio = await request.post('/api/tts/synthesize').set('Cookie', cookies).send({
      clientRequestId: invalidAudioId,
      text: '损坏的音频不可作为完成成果', voice: 'mimo_default', tone: 'normal'
    });
    assert.equal(invalidAudio.status, 202);
    assert.equal(invalidAudio.body.status, 'unknown');
    assert.equal((await request.get(`/api/tts/effects/${invalidAudioId}`).set('Cookie', cookies)).body.status, 'unknown');
    responseFormat = 'mp3';
    const spoofedMp3 = await request.post('/api/tts/synthesize').set('Cookie', cookies).send({
      clientRequestId: crypto.randomUUID(),
      text: '伪装成 MP3 的任意字节不可作为成果', voice: 'mimo_default', tone: 'normal'
    });
    assert.equal(spoofedMp3.status, 202);
    assert.equal(spoofedMp3.body.status, 'unknown');
    responseFormat = 'wav';
    validAudio = true;

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

    const synthesisId = crypto.randomUUID();
    const ttsResponse = await request
      .post('/api/tts/synthesize')
      .set('Cookie', cookies)
      .send({
        clientRequestId: synthesisId,
        text: '你好，这是一段可搜索的测试语音内容。',
        voice: 'mimo_default',
        tone: 'normal',
        messageId
      });

    assert.equal(ttsResponse.status, 200);
    assert.equal(ttsResponse.body.success, true);
    assert.equal(ttsResponse.body.requestId, synthesisId);
    const callsAfterSuccess = providerCalls;
    const replay = await request.post('/api/tts/synthesize').set('Cookie', cookies).send({
      clientRequestId: synthesisId, text: '你好，这是一段可搜索的测试语音内容。',
      voice: 'mimo_default', tone: 'normal', messageId
    });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.audio_id, ttsResponse.body.audio_id);
    assert.equal(providerCalls, callsAfterSuccess);
    const concurrentId = crypto.randomUUID();
    const concurrentBody = { clientRequestId: concurrentId,
      text: '重复点击只能合成一次', voice: 'mimo_default', tone: 'normal' };
    const beforeConcurrent = providerCalls;
    const concurrent = await Promise.all([
      request.post('/api/tts/synthesize').set('Cookie', cookies).send(concurrentBody),
      request.post('/api/tts/synthesize').set('Cookie', cookies).send(concurrentBody)
    ]);
    assert.ok(concurrent.every(result => [200, 202].includes(result.status)));
    assert.equal(providerCalls - beforeConcurrent, 1);
    assert.equal((await request.post('/api/tts/synthesize').set('Cookie', cookies).send({
      clientRequestId: synthesisId, text: '使用相同请求号但改写输入',
      voice: 'mimo_default', tone: 'normal', messageId
    })).status, 409);
    assert.equal(providerCalls, beforeConcurrent + 1);
    assert.equal(ttsResponse.body.transcript, '你好，这是一段可搜索的测试语音内容。');
    assert.match(ttsResponse.body.audio_url, /\/api\/tts\/audio\/.+\.wav$/);
    const audioDownload = await request.get(ttsResponse.body.audio_url).set('Cookie', cookies);
    assert.equal(audioDownload.status, 200);
    assert.match(audioDownload.headers['cache-control'], /no-store/);
    const partialAudio = await request.get(ttsResponse.body.audio_url).set('Cookie', cookies)
      .set('Range', 'bytes=0-15');
    assert.equal(partialAudio.status, 206);
    assert.equal(partialAudio.body.length, 16);
    assert.equal((await request.get(ttsResponse.body.audio_url).set('Cookie', cookies)
      .set('Range', 'bytes=999999-')).status, 416);
    const otherCookies = await registerAndGetSession();
    assert.equal((await request.get(`/api/tts/effects/${synthesisId}`).set('Cookie', otherCookies)).status, 404);
    assert.equal((await request.get(ttsResponse.body.audio_url).set('Cookie', otherCookies)).status, 404);
    assert.equal((await request.get(ttsResponse.body.audio_url)).status, 401);
    assert.equal((await request.get(ttsResponse.body.audio_url).set('Cookie', otherCookies)
      .query({ token: 'forged' })).status, 404);
    const otherGroups = await request.get('/api/groups').set('Cookie', otherCookies);
    assert.equal(otherGroups.status, 200);
    const forgedMessage = await request.post(`/api/groups/${otherGroups.body[0].id}/messages`)
      .set('Cookie', otherCookies).send({ content: '伪造音频元数据',
        metadata: { tts: { audioUrl: ttsResponse.body.audio_url } } });
    assert.equal(forgedMessage.status, 201);
    assert.equal(forgedMessage.body.metadata?.tts, undefined);
    assert.equal((await request.get(ttsResponse.body.audio_url).set('Cookie', otherCookies)).status, 404);
    const owner = await request.get('/api/auth/me').set('Cookie', cookies);
    assert.equal(owner.status, 200);
    let ownerDb = await getUserDb(owner.body.user.id);
    const ownerDbPath = path.join(process.env.DATA_DIR, 'users', `db_${owner.body.user.id}.json`);
    const legacyMessage = await request.post(`/api/groups/${groupId}/messages`)
      .set('Cookie', cookies).send({ content: '旧版消息音频归属迁移' });
    assert.equal(legacyMessage.status, 201);
    const legacyFilename = `tts_${legacyMessage.body.id}_${crypto.randomBytes(4).toString('hex')}.wav`;
    const legacyUrl = `/api/tts/audio/${legacyFilename}`;
    await fs.copyFile(path.join(process.env.DATA_DIR, 'tts', path.basename(ttsResponse.body.audio_url)),
      path.join(process.env.DATA_DIR, 'tts', legacyFilename));
    await withWriteLock(owner.body.user.id, async () => {
      await ownerDb.read();
      const message = ownerDb.data.messages.find(entry => entry.id === legacyMessage.body.id);
      message.metadata = { ...(message.metadata || {}), tts: { audioUrl: legacyUrl, transcript: '旧版音频' } };
      await ownerDb.write();
    });
    assert.equal((await request.get(legacyUrl).set('Cookie', otherCookies)).status, 404);
    assert.equal((await request.get(legacyUrl).set('Cookie', cookies)).status, 200);
    await ownerDb.read();
    assert.ok(ownerDb.data.ttsAudioFiles.some(audio => audio.filename === legacyFilename &&
      audio.messageId === legacyMessage.body.id));
    const unseenLegacy = await request.post(`/api/groups/${groupId}/messages`).set('Cookie', cookies)
      .send({ content: '未读取过的旧音频也能删除' });
    assert.equal(unseenLegacy.status, 201);
    const unseenFilename = `tts_${unseenLegacy.body.id}_${crypto.randomBytes(4).toString('hex')}.wav`;
    await fs.copyFile(path.join(process.env.DATA_DIR, 'tts', path.basename(ttsResponse.body.audio_url)),
      path.join(process.env.DATA_DIR, 'tts', unseenFilename));
    await withWriteLock(owner.body.user.id, async () => {
      await ownerDb.read();
      const message = ownerDb.data.messages.find(entry => entry.id === unseenLegacy.body.id);
      message.metadata = { ...(message.metadata || {}),
        tts: { audioUrl: `/api/tts/audio/${unseenFilename}`, transcript: '旧版待删' } };
      await ownerDb.write();
    });
    assert.equal((await request.delete(`/api/tts/messages/${unseenLegacy.body.id}`)
      .set('Cookie', cookies)).status, 200);
    await assert.rejects(fs.access(path.join(process.env.DATA_DIR, 'tts', unseenFilename)), { code: 'ENOENT' });
    const revokedLegacy = await request.post(`/api/groups/${groupId}/messages`).set('Cookie', cookies)
      .send({ content: '旧版音频所属消息删除后不能补登记' });
    assert.equal(revokedLegacy.status, 201);
    const revokedLegacyFilename = `tts_${revokedLegacy.body.id}_${crypto.randomBytes(4).toString('hex')}.wav`;
    const revokedLegacyPath = path.join(process.env.DATA_DIR, 'tts', revokedLegacyFilename);
    const revokedLegacyUrl = `/api/tts/audio/${revokedLegacyFilename}`;
    await fs.writeFile(revokedLegacyPath, testWav());
    await withWriteLock(owner.body.user.id, async () => {
      await ownerDb.read();
      const message = ownerDb.data.messages.find(entry => entry.id === revokedLegacy.body.id);
      message.metadata = { ...(message.metadata || {}), tts: { audioUrl: revokedLegacyUrl } };
      await ownerDb.write();
    });
    const legacyBeforeDelete = await fs.readFile(ownerDbPath);
    assert.equal((await request.delete(`/api/messages/${revokedLegacy.body.id}`).set('Cookie', cookies)).status, 200);
    const legacyAfterDelete = await fs.readFile(ownerDbPath);
    await fs.writeFile(ownerDbPath, legacyBeforeDelete);
    await fs.writeFile(revokedLegacyPath, testWav());
    clearUserDbCache(owner.body.user.id);
    try {
      assert.equal((await request.get(revokedLegacyUrl).set('Cookie', cookies)).status, 404);
      assert.equal((await request.get(`/api/tts/messages/${revokedLegacy.body.id}`)
        .set('Cookie', cookies)).status, 404);
      const restored = await getUserDb(owner.body.user.id);
      await restored.read();
      assert.ok(!restored.data.ttsAudioFiles?.some(audio => audio.filename === revokedLegacyFilename));
    } finally {
      await fs.writeFile(ownerDbPath, legacyAfterDelete);
      await fs.unlink(revokedLegacyPath).catch(() => {});
      clearUserDbCache(owner.body.user.id);
      ownerDb = await getUserDb(owner.body.user.id);
    }
    const orphan = await request.post('/api/tts/synthesize').set('Cookie', cookies).send({
      clientRequestId: crypto.randomUUID(),
      text: '无关联消息的语音也只属于当前账号', voice: 'mimo_default', tone: 'normal'
    });
    assert.equal(orphan.status, 200);
    assert.equal((await request.get(orphan.body.audio_url).set('Cookie', cookies)).status, 200);
    assert.equal((await request.get(orphan.body.audio_url).set('Cookie', otherCookies)).status, 404);
    const orphanFilename = path.basename(orphan.body.audio_url);
    await withWriteLock(owner.body.user.id, async () => {
      await ownerDb.read();
      ownerDb.data.ttsAudioFiles.find(audio => audio.filename === orphanFilename).createdAt =
        Date.now() - 24 * 60 * 60 * 1000 - 1000;
      await ownerDb.write();
    });
    await cleanupOldTTSFiles();
    assert.equal((await request.get(orphan.body.audio_url).set('Cookie', cookies)).status, 404);
    await assert.rejects(fs.access(path.join(process.env.DATA_DIR, 'tts', orphanFilename)), { code: 'ENOENT' });

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
    const editedSource = await request.post(`/api/groups/${groupId}/messages`).set('Cookie', cookies)
      .send({ content: '原始消息内容' });
    assert.equal(editedSource.status, 201);
    const editedSourceAudio = await request.post('/api/tts/synthesize').set('Cookie', cookies).send({
      clientRequestId: crypto.randomUUID(), text: '旧语音不应留在搜索',
      voice: 'mimo_default', tone: 'normal', messageId: editedSource.body.id
    });
    assert.equal(editedSourceAudio.status, 200);
    const editedAudioPath = path.join(process.env.DATA_DIR, 'tts', path.basename(editedSourceAudio.body.audio_url));
    const sourceBeforeEdit = await fs.readFile(ownerDbPath);
    const audioBeforeEdit = await fs.readFile(editedAudioPath);
    const oldTranscript = () => request.get('/api/search').set('Cookie', cookies)
      .query({ q: '旧语音不应留在搜索', type: 'messages', groupId });
    assert.ok((await oldTranscript()).body.messages.some(message => message.id === editedSource.body.id));
    const edit = await request.put(`/api/messages/${editedSource.body.id}`).set('Cookie', cookies)
      .send({ content: '修订后的消息内容' });
    assert.equal(edit.status, 200);
    assert.equal(edit.body.metadata?.tts, undefined);
    assert.equal((await request.get(editedSourceAudio.body.audio_url).set('Cookie', cookies)).status, 404);
    assert.equal((await request.get(`/api/tts/effects/${editedSourceAudio.body.requestId}`)
      .set('Cookie', cookies)).body.status, 'deleted');
    assert.ok(!(await oldTranscript()).body.messages.some(message => message.id === editedSource.body.id));
    await assert.rejects(fs.access(path.join(process.env.DATA_DIR, 'tts',
      path.basename(editedSourceAudio.body.audio_url))), { code: 'ENOENT' });
    const sourceAfterEdit = await fs.readFile(ownerDbPath);
    await fs.writeFile(ownerDbPath, sourceBeforeEdit);
    await fs.writeFile(editedAudioPath, audioBeforeEdit);
    clearUserDbCache(owner.body.user.id);
    try {
      const callsBeforeRestore = providerCalls;
      assert.equal((await request.get(`/api/tts/messages/${editedSource.body.id}`)
        .set('Cookie', cookies)).status, 404);
      assert.equal((await request.get(editedSourceAudio.body.audio_url).set('Cookie', cookies)).status, 404);
      const restoredEffect = await request.get(`/api/tts/effects/${editedSourceAudio.body.requestId}`)
        .set('Cookie', cookies);
      assert.equal(restoredEffect.status, 200);
      assert.equal(restoredEffect.body.status, 'deleted');
      assert.equal(restoredEffect.body.response, null);
      const restoredReplay = await request.post('/api/tts/synthesize').set('Cookie', cookies).send({
        clientRequestId: editedSourceAudio.body.requestId, text: '旧语音不应留在搜索',
        voice: 'mimo_default', tone: 'normal', messageId: editedSource.body.id
      });
      assert.equal(restoredReplay.status, 404);
      assert.equal(providerCalls, callsBeforeRestore);
    } finally {
      await fs.writeFile(ownerDbPath, sourceAfterEdit);
      await fs.unlink(editedAudioPath).catch(() => {});
      clearUserDbCache(owner.body.user.id);
      ownerDb = await getUserDb(owner.body.user.id);
    }
    const racingSource = await request.post(`/api/groups/${groupId}/messages`).set('Cookie', cookies)
      .send({ content: '合成开始时的正文' });
    assert.equal(racingSource.status, 201);
    let announceProviderCall;
    let releaseProviderCall;
    const providerCalled = new Promise(resolve => { announceProviderCall = resolve; });
    const providerGate = new Promise(resolve => { releaseProviderCall = resolve; });
    const mockProvider = axios.post;
    axios.post = async (...args) => {
      announceProviderCall();
      await providerGate;
      return mockProvider(...args);
    };
    const filesBeforeRace = (await fs.readdir(path.join(process.env.DATA_DIR, 'tts'))).sort();
    const racingId = crypto.randomUUID();
    const racingRequest = request.post('/api/tts/synthesize').set('Cookie', cookies).send({
      clientRequestId: racingId, text: '迟到语音不得覆盖已修改的正文',
      voice: 'mimo_default', tone: 'normal', messageId: racingSource.body.id
    }).then(result => result);
    await providerCalled;
    const sourceAtProviderCall = await fs.readFile(ownerDbPath);
    const simultaneousAlias = await request.post('/api/tts/synthesize').set('Cookie', cookies).send({
      clientRequestId: crypto.randomUUID(), text: '迟到语音不得覆盖已修改的正文',
      voice: 'mimo_default', tone: 'normal', messageId: racingSource.body.id
    });
    assert.equal(simultaneousAlias.status, 202);
    assert.equal(simultaneousAlias.body.requestId, racingId);
    const editDuringCall = await request.put(`/api/messages/${racingSource.body.id}`).set('Cookie', cookies)
      .send({ content: '调用进行中已修订的正文' });
    assert.equal(editDuringCall.status, 200);
    const sourceAfterConcurrentEdit = await fs.readFile(ownerDbPath);
    await fs.writeFile(ownerDbPath, sourceAtProviderCall);
    clearUserDbCache(owner.body.user.id);
    releaseProviderCall();
    const staleSynthesis = await racingRequest;
    axios.post = mockProvider;
    assert.equal(staleSynthesis.status, 202);
    assert.equal(staleSynthesis.body.status, 'unknown');
    const afterLateReceipt = await getUserDb(owner.body.user.id);
    await afterLateReceipt.read();
    assert.ok(!afterLateReceipt.data.ttsAudioFiles.some(audio => audio.messageId === racingSource.body.id));
    assert.equal(afterLateReceipt.data.ttsEffects.find(effect => effect.id === racingId)?.status, 'unknown');
    await fs.writeFile(ownerDbPath, sourceAfterConcurrentEdit);
    clearUserDbCache(owner.body.user.id);
    ownerDb = await getUserDb(owner.body.user.id);
    await ownerDb.read();
    assert.ok(!ownerDb.data.ttsAudioFiles.some(audio => audio.messageId === racingSource.body.id));
    assert.deepEqual((await fs.readdir(path.join(process.env.DATA_DIR, 'tts'))).sort(), filesBeforeRace);
    const deletedDuringCall = await request.post(`/api/groups/${groupId}/messages`).set('Cookie', cookies)
      .send({ content: '合成途中被删除的消息' });
    assert.equal(deletedDuringCall.status, 201);
    let announceDeleteCall;
    let releaseDeleteCall;
    const deleteProviderCalled = new Promise(resolve => { announceDeleteCall = resolve; });
    const deleteProviderGate = new Promise(resolve => { releaseDeleteCall = resolve; });
    axios.post = async (...args) => {
      announceDeleteCall();
      await deleteProviderGate;
      return mockProvider(...args);
    };
    const filesBeforeDeleteRace = (await fs.readdir(path.join(process.env.DATA_DIR, 'tts'))).sort();
    const deletedSourceRequest = request.post('/api/tts/synthesize').set('Cookie', cookies).send({
      clientRequestId: crypto.randomUUID(), text: '删除后迟到语音不能复活消息',
      voice: 'mimo_default', tone: 'normal', messageId: deletedDuringCall.body.id
    }).then(result => result);
    await deleteProviderCalled;
    assert.equal((await request.delete(`/api/messages/${deletedDuringCall.body.id}`)
      .set('Cookie', cookies)).status, 200);
    releaseDeleteCall();
    assert.equal((await deletedSourceRequest).status, 202);
    axios.post = mockProvider;
    await ownerDb.read();
    assert.ok(!ownerDb.data.messages.some(message => message.id === deletedDuringCall.body.id));
    assert.ok(!ownerDb.data.ttsAudioFiles.some(audio => audio.messageId === deletedDuringCall.body.id));
    assert.deepEqual((await fs.readdir(path.join(process.env.DATA_DIR, 'tts'))).sort(), filesBeforeDeleteRace);
    const ambiguousMessage = await request.post(`/api/groups/${groupId}/messages`).set('Cookie', cookies)
      .send({ content: '数据库已提交但回执丢失' });
    assert.equal(ambiguousMessage.status, 201);
    const ambiguousId = crypto.randomUUID();
    const originalWrite = ownerDb.write.bind(ownerDb);
    const filesBeforeAmbiguous = (await fs.readdir(path.join(process.env.DATA_DIR, 'tts'))).sort();
    ownerDb.write = async function () {
      await originalWrite();
      if (this.data.ttsEffects?.some(effect => effect.id === ambiguousId && effect.status === 'succeeded')) {
        this.write = originalWrite;
        throw new Error('simulated lost storage acknowledgement after commit');
      }
    };
    let ambiguousResponse;
    try {
      ambiguousResponse = await request.post('/api/tts/synthesize').set('Cookie', cookies).send({
        clientRequestId: ambiguousId, text: '回执丢失不能呈现为成功',
        voice: 'mimo_default', tone: 'normal', messageId: ambiguousMessage.body.id
      });
    } finally {
      ownerDb.write = originalWrite;
    }
    ownerDb = await getUserDb(owner.body.user.id);
    assert.equal(ambiguousResponse.status, 202);
    assert.equal(ambiguousResponse.body.status, 'unknown');
    const ambiguousEffect = await request.get(`/api/tts/effects/${ambiguousId}`).set('Cookie', cookies);
    assert.equal(ambiguousEffect.body.status, 'unknown');
    assert.equal(ambiguousEffect.body.response, null);
    assert.equal((await request.get(`/api/tts/messages/${ambiguousMessage.body.id}`)
      .set('Cookie', cookies)).status, 404);
    await ownerDb.read();
    assert.ok(!ownerDb.data.ttsAudioFiles.some(audio => audio.messageId === ambiguousMessage.body.id));
    assert.equal(await drainTtsPendingDeletes(owner.body.user.id), 0);
    assert.deepEqual((await fs.readdir(path.join(process.env.DATA_DIR, 'tts'))).sort(), filesBeforeAmbiguous);
    const deletedAudio = await request.delete(`/api/tts/messages/${messageId}`).set('Cookie', cookies);
    assert.equal(deletedAudio.status, 200);
    assert.equal(deletedAudio.body.fileDeletionPending, false);
    assert.equal((await request.get(ttsResponse.body.audio_url).set('Cookie', cookies)).status, 404);
    assert.equal((await request.get(`/api/tts/effects/${synthesisId}`).set('Cookie', cookies)).body.status, 'deleted');
    assert.equal((await request.post('/api/tts/synthesize').set('Cookie', cookies).send({
      clientRequestId: synthesisId, text: '你好，这是一段可搜索的测试语音内容。',
      voice: 'mimo_default', tone: 'normal', messageId
    })).status, 410);
    await assert.rejects(fs.access(path.join(process.env.DATA_DIR, 'tts',
      path.basename(ttsResponse.body.audio_url))), { code: 'ENOENT' });

    const secondMessage = await request.post(`/api/groups/${groupId}/messages`).set('Cookie', cookies)
      .send({ content: '删除消息也应删除关联音频' });
    assert.equal(secondMessage.status, 201);
    const secondAudio = await request.post('/api/tts/synthesize').set('Cookie', cookies).send({
      clientRequestId: crypto.randomUUID(),
      text: '删除消息后的音频不可继续访问', voice: 'mimo_default', tone: 'normal', messageId: secondMessage.body.id
    });
    assert.equal(secondAudio.status, 200);
    const secondAudioPath = path.join(process.env.DATA_DIR, 'tts', path.basename(secondAudio.body.audio_url));
    const secondBeforeDelete = await fs.readFile(ownerDbPath);
    const secondAudioBytes = await fs.readFile(secondAudioPath);
    const messageDelete = await request.delete(`/api/messages/${secondMessage.body.id}`).set('Cookie', cookies);
    assert.equal(messageDelete.status, 200);
    assert.equal(messageDelete.body.audioDeletionPending, false);
    assert.equal((await request.get(secondAudio.body.audio_url).set('Cookie', cookies)).status, 404);
    await assert.rejects(fs.access(path.join(process.env.DATA_DIR, 'tts',
      path.basename(secondAudio.body.audio_url))), { code: 'ENOENT' });
    const secondAfterDelete = await fs.readFile(ownerDbPath);
    await fs.writeFile(ownerDbPath, secondBeforeDelete);
    await fs.writeFile(secondAudioPath, secondAudioBytes);
    clearUserDbCache(owner.body.user.id);
    try {
      assert.equal((await request.get(secondAudio.body.audio_url).set('Cookie', cookies)).status, 404);
      assert.equal((await request.get(`/api/tts/messages/${secondMessage.body.id}`)
        .set('Cookie', cookies)).status, 404);
      const oldReceipt = await request.get(`/api/tts/effects/${secondAudio.body.requestId}`)
        .set('Cookie', cookies);
      assert.equal(oldReceipt.body.status, 'deleted');
      assert.equal(oldReceipt.body.response, null);
    } finally {
      await fs.writeFile(ownerDbPath, secondAfterDelete);
      await fs.unlink(secondAudioPath).catch(() => {});
      clearUserDbCache(owner.body.user.id);
      ownerDb = await getUserDb(owner.body.user.id);
    }

    const batchIds = [];
    const batchUrls = [];
    for (const content of ['批量删除甲', '批量删除乙']) {
      const sent = await request.post(`/api/groups/${groupId}/messages`).set('Cookie', cookies).send({ content });
      assert.equal(sent.status, 201);
      const spoken = await request.post('/api/tts/synthesize').set('Cookie', cookies).send({
        clientRequestId: crypto.randomUUID(),
        text: content, voice: 'mimo_default', tone: 'normal', messageId: sent.body.id
      });
      assert.equal(spoken.status, 200);
      batchIds.push(sent.body.id);
      batchUrls.push(spoken.body.audio_url);
    }
    const batchDelete = await request.post('/api/messages/batch-delete').set('Cookie', cookies)
      .send({ message_ids: batchIds, group_id: groupId });
    assert.equal(batchDelete.status, 200);
    assert.equal(batchDelete.body.audioDeletionPending, false);
    for (const audioUrl of batchUrls) {
      assert.equal((await request.get(audioUrl).set('Cookie', cookies)).status, 404);
      await assert.rejects(fs.access(path.join(process.env.DATA_DIR, 'tts', path.basename(audioUrl))), { code: 'ENOENT' });
    }

    const groupMessage = await request.post(`/api/groups/${groupId}/messages`).set('Cookie', cookies)
      .send({ content: '删除会话应清理音频' });
    assert.equal(groupMessage.status, 201);
    const groupAudio = await request.post('/api/tts/synthesize').set('Cookie', cookies).send({
      clientRequestId: crypto.randomUUID(),
      text: '删除会话后的音频不可读取', voice: 'mimo_default', tone: 'normal', messageId: groupMessage.body.id
    });
    assert.equal(groupAudio.status, 200);
    const groupDelete = await request.delete(`/api/groups/${groupId}`).set('Cookie', cookies);
    assert.equal(groupDelete.status, 200);
    assert.equal(groupDelete.body.audioDeletionPending, false);
    assert.equal((await request.get(groupAudio.body.audio_url).set('Cookie', cookies)).status, 404);
    await assert.rejects(fs.access(path.join(process.env.DATA_DIR, 'tts',
      path.basename(groupAudio.body.audio_url))), { code: 'ENOENT' });

    const recoveryName = 'tts_pending_recovery.wav';
    await fs.writeFile(path.join(process.env.DATA_DIR, 'tts', recoveryName), testWav());
    await withWriteLock(owner.body.user.id, async () => {
      await ownerDb.read();
      ownerDb.data.ttsPendingDeletes ||= [];
      ownerDb.data.ttsPendingDeletes.push(recoveryName);
      await ownerDb.write();
    });
    assert.equal(await drainTtsPendingDeletes(owner.body.user.id), 0);
    await assert.rejects(fs.access(path.join(process.env.DATA_DIR, 'tts', recoveryName)), { code: 'ENOENT' });

    let uncertainCalls = 0;
    axios.post = async () => {
      uncertainCalls += 1;
      throw Object.assign(new Error('timeout after dispatch'), { code: 'ECONNABORTED' });
    };
    const uncertainId = crypto.randomUUID();
    const uncertain = await request.post('/api/tts/synthesize').set('Cookie', cookies).send({
      clientRequestId: uncertainId,
      text: '超时不允许自动重试可能已经计费的请求', voice: 'mimo_default', tone: 'normal'
    });
    assert.equal(uncertain.status, 202);
    assert.equal(uncertain.body.status, 'unknown');
    assert.equal(uncertainCalls, 1);
    const unknownReplay = await request.post('/api/tts/synthesize').set('Cookie', cookies).send({
      clientRequestId: uncertainId,
      text: '超时不允许自动重试可能已经计费的请求', voice: 'mimo_default', tone: 'normal'
    });
    assert.equal(unknownReplay.status, 202);
    assert.equal(uncertainCalls, 1);
    const reopenedModal = await request.post('/api/tts/synthesize').set('Cookie', cookies).send({
      clientRequestId: crypto.randomUUID(),
      text: '超时不允许自动重试可能已经计费的请求', voice: 'mimo_default', tone: 'normal'
    });
    assert.equal(reopenedModal.status, 202);
    assert.equal(reopenedModal.body.requestId, uncertainId);
    assert.equal(uncertainCalls, 1);
    assert.equal((await request.get(`/api/tts/effects/${uncertainId}`).set('Cookie', cookies)).body.status, 'unknown');
    const savedEffects = JSON.parse(await fs.readFile(path.join(process.env.DATA_DIR, 'users',
      `db_${owner.body.user.id}.json`), 'utf8'));
    assert.ok(savedEffects.ttsEffects.some(effect => effect.id === uncertainId && effect.status === 'unknown'));

    const testedCatalog = (await request.get('/api/user/model-catalog').set('Cookie', cookies)).body;
    assert.ok(testedCatalog.models.find(model => model.id === 'mimo_tts').verifiedCapabilities.includes('tts'));
    testedCatalog.models.find(model => model.id === 'mimo_tts').ttsMode = 'speech';
    const changed = await request.put('/api/user/model-catalog').set('Cookie', cookies).send(testedCatalog);
    assert.equal(changed.status, 200);
    assert.ok(!changed.body.models.find(model => model.id === 'mimo_tts').verifiedCapabilities.includes('tts'));
    const disabledModelReplay = await request.post('/api/tts/synthesize').set('Cookie', cookies).send({
      clientRequestId: crypto.randomUUID(),
      text: '超时不允许自动重试可能已经计费的请求', voice: 'mimo_default', tone: 'normal'
    });
    assert.equal(disabledModelReplay.status, 202);
    assert.equal(disabledModelReplay.body.requestId, uncertainId);
    assert.equal(uncertainCalls, 1);
    assert.equal((await request.post('/api/tts/synthesize').set('Cookie', cookies).send({
      clientRequestId: crypto.randomUUID(),
      text: '语音协议变更后必须重新验证', voice: 'mimo_default', tone: 'normal'
    })).status, 409);
  } finally {
    axios.post = originalAxiosPost;
  }
});
