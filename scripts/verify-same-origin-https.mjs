// Protocol integration, not browser or Docker acceptance. Synthetic fixture only.
// Every client explicitly trusts this test CA; never disables certificate checks.
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { renderSameOriginHttps } from './render-same-origin-https.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../backend/package.json', import.meta.url));
const { WebSocket } = require('ws');
const nginx = process.env.QUNTHINK_TEST_NGINX_BIN;
const mime = process.env.QUNTHINK_TEST_NGINX_MIME;
if (!nginx || !mime || !path.isAbsolute(nginx) || !path.isAbsolute(mime)) throw new Error('Set absolute QUNTHINK_TEST_NGINX_BIN and QUNTHINK_TEST_NGINX_MIME');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qunthink-https-'));
const output = process.env.QUNTHINK_TEST_OUTPUT_DIR || await fs.mkdtemp(path.join(os.tmpdir(), 'qunthink-https-results-'));
if (!path.isAbsolute(output)) throw new Error('QUNTHINK_TEST_OUTPUT_DIR must be absolute');
await fs.mkdir(output, { recursive: true });
const children = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function port() { const s = net.createServer(); await new Promise(r => s.listen(0,'127.0.0.1',r)); const p = s.address().port; await new Promise(r=>s.close(r)); return p; }
const [httpPort, tlsPort, backendPort] = await Promise.all([port(), port(), port()]);
const origin = `https://localhost:${tlsPort}`;
const data = path.join(dir, 'data'); await fs.mkdir(data);
const env = { ...process.env, DATA_DIR: data, AUTH_DB_PATH: path.join(data,'auth.json'), ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'), AUTH_MODE:'session', NODE_ENV:'production', TRUST_PROXY:'1', CORS_ORIGINS:origin, PORT:String(backendPort), SERVER_AI_ENABLED:'false', SERVER_AI_API_KEY:'', ALIYUN_ACCESS_KEY_ID:'', ALIYUN_ACCESS_KEY_SECRET:'', SUPABASE_DB_URL:'', MONGODB_URI:'', MEMORY_DELETION_MODE:'legacy' };
function command(bin, args, options={}) { const r=spawnSync(bin,args,{cwd:dir,encoding:'utf8',...options}); if(r.status!==0) throw new Error(`${path.basename(bin)} failed: ${r.stderr}`); return r.stdout; }
function child(bin,args,options={}) { const p=spawn(bin,args,{cwd:root,env,stdio:['ignore','pipe','pipe'],...options}); children.push(p); const log=createWriteStream(path.join(output,`${path.basename(bin)}-${children.length}.log`)); p.stdout.pipe(log); p.stderr.pipe(log); return p; }
const results=[]; function pass(label) { results.push(label); console.log(`PASS ${label}`); }
try {
  command('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=QunThink synthetic test CA','-keyout','ca.key','-out','ca.crt']);
  command('openssl',['req','-newkey','rsa:2048','-nodes','-subj','/CN=localhost','-keyout','server.key','-out','server.csr']);
  await fs.writeFile(path.join(dir,'server.ext'),'subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n');
  command('openssl',['x509','-req','-in','server.csr','-CA','ca.crt','-CAkey','ca.key','-CAcreateserial','-out','server.crt','-days','1','-extfile','server.ext']);
  const seed = `
    import fs from 'node:fs/promises'; import path from 'node:path';
    const { initDatabase,getUserDb,getUploadsDir }=await import(${JSON.stringify(new URL('../backend/src/models/db.js',import.meta.url).href)});
    const {initAuthDb}=await import(${JSON.stringify(new URL('../backend/src/models/authDb.js',import.meta.url).href)});
    const {createTestApp}=await import(${JSON.stringify(new URL('../backend/test/helpers/createTestApp.js',import.meta.url).href)});
    const request=(await import(${JSON.stringify(new URL('../backend/node_modules/supertest/index.js',import.meta.url).href)})).default(createTestApp());
    await initDatabase(); await initAuthDb(); const users=[];
    for(const [i,phone] of ['13900000901','13900000902'].entries()) { const r=await request.post('/api/auth/register').send({username:'tls_user_'+i,phone,password:'Passw0rd123'}); if(r.status!==201)throw new Error('seed register'); users.push(r.body.user); }
    const db=await getUserDb(users[0].id);await db.read(); const gid=db.data.groups[1].id;
    const fid='1a203ac5-ff3c-47b0-ae65-d1a69ae933ca'; const file='synthetic.txt';
    await fs.mkdir(path.join(getUploadsDir(),users[0].id),{recursive:true}); await fs.writeFile(path.join(getUploadsDir(),users[0].id,file),'0123456789abcdefghij');
    db.data.files.push({id:fid,group_id:gid,owner_user_id:users[0].id,uploader_id:users[0].id,stored_filename:file,filename:file,mime_type:'text/plain',file_size:20});
    const bg='synthetic-background.png'; await fs.mkdir(path.join(getUploadsDir(),'backgrounds'),{recursive:true});await fs.writeFile(path.join(getUploadsDir(),'backgrounds',bg),Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3xoAAAAASUVORK5CYII=','base64'));db.data.groups.find(g=>g.id===gid).background_storage_key=bg;
    const mid='34990110-aeba-46f0-bbe1-83b0e0f8b011';const audio='tts_'+mid+'_abcdefgh.wav';
    db.data.messages.push({id:mid,group_id:gid,sender_type:'user',content:'Synthetic audio source',created_at:new Date().toISOString(),metadata:{tts:{audioUrl:'/api/tts/audio/'+audio}}});
    db.data.ttsAudioFiles=[{filename:audio,messageId:mid,createdAt:Date.now()}];await fs.mkdir(path.join(process.env.DATA_DIR,'tts'),{recursive:true});await fs.writeFile(path.join(process.env.DATA_DIR,'tts',audio),Buffer.alloc(128,1));await db.write();
    await fs.writeFile(${JSON.stringify(path.join(dir,'seed.json'))},JSON.stringify({users,gid,fid,audio}));
  `;
  command(process.execPath,['--input-type=module','-e',seed],{cwd:root,env:{...env,NODE_ENV:'test'}});
  const seeded=JSON.parse(await fs.readFile(path.join(dir,'seed.json'),'utf8'));
  let backend=child(process.execPath,['src/index.js'],{cwd:path.join(root,'backend')});
  let ready=false; for(let i=0;i<100;i++){try{const r=await fetch(`http://127.0.0.1:${backendPort}/api/health`);if(r.ok){ready=true;break;}}catch{} if(backend.exitCode!==null)break;await wait(100);} assert.ok(ready,'production backend ready');
  const base=await fs.readFile(path.join(root,'frontend/nginx.conf'),'utf8');
  const config=renderSameOriginHttps(base,origin).replace('listen 80;',`listen 127.0.0.1:${httpPort};`).replace('listen 443 ssl;',`listen 127.0.0.1:${tlsPort} ssl;`).replaceAll('/etc/nginx/tls/',dir+'/').replaceAll('http://backend:3002',`http://127.0.0.1:${backendPort}`).replaceAll('/usr/share/nginx/html',path.join(root,'frontend/dist'));
  const configPath=path.join(dir,'nginx.conf'); await fs.writeFile(configPath,`pid ${dir}/nginx.pid;\nerror_log ${output}/nginx-error.log;\nevents {}\nhttp { include ${mime}; access_log off; client_body_temp_path ${dir}/body; proxy_temp_path ${dir}/proxy; ${config} }`);
  command(nginx,['-t','-p',dir+'/', '-c',configPath]);child(nginx,['-p',dir+'/', '-c',configPath,'-g','daemon off;']);await wait(150);
  const ca=await fs.readFile(path.join(dir,'ca.crt'));
  const cookies=new Map();
  function req(route,{method='GET',body,headers={},jar=cookies,plain=false}={}) { return new Promise((resolve,reject)=>{
    const bytes=body===undefined?null:Buffer.from(typeof body==='string'?body:JSON.stringify(body));
    const request=(plain?http:https).request({hostname:'127.0.0.1',port:plain?httpPort:tlsPort,path:route,method,servername:'localhost',ca,headers:{Host:`localhost:${tlsPort}`,...(jar.size?{Cookie:[...jar].map(([k,v])=>`${k}=${v}`).join('; ')}:{}),...(bytes?{'Content-Type':'application/json','Content-Length':bytes.length}:{}),...headers}},res=>{
      for(const value of res.headers['set-cookie']||[]){const pair=value.split(';')[0]; const at=pair.indexOf('=');jar.set(pair.slice(0,at),pair.slice(at+1));}
      const chunks=[];res.on('data',x=>chunks.push(x));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));
    });request.on('error',reject);if(bytes)request.write(bytes);request.end();
  }); }
  const redirect=await req('/deep/link?a=1',{plain:true,headers:{Host:'untrusted.invalid'}});assert.equal(redirect.status,308);assert.equal(redirect.headers.location,origin+'/deep/link?a=1');pass('fixed canonical HTTP redirect resists Host injection');
  const html=await req('/deep/link');assert.equal(html.status,200);assert.match(html.headers['content-type'],/text\/html/);assert.match(html.headers['strict-transport-security'],/31536000/);pass('real frontend SPA over trusted TLS with HSTS');
  const wrongHost=await req('/',{headers:{Host:'untrusted.invalid'}});assert.equal(wrongHost.status,421);pass('HTTPS Host validation with valid localhost SNI');
  let csrf=JSON.parse((await req('/api/csrf-token')).body).csrfToken;
  const login=await req('/api/auth/login-phone',{method:'POST',body:{phone:'13900000901',password:'Passw0rd123'},headers:{Origin:origin,'x-csrf-token':csrf}});assert.equal(login.status,200);const session=login.headers['set-cookie'].find(x=>x.startsWith('session_token='));assert.match(session,/Secure/);assert.match(session,/HttpOnly/);assert.match(session,/SameSite=None/);assert.ok(!/Domain=/i.test(session));pass('production session uses host-only Secure HttpOnly cookie');
  assert.equal((await req('/api/groups',{method:'POST',body:{name:'bad'}})).status,403);pass('unsafe request without CSRF remains forbidden');
  const fileRoute=`/api/files/${seeded.fid}/download?group_id=${seeded.gid}`;
  const range=await req(fileRoute,{headers:{Range:'bytes=2-5'}});assert.equal(range.status,206);assert.equal(range.body.toString(),'2345');assert.equal(range.headers['cross-origin-resource-policy'],'same-origin');pass('authorized same-origin file Range and private CORP');
  const background=await req(`/api/groups/${seeded.gid}/background`);assert.equal(background.status,200);assert.equal(background.headers['cross-origin-resource-policy'],'same-origin');pass('authorized private background retains same-origin policy');
  const audio=await req(`/api/tts/audio/${seeded.audio}`,{headers:{Range:'bytes=0-15'}});assert.equal(audio.status,206);assert.equal(audio.body.length,16);pass('offline seeded TTS protected Range without model billing');
  async function multipart(route, count, size, { background = false } = {}) {
    const boundary = 'qunthink-test-boundary';
    const prefix = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="group_id"\r\n\r\n${seeded.gid}\r\n`);
    const pieces = [prefix]; let total = prefix.length;
    for (let i = 0; i < count; i++) {
      const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${background ? 'background' : 'files'}"; filename="test-${i}.${background ? 'png' : 'wav'}"\r\nContent-Type: ${background ? 'image/png' : 'audio/wav'}\r\n\r\n`);
      const signature = background ? Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]) : Buffer.from('RIFF');
      pieces.push(head, signature, size - signature.length, Buffer.from('\r\n'));
      total += head.length + size + 2;
    }
    const tail = Buffer.from(`--${boundary}--\r\n`); pieces.push(tail); total += tail.length;
    const chunk = Buffer.alloc(1024 * 1024, 1);
    let resolveResponse, rejectResponse;
    const response = new Promise((resolve,reject) => { resolveResponse=resolve; rejectResponse=reject; });
    const r = https.request({hostname:'127.0.0.1',port:tlsPort,path:route,method:'POST',servername:'localhost',ca,headers:{Host:`localhost:${tlsPort}`,Origin:origin,'x-csrf-token':csrf,Cookie:[...cookies].map(([k,v])=>`${k}=${v}`).join('; '),'Content-Type':`multipart/form-data; boundary=${boundary}`,'Content-Length':total}}, res => {
      const chunks=[];res.on('data',x=>chunks.push(x));res.on('end',()=>resolveResponse({status:res.statusCode,body:Buffer.concat(chunks),bytes:total}));
    }); r.on('error',rejectResponse);
    for (const piece of pieces) {
      if (typeof piece === 'number') { let remaining=piece; while(remaining>0) { const bytes=chunk.subarray(0,Math.min(chunk.length,remaining)); if(!r.write(bytes))await once(r,'drain'); remaining-=bytes.length; } }
      else if(!r.write(piece)) await once(r,'drain');
    }
    r.end(); return response;
  }
  const ownerDir=path.join(data,'uploads',seeded.users[0].id);
  const small=await multipart('/api/files/upload',1,2*1024*1024);assert.equal(small.status,201,small.body.toString());pass('2 MiB upload traverses Nginx instead of its default 1 MiB rejection');
  const batch=await multipart('/api/files/upload',10,50*1024*1024-1);assert.equal(batch.status,201,batch.body.toString());assert.ok(batch.bytes>500*1024*1024);pass('ten near-50 MiB files preserve a multipart request larger than 500 MiB');
  const beforeInvalid=(await fs.readdir(ownerDir)).sort();
  assert.equal((await multipart('/api/files/upload',1,50*1024*1024+1)).status,400);
  assert.equal((await multipart('/api/files/upload',11,1024)).status,400);
  assert.deepEqual((await fs.readdir(ownerDir)).sort(),beforeInvalid);pass('application file-size/count rejections clean temporary uploads');
  const bgRoute=`/api/groups/${seeded.gid}/upload-background`;
  assert.equal((await multipart(bgRoute,1,10*1024*1024-1,{background:true})).status,200);
  const beforeBg=(await fs.readdir(path.join(data,'uploads','backgrounds'))).sort();
  assert.equal((await multipart(bgRoute,1,10*1024*1024+1,{background:true})).status,400);
  assert.deepEqual((await fs.readdir(path.join(data,'uploads','backgrounds'))).sort(),beforeBg);pass('real background upload route accepts near-10 MiB and rejects/cleans oversize');
  const agent=await multipart('/api/agents/missing-synthetic-agent/chat-with-files',1,2*1024*1024);assert.equal(agent.status,200);assert.match(agent.body.toString(),/智能体不存在/);assert.deepEqual((await fs.readdir(ownerDir)).sort(),beforeInvalid);pass('nonexistent-agent SSE error cleans uploaded attachments (not valid-agent AI acceptance)');
  for (const [route,limit] of [['/api/files/upload',512],['/api/agents/missing-synthetic-agent/chat-with-files',512],[bgRoute,11],['/api/groups',6]]) {
    const rejected=await req(route,{method:'POST',headers:{'Content-Length':limit*1024*1024+1},jar:new Map()});assert.equal(rejected.status,413,route);
  }
  pass('proxy rejects request headers above the 512/11/6 MiB route limits');
  const other=new Map();const token2=JSON.parse((await req('/api/csrf-token',{jar:other})).body).csrfToken;
  assert.equal((await req('/api/auth/login-phone',{jar:other,method:'POST',body:{phone:'13900000902',password:'Passw0rd123'},headers:{Origin:origin,'x-csrf-token':token2}})).status,200);
  assert.equal((await req(fileRoute,{jar:other})).status,404);assert.equal((await req(`/api/tts/audio/${seeded.audio}`,{jar:other})).status,404);assert.equal((await req(fileRoute,{jar:new Map()})).status,401);pass('B and anonymous clients cannot read A private media');
  // Same physical synthetic DATA_DIR, production process stopped and restarted.
  const exited=once(backend,'exit'); backend.kill('SIGTERM'); await exited;
  backend=child(process.execPath,['src/index.js'],{cwd:path.join(root,'backend')});
  let restarted=false;for(let i=0;i<100;i++){try{const result=await req('/api/health');if(result.status===200){restarted=true;break;}}catch{}if(backend.exitCode!==null)break;await wait(100);}assert.ok(restarted);
  assert.equal((await req('/api/auth/me')).status,200);
  const afterRestart=await req(fileRoute,{headers:{Range:'bytes=2-5'}});assert.equal(afterRestart.status,206);assert.equal(afterRestart.body.toString(),'2345');
  assert.equal((await req(`/api/groups/${seeded.gid}/background`)).status,200);
  assert.equal((await req(`/api/tts/audio/${seeded.audio}`,{headers:{Range:'bytes=0-15'}})).status,206);
  csrf=JSON.parse((await req('/api/csrf-token')).body).csrfToken;
  pass('production restart preserves sessions, uploaded bytes, background and TTS Range');
  const ws=new WebSocket(`wss://127.0.0.1:${tlsPort}/ws`,{ca,servername:'localhost',headers:{Host:`localhost:${tlsPort}`,Origin:origin,Cookie:[...cookies].map(([k,v])=>`${k}=${v}`).join('; ')}});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('WSS admission timeout')),3000);ws.on('message',data=>{if(JSON.parse(data).type==='connected'){clearTimeout(timer);resolve();}});ws.on('error',reject);});pass('authenticated WSS upgrade through the TLS proxy');
  const closed=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('WSS logout timeout')),3000);ws.on('close',()=>{clearTimeout(timer);resolve();});});
  assert.equal((await req('/api/auth/logout',{method:'POST',body:{},headers:{Origin:origin,'x-csrf-token':csrf}})).status,200);await closed;assert.equal((await req(fileRoute)).status,401);pass('logout revokes the WSS connection and protected media');
  let limited = false;
  for (let i=0;i<11;i++) {
    const result=await req('/api/auth/login-phone',{method:'POST',body:{phone:'13900000901',password:'wrong-password'},headers:{Origin:origin,'x-csrf-token':csrf,'X-Forwarded-For':`198.51.100.${i+1}`}});
    if(result.status===429){limited=true;break;}
    assert.equal(result.status,401);
  }
  assert.ok(limited,'changing forged XFF must not create new auth IP buckets');pass('forged client XFF cannot bypass the auth rate-limit bucket');
  await fs.writeFile(path.join(output,'https-protocol-results.json'),JSON.stringify({node:process.version,passed:results.length,checks:results,scope:'synthetic Node HTTPS/WS protocol, not browser/container/cloud',nginx},null,2)+'\n');
} finally {
  for(const process of children.reverse()){if(process.exitCode===null)process.kill('SIGTERM');}
  await wait(200);
  // Certificates, synthetic credentials and private fixtures never enter output.
  await fs.rm(dir,{recursive:true,force:true});
}
