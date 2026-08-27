import puppeteer from 'puppeteer-core';
import path from 'path';
import fs from 'fs';

const OUT = path.resolve(process.cwd(), '../../.runtime-logs/shots');
fs.mkdirSync(OUT, { recursive: true });

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = 'http://localhost:3010';

async function login(page) {
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await new Promise(r => setTimeout(r, 1500));
  const hasLogin = await page.$('input[placeholder="请输入手机号"]');
  if (!hasLogin) return false;
  await page.type('input[placeholder="请输入手机号"]', '13800000001', { delay: 10 });
  await page.type('input[placeholder="请输入密码"]', 'QunXiang#2026', { delay: 10 });
  await page.keyboard.press('Enter');
  await new Promise(r => setTimeout(r, 3500));
  return true;
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(OUT, name + '.png') });
  console.log('SHOT', name);
}

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: 'new',
  args: ['--no-first-run', '--disable-gpu', '--hide-scrollbars', `--user-data-dir=${path.join(process.env.TEMP, 'edge-shots-' + Date.now())}`]
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await login(page);
  await new Promise(r => setTimeout(r, 1000));

  // 1) 展开侧边栏（title 选择器，精确）
  const expandBtn = await page.$('button[title="展开侧栏"]');
  if (expandBtn) { await expandBtn.click(); await new Promise(r => setTimeout(r, 900)); }
  await shot(page, 'v2-sidebar-expanded');

  // 2) 进入第一个群（侧栏内文本匹配）
  await page.evaluate(() => {
    const els = [...document.querySelectorAll('aside span, aside div, aside p')];
    const target = els.find(e => e.textContent?.trim() === '智囊团会议室' && e.children.length === 0);
    target?.closest('div[class*="cursor-pointer"], button, div')?.click();
  });
  await new Promise(r => setTimeout(r, 2500));
  await shot(page, 'v2-group-chat');

  // 3) 发消息
  const ta = await page.$('textarea[placeholder], textarea');
  if (ta) {
    await ta.click();
    await ta.type('大家好，简单介绍一下你自己', { delay: 12 });
    await new Promise(r => setTimeout(r, 400));
    await shot(page, 'v2-message-typed');
    await page.keyboard.press('Enter');
    await new Promise(r => setTimeout(r, 2000));
    await shot(page, 'v2-message-sent');
    await new Promise(r => setTimeout(r, 12000));
    await shot(page, 'v2-ai-replied');
  } else {
    console.log('NO TEXTAREA FOUND');
  }

  // 4) 命令面板
  await page.keyboard.down('Control'); await page.keyboard.press('k'); await page.keyboard.up('Control');
  await new Promise(r => setTimeout(r, 600));
  await shot(page, 'v2-palette');
  await page.keyboard.press('Escape');
  await new Promise(r => setTimeout(r, 400));

  // 5) 群资料 → 洞察：点头部的群名/信息区（ChatHeader 顶部中央）
  await page.evaluate(() => {
    const candidates = [...document.querySelectorAll('header button, header div[class*="cursor"], [class*="ChatHeader"] button')];
    const info = candidates.find(b => (b.textContent || '').includes('智囊团')) || candidates[0];
    info?.click();
  });
  await new Promise(r => setTimeout(r, 2000));
  await shot(page, 'v2-group-info');

  // 若群资料已开，点洞察 tab
  await page.evaluate(() => {
    const tabs = [...document.querySelectorAll('button, [role="tab"]')];
    const t = tabs.find(b => (b.textContent || '').trim() === '洞察');
    t?.click();
  });
  await new Promise(r => setTimeout(r, 2200));
  await shot(page, 'v2-insights');

  browser.close();
} catch (err) {
  console.error('FATAL', err.message);
  process.exitCode = 1;
}
