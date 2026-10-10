import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const cwd=fileURLToPath(new URL('..',import.meta.url));
function run(source,url){
 return spawnSync(process.execPath,['--input-type=module','-e',source],{
  cwd,encoding:'utf8',env:{...process.env,NODE_OPTIONS:'',QUNTHINK_TEST_PG_URL:url}
 });
}
test('plaintext test injection is exact-fixture-only and cannot override explicit CA tests',()=>{
 const out=run(`
  import assert from 'node:assert/strict';import pg from 'pg';
  import {configureLoopbackPgFixture} from './test/helpers/loopbackPgFixture.js';
  configureLoopbackPgFixture();
  const {buildPostgresTlsConfig}=await import('./src/models/postgresTls.js');
  const uri=process.env.SUPABASE_DB_URL;
  const config=buildPostgresTlsConfig(uri);
  assert.equal(new pg.Pool(config).options.ssl,false);
  for(const candidate of [
    {...config,ssl:{...config.ssl,ca:'negative-test-ca'}},
    {...config,ssl:{rejectUnauthorized:true,checkServerIdentity:()=>undefined}},
    {...config,port:'54328'},
    {...config,host:'example.invalid'}
  ]) assert.equal(new pg.Pool(candidate).options.ssl.rejectUnauthorized,true);
 `,'postgresql://fixture@127.0.0.1:54329/qunthink_fixture?sslmode=disable');
 assert.equal(out.status,0,out.stderr);
});
for(const url of ['postgresql://secret@[invalid', 'postgresql://postgres:secret@127.0.0.1:5432/qunthink_ci', 'postgresql://postgres:ci_test_only@127.0.0.1:5433/qunthink_ci', 'postgresql://fixture@example.invalid:54329/qunthink_fixture','postgresql://fixture@127.0.0.1:54329/production','postgresql://fixture:secret@127.0.0.1:54329/qunthink_fixture','postgresql://fixture@127.0.0.1:54329/qunthink_fixture?host=example.invalid']){
 test('test injection rejects non-fixture destination '+url.replace('secret','[redacted]'),()=>{
  const out=run(`import {configureLoopbackPgFixture} from './test/helpers/loopbackPgFixture.js';configureLoopbackPgFixture();`,url);
  assert.notEqual(out.status,0);assert.equal(out.stderr.includes('secret'),false);
 });
}

test('existing CI disposable fixture remains supported without a production exception',()=>{
 const out=run(`
  import assert from 'node:assert/strict';import pg from 'pg';
  import {configureLoopbackPgFixture} from './test/helpers/loopbackPgFixture.js';
  import {buildPostgresTlsConfig} from './src/models/postgresTls.js';
  configureLoopbackPgFixture();
  const config=buildPostgresTlsConfig(process.env.SUPABASE_DB_URL);
  assert.equal(config.ssl.rejectUnauthorized,true);
  assert.equal(new pg.Pool(config).options.ssl,false);
  assert.equal(new pg.Pool({...config,password:'other'}).options.ssl.rejectUnauthorized,true);
  assert.equal(new pg.Pool({...config,ssl:{...config.ssl,ca:'negative'}}).options.ssl.rejectUnauthorized,true);
 `,'postgresql://postgres:ci_test_only@127.0.0.1:5432/qunthink_ci');
 assert.equal(out.status,0,out.stderr);
});
