import puppeteer from 'puppeteer-core';
import path from 'path';
import fs from 'fs';

const OUT = path.resolve(process.cwd(), '../../.runtime-logs/shots');
fs.mkdirSync(OUT, { recursive: true });

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = 'http://localhost:3010';

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  laptop: { width: 1280, height: 800 },
  tablet: { width: 820, height: 1180 },
  phone: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
};

async function login(page) {
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await new Promise(r => setTimeout(r, 1200));
  // 已登录则跳过
  const hasLogin = await page.$('input[placeholder="请输入手机号"]');
  if (!hasLogin) return false;
  await page.type('input[placeholder="请输入手机号"]', '13800000001', { delay: 10 });
  await page.type('input[placeholder="请输入密码"]', 'QunXiang#2026', { delay: 10 });
  await page.keyboard.press('Enter');
  await new Promise(r => setTimeout(r, 3500));
  return true;
}

async function shot(page, name) {
  const file = path.join(OUT, name + '.png');
  await page.screenshot({ path: file });
  console.log('SHOT', name);
}

const scenarios = process.argv[2] || 'all';

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: 'new',
  args: ['--no-first-run', '--disable-gpu', '--hide-scrollbars', `--user-data-dir=${path.join(process.env.TEMP, 'edge-shots-' + Date.now())}`]
});

try {
  const vp = VIEWPORTS.desktop;
  const page = await browser.newPage();
  await page.setViewport({ width: vp.width, height: vp.height });

  if (scenarios === 'all' || scenarios.includes('login')) {
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 2500));
    await shot(page, 'login-desktop');
    await page.setViewport({ width: VIEWPORTS.phone.width, height: VIEWPORTS.phone.height, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await new Promise(r => setTimeout(r, 1500));
    await shot(page, 'login-phone');
    await page.setViewport(vp);
    await new Promise(r => setTimeout(r, 800));
  }

  await login(page);

  if (scenarios === 'all' || scenarios.includes('main')) {
    await new Promise(r => setTimeout(r, 1500));
    await shot(page, 'chat-desktop');
    // 点击第一个会话（若有）
    const groupItem = await page.$('[class*="group-item"], [data-group-id], aside button');
    if (groupItem) { await groupItem.click().catch(() => {}); await new Promise(r => setTimeout(r, 2000)); await shot(page, 'chat-opened'); }
  }

  if (scenarios === 'all' || scenarios.includes('palette')) {
    await page.keyboard.down('Control');
    await page.keyboard.press('k');
    await page.keyboard.up('Control');
    await new Promise(r => setTimeout(r, 700));
    await shot(page, 'command-palette');
    await page.keyboard.press('Escape');
  }

  browser.close();
} catch (err) {
  console.error('FATAL', err.message);
  process.exitCode = 1;
}
