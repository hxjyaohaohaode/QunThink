// Actual isolated HTTP startup, not a browser or live-model acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const cwd=fileURLToPath(new URL('..',import.meta.url));
for(const [script,port,provider] of [['start-e2e-backend.mjs',3202,true],['start-site-ai-backend.mjs',3222,false]]) {
  test(`${script}: new empty installation starts, registers isolated ordered account and commits one message`,{timeout:30000},async()=>{
    const child=spawn(process.execPath,[`scripts/${script}`],{cwd,env:process.env,stdio:['ignore','pipe','pipe']});
    let output=''; child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
    const closed=once(child,'close'); const base=`http://127.0.0.1:${port}`;
    try {
      const deadline=Date.now()+20000;let ready=false;
      while(Date.now()<deadline){
        if(child.exitCode!==null) throw new Error(`Fixture exited before health (${child.exitCode}): ${output}`);
        try{const r=await fetch(base+'/api/health',{signal:AbortSignal.timeout(300)});if(r.status===200){ready=true;break;}}catch{}
        await new Promise(r=>setTimeout(r,50));
      }
      assert.equal(ready,true,'New synthetic installation must be ready without repairing existing state');
      const cookies=new Map();
      const request=async(path,options={})=>{
        const response=await fetch(base+path,{...options,headers:{cookie:[...cookies].map(([k,v])=>`${k}=${v}`).join('; '),...options.headers},signal:AbortSignal.timeout(5000)});
        for(const value of response.headers.getSetCookie()){const pair=value.split(';',1)[0];const i=pair.indexOf('=');cookies.set(pair.slice(0,i),pair.slice(i+1));}
        return response;
      };
      const csrf=await(await request('/api/csrf-token')).json();
      const headers={'content-type':'application/json','x-csrf-token':csrf.csrfToken};
      const registration=await request('/api/auth/register',{method:'POST',headers,body:JSON.stringify({username:`fixture_${randomUUID().replaceAll('-','')}`,password:'Synthetic-Startup-Only-2026'})});
      assert.equal(registration.status,201);
      const groups=await(await request('/api/groups')).json();assert.equal(Array.isArray(groups),true);assert.equal(groups.length,3);
      const group=groups[0].id;
      const empty=await request(`/api/groups/${group}/messages?order=sequence_v1`);assert.equal(empty.status,200);const initial=await empty.json();assert.equal(initial.high_watermark,'0');assert.deepEqual(initial.messages,[]);
      const sent=await request(`/api/groups/${group}/messages`,{method:'POST',headers,body:JSON.stringify({content:'Synthetic startup ordering',content_type:'text',clientMessageId:randomUUID()})});assert.equal(sent.status,201);
      const message=await sent.json();assert.equal(message.server_order.sequence,'1');assert.equal(message.server_order.generation,initial.generation);
      const page=await(await request(`/api/groups/${group}/messages?order=sequence_v1`)).json();assert.equal(page.high_watermark,'1');assert.equal(page.messages.length,1);assert.equal(page.messages[0].id,message.id);
      if(provider){const observed=await(await fetch('http://127.0.0.1:3203/__agent/observations')).json();assert.deepEqual(observed.calls,[]);}
    } finally {if(child.exitCode===null) child.kill('SIGTERM');await closed;}
  });
}
test('Q1 startup retains the explicit CI guard before creating any listener or temporary installation',async()=>{
  const env={...process.env};for(const name of ['CI','GITHUB_ACTIONS','GITHUB_RUN_ID'])delete env[name];
  const result=spawnSync(process.execPath,['scripts/start-q1-backend.mjs'],{cwd,env,encoding:'utf8',timeout:5000});assert.equal(result.status,1);assert.match(result.stderr,/Local browser or listener execution is not permitted/);
  const source=await readFile(new URL('../scripts/start-q1-backend.mjs',import.meta.url),'utf8');
  assert.ok(source.indexOf('assertQ1CiRuntime();')<source.indexOf('await mkdtemp('));
  assert.ok(source.indexOf('await initializeEmptyInstallation();')<source.indexOf('provider.listen('));
  assert.ok(source.indexOf('await initializeEmptyInstallation();')<source.indexOf("await import('../../backend/src/index.js')"));
  assert.match(source,/const data = join\(root, 'data'\)/);assert.match(source,/const emptyEnv = join\(root, 'empty.env'\)/);
});
