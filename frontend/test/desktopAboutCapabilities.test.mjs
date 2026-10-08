import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { build } from 'esbuild';
import { resolve } from 'node:path';
const root=resolve(import.meta.dirname,'..'),win=new Window({url:'http://localhost/'});
Object.assign(globalThis,{window:win,document:win.document,HTMLElement:win.HTMLElement,Node:win.Node,Element:win.Element,requestAnimationFrame:fn=>setTimeout(fn,0),cancelAnimationFrame:clearTimeout,IS_REACT_ACT_ENVIRONMENT:true});
Object.defineProperty(globalThis,'navigator',{value:win.navigator,configurable:true});
Object.defineProperty(win.HTMLElement.prototype,'offsetWidth',{configurable:true,get(){return 100;}});
class Channel{port1={onmessage:null};port2={postMessage:()=>setTimeout(()=>this.port1.onmessage?.(),0)};}
Object.defineProperty(globalThis,'MessageChannel',{value:Channel,configurable:true});
const fixture=globalThis.__desktopAbout={models:[]};
const bundle=await build({stdin:{contents:`import {createRoot} from 'react-dom/client'; import {act} from 'react'; import {DesktopSettingsModal} from './src/components/Layout/DesktopSettingsModal';export {act}; export async function render(el,existing){const root=existing||createRoot(el);await act(async()=>root.render(<DesktopSettingsModal isOpen onClose={()=>{}}/>));return root;}`,resolveDir:root,sourcefile:'desktop-about.tsx',loader:'tsx'},bundle:true,format:'esm',platform:'browser',jsx:'automatic',write:false,define:{'import.meta.env':'{}'},plugins:[{name:'explicit-settings-fixtures',setup(build){
 const fixtures={themeStore:`export const useThemeStore=s=>s({theme:'light',setTheme:()=>{}});`,groupsStore:`export const useGroupsStore=s=>s({groups:[]});`,personasStore:`const fetchPersonas=async()=>{};export const usePersonasStore=s=>s({personas:{},loading:false,fetchPersonas});`,profileStore:`const fetchProfile=async()=>{};export const useProfileStore=s=>s({profile:{},fetchProfile});`,modelsStore:`export const useModelsStore=s=>s({catalog:{models:globalThis.__desktopAbout.models}});export const useChatModelIds=()=>[];`,useLocalCacheClear:`export const useLocalCacheClear=()=>({clear:()=>{},clearing:false,ConfirmModal:null});`,useModalAnimation:`export const useModalAnimation=(open,close)=>({isVisible:open,close,overlayClass:'',contentClass:''});`,common:`export const useToast=()=>({showToast:()=>{}});export const ErrorBoundary=({children})=>children;`,AIPersonaEditor:`export const AIPersonaEditor=()=>null;`,UserProfileEditor:`export const UserProfileEditor=()=>null;`,FontSizeToggle:`export const FontSizeSelector=()=>null;`,ModelCenter:`export const ModelCenter=()=>null;`};
 build.onResolve({filter:/stores\/(themeStore|groupsStore|personasStore|profileStore|modelsStore)$|hooks\/(useLocalCacheClear|useModalAnimation)$|^\.\/(AIPersonaEditor|UserProfileEditor|FontSizeToggle|ModelCenter)$|^\.\.\/Common$/},({path})=>({path:path==='../Common'?'common':path.split('/').at(-1),namespace:'fixture'}));
 build.onLoad({filter:/.*/,namespace:'fixture'},({path})=>({loader:'js',contents:fixtures[path]}));
}}]});
const {act,render}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
let container,mounted;const text=()=>container.textContent.replace(/\s+/g,' ');
async function show(){mounted=await render(container,mounted);await act(async()=>[...container.querySelectorAll('button')].find(b=>b.textContent==='关于').click());}
beforeEach(async()=>{if(mounted)await act(async()=>mounted.unmount());container?.remove();container=document.createElement('div');document.body.append(container);mounted=null;fixture.models=[];});
after(async()=>{if(mounted)await act(async()=>mounted.unmount());win.close();});
test('unverified catalog presets are directory entries, not available specialist capabilities',async()=>{fixture.models=[{id:'preset1',capabilities:['chat','vision']},{id:'preset2',capabilities:['tts'],verifiedCapabilities:[]}];await show();assert.match(text(),/2 个目录条目/);assert.match(text(),/已验证其他能力：0 个模型/);assert.doesNotMatch(text(),/专用AI：4|全模态分析|个已配置/);});
test('counts only models with a verified non-chat capability, once per model',async()=>{fixture.models=[{id:'chat',verifiedCapabilities:['chat']},{id:'image',verifiedCapabilities:['chat','vision']},{id:'voice',verifiedCapabilities:['tts','audio']},{id:'unverified',capabilities:['video'],verifiedCapabilities:[]}];await show();assert.match(text(),/4 个目录条目/);assert.match(text(),/已验证其他能力：2 个模型/);});
test('empty catalog renders zero without claiming specialist availability',async()=>{await show();assert.match(text(),/0 个目录条目/);assert.match(text(),/已验证其他能力：0 个模型/);});
