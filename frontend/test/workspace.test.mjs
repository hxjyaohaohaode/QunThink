import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { build } from 'esbuild';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const window = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, { window, localStorage: window.localStorage, document: window.document, HTMLElement: window.HTMLElement, Node: window.Node, Element: window.Element, requestAnimationFrame: fn => setTimeout(fn, 0), IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
window.HTMLElement.prototype.scrollIntoView = () => {};
class Channel { port1 = { onmessage: null }; port2 = { postMessage: () => setTimeout(() => this.port1.onmessage?.(), 0) }; }
Object.defineProperty(globalThis, 'MessageChannel', { value: Channel, configurable: true });
after(() => window.close());
globalThis.__workspaceTest = { tasks: [], writes: [], post: async () => ({ data: {} }), user: 'alice' };
const bundled = await build({ stdin: { contents: `import { createRoot } from 'react-dom/client'; import { act } from 'react'; import { WorkspacePage } from './src/components/Layout/WorkspacePage'; import { ConversationWriting } from './src/components/Writing/ConversationWriting'; import { useTaskResultsStore } from './src/stores/taskResultsStore'; import { useTasksStore } from './src/stores/tasksStore'; export { act, useTasksStore }; export async function mountConversation(element) { useTaskResultsStore.setState({panelGroupId:'group-a',selectedTaskId:null,incomingSourceId:null}); const root=createRoot(element); await act(async()=>root.render(<ConversationWriting groupId="group-a"><div>会话</div></ConversationWriting>)); return root; } export async function mount(element) { const root = createRoot(element); await act(async () => root.render(<WorkspacePage onOpenConversation={() => {}} />)); return root; }`, resolveDir: root, sourcefile: 'test-workspace.tsx', loader: 'tsx' }, bundle: true, format: 'esm', platform: 'browser', jsx: 'automatic', write: false, plugins: [{ name: 'ui-boundaries', setup(build) {
  build.onResolve({ filter: /services\/api$/ }, () => ({ path: 'api', namespace: 'ui-mock' }));
  build.onResolve({ filter: /(?:utils\/|\.\/)cacheUtils$/ }, () => ({ path: 'cache', namespace: 'ui-mock' }));
  build.onResolve({ filter: /(?:^\.\/|stores\/)(modelsStore|groupsStore|profileStore)$/ }, args => ({ path: args.path.split('/').at(-1), namespace: 'ui-mock' }));
  build.onResolve({ filter: /^\.\/(ModelCenter|PersonalGoalsPanel|MemoryCenter)$/ }, args => ({ path: args.path.slice(2), namespace: 'ui-mock' }));
  build.onResolve({ filter: /(?:Writing\/|^\.\/)TaskResultEditor$/ }, () => ({ path: 'TaskResultEditor', namespace: 'ui-mock' }));
  build.onResolve({ filter: /stores\/messagesStore$/ }, () => ({ path: 'messagesStore', namespace: 'ui-mock' }));
  build.onResolve({ filter: /Chat\/MessageContent$/ }, () => ({ path: 'MessageContent', namespace: 'ui-mock' }));
  build.onResolve({ filter: /^\.\.\/Common$/ }, () => ({ path: 'Common', namespace: 'ui-mock' }));
  build.onResolve({ filter: /hooks\/useReducedMotion$/ }, () => ({ path: 'reduced', namespace: 'ui-mock' }));
  build.onResolve({ filter: /^framer-motion$/ }, () => ({ path: 'motion', namespace: 'ui-mock' }));
  build.onLoad({ filter: /.*/, namespace: 'ui-mock' }, ({ path }) => {
    const source = {
      api: `export const getAuthGeneration=()=>0; export const axiosInstance = { get: async (...args) => globalThis.__workspaceTest.get ? globalThis.__workspaceTest.get(...args) : ({data: globalThis.__workspaceTest.tasks}), post: (...args) => globalThis.__workspaceTest.post(...args), patch: async () => ({data:{}}), delete: async () => ({data:{}}) }; export const api = {createGroup: async () => ({id:'group'})};`,
      cache: `export const getCacheUserId = () => globalThis.__workspaceTest.user;`,
      modelsStore: `export const useModelsStore = fn => fn({ catalog: {models: [], defaults:{}} }); export const requestError = e => e.message;`,
      messagesStore: `export const useMessagesStore = fn => fn({messages:{}});`,
      groupsStore: `export const useGroupsStore = fn => fn({ groups: globalThis.__workspaceTest.groups });`,
      profileStore: `export const useProfileStore = fn => fn({profile:{nickname:'测试用户'}});`,
      ModelCenter: `export const ModelCenter = () => <div>模型配置测试页</div>;`,
      PersonalGoalsPanel: `export const PersonalGoalsPanel = () => <div>目标测试页</div>;`,
      MemoryCenter: `export const MemoryCenter = () => <div>记忆测试页</div>;`,
      TaskResultEditor: `export const TaskResultEditor = () => <div>共享正文编辑器</div>;`,
      MessageContent: `export const MessageContent = ({content}) => <div>{content}</div>;`,
      Common: `export const useConfirm = () => ({ confirm: () => globalThis.__workspaceTest.confirm ? new Promise(resolve => { globalThis.__workspaceTest.resolveConfirm = resolve; }) : Promise.resolve(true), ConfirmModal: null });`,
      reduced: `export const useReducedMotion = () => true;`,
      motion: `import {forwardRef} from 'react'; const cache = {}; export const motion = new Proxy({}, {get(_, tag) { return cache[tag] ||= forwardRef(({initial,animate,exit,transition,layout,layoutId,...props},ref) => {const Tag=tag; return <Tag ref={ref} {...props}/>;}); }}); export const AnimatePresence = ({children}) => children;`
    }[path];
    return { contents: source, loader: 'tsx', resolveDir: root };
  });
}}] });
const { mount, mountConversation, act, useTasksStore: store } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
let container, mounted;
const button = text => [...container.querySelectorAll('button')].find(element => element.textContent === text);
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const waitFor = async check => { for (let n=0;n<200&&!check();n++) await new Promise(resolve=>setTimeout(resolve,5)); assert.ok(check(), 'expected request preparation to reach the mock transport'); };
async function type(element, value) { await act(async () => { const proto = element.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(element, value); element.dispatchEvent(new window.Event('input', { bubbles: true })); }); }
beforeEach(async () => { localStorage.clear(); if (mounted) await act(async () => mounted.unmount()); container?.remove(); store.getState().cleanup(); globalThis.__workspaceTest.tasks = []; globalThis.__workspaceTest.get = undefined; globalThis.__workspaceTest.user = 'alice'; globalThis.__workspaceTest.groups = [{id:'group-a', name:'来源会话'}]; container = document.createElement('div'); document.body.appendChild(container); mounted = await mount(container); });
after(async () => { if (mounted) await act(async () => mounted.unmount()); });
test('draft survives workspace navigation and remount without persistent private storage', async () => {
  await act(async () => button('＋ 新任务').click());
  await type(container.querySelector('input[maxlength="150"]'), '尚未保存的标题');
  await type(container.querySelector('textarea'), '只有当前标签页的私密输入');
  await act(async () => button('模型中心').click()); assert.match(container.textContent, /模型配置测试页/);
  await act(async () => button('工作台').click()); assert.equal(container.querySelector('textarea').value, '只有当前标签页的私密输入');
  await act(async () => mounted.unmount()); mounted = await mount(container);
  assert.equal(container.querySelector('input[maxlength="150"]').value, '尚未保存的标题');
  assert.equal(window.localStorage.length, 0);
});
test('double form submit sends once; new typing stays separate from explicit frozen same-key replay', async () => {
  await act(async () => button('＋ 新任务').click());
  await type(container.querySelector('input[maxlength="150"]'), '保存回执测试'); await type(container.querySelector('textarea'), '内容');
  const calls = []; let rejectFirst;
  globalThis.__workspaceTest.post = (...args) => { calls.push(args); return new Promise((_, reject) => { rejectFirst = reject; }); };
  await act(async () => { const form = container.querySelector('form'); form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); });
  await act(async()=>{await waitFor(()=>calls.length===1);});
  assert.equal(calls.length, 1); assert.equal(calls[0][2].headers['X-Expected-User-Id'], 'alice');
  await act(async () => { rejectFirst(new Error('连接中断')); await settle(); });
  assert.equal(container.querySelector('fieldset').disabled, false); assert.ok(button('按原内容重试')); await type(container.querySelector('textarea'),'这次新输入');
  globalThis.__workspaceTest.post = async (...args) => { calls.push(args); const task = { priority: null, estimated_minutes: null, metadata_revision: 0, ...args[1], client_request_id:args[2].headers['Idempotency-Key'], id:'created', status:'pending', history:[], result:'', run_count:0 }; globalThis.__workspaceTest.tasks = [task]; return {data:task}; };
  await act(async () => { button('按原内容重试').click(); await settle(); });
  assert.equal(calls[0][2].headers['Idempotency-Key'], calls[1][2].headers['Idempotency-Key']);
  assert.equal(calls[1][1].prompt,'内容'); assert.equal(container.querySelector('textarea').value,'这次新输入'); assert.match(container.textContent, /保存回执测试/);
});
test('empty filtered results have clear recovery and no fabricated placeholder task', async () => {
  globalThis.__workspaceTest.tasks = [{id:'existing',title:'真正任务',prompt:'内容',category:'work',status:'pending',history:[],result:'',run_count:0}];
  await act(async () => store.getState().fetch());
  await type(container.querySelector('input[type="search"]'), '找不到的词');
  assert.match(container.textContent, /没有符合条件的任务/); assert.ok(button('清除筛选'));
  await act(async () => button('清除筛选').click()); assert.match(container.textContent, /真正任务/);
});

test('unknown-result approval stays bound to the run shown before confirmation', async () => {
  const first = {id:'existing',title:'待核验',prompt:'内容',category:'work',status:'outcome_unknown',history:[],result:'',run_count:1,run_id:'11111111-1111-4111-8111-111111111111'};
  globalThis.__workspaceTest.tasks = [first];
  await act(async () => store.getState().fetch());
  globalThis.__workspaceTest.confirm = true;
  await act(async () => button('已核验，允许重试').click());
  const second = {...first,run_count:2,run_id:'22222222-2222-4222-8222-222222222222'};
  globalThis.__workspaceTest.tasks = [second];
  await act(async () => store.getState().fetch());
  let payload;
  globalThis.__workspaceTest.post = async (_, body) => { payload = body; throw Object.assign(new Error('待核验运行已变化'), {status:409}); };
  await act(async () => { globalThis.__workspaceTest.resolveConfirm(true); await settle(); });
  assert.equal(payload.run_id, first.run_id);
  assert.match(container.textContent, /待核验运行已变化/);
  globalThis.__workspaceTest.confirm = false;
});

test('uncertain create can still verify its original receipt after source group disappears', async () => {
  await act(async () => store.getState().setComposerDraft({ ...store.getState().composerDraft, title:'有来源的草稿',prompt:'内容',groupId:'group-a' }));
  await act(async () => button('继续任务草稿').click());
  const requests = [];
  globalThis.__workspaceTest.post = async (...args) => { requests.push(args); throw new Error('lost receipt'); };
  await act(async () => { button('保存任务').click(); await waitFor(()=>requests.length===1); });
  globalThis.__workspaceTest.groups = [];
  await act(async () => store.getState().fetch());
  assert.equal(button('按原内容重试').disabled, false);
  globalThis.__workspaceTest.post = async (...args) => { requests.push(args); throw Object.assign(new Error('来源已删除'), {status:404}); };
  await act(async () => { button('按原内容重试').click(); await settle(); });
  assert.equal(requests[0][2].headers['Idempotency-Key'], requests[1][2].headers['Idempotency-Key']);
  assert.equal(store.getState().uncertainCreate, true);
  const key=requests[0][2].headers['Idempotency-Key'];globalThis.__workspaceTest.post=async path=>({data:{status:'cancelled',operation:'create',client_request_id:key,task_id:null,task_deleted:false,task:null,closed_at:'2026-10-04'}});
  await act(async()=>store.getState().closeCreate(key));assert.equal(store.getState().uncertainCreate,false);
  assert.equal(container.querySelector('fieldset').disabled, false);
});

test('confirmed document filter includes exact manual head and excludes unconfirmed or source-changed revisions', async () => {
  const base={category:'work',status:'completed',history:[],result:'人工正文',run_count:0,result_editor_available:true,result_head_version_id:'manual-2',accepted_run_id:null,source_stale:false};
  globalThis.__workspaceTest.tasks=[{...base,id:'accepted',title:'已确认的人工稿',prompt:'用途',result_accepted_version_id:'manual-2',source_input_stale:true},{...base,id:'old',title:'更新后未确认',prompt:'用途',result_accepted_version_id:'manual-1'},{...base,id:'changed',title:'来源已变化稿',prompt:'用途',result_accepted_version_id:'manual-2',source_stale:true}];
  await act(async()=>store.getState().fetch()); await act(async()=>button('已确认文稿').click());
  const cards=[...container.querySelectorAll('[data-observe="task-card"]')];assert.equal(cards.length,1);assert.match(cards[0].textContent,/已确认的人工稿/);assert.match(cards[0].textContent,/已确认成果/);assert.doesNotMatch(cards[0].querySelector('.workspace-status').textContent,/原始消息已变化/);
});

test('zero-model workspace offers writing first and replaces the large setup card once a document exists',async()=>{
 assert.ok(button('现在开始写作'));await act(async()=>button('现在开始写作').click());assert.ok(container.querySelector('form'));await act(async()=>button('收起').click());
 globalThis.__workspaceTest.tasks=[{id:'writing',title:'已有人工文稿',prompt:'用途',category:'work',status:'needs_review',history:[],result:'实际正文',run_count:0,group_id:null}];await act(async()=>store.getState().fetch());
 assert.equal(container.querySelector('.workspace-setup'),null);assert.ok(button('继续最近文稿'));await act(async()=>button('继续最近文稿').click());assert.match(container.textContent,/共享正文编辑器/);
});
test('minimal unresolved receipt prioritizes the original document without starting a model or new task',async()=>{
 const requestId='11111111-1111-4111-8111-111111111111';localStorage.setItem('qunthink_command_v1_alice:'+requestId,JSON.stringify({key:requestId,action:'save_revision',taskId:'pending-doc',payloadHash:'a'.repeat(64),createdAt:'2026-10-04T12:00:00Z'}));
 globalThis.__workspaceTest.tasks=[{id:'recent',title:'另一较新文稿',prompt:'用途',category:'work',status:'needs_review',history:[],result:'文字',run_count:0,group_id:null},{id:'pending-doc',title:'原回执对应文稿',prompt:'用途',category:'work',status:'needs_review',history:[],result:'待核验正文',run_count:0,group_id:null}];await act(async()=>store.getState().fetch());
 assert.ok(button('打开文稿核验'));assert.equal(container.querySelector('.workspace-setup'),null);await act(async()=>button('打开文稿核验').click());
 assert.ok(container.querySelector('#task-detail-pending-doc'));assert.equal(container.querySelector('#task-detail-recent'),null);assert.ok(localStorage.getItem('qunthink_command_v1_alice:'+requestId));
});

test('new task dependency chooser sends IDs only and leaves legacy creation payload unchanged when empty',async()=>{
 const prior='20000000-0000-4000-8000-000000000002';globalThis.__workspaceTest.tasks=[{id:prior,title:'可选择的前置任务',prompt:'前置私密正文',category:'work',status:'pending',history:[],result:'不应发送的前置成果',run_count:0}];await act(async()=>store.getState().fetch());await act(async()=>button('＋ 新任务').click());await type(container.querySelector('input[maxlength="150"]'),'下游任务');await type(container.querySelector('textarea'),'自己的输入');
 const checkbox=[...container.querySelectorAll('label')].find(el=>el.textContent==='可选择的前置任务').querySelector('input');await act(async()=>checkbox.click());const calls=[];globalThis.__workspaceTest.post=async(...args)=>{calls.push(args);throw new Error('lost')};await act(async()=>{container.querySelector('form').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));await settle()});await waitFor(()=>calls.length===1);assert.deepEqual(calls[0][1].dependency_ids,[prior]);assert.doesNotMatch(JSON.stringify(calls[0][1]),/前置私密正文|不应发送的前置成果/);
 localStorage.clear();await act(async()=>{store.getState().cleanup();store.getState().setComposerDraft({...store.getState().composerDraft,title:'旧式任务',prompt:'不选依赖'});});await act(async()=>{container.querySelector('form').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));await settle()});await waitFor(()=>calls.length===2);assert.equal('dependency_ids' in calls[1][1],false);
});
test('dependency-blocked and stale accepted tasks are absent from current accepted filter',async()=>{
 const base={category:'work',status:'completed',history:[],result:'正文',run_count:0,result_editor_available:true,result_head_version_id:'v1',result_accepted_version_id:'v1',source_stale:false};globalThis.__workspaceTest.tasks=[{...base,id:'blocked',title:'阻塞旧验收',prompt:'用途',dependency_state:{blocked:true,result_stale:false,reasons:[],signature:null}},{...base,id:'stale',title:'失效旧验收',prompt:'用途',dependency_state:{blocked:false,result_stale:true,reasons:[],signature:'changed'}},{...base,id:'good',title:'有效旧任务',prompt:'用途'}];await act(async()=>store.getState().fetch());assert.match(container.textContent,/等待前置任务/);assert.match(container.textContent,/依赖变化待复核/);await act(async()=>button('已确认文稿').click());const cards=[...container.querySelectorAll('[data-observe="task-card"]')];assert.equal(cards.length,1);assert.match(cards[0].textContent,/有效旧任务/);
});

test('planning creation controls preserve priority and zero in the exact frozen create payload', async () => {
 await act(async () => button('＋ 新任务').click()); await type(container.querySelector('input[maxlength="150"]'), '规划任务'); await type(container.querySelector('textarea'), '仅保存，不调用模型');
 const priority = container.querySelector('select[aria-label="新任务优先级"]'), minutes = container.querySelector('input[aria-label="新任务预计分钟"]');
 assert.ok(priority, 'new-task priority selector must be mounted'); assert.ok(minutes, 'new-task estimate control must be mounted');
 await act(async () => { priority.value = 'medium'; priority.dispatchEvent(new window.Event('change', { bubbles: true })); }); await type(minutes, '0');
 await act(async () => button('模型中心').click()); await act(async () => button('工作台').click());
 assert.equal(container.querySelector('select[aria-label="新任务优先级"]').value, 'medium'); assert.equal(container.querySelector('input[aria-label="新任务预计分钟"]').value, '0');
 const calls = []; globalThis.__workspaceTest.post = async (...args) => { calls.push(args); throw new Error('lost ACK'); };
 await act(async () => { button('保存任务').click(); await waitFor(() => calls.length === 1); });
 assert.equal(calls[0][1].priority, 'medium'); assert.equal(calls[0][1].estimated_minutes, 0); assert.equal(calls[0][1].auto_run, false); assert.equal(calls[0][1].run_at, null);
 await type(container.querySelector('input[aria-label="新任务预计分钟"]'), '15');
 await act(async () => { button('按原内容重试').click(); await waitFor(() => calls.length === 2); });
 assert.deepEqual(calls[1], calls[0]); assert.equal(container.querySelector('input[aria-label="新任务预计分钟"]').value, '15');
});
test('planning creation omits untouched defaults so legacy create replay bytes remain unchanged', async () => {
 await act(async () => button('＋ 新任务').click()); await type(container.querySelector('input[maxlength="150"]'), '旧式载荷'); await type(container.querySelector('textarea'), '不填规划属性');
 const calls = []; globalThis.__workspaceTest.post = async (...args) => { calls.push(args); throw new Error('lost ACK'); };
 await act(async () => { button('保存任务').click(); await waitFor(() => calls.length === 1); });
 assert.equal(Object.hasOwn(calls[0][1], 'priority'), false); assert.equal(Object.hasOwn(calls[0][1], 'estimated_minutes'), false);
});
test('planning task summaries distinguish no estimate from zero without reordering cards', async () => {
 const base = { prompt: '说明', category: 'work', status: 'pending', history: [], result: '', run_count: 0 };
 globalThis.__workspaceTest.tasks = [{ ...base, id: 'legacy', title: '旧记录' }, { ...base, id: 'zero', title: '零分钟', priority: 'high', estimated_minutes: 0 }];
 await act(async () => store.getState().fetch()); const cards = [...container.querySelectorAll('[data-observe="task-card"]')];
 assert.match(cards[0].textContent, /旧记录/); assert.match(cards[0].textContent, /优先级未设置/); assert.match(cards[0].textContent, /未估算/);
 assert.match(cards[1].textContent, /优先级高/); assert.match(cards[1].textContent, /预计 0 分钟/);
});

for (const input of ['-1', '1.5', '1e2', ' ', '525601']) test(`planning composer keeps invalid estimate ${JSON.stringify(input)} through remount and never sends`, async () => {
 await act(async () => button('＋ 新任务').click()); await type(container.querySelector('input[maxlength="150"]'), '无效分钟'); await type(container.querySelector('textarea'), '不应发送'); await type(container.querySelector('input[aria-label="新任务预计分钟"]'), input);
 let writes = 0; globalThis.__workspaceTest.post = async () => { writes++; };
 assert.equal(button('保存任务').disabled, true); await act(async () => { container.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await settle(); }); assert.equal(writes, 0);
 await act(async () => mounted.unmount()); mounted = await mount(container); assert.equal(container.querySelector('input[aria-label="新任务预计分钟"]').value, input); assert.equal(button('保存任务').disabled, true);
});
test('planning-only composer draft survives remount and incoming source without being replaced', async () => {
 await act(async () => button('＋ 新任务').click()); await type(container.querySelector('input[aria-label="新任务预计分钟"]'), '0');
 await act(async () => mounted.unmount()); mounted = await mount(container); assert.equal(container.querySelector('input[aria-label="新任务预计分钟"]').value, '0');
 await act(async () => store.getState().setDraft({ prompt: '另一个输入', groupId: null })); assert.equal(container.querySelector('textarea').value, ''); assert.equal(container.querySelector('input[aria-label="新任务预计分钟"]').value, '0'); assert.match(container.textContent, /请先保存或清空当前任务草稿/);
});


test('planning actual workspace and conversation surfaces keep one shared draft in both directions', async () => {
 await act(async () => button('＋ 新任务').click()); await type(container.querySelector('input[maxlength="150"]'), '工作台草稿'); await type(container.querySelector('textarea'), '原输入');
 const priority = container.querySelector('select[aria-label="新任务优先级"]'); await act(async () => { priority.value = 'high'; priority.dispatchEvent(new window.Event('change', { bubbles: true })); }); await type(container.querySelector('input[aria-label="新任务预计分钟"]'), '0');
 await act(async () => mounted.unmount()); mounted = await mountConversation(container); assert.match(container.textContent, /已保留工作台规划：优先级高 · 预计 0 分钟/); assert.equal(container.querySelector('select[aria-label="新任务优先级"]'), null);
 await type(container.querySelector('textarea'), '会话中继续修改'); await act(async () => mounted.unmount()); mounted = await mount(container);
 assert.equal(container.querySelector('textarea').value, '会话中继续修改'); assert.equal(container.querySelector('select[aria-label="新任务优先级"]').value, 'high'); assert.equal(container.querySelector('input[aria-label="新任务预计分钟"]').value, '0'); assert.equal(localStorage.length, 0);
});


test('natural background recovery of a malformed create ACK removes the transient React recovery button without another POST', async () => {
 const input = { title: '自然恢复原任务', prompt: '合成测试输入', category: 'work', model_id: null, group_id: null, run_at: null, repeat_minutes: null, auto_run: false, priority: 'high', estimated_minutes: 0 };
 let key, posts = 0, journalAtDispatch;
 globalThis.__workspaceTest.post = async (_, payload, config) => {
  posts++; key = config.headers['Idempotency-Key']; journalAtDispatch = localStorage.getItem(`qunthink_command_v1_alice:${key}`);
  const saved = { ...payload, id: '10000000-0000-4000-8000-000000000001', client_request_id: key, metadata_revision: 0, status: 'pending', history: [], result: '', run_count: 0 };
  globalThis.__workspaceTest.tasks = [saved]; const malformed = { ...saved }; delete malformed.estimated_minutes; return { data: malformed };
 };
 // No response gate or manual verification: use the unchanged store's natural
 // create-finally GET, and mount the actual WorkspacePage/PendingCreateRecovery.
 await act(async () => { await assert.rejects(store.getState().create(input), /创建回执缺少有效规划属性/); await waitFor(() => store.getState().recoveredCreate?.taskId); });
 assert.equal(JSON.parse(journalAtDispatch).key, key); assert.equal(posts, 1); assert.equal(localStorage.getItem(`qunthink_command_v1_alice:${key}`), null);
 assert.equal(store.getState().pendingCreates.length, 0); assert.equal(button('核验这次创建'), undefined); assert.match(container.textContent, /已找到上次保存的同一份文稿/);
 const cards = [...container.querySelectorAll('[data-observe="task-card"]')]; assert.equal(cards.length, 1); assert.match(cards[0].textContent, /自然恢复原任务/); assert.match(cards[0].textContent, /预计 0 分钟/);
 assert.equal(store.getState().tasks[0].client_request_id, key);
});
for (const problem of ['wrong-key', 'missing-estimate']) test(`natural background ${problem} response cannot retire the original create journal`, async () => {
 const input = { title: '保留原号', prompt: '合成测试输入', category: 'work', model_id: null, group_id: null, run_at: null, repeat_minutes: null, auto_run: false, priority: 'high', estimated_minutes: 0 };
 let key, saved, posts = 0, queries = 0;
 globalThis.__workspaceTest.post = async (_, payload, config) => { posts++; key = config.headers['Idempotency-Key']; saved = { ...payload, id: '10000000-0000-4000-8000-000000000001', client_request_id: key, metadata_revision: 0, status: 'pending', history: [], result: '', run_count: 0 }; const malformed = { ...saved }; delete malformed.estimated_minutes; return { data: malformed }; };
 globalThis.__workspaceTest.get = async (path, config) => {
  if (path === '/tasks') return { data: [] };
  queries++; assert.equal(path, `/tasks/commands/${key}`); assert.equal(config.headers['X-Expected-User-Id'], 'alice');
  const body = { operation: 'create', status: 'succeeded', client_request_id: key, task_id: saved.id, task_deleted: false, task: { ...saved } };
  if (problem === 'wrong-key') body.client_request_id = '20000000-0000-4000-8000-000000000002'; else delete body.task.estimated_minutes;
  return { data: body };
 };
 await act(async () => { await assert.rejects(store.getState().create(input), /创建回执/); await waitFor(() => queries === 1 && !store.getState().loading); });
 assert.equal(posts, 1); assert.equal(store.getState().pendingCreates[0].key, key); assert.ok(localStorage.getItem(`qunthink_command_v1_alice:${key}`)); assert.equal(button('核验这次创建').disabled, false); assert.equal(store.getState().recoveredCreate, null);
});
test('account switch during malformed create cannot auto-settle or expose the former owners journal', async () => {
 let key, posts = 0, reads = 0;
 globalThis.__workspaceTest.get = async () => { reads++; return { data: [] }; };
 globalThis.__workspaceTest.post = async (_, payload, config) => { posts++; key = config.headers['Idempotency-Key']; store.getState().cleanup(); globalThis.__workspaceTest.user = 'bob'; return { data: { ...payload, id: '10000000-0000-4000-8000-000000000001', client_request_id: key, metadata_revision: 0, priority: 'high', estimated_minutes: 0, history: [], result: '', status: 'pending', run_count: 0 } }; };
 await act(async () => { await assert.rejects(store.getState().create({ title: '旧账号任务', prompt: '合成私密测试', category: 'work', model_id: null, group_id: null, run_at: null, repeat_minutes: null, auto_run: false, priority: 'high', estimated_minutes: 0 }), /账号已切换/); });
 assert.equal(posts, 1); assert.equal(reads, 0); assert.ok(localStorage.getItem(`qunthink_command_v1_alice:${key}`)); assert.deepEqual(store.getState().pendingCreates, []); assert.doesNotMatch(container.textContent, /旧账号任务|合成私密测试/);
});
