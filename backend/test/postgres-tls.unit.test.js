import test from 'node:test';
import assert from 'node:assert/strict';
import { rootCertificates } from 'node:tls';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { buildPostgresTlsConfig } from '../src/models/postgresTls.js';
const base = 'postgresql://offline:secret-canary@db.example.invalid:5432/postgres';

for (const flags of ['', 'sslmode=verify-full', 'sslmode=require', 'sslmode=prefer', 'sslmode=verify-ca', 'ssl=true', 'ssl=1', 'application_name=tls-unit&sslmode=verify-full']) {
  test(`strict TLS retained for ${flags || 'default'}`, () => {
    const cfg=buildPostgresTlsConfig(base+(flags?'?'+flags:''));
    assert.equal(Object.hasOwn(cfg,'connectionString'),false);
    const ssl=new pg.Client(cfg).connectionParameters.ssl;
    assert.equal(ssl.rejectUnauthorized,true);
    assert.equal(typeof ssl.checkServerIdentity,'function');
    assert.equal(Object.hasOwn(ssl,'ca'),false);
  });
}
for (const flags of ['sslmode=disable','sslmode=no-verify','ssl=no-verify','ssl=0','ssl=false','uselibpqcompat=true','sslmode=require&uselibpqcompat=true','sslrootcert=/private/secret-canary','sslcert=/private/secret-canary','sslkey=/private/secret-canary','SSLMode=disable','sslmode=verify-full&sslmode=disable','sslmode=disable&sslmode=verify-full','sslnegotiation=direct','%73slmode=no-verify','connectionString=postgresql%3A%2F%2Fsecret-canary%40evil.invalid%2Fdb%3Fsslmode%3Ddisable']) {
  test(`fails closed for ${flags}`, () => {
    assert.throws(()=>buildPostgresTlsConfig(base+'?'+flags), error => {
      assert.equal(error.code,'POSTGRES_TLS_CONFIG_INVALID');
      assert.equal(error.message.includes('secret-canary'),false);
      assert.equal(error.cause,undefined); return true;
    });
  });
}
test('explicit CA survives pg parsing; malformed config never includes credentials or file paths', () => {
  const dir=mkdtempSync(path.join(tmpdir(),'qunthink-tls-'));
  try {
    const file=path.join(dir,'ca.pem');writeFileSync(file,rootCertificates[0]);
    const cfg=buildPostgresTlsConfig(base+'?sslmode=verify-full',file);
    assert.equal(Object.hasOwn(cfg,'connectionString'),false);
    const ssl=new pg.Client(cfg).connectionParameters.ssl;
    assert.equal(ssl.ca,rootCertificates[0]); assert.equal(ssl.rejectUnauthorized,true);
    for (const text of ['garbage','-----BEGIN PRIVATE KEY-----\nsecret-canary\n-----END PRIVATE KEY-----',rootCertificates[0]+rootCertificates[1]]) {
      writeFileSync(file,text);assert.throws(()=>buildPostgresTlsConfig(base,file),{code:'POSTGRES_TLS_CONFIG_INVALID'});
    }
    for (const [uri,ca] of [['postgres://secret-canary@%invalid/',undefined],['https://example.invalid/',undefined],[base,path.join(dir,'secret-canary')]]) {
      assert.throws(()=>buildPostgresTlsConfig(uri,ca), error => !JSON.stringify(error).includes('secret-canary') && !error.message.includes('secret-canary'));
    }
  } finally {rmSync(dir,{recursive:true,force:true});}
});
test('production adapter rejects downgrade before Pool construction even in test mode', async () => {
  const old=pg.Pool,oldUrl=process.env.SUPABASE_DB_URL,oldMode=process.env.NODE_ENV;
  let constructed=false;
  pg.Pool=class {constructor(){constructed=true;throw new Error('must not be called');}};
  process.env.SUPABASE_DB_URL=base+'?sslmode=no-verify';process.env.NODE_ENV='test';
  try {
    const {getPool}=await import('../src/models/supabaseAdapter.js?tls-regression');
    await assert.rejects(getPool(),{code:'POSTGRES_TLS_CONFIG_INVALID'});
    assert.equal(constructed,false);
  } finally {
    pg.Pool=old;
    if(oldUrl===undefined)delete process.env.SUPABASE_DB_URL;else process.env.SUPABASE_DB_URL=oldUrl;
    if(oldMode===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=oldMode;
  }
});

test('connection failure propagated to callers and logs never exposes original message', async () => {
  const old=pg.Pool,oldUrl=process.env.SUPABASE_DB_URL,oldConsole=console.error;
  const logs=[];
  pg.Pool=class { on() {} async connect(){throw Object.assign(new Error(base),{code:'ECONNREFUSED'});} async end(){} };
  process.env.SUPABASE_DB_URL=base;
  console.error=(...args)=>logs.push(args.join(' '));
  try {
    const {getPool}=await import('../src/models/supabaseAdapter.js?redaction-regression');
    await assert.rejects(getPool(), error => {
      assert.equal(error.code,'ECONNREFUSED');assert.equal(error.cause,undefined);
      assert.equal(error.message.includes('secret-canary'),false);return true;
    });
    assert.equal(logs.join('\n').includes('secret-canary'),false);
  } finally {
    console.error=oldConsole;pg.Pool=old;
    if(oldUrl===undefined)delete process.env.SUPABASE_DB_URL;else process.env.SUPABASE_DB_URL=oldUrl;
  }
});

test('non-connection query keys cannot inject Pool constructors or prototype fields', () => {
  const cfg=buildPostgresTlsConfig(base+'?Client=unsafe&Promise=unsafe&__proto__=unsafe&constructor=unsafe');
  assert.equal(Object.hasOwn(cfg,'Client'),false);assert.equal(Object.hasOwn(cfg,'Promise'),false);
  assert.equal(Object.hasOwn(cfg,'__proto__'),false);assert.equal(Object.hasOwn(cfg,'constructor'),false);
  assert.equal(new pg.Client(cfg).connectionParameters.ssl.rejectUnauthorized,true);
});

test('hostname verifier is bound to the effective host even when pg supplies localhost for an IP',()=>{
 for (const flags of ['', 'sslmode=verify-full', 'sslmode=require', 'sslmode=prefer', 'sslmode=verify-ca']) {
  const cfg=buildPostgresTlsConfig('postgresql://offline:dummy@127.0.0.1:5432/postgres'+(flags?'?'+flags:''));
  const verify=cfg.ssl.checkServerIdentity;
  assert.equal(verify('localhost',{subjectaltname:'DNS:localhost'}).code,'ERR_TLS_CERT_ALTNAME_INVALID');
  assert.equal(verify('localhost',{subjectaltname:'IP Address:127.0.0.1'}),undefined);
  assert.equal(verify('localhost',{subjectaltname:'IP Address:127.0.0.2'}).code,'ERR_TLS_CERT_ALTNAME_INVALID');
 }
 const cfg=buildPostgresTlsConfig(base+'?host=actual.example.invalid');
 assert.equal(cfg.ssl.checkServerIdentity('db.example.invalid',{subjectaltname:'DNS:db.example.invalid'}).code,'ERR_TLS_CERT_ALTNAME_INVALID');
 assert.equal(cfg.ssl.checkServerIdentity('ignored',{subjectaltname:'DNS:actual.example.invalid'}),undefined);
});
