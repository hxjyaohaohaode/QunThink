// Real local HTTP routes, synthetic account and content. No provider configured.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
for(const key of Object.keys(process.env))if(/^(SUPABASE_|MONGO|MEMORY_DELETION_|SERVER_AI_|ALIYUN_)/.test(key))delete process.env[key];
Object.assign(process.env,{NODE_ENV:'test',AUTH_MODE:'session',DATA_DIR:await fs.mkdtemp(path.join(os.tmpdir(),'qunthink-restore-http-')),ENCRYPTION_KEY:randomBytes(32).toString('base64')});
process.env.AUTH_DB_PATH=path.join(process.env.DATA_DIR,'auth.json');
const {initializeEmptyInstallation,initDatabase,getUserDb,restoreAccountGenerations}=await import('../src/models/db.js');
const {initAuthDb}=await import('../src/models/authDb.js');
const {createTestApp}=await import('./helpers/createTestApp.js');
const {sourceHash}=await import('../src/services/taskSources.js');
await initializeEmptyInstallation();await initDatabase();await initAuthDb();
let server,base;
async function start(){server=createTestApp().listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${server.address().port}`;}
async function stop(){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
await start();test.after(async()=>{if(server.listening)await stop();await fs.rm(process.env.DATA_DIR,{recursive:true,force:true});});
async function http(method,endpoint,body,cookie){const r=await fetch(base+endpoint,{method,headers:{...(body?{'content-type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{})},...(body?{body:JSON.stringify(body)}:{})});return{status:r.status,body:await r.json(),cookie:r.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ') };}
async function tree(root){const out={};for(const e of await fs.readdir(root,{withFileTypes:true})){const f=path.join(root,e.name);if(e.isDirectory())Object.assign(out,await tree(f));else out[f]=await fs.readFile(f,'utf8');}return out;}
test('restored deleted message, group and file stay filtered after real rotation; low old cursor resets through HTTP',async()=>{
  const registered=await http('POST','/api/auth/register',{username:`restore_${randomUUID()}`,password:'SyntheticTestOnly2026!'});assert.equal(registered.status,201);
  const owner=registered.body.user.id,cookie=registered.cookie,db=await getUserDb(owner),group=db.data.groups[0].id,deletedGroup=db.data.groups[1].id,endpoint=`/api/groups/${group}/messages`;
  const empty=await http('GET',`${endpoint}?order=sequence_v1`,null,cookie);assert.equal(empty.status,200);
  const sent=await http('POST',endpoint,{content:'Synthetic deleted message',clientMessageId:randomUUID()},cookie);assert.equal(sent.status,201);
  const fileId=randomUUID();await db.read({force:true});db.data.files.push({id:fileId,group_id:group,owner_user_id:owner,uploader_id:owner,filename:'synthetic.txt',parsed_content:'Synthetic deleted source'});await db.write();
  const file=path.join(process.env.DATA_DIR,'users',`db_${owner}.json`),backup=await fs.readFile(file),source=JSON.parse(backup),hashes=[1,2].map(v=>sourceHash(source.messages,{data:source},v));
  assert.equal((await http('DELETE',`/api/messages/${sent.body.id}`,null,cookie)).status,200);
  assert.equal((await http('DELETE',`/api/files/${fileId}`,{group_id:group},cookie)).status,200);
  assert.equal((await http('DELETE',`/api/groups/${deletedGroup}`,null,cookie)).status,200);
  await stop();await fs.writeFile(file,backup);
  const protectedBefore=await tree(path.join(process.env.DATA_DIR,'memory-deletions')),authBefore=await fs.readFile(process.env.AUTH_DB_PATH,'utf8');
  const planFile=path.join(process.env.DATA_DIR,'plan.json'),prepared=await restoreAccountGenerations(owner,{operation:'prepare',planFile,writersStopped:true});
  const applied=await restoreAccountGenerations(owner,{operation:'apply',planFile,writersStopped:true,expectedPlanSha:prepared.planSha});assert.equal(applied.outcome,'confirmed');
  await assert.rejects(db.read(),{code:'USER_DB_REPLACED'});
  const target=JSON.parse(await fs.readFile(file,'utf8'));assert.deepEqual(target.messages,source.messages);assert.deepEqual(target.messageIdempotency,source.messageIdempotency);assert.deepEqual([1,2].map(v=>sourceHash(target.messages,{data:target},v)),hashes);
  assert.deepEqual(await tree(path.join(process.env.DATA_DIR,'memory-deletions')),protectedBefore);assert.equal(await fs.readFile(process.env.AUTH_DB_PATH,'utf8'),authBefore);
  await start();
  const stale=await http('GET',`${endpoint}?order=sequence_v1&after_cursor=${empty.body.after_cursor}`,null,cookie);assert.equal(stale.status,409);assert.equal(stale.body.code,'CURSOR_RESET_REQUIRED');
  const visible=await http('GET',`${endpoint}?order=sequence_v1`,null,cookie);assert.equal(visible.status,200);assert.deepEqual(visible.body.messages,[]);
  assert.equal((await http('GET',`/api/groups/${deletedGroup}/messages?order=sequence_v1`,null,cookie)).status,404);
  assert.equal((await http('GET',`/api/files/${fileId}/content?group_id=${group}`,null,cookie)).status,404);
  assert.equal(JSON.parse(await fs.readFile(file,'utf8')).messages.length,1,'normal filtering must not scrub restored source');
});
