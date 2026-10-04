import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { pickWorkspaceNavigationState as choose, sessionRetryAt, CONTEXT_DISCLOSURE } from '../scripts/q1-navigation.mjs';
const empty={workspace:false,writingClose:false,mobileWorkspace:false,mobileBack:false,desktopBack:false};
test('reload loading state waits instead of assuming a nonexistent Back button',()=>{assert.equal(choose(empty,true),'waiting');assert.equal(choose({...empty,workspace:true,mobileWorkspace:true},true),'workspace');});
test('mobile chat and main tab each use their actually visible navigation control',()=>{assert.equal(choose({...empty,mobileBack:true},true),'mobile-chat');assert.equal(choose({...empty,mobileWorkspace:true},true),'mobile-home');assert.equal(choose({...empty,mobileWorkspace:true,mobileBack:true},true),'mobile-home');});
test('an open writing sheet must close through its own control before underlying navigation',()=>{assert.equal(choose({...empty,writingClose:true,mobileBack:true},true),'close-writing');});
test('desktop readiness does not infer a mobile route and the target view takes precedence',()=>{assert.equal(choose({...empty,mobileBack:true},false),'waiting');assert.equal(choose({...empty,desktopBack:true},false),'desktop-chat');assert.equal(choose({...empty,workspace:true,desktopBack:true},false),'workspace');});
test('a visible session recovery control is handled before assuming conversation navigation',()=>{assert.equal(choose({...empty,sessionRetry:true},true),'session-retry');assert.equal(choose({...empty,sessionRetry:true,mobileBack:true},true),'session-retry');assert.equal(choose({...empty,sessionRetry:true,workspace:true},true),'workspace');});
test('session wait comes only from bounded server Retry-After seconds or date',()=>{const now=Date.parse('2026-10-04T23:11:25Z');assert.equal(sessionRetryAt('15',now),now+15000);assert.equal(sessionRetryAt('0',now),now);assert.equal(sessionRetryAt('Sun, 04 Oct 2026 23:11:40 GMT',now),now+15000);for(const value of ['',null,'garbage','-1','121','Sun, 04 Oct 2026 23:11:24 GMT'])assert.equal(sessionRetryAt(value,now),null);});

test('context disclosure uniquely targets its own summary even with four nested material disclosures',()=>{
 const window=new Window();window.document.body.innerHTML='<details class="writing-context"><summary id="context-summary">用途与来源</summary><ol>'+Array.from({length:4},(_,i)=>`<li data-source-id="test-${i}"><details><summary>查看这条材料全文</summary><p>资料${i}</p></details></li>`).join('')+'</ol></details>';
 const context=window.document.querySelector('.writing-context');assert.equal(context.querySelectorAll('summary').length,5);const matches=context.querySelectorAll(CONTEXT_DISCLOSURE);assert.equal(matches.length,1);assert.equal(matches[0].id,'context-summary');matches[0].click();assert.equal(context.open,true);assert.equal([...context.querySelectorAll('li details')].some(item=>item.open),false);window.close();
});
