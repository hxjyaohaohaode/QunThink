import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { Window } from 'happy-dom';

const root = resolve(import.meta.dirname, '..');
const window = new Window({ url: 'http://localhost/' });
let frameId = 0;
const frames = new Map();
const requestFrame = fn => { const id = ++frameId; frames.set(id, fn); return id; };
const cancelFrame = id => frames.delete(id);
Object.assign(globalThis, {
  window, document: window.document, localStorage: window.localStorage,
  HTMLElement: window.HTMLElement, Element: window.Element, SVGElement: window.SVGElement,
  Node: window.Node, getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: requestFrame, cancelAnimationFrame: cancelFrame,
  IS_REACT_ACT_ENVIRONMENT: true,
});
window.requestAnimationFrame = requestFrame; window.cancelAnimationFrame = cancelFrame;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
class Channel {
  port1 = { onmessage: null };
  port2 = { postMessage: () => setTimeout(() => this.port1.onmessage?.(), 0) };
}
Object.defineProperty(globalThis, 'MessageChannel', { value: Channel, configurable: true });
const source = await readFile(resolve(root, 'src/App.tsx'), 'utf8');
function section(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `Production mobile boundary found: ${start}`);
  return source.slice(a, b);
}
// Execute App's actual mobile markup and navigation handlers with real React,
// Zustand and Framer Motion. Only page contents/network boundaries are stubs.
const transitions = section('const viewTransitionVariants =', '\ntype BootstrapPayload');
const handlers = section('  const navigateToView =', '\n  const shouldEnableSwipe');
const mobile = section('      {isMobileLayout && <div className="relative h-full overflow-hidden"', '\n      {showAgentCreate &&');
const routeDeclaration = source.includes('  const mobileRoute =')
  ? section('  const mobileRoute =', '\n\n') : '';
const state = globalThis.__mobileNavigationTest = { warnings: [] };
const bundled = await build({
  stdin: { sourcefile: 'mobile-navigation-test.tsx', resolveDir: root, loader: 'tsx', contents: `
    import { createRoot } from 'react-dom/client';
    import { act, useState, useRef, useCallback, useEffect } from 'react';
    import { create } from 'zustand';
    import { motion, AnimatePresence } from 'framer-motion';
    import { useNavigationStore } from './src/stores/navigationStore';
    import { MobileTabBar } from './src/components/Layout/MobileTabBar';
    ${source.includes("from './utils/mobileNavigation'") ? "import { resolveMobileRoute, mobileRouteKey } from './src/utils/mobileNavigation';" : ''}
    export { act, useNavigationStore };
    const useGroupsStore = create(set => ({ currentGroup: null,
      selectGroup: id => set({ currentGroup: id ? { id, ai_members: [] } : null }) }));
    const joinGroup = () => {};
    const LazyBoundary = ({ children }) => children;
    const WorkspacePage = ({ onOpenConversation }) => <div data-screen="workspace"><button onClick={() => onOpenConversation('synthetic-group')}>Open conversation</button></div>;
    const ChatList = ({ onSelectGroup }) => <div data-screen="chats"><button onClick={() => onSelectGroup('synthetic-group')}>Open conversation</button></div>;
    const SettingsPage = () => <div data-screen="settings"/>;
    const AgentsPage = ({ onSelectAgent }) => <div data-screen="agents"><button onClick={() => onSelectAgent('synthetic-agent')}>Open agent</button></div>;
    const AgentChatView = ({ onBack }) => <div data-screen="agentChat"><button onClick={onBack}>Back</button></div>;
    const ConversationWriting = ({ children }) => children;
    const ChatHeader = ({ onBack, onToggleGroupInfo }) => <div data-screen="chat"><button onClick={onBack}>Back</button><button onClick={onToggleGroupInfo}>Group info</button></div>;
    const GroupInfoPage = ({ onClose }) => <div data-screen="groupInfo"><button onClick={onClose}>Back</button></div>;
    const ChatModelNotice = () => null, MessageList = () => null, MessageInput = () => null, ObserverControlPanel = () => null;
    ${transitions}
    function Harness({ reducedMotion }) {
      const mobileTab = useNavigationStore(s => s.activeMobileTab);
      const setMobileTab = useNavigationStore(s => s.setActiveMobileTab);
      const [mobileView, setMobileView] = useState('main');
      const [selectedAgentId, setSelectedAgentId] = useState(null);
      const currentGroup = useGroupsStore(s => s.currentGroup);
      const mobileViewRef = useRef(mobileView); mobileViewRef.current = mobileView;
      const prevViewRef = useRef('main'), mobileTransitionDirRef = useRef(1);
      const isMobileLayout = true, swipeProgress = 0, swipeHandlers = {};
      const setShowNewChatModal = () => {}, setShowAgentCreate = () => {};
      ${handlers}
      ${routeDeclaration}
      return <>${mobile}</>;
    }
    export async function render(container, reducedMotion) {
      useGroupsStore.setState({ currentGroup: null });
      useNavigationStore.setState({ activeMobileTab: 'workspace', activeDesktopView: 'workspace', isTransitioning: false });
      const root = createRoot(container);
      await act(async () => root.render(<Harness reducedMotion={reducedMotion}/>));
      return root;
    }
  ` },
  bundle: true, format: 'esm', platform: 'browser', jsx: 'automatic', write: false,
});
const { act, render, useNavigationStore } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const originalWarn = console.warn;
console.warn = (...args) => { state.warnings.push(args.join(' ')); };
let container, mounted;
const button = text => {
  const found = [...container.querySelectorAll('button')].find(el => el.textContent.trim().replace(/\s+/g, ' ') === text);
  assert.ok(found, `Missing button ${text}; screens: ${screens().join(', ')}`); return found;
};
const screens = () => [...container.querySelectorAll('[data-screen]')].map(el => el.dataset.screen);
const click = async text => act(async () => button(text).click());
async function frame() {
  await new Promise(resolve => setTimeout(resolve, 16));
  await act(async () => {
    const pending = [...frames.values()]; frames.clear();
    for (const fn of pending) fn(performance.now());
  });
}
async function settle() { for (let i = 0; i < 35; i++) await frame(); }
function assertSingleScreen(expected) {
  assert.deepEqual(screens(), [expected]);
  assert.deepEqual(state.warnings.filter(message => message.includes('multiple children within AnimatePresence')), []);
}
beforeEach(async () => {
  if (mounted) await act(async () => mounted.unmount());
  container?.remove(); mounted = null;
  for (let i = 0; i < 5; i++) await frame();
  state.warnings = [];
  container = document.createElement('div'); document.body.append(container);
});
after(async () => {
  if (mounted) await act(async () => mounted.unmount());
  console.warn = originalWarn; frames.clear(); window.close();
});

for (const reduced of [false, true]) {
  test(`mobile conversation Back followed by Workspace keeps one active view (reduced=${reduced})`, async () => {
    mounted = await render(container, reduced); await settle(); assertSingleScreen('workspace');
    await click('Open conversation'); await settle(); assert.deepEqual(screens(), ['chat']);
    await click('Back');
    // The tab is interactive immediately, before the outgoing view has finished.
    await click('⌘工作台');
    await settle(); assertSingleScreen('workspace');
  });
  test(`mobile agents and external workspace navigation remain exclusive (reduced=${reduced})`, async () => {
    mounted = await render(container, reduced); await settle();
    await click('智能体'); await settle(); assert.deepEqual(screens(), ['agents']);
    await click('Open agent'); await settle(); assert.deepEqual(screens(), ['agentChat']);
    await act(async () => useNavigationStore.getState().setActiveMobileTab('workspace'));
    await settle(); assertSingleScreen('workspace');
  });
  test(`rapid mobile tab reversal preserves the latest choice (reduced=${reduced})`, async () => {
    mounted = await render(container, reduced); await settle();
    await click('智能体'); await click('设置'); await click('⌘工作台');
    await settle(); assertSingleScreen('workspace');
  });
  test(`group details return and external chat navigation do not retain another tab's view (reduced=${reduced})`, async () => {
    mounted = await render(container, reduced); await settle();
    await click('Open conversation'); await settle();
    await click('Group info'); await settle(); assert.deepEqual(screens(), ['groupInfo']);
    await click('Back'); await settle(); assert.deepEqual(screens(), ['chat']);
    await click('Back'); await click('智能体'); await settle();
    await act(async () => useNavigationStore.getState().setActiveMobileTab('chats'));
    await settle(); assertSingleScreen('chats');
  });
}
