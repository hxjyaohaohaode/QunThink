import puppeteer from 'puppeteer-core';
import path from 'path';
import fs from 'fs';

const OUT = path.resolve(process.cwd(), '../../.runtime-logs/shots');
fs.mkdirSync(OUT, { recursive: true });

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = 'http://localhost:3010';

async function login(page) {
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await new Promise(r => setTimeout(r, 1800));
  const hasLogin = await page.$('input[placeholder="请输入手机号"]');
  if (!hasLogin) return false;
  await page.type('input[placeholder="请输入手机号"]', '13800000001', { delay: 10 });
  await page.type('input[placeholder="请输入密码"]', 'QunXiang#2026', { delay: 10 });
  await page.keyboard.press('Enter');
  await new Promise(r => setTimeout(r, 4000));
  return true;
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(OUT, name + '.png') });
  console.log('SHOT', name);
}

// 坐标点击：找到含指定文本的叶子元素，取其可点击祖先的包围盒中心
async function clickTextAt(page, text) {
  const box = await page.evaluate((t) => {
    const els = [...document.querySelectorAll('aside *, body *')];
    const el = els.filter(e => e.closest('aside') || e.closest('[class*="sidebar"]'))
      .find(e => e.children.length === 0 && e.textContent?.trim() === t);
    if (!el) return null;
    const target = el.closest('[class*="cursor-pointer"], button') || el;
    const r = target.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, text);
  if (!box) { console.log('MISS', text); return false; }
  await page.mouse.click(box.x, box.y);
  return true;
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
  await new Promise(r => setTimeout(r, 1500));

  // 自动选群应已生效：直接截主界面
  await shot(page, 'v3-auto-selected');

  // 若未选中（兜底），坐标点击第一个群
  const needClick = await page.evaluate(() => !document.querySelector('textarea'));
  if (needClick) {
    await clickTextAt(page, '智囊团会议室');
    await new Promise(r => setTimeout(r, 2500));
  }
  await shot(page, 'v3-group-chat');

  // 发消息
  const ta = await page.$('textarea');
  if (ta) {
    await ta.click();
    await ta.type('大家好，简单介绍一下你自己', { delay: 12 });
    await page.keyboard.press('Enter');
    await new Promise(r => setTimeout(r, 2000));
    await shot(page, 'v3-message-sent');
    await new Promise(r => setTimeout(r, 13000));
    await shot(page, 'v3-ai-replied');
  }

  // 群资料（点头部中央群名区）
  await page.evaluate(() => {
    const headerBtns = [...document.querySelectorAll('button')].filter(b => {
      const r = b.getBoundingClientRect();
      return r.y < 90 && r.x > 300 && (b.textContent || '').includes('智囊团');
    });
    headerBtns[0]?.click();
  });
  await new Promise(r => setTimeout(r, 2000));
  await shot(page, 'v3-group-info');
  await page.evaluate(() => {
    const t = [...document.querySelectorAll('button')].find(b => (b.textContent || '').trim() === '洞察');
    t?.click();
  });
  await new Promise(r => setTimeout(r, 2500));
  await shot(page, 'v3-insights');

  browser.close();
} catch (err) {
  console.error('FATAL', err.message);
  process.exitCode = 1;
}
