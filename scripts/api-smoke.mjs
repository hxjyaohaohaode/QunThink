/**
 * API 全矩阵冒烟探针
 * 用法: node scripts/api-smoke.mjs [baseUrl] [devUserId]
 * 覆盖：全部只读端点 + 群组/消息/文件完整生命周期写操作 + 错误路径
 */
const BASE = process.argv[2] || 'http://localhost:3102';
const UID = process.argv[3] || 'dev_user_default';
const H = { 'x-user-id': UID, 'Content-Type': 'application/json', Origin: 'http://localhost:3010' };

const results = [];
let createdGroupId = null;
let createdMessageId = null;
let uploadedFileId = null;

async function req(method, path, body, extraHeaders = {}, expectStatus = null) {
  const url = `${BASE}${path}`;
  try {
    const res = await fetch(url, {
      method,
      headers: { ...H, ...extraHeaders },
      body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined
    });
    let json = null;
    const text = await res.text();
    try { json = JSON.parse(text); } catch { json = text.slice(0, 120); }
    const ok = expectStatus ? res.status === expectStatus : res.status < 500;
    results.push({ method, path, status: res.status, ok, expectStatus });
    return { status: res.status, json };
  } catch (err) {
    results.push({ method, path, status: 'ERR', ok: false, error: err.message });
    return { status: 0, json: null };
  }
}

function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail });
}

// ---------- 只读端点全扫描 ----------
const getEndpoints = [
  '/api/health',
  '/api/csrf-token',
  '/api/bootstrap',
  '/api/groups',
  '/api/ai-private-chats',
  '/api/user/apiconfig',
  '/api/profile',
  '/api/personas',
  '/api/agents',
  '/api/memory/list',
  '/api/social/top-messages?limit=5',
  '/api/interaction/logs',
  '/api/interaction/stats',
  '/api/interaction/participation?groupId=group-presidential',
  '/api/interaction/quality',
  '/api/interaction/status',
  '/api/monitoring/metrics',
  '/api/tts/voices',
  '/api/search?q=%E6%B5%8B%E8%AF%95'
];

// ---------- 执行 ----------
await req('GET', getEndpoints[0]);
for (const ep of getEndpoints.slice(1)) {
  await req('GET', ep);
}

// 认证状态
await req('GET', '/api/auth/token');
await req('GET', '/api/auth/me');

// ---------- 群组生命周期 ----------
{
  const { status, json } = await req('POST', '/api/groups', {
    name: `smoke_${Date.now()}`,
    description: 'API smoke test group',
    is_private: false,
    ai_members: ['deepseek', 'qwen_flash']
  }, {}, 201);
  if (json && json.id) {
    createdGroupId = json.id;
    check('group.created_has_id', true);
    check('group.preview_null_on_create', json.last_message_preview === null || json.last_message_preview === undefined, String(json.last_message_preview).slice(0, 30));
  } else {
    check('group.created_has_id', false, `status=${status}`);
  }

  if (createdGroupId) {
    // 无效成员校验
    await req('POST', '/api/groups', { name: 'bad', is_private: false, ai_members: ['not_an_ai', 'deepseek'] }, {}, 400);

    // 发送消息
    const sent = await req('POST', `/api/groups/${createdGroupId}/messages`, {
      content: '你好，这是 API 探针测试消息',
      sender_type: 'user'
    }, {}, 201);
    if (sent.json && (sent.json.message?.id || sent.json.id)) {
      createdMessageId = sent.json.message?.id || sent.json.id;
    }
    check('message.sent', Boolean(createdMessageId));

    // 拉取消息（limit 合法值）
    const list = await req('GET', `/api/groups/${createdGroupId}/messages?limit=20`);
    check('messages.list_array', Array.isArray(list.json?.messages || list.json));
    const arr = Array.isArray(list.json?.messages) ? list.json.messages : (Array.isArray(list.json) ? list.json : []);
    check('messages.decrypt_ok', arr.length > 0 && typeof arr[0].content === 'string');

    // limit=NaN 防御（应回退默认而非返回异常）
    await req('GET', `/api/groups/${createdGroupId}/messages?limit=abc`);

    // 点赞 / 评论
    if (createdMessageId) {
      await req('POST', `/api/messages/${createdMessageId}/like`, {});
      const cm = await req('POST', '/api/comments', {
        message_id: createdMessageId,
        content: '探针评论'
      });
      check('comment.created', cm.status === 200 || cm.status === 201, `status=${cm.status}`);

      // 已读回执
      await req('POST', `/api/groups/${createdGroupId}/read`, { messageIds: [createdMessageId] });
    }

    // 成员管理（无效 aiId 应 400）
    await req('POST', `/api/groups/${createdGroupId}/members`, { aiId: 'hacker_ai' }, {}, 400);
    await req('POST', `/api/groups/${createdGroupId}/members`, { aiId: 'glm_flash' });

    // settings 校验（background_url 注入应被拒）
    await req('PUT', `/api/groups/${createdGroupId}/settings`, { background_url: 'javascript:alert(1)' }, {}, 400);
    await req('PUT', `/api/groups/${createdGroupId}/pin`, { pinned: true });

    // 辩论状态（归属校验路径）
    await req('GET', `/api/groups/${createdGroupId}/formal-debate/status`);
    await req('GET', '/api/groups/nonexistent-group-xyz/formal-debate/status', undefined, {}, 404);

    // 文件上传 → 列表 → 删除
    const boundary = '----probe' + Date.now();
    const fileContent = 'API probe attachment content 测试附件内容';
    const multipart = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="group_id"',
      '',
      createdGroupId,
      `--${boundary}`,
      'Content-Disposition: form-data; name="files"; filename="probe.txt"',
      'Content-Type: text/plain',
      '',
      fileContent,
      `--${boundary}--`
    ].join('\r\n');
    const up = await fetch(`${BASE}/api/files/upload`, {
      method: 'POST',
      headers: { ...H, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body: multipart
    });
    const upJson = await up.json().catch(() => null);
    uploadedFileId = upJson?.file?.id || upJson?.files?.[0]?.id || null;
    check('file.uploaded', up.status < 400 && Boolean(uploadedFileId), `status=${up.status}`);
    check('file.response_no_server_path', upJson ? !JSON.stringify(upJson).includes('original_path') : false);
    check('file.url_signed', upJson?.file?.url ? upJson.file.url.includes('token=') : false, String(upJson?.file?.url || '').slice(0, 60));

    await req('GET', `/api/groups/${createdGroupId}/files`);
    if (uploadedFileId) {
      const dl = await fetch(`${BASE}${upJson.file.url.startsWith('/api') ? upJson.file.url : '/api/files/' + uploadedFileId + '/download?group_id=' + createdGroupId}`);
      check('file.download_200_or_403', dl.status === 200 || dl.status === 403, `status=${dl.status}`);
      await req('DELETE', `/api/files/${uploadedFileId}?group_id=${createdGroupId}`);
    }

    // 删除群组（应同时清理引擎）
    await req('DELETE', `/api/groups/${createdGroupId}`, undefined, {}, 200);
    await req('GET', `/api/groups/${createdGroupId}`, undefined, {}, 404);
  }
}

// ---------- 私聊获取或创建（幂等）----------
{
  const r1 = await req('POST', '/api/private-chat/deepseek');
  const r2 = await req('POST', '/api/private-chat/deepseek');
  check('private_chat_idempotent', r1.json?.id && r2.json?.id === r1.json.id, `${r1.status}/${r2.status}`);
  // 无效 aiId 拒绝
  await req('POST', '/api/private-chat/not_an_ai', undefined, {}, 400);
}

// ---------- apiconfig 写语义 ----------
{
  const save = await req('PUT', '/api/user/apiconfig', {
    deepseek: { apiKey: '' },
    zhipu: { baseUrl: '' }
  });
  check('apiconfig.save_empty_keeps', save.status === 200 && save.json?.success === true, `status=${save.status}`);
  check('apiconfig.no_plaintext_key', !JSON.stringify(save.json).match(/sk-[A-Za-z0-9]{10,}/), '');
}

// ---------- profile 校验 ----------
{
  await req('PUT', '/api/profile', { nickname: '探针用户', age: 25, hobbies: ['测试'] });
  const badAge = await req('PUT', '/api/profile', { age: 'not_a_number' }, {}, 400);
  check('profile.rejects_bad_types', badAge.status === 400, `status=${badAge.status}`);
  const badKey = await req('PUT', '/api/profile', { hacker_field: 'x' }, {}, 400);
  check('profile.rejects_unknown_keys', badKey.status === 400, `status=${badKey.status}`);
}

// ---------- personas 校验（补充：非法值应被拒或忽略）----------
{
  await req('PATCH', '/api/personas/deepseek', { temperature: 'hot' });
}

// ---------- interaction 自定义事件 ----------
{
  const log = await req('POST', '/api/interaction/log', {
    type: 'custom', participantType: 'user', participantId: 'probe', content: '探针事件'
  });
  check('interaction.log_ok', log.status === 200 && log.json?.success === true, `status=${log.status}`);
  await req('POST', '/api/interaction/log', { type: 'evil_type', participantType: 'user', participantId: 'x' }, {}, 400);
}

// ---------- personas 校验 ----------
{
  await req('PATCH', '/api/personas/not_an_ai', { temperature: 99 }, {}, 404);
  await req('PATCH', '/api/personas/deepseek', { temperature: 0.5 });
}

// ---------- 监控上报分桶 ----------
await req('POST', '/api/monitoring/errors', { message: 'probe error', stack: '', url: '/test' });
await req('GET', '/api/monitoring/client-errors');

// ---------- TTS voices + 配额错误路径（不实际合成，避免外部调用）----------
await req('GET', '/api/tts/messages?limit=5').catch(() => {});

// ---------- WebSocket 握手 ----------
{
  const wsOk = await new Promise((resolve) => {
    const wsModulePath = new URL('../backend/node_modules/ws/index.js', import.meta.url).href;
    import(wsModulePath).then(({ default: WebSocket }) => {
      try {
        const ws = new WebSocket(BASE.replace('http', 'ws') + '/ws?userId=' + UID, {
          headers: { 'x-user-id': UID, Origin: 'http://localhost:3010' }
        });
        const timer = setTimeout(() => { try { ws.terminate(); } catch {} resolve(false); }, 4000);
        let sawExpected = false;
        ws.on('open', () => {
          ws.send(JSON.stringify({ type: 'join_group', group_id: 'group-presidential' }));
          ws.send(JSON.stringify({ type: 'ping' }));
        });
        ws.on('message', (raw) => {
          try {
            const msg = JSON.parse(raw.toString());
            if (msg.type === 'pong' || msg.type === 'joined_group') {
              if (!sawExpected) {
                sawExpected = true;
                // typing 越权探测：不应导致连接崩溃
                ws.send(JSON.stringify({ type: 'typing', group_id: 'someone-elses-group', ai: 'deepseek', status: 'start' }));
                setTimeout(() => { try { ws.close(); } catch {} clearTimeout(timer); resolve(true); }, 500);
              }
            }
          } catch {}
        });
        ws.on('error', () => { clearTimeout(timer); resolve(false); });
      } catch { resolve(false); }
    }).catch((e) => { console.error('ws import failed:', e.message); resolve(false); });
  });
  check('websocket.handshake_and_join', wsOk);
}

// ---------- 洞察与记忆摘要（v2 新功能）----------
{
  const g = await req('POST', '/api/groups', {
    name: `insight_probe_${Date.now()}`,
    is_private: false,
    ai_members: ['deepseek', 'qwen_flash']
  }, {}, 201);
  if (g.json?.id) {
    await req('POST', `/api/groups/${g.json.id}/messages`, { content: '洞察探针消息' }, {}, 201);
    const ins = await req('GET', `/api/groups/${g.json.id}/insights?days=7`);
    check('insights.shape_ok',
      ins.status === 200 && ins.json?.totals && Array.isArray(ins.json?.activity_daily) && ins.json.activity_daily.length === 7,
      `status=${ins.status}`);
    check('insights.counts_live',
      ins.json?.totals?.messages >= 1 && ins.json?.activity_daily?.[6]?.count >= 1,
      JSON.stringify(ins.json?.totals || {}));
    const ins30 = await req('GET', `/api/groups/${g.json.id}/insights?days=30`);
    check('insights.days30_buckets', ins30.status === 200 && ins30.json?.activity_daily?.length === 30);
    await req('DELETE', `/api/groups/${g.json.id}`);
  }
  const dg = await req('GET', '/api/memory/digest?limit=5');
  check('digest.shape_ok', dg.status === 200 && typeof dg.json?.total === 'number' && Array.isArray(dg.json?.memories), `status=${dg.status}`);
}

// ---------- 汇总 ----------
const failures = results.filter(r => r.ok === false);
console.log('\n========== SMOKE SUMMARY ==========');
const endpointChecks = results.filter(r => r.method);
const passCount = endpointChecks.filter(r => r.ok).length;
console.log(`endpoint probes: ${passCount}/${endpointChecks.length} non-5xx-or-as-expected`);
const namedChecks = results.filter(r => r.name);
for (const c of namedChecks) {
  console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}${c.detail ? ' | ' + c.detail : ''}`);
}
if (failures.length) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log(JSON.stringify(f));
}
const allNamedPass = namedChecks.every(c => c.ok);
console.log(`\n${allNamedPass ? 'ALL CHECKS PASSED' : 'SOME CHECKS FAILED'}`);
process.exit(allNamedPass ? 0 : 1);
