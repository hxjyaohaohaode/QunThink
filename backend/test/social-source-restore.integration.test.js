import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'session';
process.env.DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'qunthink-social-source-'));
process.env.AUTH_DB_PATH = path.join(process.env.DATA_DIR, 'auth.json');

const express = (await import('express')).default;
const cookieParser = (await import('cookie-parser')).default;
const supertest = (await import('supertest')).default;
const { initDatabase, getUserDb, clearUserDbCache } = await import('../src/models/db.js');
const { initAuthDb } = await import('../src/models/authDb.js');
const { default: authRouter } = await import('../src/routes/auth.js');
const { default: groupsRouter } = await import('../src/routes/groups.js');
const { default: messagesRouter } = await import('../src/routes/messages.js');
const { default: socialRouter } = await import('../src/routes/social.js');
const { default: authMiddleware } = await import('../src/middleware/auth.js');
const { injectUserDb } = await import('../src/middleware/userDb.js');
const { errorHandler } = await import('../src/middleware/errorHandler.js');
const socialService = (await import('../src/services/social/index.js')).default;

await initDatabase();
await initAuthDb();
const app = express();
app.use(cookieParser());
app.use(express.json());
app.use('/api', authRouter);
app.use(authMiddleware);
app.use(injectUserDb);
app.use('/api', groupsRouter);
app.use('/api', messagesRouter);
app.use('/api', socialRouter);
app.use(errorHandler);
const request = supertest(app);

async function account(label) {
  const name = `${label}_${Math.random().toString(36).slice(2)}`;
  const registered = await request.post('/api/auth/register').send({
    username: name, password: 'Passw0rd123', nickname: label
  });
  assert.equal(registered.status, 201, JSON.stringify(registered.body));
  const cookie = registered.headers['set-cookie'];
  const groups = await request.get('/api/groups').set('Cookie', cookie);
  assert.equal(groups.status, 200);
  return { userId: registered.body.user.id, cookie, groupId: groups.body[0].id };
}

const call = (method, url, owner, body) => {
  const operation = request[method](url).set('Cookie', owner.cookie);
  return body === undefined ? operation : operation.send(body);
};

test('social reads and mutations exclude a source revoked after old local JSON restore', async () => {
  const owner = await account('social_restore');
  const sent = await call('post', `/api/groups/${owner.groupId}/messages`, owner,
    { content: '这是一条恢复后不得重新显示的讨论原文' });
  assert.equal(sent.status, 201);
  const messageId = sent.body.id;
  const commented = await call('post', '/api/comments', owner,
    { message_id: messageId, content: '旧评论内容' });
  assert.equal(commented.status, 201);
  const file = path.join(process.env.DATA_DIR, 'users', `db_${owner.userId}.json`);
  const oldSnapshot = await fs.readFile(file);

  const before = await call('get', `/api/social/comments/tree?messageId=${messageId}`, owner);
  assert.equal(before.status, 200);
  assert.equal(before.body.totalComments, 1);
  const analyzedBefore = await call('post', '/api/social/comments/analyze', owner,
    { comment: { content: '对现有消息的评论' }, targetMessage: { id: messageId, content: '伪造内容' },
      messageContext: [], commentThread: [] });
  assert.equal(analyzedBefore.status, 200);
  assert.equal(analyzedBefore.body.analysis.targetMessageId, messageId);
  const suggestionBefore = await call('get',
    `/api/social/comments/suggestions?messageId=${messageId}&parentCommentId=${commented.body.comment.id}`, owner);
  assert.equal(suggestionBefore.status, 200);
  assert.ok(suggestionBefore.body.suggestions.length > 0);
  const wrongParent = await call('get',
    `/api/social/comments/suggestions?messageId=${messageId}&parentCommentId=other-comment`, owner);
  assert.equal(wrongParent.status, 404);
  const forgedThread = await call('post', '/api/social/comments/analyze', owner,
    { comment: { content: '无权评论链' }, targetMessage: { id: messageId },
      commentThread: [{ id: 'other-comment', content: '伪造上下文' }] });
  assert.equal(forgedThread.status, 404);
  const deleted = await call('delete', `/api/messages/${messageId}`, owner);
  assert.equal(deleted.status, 200);
  await fs.writeFile(file, oldSnapshot);
  clearUserDbCache(owner.userId);

  const endpoints = [
    ['get', `/api/social/comments/tree?messageId=${messageId}`],
    ['get', `/api/social/comments/suggestions?messageId=${messageId}`],
    ['post', '/api/social/comments/analyze', { comment: { content: '后续评论' },
      targetMessage: { id: messageId, content: '伪造内容' }, commentThread: [] }],
    ['post', '/api/social/evaluate-like', { message: { id: messageId, content: '伪造的旧原文' }, contextMessages: [], senderInfo: {} }],
    ['post', '/api/social/auto-like', { messageId, groupId: owner.groupId }],
    ['post', '/api/social/batch-evaluate', { groupId: owner.groupId, messages: [{ id: messageId }] }]
  ];
  for (const [method, url, body] of endpoints) {
    const result = await call(method, url, owner, body);
    assert.equal(result.status, 404, `${method} ${url}: ${JSON.stringify(result.body)}`);
    assert.doesNotMatch(JSON.stringify(result.body), /旧评论内容|讨论原文/);
  }
  const top = await call('get', '/api/social/top-messages', owner);
  assert.equal(top.status, 200);
  assert.deepEqual(top.body.messages, []);
  const stats = await call('get', '/api/social/stats', owner);
  assert.equal(stats.status, 200);
  assert.equal(stats.body.stats.totalInteractions, 0);
  const participants = await call('get', '/api/social/active-participants', owner);
  assert.deepEqual(participants.body.participants, []);
  const config = await call('get', '/api/social/smart-like-config', owner);
  assert.equal(config.body.engineStats.available, false);
  assert.deepEqual(config.body.engineStats.recentActivity, []);
  assert.deepEqual(await fs.readFile(file), oldSnapshot, 'rejected auto-like must not mutate restored source');
});

test('social metrics use current account data, not process singleton or caller-supplied message content', async () => {
  const a = await account('social_a');
  const b = await account('social_b');
  const sentA = await call('post', `/api/groups/${a.groupId}/messages`, a,
    { content: '甲账号当前可读内容' });
  const sentB = await call('post', `/api/groups/${b.groupId}/messages`, b,
    { content: '乙账号秘密内容需要保持账号隔离' });
  assert.equal(sentA.status, 201); assert.equal(sentB.status, 201);
  socialService.analyzeMessage({ ...sentB.body, content: '乙账号秘密内容' }, { recentMessages: [] });

  const top = await call('get', '/api/social/top-messages', a);
  assert.equal(top.status, 200);
  assert.deepEqual(top.body.messages.map(item => item.messageId), [sentA.body.id]);
  assert.doesNotMatch(JSON.stringify(top.body), /乙账号秘密内容/);
  const participants = await call('get', '/api/social/active-participants', a);
  assert.equal(participants.status, 200);
  assert.equal(participants.body.participants.some(item => item.id === b.userId), false);
  const stats = await call('get', '/api/social/stats', a);
  assert.equal(stats.body.stats.totalInteractions, 1);

  const alien = await call('post', '/api/social/batch-evaluate', a,
    { groupId: a.groupId, messages: [{ id: sentB.body.id, content: 'spoofed' }] });
  assert.equal(alien.status, 404);
  const current = await call('post', '/api/social/batch-evaluate', a,
    { groupId: a.groupId, messages: [{ id: sentA.body.id, content: 'spoofed' }] });
  assert.equal(current.status, 200);
  assert.deepEqual(current.body.evaluations.map(item => item.messageId), [sentA.body.id]);
  const config = await call('get', '/api/social/smart-like-config', a);
  assert.doesNotMatch(JSON.stringify(config.body), new RegExp(sentB.body.id));
  const updated = await call('put', '/api/social/smart-like-config', a,
    { config: { threshold: 0 } });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.newConfig.threshold, 0);
  assert.equal((await call('get', '/api/social/smart-like-config', a)).body.config.threshold, 0);
  assert.equal((await call('get', '/api/social/smart-like-config', b)).body.config.threshold, 0.55);
  assert.equal((await call('get', '/api/social/stats', a)).body.stats.smartLikeStats.threshold, 0);
  assert.equal((await call('get', '/api/social/stats', b)).body.stats.smartLikeStats.threshold, 0.55);

  const crossLike = await call('post', '/api/social/auto-like', a,
    { groupId: a.groupId, messageId: sentB.body.id });
  assert.equal(crossLike.status, 404);
  const liked = await call('post', '/api/social/auto-like', a,
    { groupId: a.groupId, messageId: sentA.body.id });
  assert.equal(liked.status, 200);
  assert.equal(liked.body.liked, true);
  const repeated = await call('post', '/api/social/auto-like', a,
    { groupId: a.groupId, messageId: sentA.body.id });
  assert.equal(repeated.status, 200);
  assert.equal(repeated.body.liked, false);
  assert.equal(repeated.body.likeCount, 1);
  const persistedA = await call('get', `/api/groups/${a.groupId}/messages`, a);
  assert.deepEqual(persistedA.body.messages.find(message => message.id === sentA.body.id).likes,
    ['system_auto_like']);

  assert.equal((await call('put', '/api/social/smart-like-config', b,
    { config: { threshold: 0 } })).status, 200);
  const bDb = await getUserDb(b.userId);
  const originalWrite = bDb.write.bind(bDb);
  bDb.write = async () => { throw new Error('injected social write failure'); };
  try {
    const failed = await call('post', '/api/social/auto-like', b,
      { groupId: b.groupId, messageId: sentB.body.id });
    assert.equal(failed.status, 503, JSON.stringify(failed.body));
    assert.equal(failed.body.code, 'SOCIAL_WRITE_UNCERTAIN');
  } finally {
    bDb.write = originalWrite;
  }
  const persistedB = await call('get', `/api/groups/${b.groupId}/messages`, b);
  assert.equal(persistedB.status, 200);
  assert.equal(persistedB.body.messages.find(message => message.id === sentB.body.id).likes?.length || 0, 0);
});
