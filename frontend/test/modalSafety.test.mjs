import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { build } from 'esbuild';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const window = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, Node: window.Node, Element: window.Element, requestAnimationFrame: fn => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
Object.defineProperty(window.HTMLElement.prototype, 'offsetWidth', { configurable:true, get() { return this.hidden ? 0 : 100; } });
class Channel { port1 = { onmessage: null }; port2 = { postMessage: () => setTimeout(() => this.port1.onmessage?.(), 0) }; }
Object.defineProperty(globalThis, 'MessageChannel', { value: Channel, configurable: true });
after(() => window.close());
globalThis.__modalTest = { reduced: true, close: 0, answers: [] };
const bundled = await build({ stdin: { contents: `
import { createRoot } from 'react-dom/client'; import { act, useState } from 'react';
import { useModalAnimation } from './src/hooks/useModalAnimation';
import { useConfirm } from './src/components/Common/useConfirm';
import { ConfirmModal } from './src/components/Common/ConfirmModal';
import { useFocusTrap } from './src/components/Common/useFocusTrap';
export { act };
function ConfirmHarness() { const {confirm,ConfirmModal} = useConfirm(); globalThis.__modalTest.ask = title => confirm({title}).then(answer => globalThis.__modalTest.answers.push([title,answer])); return ConfirmModal; }
function AnimationHarness({open}) { const modal=useModalAnimation(open,()=>globalThis.__modalTest.close++); return <div data-visible={modal.isVisible} data-closing={modal.isClosing}/>; }
function Trap({name,onClose,children}) { const ref=useFocusTrap(true,onClose); return <div ref={ref} data-trap={name}>{children}</div>; }
function TrapHarness({nested}) { return <Trap name="outer" onClose={()=>globalThis.__modalTest.outer++}><button>first</button><fieldset disabled><button>disabled</button></fieldset><button>last</button>{nested&&<Trap name="inner" onClose={()=>globalThis.__modalTest.inner++}><button>nested</button></Trap>}</Trap>; }
const components={confirm:ConfirmHarness,animation:AnimationHarness,trap:TrapHarness,direct:ConfirmModal};
export async function render(element,name,props={},existing) { const root=existing||createRoot(element); const Component=components[name]; await act(async()=>root.render(<Component {...props}/>)); return root; }
`, resolveDir:root, sourcefile:'modal-safety.tsx', loader:'tsx' }, bundle:true, format:'esm', platform:'browser', jsx:'automatic', write:false,
plugins:[{name:'reduced-motion',setup(build) { build.onResolve({filter:/useReducedMotion$/},()=>({path:'reduced',namespace:'mock'})); build.onLoad({filter:/.*/,namespace:'mock'},()=>({contents:'export const useReducedMotion = () => globalThis.__modalTest.reduced;',loader:'js'})); }}] });
const {act,render}=await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
let container,mounted;
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const button=text=>[...container.querySelectorAll('button')].find(el=>el.textContent===text);
async function flush(ms=5) { await act(async()=>{await wait(ms);}); }
async function key(value,shift=false) { await act(async()=>document.dispatchEvent(new window.KeyboardEvent('keydown',{key:value,shiftKey:shift,bubbles:true,cancelable:true}))); }
beforeEach(async()=>{if(mounted)await act(async()=>mounted.unmount());container?.remove();container=document.createElement('div');document.body.append(container);mounted=null;Object.assign(globalThis.__modalTest,{reduced:true,close:0,answers:[],outer:0,inner:0});});
after(async()=>{if(mounted)await act(async()=>mounted.unmount());});

test('replacing an in-flight confirmation cancels the old intent, including its exit timer',async()=>{
 globalThis.__modalTest.reduced=false; mounted=await render(container,'confirm');
 await act(async()=>{void globalThis.__modalTest.ask('first');});
 await act(async()=>button('确认').click());
 await act(async()=>{void globalThis.__modalTest.ask('second');});
 await flush();
 assert.deepEqual(globalThis.__modalTest.answers,[['first',false]]);
 assert.equal(container.querySelector('[role="dialog"]').getAttribute('aria-label'),'second');
 await act(async()=>button('取消').click()); await flush(180);
 assert.deepEqual(globalThis.__modalTest.answers,[['first',false],['second',false]]);
});
test('unmount cancels an unanswered confirmation promise',async()=>{
 mounted=await render(container,'confirm'); await act(async()=>{void globalThis.__modalTest.ask('pending');});
 await act(async()=>mounted.unmount());mounted=null;await flush(); assert.deepEqual(globalThis.__modalTest.answers,[['pending',false]]);
});
test('same-frame double confirm invokes one callback and loading blocks all dismissal',async()=>{
 let confirmed=0,cancelled=0;const props={visible:true,title:'approve',description:'details',onConfirm:()=>confirmed++,onCancel:()=>cancelled++};
 mounted=await render(container,'direct',props);
 await act(async()=>{button('确认').click();button('确认').click();});await flush();assert.equal(confirmed,1);
 mounted=await render(container,'direct',{...props,visible:false},mounted);mounted=await render(container,'direct',{...props,loading:true},mounted);
 await key('Escape');await act(async()=>container.firstElementChild.click());await flush(); assert.equal(cancelled,0);assert.equal(confirmed,1);
 assert.ok(document.getElementById(container.querySelector('[role="dialog"]').getAttribute('aria-describedby')));
});
test('focus cycles past fieldset-disabled controls and only the top dialog receives Escape',async()=>{
 const trigger=document.createElement('button');document.body.append(trigger);trigger.focus();
 mounted=await render(container,'trap',{nested:false});assert.equal(document.activeElement.textContent,'first');
 button('last').focus();await key('Tab');assert.equal(document.activeElement.textContent,'first');
 await key('Tab',true);assert.equal(document.activeElement.textContent,'last');
 mounted=await render(container,'trap',{nested:true},mounted);await key('Escape');assert.equal(globalThis.__modalTest.inner,1);assert.equal(globalThis.__modalTest.outer,0);
 mounted=await render(container,'trap',{nested:false},mounted);assert.equal(document.activeElement.textContent,'last');await key('Escape');assert.equal(globalThis.__modalTest.outer,1);
 await act(async()=>mounted.unmount());mounted=null;assert.equal(document.activeElement,trigger);trigger.remove();
});
test('rapid close and reopen does not let an earlier exit timer hide a dialog',async()=>{
 globalThis.__modalTest.reduced=false;mounted=await render(container,'animation',{open:true});await flush();
 mounted=await render(container,'animation',{open:false},mounted);assert.equal(container.firstElementChild.dataset.closing,'true');
 mounted=await render(container,'animation',{open:true},mounted);await flush(180);assert.equal(container.firstElementChild.dataset.visible,'true');assert.equal(container.firstElementChild.dataset.closing,'false');
});
test('reduced motion removes the delayed close',async()=>{
 mounted=await render(container,'animation',{open:true});mounted=await render(container,'animation',{open:false},mounted);await flush();assert.equal(container.firstElementChild.dataset.visible,'false');
});

test('simultaneously mounted nested dialogs keep the inner trap on top and restore the external trigger',async()=>{
 const trigger=document.createElement('button');document.body.append(trigger);trigger.focus();
 mounted=await render(container,'trap',{nested:true});assert.equal(document.activeElement.textContent,'nested');await key('Escape');assert.equal(globalThis.__modalTest.inner,1);assert.equal(globalThis.__modalTest.outer,0);
 mounted=await render(container,'trap',{nested:false},mounted);assert.equal(document.activeElement.textContent,'first');await act(async()=>mounted.unmount());mounted=null;assert.equal(document.activeElement,trigger);trigger.remove();
});
