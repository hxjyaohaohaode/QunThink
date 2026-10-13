import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const backend = fileURLToPath(new URL('..',import.meta.url));
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(),'qunthink-lifecycle-startup-'));
const env = { PATH:process.env.PATH, HOME:process.env.HOME, LANG:process.env.LANG || 'C.UTF-8', NODE_ENV:'production',
  AUTH_MODE:'session', DATA_DIR:dataDir, AUTH_DB_PATH:path.join(dataDir,'auth.json'),
  ENCRYPTION_KEY:randomBytes(32).toString('base64') };
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function freePort(){const server=net.createServer();await new Promise((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}
async function start(){
  const port=await freePort(),child=spawn(process.execPath,['src/index.js'],{cwd:backend,env:{...env,PORT:String(port)},stdio:['ignore','pipe','pipe']});
  let log='',exited=false,exitCode;child.stdout.on('data',chunk=>{log+=chunk});child.stderr.on('data',chunk=>{log+=chunk});child.on('exit',code=>{exited=true;exitCode=code});
  const deadline=Date.now()+20000;
  try {
    while(Date.now()<deadline){
      if(exited)throw new Error(`Server exited ${exitCode}: ${log}`);
      try{const response=await fetch(`http://127.0.0.1:${port}/api/health`,{signal:AbortSignal.timeout(500)});if(response.status===200)return {child,port,log:()=>log};}catch{}
      await sleep(50);
    }
    throw new Error(`Server startup deadline exceeded: ${log}`);
  } catch(error){child.kill('SIGTERM');await new Promise(resolve=>{if(exited)return resolve();child.once('exit',resolve)});throw error;}
}
async function stop(server){
  if(server.child.exitCode!==null)return;
  const done=new Promise(resolve=>server.child.once('exit',resolve));server.child.kill('SIGTERM');
  let timer;
  try { await Promise.race([done,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Server did not gracefully stop within deadline')),10000)})]); }
  finally { clearTimeout(timer); }
}
const file=path.join(dataDir,'users','db_default.json');

test('explicit CLI initialization followed by real production cold-start and restart preserves generation and authority', {timeout:50000},async()=>{
  const setup=execFileSync(process.execPath,['scripts/account-store-maintenance.mjs','init-empty'],{cwd:backend,env,encoding:'utf8',stdio:['ignore','pipe','pipe']});
  assert.equal(JSON.parse(setup.trim()).confirmedByRead,true);
  const before=await fs.readFile(file,'utf8'), snapshot=JSON.parse(before);
  assert.equal(snapshot.message_order.groups.length,3);
  for(let cycle=0;cycle<2;cycle++){
    const server=await start();
    try{
      assert.equal((await fetch(`http://127.0.0.1:${server.port}/api/health`)).status,200);
      assert.equal((await fetch(`http://127.0.0.1:${server.port}/api/groups`)).status,401);
      const csrfResponse=await fetch(`http://127.0.0.1:${server.port}/api/csrf-token`);
      assert.equal(csrfResponse.status,200); const csrf=await csrfResponse.json();
      assert.equal(csrf.enabled,true); const cookie=csrfResponse.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
      // Raw loopback protocol fixture, not a browser/Secure-cookie or TLS acceptance claim.
      const sms=await fetch(`http://127.0.0.1:${server.port}/api/sms/send`,{method:'POST',headers:{'content-type':'application/json','x-csrf-token':csrf.csrfToken,cookie},body:JSON.stringify({phone:'13900000599'})});
      assert.equal(sms.status,503,await sms.text());
      assert.equal(await fs.readFile(file,'utf8'),before,'normal startup must not rewrite account data or generation');
    }finally{await stop(server)}
    assert.match(server.log(),/HTTP server closed/);
    assert.match(server.log(),/WebSocket server closed/);
  }
});

test('offline CLI honors the same dotenv DATA_DIR as server startup before selecting the raw store', async () => {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'qunthink-cli-dotenv-'));
  const configured=path.join(directory,'configured-data'),owner='55555555-5555-4555-8555-555555555555';
  await fs.mkdir(path.join(configured,'users'),{recursive:true});
  const raw=JSON.stringify({groups:[],messages:[],synthetic:'dotenv-contract'});
  const target=path.join(configured,'users',`db_${owner}.json`);await fs.writeFile(target,raw,{flag:'wx'});
  await fs.writeFile(path.join(directory,'.env'),`DATA_DIR=${configured}\n`,{flag:'wx'});
  const clean={PATH:process.env.PATH,HOME:process.env.HOME,LANG:'C.UTF-8',NODE_ENV:'test'};
  const output=execFileSync(process.execPath,[path.join(backend,'scripts/account-store-maintenance.mjs'),'migrate-account',owner],{cwd:directory,env:clean,encoding:'utf8',stdio:['ignore','pipe','pipe']});
  const result=JSON.parse(output.trim());assert.equal(result.applied,false);assert.equal(result.messages,0);
  assert.equal(await fs.readFile(target,'utf8'),raw,'dry-run must not mutate the configured account');
});
