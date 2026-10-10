import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { build } from 'esbuild';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const window = new Window({ url:'http://localhost/' });
Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,Node:window.Node,Element:window.Element,IS_REACT_ACT_ENVIRONMENT:true});
Object.defineProperty(globalThis,'navigator',{value:window.navigator,configurable:true});
class Channel { port1={onmessage:null}; port2={postMessage:()=>setTimeout(()=>this.port1.onmessage?.(),0)}; }
Object.defineProperty(globalThis,'MessageChannel',{value:Channel,configurable:true});
globalThis.__modelUi={user:'alice',get:async()=>({data:{}}),post:async()=>({data:{}}),put:async()=>({data:{}}),personas:0};
const bundled=await build({stdin:{contents:`import {createRoot} from 'react-dom/client'; import {act} from 'react'; import {ModelCenter} from './src/components/Layout/ModelCenter'; import {useModelsStore} from './src/stores/modelsStore'; export {act,useModelsStore}; export async function mount(element){const root=createRoot(element);await act(async()=>root.render(<ModelCenter/>));return root;}`,resolveDir:root,sourcefile:'test-model-ui.tsx',loader:'tsx'},bundle:true,format:'esm',platform:'browser',jsx:'automatic',write:false,plugins:[{name:'ui-boundaries',setup(build){
  build.onResolve({filter:/(?:services\/api|^\.\/api)$/},()=>({path:'api',namespace:'mock'}));
  build.onResolve({filter:/utils\/cacheUtils$/},()=>({path:'cache',namespace:'mock'}));
  build.onResolve({filter:/^\.\/personasStore$/},()=>({path:'personas',namespace:'mock'}));
  build.onLoad({filter:/.*/,namespace:'mock'},({path})=>({contents:path==='api'?`export const getAuthGeneration=()=>0;export const axiosInstance=Object.fromEntries(['get','post','put'].map(method=>[method,(...args)=>globalThis.__modelUi[method](...args)]));`:path==='cache'?'export const getCacheUserId=()=>globalThis.__modelUi.user;':'export const usePersonasStore={getState:()=>({fetchPersonas:async()=>{globalThis.__modelUi.personas++}})};',loader:'js'}));
}}]});
const {mount,act,useModelsStore:store}=await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
function catalog(){return{revision:1,providers:['a','b'].map(id=>({id,name:`服务${id}`,protocol:'openai',baseUrl:`https://${id}.example/v1`,enabled:true,keyRequired:true,apiKeyConfigured:true,ready:true})),models:[{id:'model-a',providerId:'a',name:'示例模型',model:'example',enabled:true,capabilities:['chat','vision','audio','video'],verifiedCapabilities:['chat'],ready:true,contextWindow:32000,maxTokens:4096,temperature:null,tokenParameter:'max_tokens',color:'#6366f1'}],defaults:{chat:'model-a',vision:null,tts:null}}}
let container,mounted;
const settle=()=>new Promise(resolve=>setTimeout(resolve,0));
const button=text=>[...container.querySelectorAll('button')].find(node=>node.textContent===text);
const inputFor=text=>[...container.querySelectorAll('label')].find(node=>node.textContent.startsWith(text))?.querySelector('input');
async function type(element,value){await act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(element,value);element.dispatchEvent(new window.Event('input',{bubbles:true}));});}
async function click(text){assert.ok(button(text),`Missing button: ${text}`);await act(async()=>{button(text).click();await settle()});}
beforeEach(async()=>{if(mounted)await act(async()=>mounted.unmount());container?.remove();store.getState().cleanup();window.localStorage.clear();window.sessionStorage.clear();globalThis.__modelUi.user='alice';globalThis.__modelUi.personas=0;globalThis.__modelUi.get=async()=>({data:catalog()});globalThis.__modelUi.post=async()=>({data:{models:[]}});globalThis.__modelUi.put=async(_,body)=>({data:{...body,revision:body.revision+1,providers:body.providers.map(({apiKey,...p})=>p)}});container=document.createElement('div');document.body.append(container);mounted=await mount(container)});
after(async()=>{if(mounted)await act(async()=>mounted.unmount());await window.close()});

test('draft and selected provider survive unmount in memory; keys never enter persistent browser storage',async()=>{
  await click('服务b');await type(inputFor('服务商名称'),'我的服务草稿');await type(container.querySelector('input[type="password"]'),'private-draft-key');
  await act(async()=>mounted.unmount());mounted=await mount(container);
  assert.equal(inputFor('服务商名称').value,'我的服务草稿');assert.equal(container.querySelector('input[type="password"]').value,'private-draft-key');assert.equal(button('我的服务草稿').getAttribute('aria-pressed'),'true');assert.equal(window.localStorage.length,0);assert.equal(window.sessionStorage.length,0);assert.match(container.textContent,/刷新或退出账号会清除/);
});
test('save freezes edits across remount and double click saves only once',async()=>{
  await type(inputFor('服务商名称'),'待保存名称');let complete;const writes=[];globalThis.__modelUi.put=(...args)=>{writes.push(args);return new Promise(resolve=>{complete=resolve})};
  await act(async()=>{button('保存并应用').click();button('保存并应用').click()});assert.equal(writes.length,1);assert.equal(container.querySelector('fieldset').disabled,true);
  await act(async()=>mounted.unmount());mounted=await mount(container);assert.equal(container.querySelector('fieldset').disabled,true);assert.equal(inputFor('服务商名称').value,'待保存名称');
  await act(async()=>{complete({data:{...writes[0][1],revision:2}});await settle()});assert.equal(container.querySelector('fieldset').disabled,false);assert.equal(globalThis.__modelUi.personas,1);assert.match(container.textContent,/已保存。会话/);
});
test('409 leaves editable draft and explicit merge preserves remote fields before another save',async()=>{
  await type(inputFor('服务商名称'),'本地名称');const latest=catalog();latest.revision=2;latest.models[0].maxTokens=8192;globalThis.__modelUi.get=async()=>({data:latest});globalThis.__modelUi.put=async()=>{throw Object.assign(new Error('conflict'),{response:{status:409,data:{error:'配置已在另一页面修改'}}})};
  await click('保存并应用');assert.equal(inputFor('服务商名称').value,'本地名称');assert.equal(button('保存并应用').disabled,true);assert.match(container.textContent,/你的草稿仍保留/);
  await click('合并最新配置，保留我的修改');assert.equal(inputFor('服务商名称').value,'本地名称');assert.equal(inputFor('输出上限').value,'8192');assert.equal(button('保存并应用').disabled,false);assert.equal(store.getState().draft.revision,2);
});
test('provider navigation discards late discovery and exposes manual recovery on discovery failure',async()=>{
  let finish;globalThis.__modelUi.post=()=>new Promise(resolve=>{finish=resolve});await click('拉取模型列表');await click('服务b');
  await act(async()=>{finish({data:{models:['private-a-model']}});await settle()});assert.doesNotMatch(container.textContent,/private-a-model/);assert.ok(button('＋ 手动添加模型'));
  globalThis.__modelUi.post=async()=>{throw new Error('服务商不支持模型列表')};await click('拉取模型列表');assert.match(container.querySelector('[role="alert"]').textContent,/手动添加/);assert.ok(button('＋ 手动添加模型'));
});
test('paid test timeout survives remount, disables paid retry, and offers only original-status recovery',async()=>{
  const writes=[];globalThis.__modelUi.post=async(...args)=>{writes.push(args);throw new Error('timeout')};await click('测试对话');
  assert.equal(writes.length,1);assert.equal(button('测试对话').disabled,true);assert.ok(button('查询原请求状态'));assert.match(container.querySelector('[aria-label="待核验测试"]').textContent,/待确认结果/);
  const requestId=store.getState().probes['model-a:chat'].requestId;await act(async()=>mounted.unmount());mounted=await mount(container);assert.match(container.textContent,new RegExp(requestId));assert.ok(button('查询原请求状态'));assert.equal(button('测试对话').disabled,true);
  const paths=[];globalThis.__modelUi.get=async path=>{paths.push(path);return{data:path.includes('/tests/')?{requestId,modelId:'model-a',capability:'chat',status:'succeeded',healthy:true,stale:false,possibleCharge:true,replayed:true,responseTime:55}:catalog()}};
  await click('查询原请求状态');assert.equal(writes.length,1);assert.ok(paths.includes(`/user/model-catalog/tests/${requestId}`));assert.match(container.textContent,/测试通过 · 55 ms/);assert.equal(button('测试对话').disabled,false);
});
test('known failed test removes verified label and refresh failure remains actionable',async()=>{
  globalThis.__modelUi.post=async(_,body)=>{throw Object.assign(new Error('failed'),{response:{status:502,data:{requestId:body.clientRequestId,modelId:'model-a',capability:'chat',status:'failed',healthy:false,stale:false,possibleCharge:true,replayed:false,error:'模型不支持'}}})};globalThis.__modelUi.get=async()=>{throw new Error('目录暂不可用')};
  await click('测试对话');assert.doesNotMatch(container.querySelector('fieldset summary').textContent,/已验证：对话/);assert.match(container.textContent,/测试失败：服务商已返回/);assert.ok(button('重新读取目录'));assert.ok(button('测试对话'));assert.equal(button('测试对话').disabled,false);
});
test('first-use manual setup, fail-closed defaults, unsupported audio/video, and keyboard repair are explicit',async()=>{
  assert.match(container.textContent,/音频理解和视频理解目前不能验证/);assert.match(container.textContent,/不会偷偷改用其他模型/);assert.equal(container.querySelector('ol[aria-label="连接步骤"]').children.length,3);
  const next=catalog();next.models[0].verifiedCapabilities=[];globalThis.__modelUi.get=async()=>({data:next});await act(async()=>store.getState().fetch());
  assert.match(container.textContent,/保存后仍会阻止请求/);await click('查看并测试对话');assert.equal(container.querySelector('fieldset details').open,true);assert.equal(document.activeElement,container.querySelector('fieldset summary'));
  await click('服务b');assert.match(container.textContent,/此服务商还没有模型/);await click('＋ 手动添加模型');assert.equal(inputFor('模型 ID').value,'');assert.equal(button('保存并应用').disabled,false);assert.equal(store.getState().draft.models.at(-1).providerId,'b');
});
test('changing destination clears an unsaved key before any save or discovery',async()=>{
  await type(container.querySelector('input[type="password"]'),'scoped-to-a');await type(inputFor('服务地址'),'https://new.example/v1');assert.equal(container.querySelector('input[type="password"]').value,'');assert.match(container.textContent,/尚未配置/);assert.equal(button('拉取模型列表').disabled,true);
});
test('account cleanup clears current DOM secrets and ignores late prior-account results',async()=>{
  await type(container.querySelector('input[type="password"]'),'alice-only');
  globalThis.__modelUi.user='bob';const next=catalog();next.providers[0].name='Bob 服务';globalThis.__modelUi.get=async()=>({data:next});await act(async()=>{store.getState().cleanup();await settle()});
  assert.equal(container.querySelector('input[type="password"]').value,'');assert.equal(inputFor('服务商名称').value,'Bob 服务');assert.equal(store.getState().dirty,false);
});

test('unknown test stays queryable even if another page removes its model',async()=>{
  globalThis.__modelUi.post=async()=>{throw new Error('timeout')};await click('测试对话');
  const next=catalog();next.revision=2;next.models=[];next.defaults.chat=null;globalThis.__modelUi.get=async()=>({data:next});await act(async()=>store.getState().fetch());
  assert.match(container.querySelector('[aria-label="待核验测试"]').textContent,/已移除模型/);assert.ok(button('查询原请求状态'));assert.equal(button('查询原请求状态').disabled,false);
});

test('repair button reopens and focuses a model after the user manually closed its disclosure',async()=>{
  const next=catalog();next.models[0].verifiedCapabilities=[];globalThis.__modelUi.get=async()=>({data:next});await act(async()=>store.getState().fetch());
  await click('查看并测试对话');container.querySelector('fieldset details').open=false;await click('查看并测试对话');assert.equal(container.querySelector('fieldset details').open,true);assert.equal(document.activeElement,container.querySelector('fieldset summary'));
});

test('404 recovery discloses charge risk and requires an explicit same-request button',async()=>{
  const writes=[];globalThis.__modelUi.post=async(...args)=>{writes.push(args);throw new Error('timeout')};await click('测试对话');assert.equal(button('重新提交原测试请求'),undefined);
  globalThis.__modelUi.get=async path=>{if(path.includes('/tests/'))throw Object.assign(new Error('404'),{response:{status:404,data:{error:'not found'}}});return{data:catalog()}};await click('查询原请求状态');assert.equal(writes.length,1);assert.match(container.textContent,/尚未收到原请求，将开始测试，可能产生费用/);assert.ok(button('重新提交原测试请求'));
  await click('重新提交原测试请求');assert.equal(writes.length,2);assert.deepEqual(writes[0][1],writes[1][1]);assert.equal(writes[0][2].headers['Idempotency-Key'],writes[1][2].headers['Idempotency-Key']);
});

test('empty account catalog stays empty until the user explicitly adds a connection',async()=>{
  const empty={revision:0,providers:[],models:[],defaults:{chat:null,vision:null,tts:null}};
  const writes=[];globalThis.__modelUi.get=async()=>({data:empty});globalThis.__modelUi.post=async(...args)=>{writes.push(args);return {data:{}}};globalThis.__modelUi.put=async(...args)=>{writes.push(args);return {data:{}}};
  await act(async()=>{store.getState().cleanup();await settle()});
  assert.deepEqual(store.getState().catalog,empty);assert.equal(store.getState().selected,'');
  assert.match(container.textContent,/个人模型由你自行配置/);
  assert.match(container.textContent,/当前没有服务商/);assert.match(container.textContent,/查看历史会话和进行人工写作/);
  assert.equal(container.querySelector('input[type="password"]'),null);assert.equal(button('保存并应用').disabled,true);
  for(const select of container.querySelectorAll('select')) assert.equal(select.options.length,1);
  assert.deepEqual(writes,[]);
  await click('＋ 服务商');
  const draft=store.getState().draft;assert.equal(draft.providers.length,1);assert.equal(draft.providers[0].baseUrl,'');assert.equal(draft.providers[0].apiKey,undefined);assert.deepEqual(draft.models,[]);assert.deepEqual(draft.defaults,empty.defaults);
  assert.equal(inputFor('服务地址').value,'');assert.equal(container.querySelector('input[type="password"]').value,'');assert.equal(button('拉取模型列表').disabled,true);assert.deepEqual(writes,[]);
  await click('放弃修改');assert.deepEqual(store.getState().draft,empty);assert.match(container.textContent,/当前没有服务商/);assert.deepEqual(writes,[]);
});
