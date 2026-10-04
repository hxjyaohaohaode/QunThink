import test from 'node:test';
import assert from 'node:assert/strict';
import { pickWorkspaceNavigationState as choose } from '../scripts/q1-navigation.mjs';
const empty={workspace:false,writingClose:false,mobileWorkspace:false,mobileBack:false,desktopBack:false};
test('reload loading state waits instead of assuming a nonexistent Back button',()=>{assert.equal(choose(empty,true),'waiting');assert.equal(choose({...empty,workspace:true,mobileWorkspace:true},true),'workspace');});
test('mobile chat and main tab each use their actually visible navigation control',()=>{assert.equal(choose({...empty,mobileBack:true},true),'mobile-chat');assert.equal(choose({...empty,mobileWorkspace:true},true),'mobile-home');assert.equal(choose({...empty,mobileWorkspace:true,mobileBack:true},true),'mobile-home');});
test('an open writing sheet must close through its own control before underlying navigation',()=>{assert.equal(choose({...empty,writingClose:true,mobileBack:true},true),'close-writing');});
test('desktop readiness does not infer a mobile route and the target view takes precedence',()=>{assert.equal(choose({...empty,mobileBack:true},false),'waiting');assert.equal(choose({...empty,desktopBack:true},false),'desktop-chat');assert.equal(choose({...empty,workspace:true,desktopBack:true},false),'workspace');});
