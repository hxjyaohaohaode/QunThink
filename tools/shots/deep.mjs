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

// 在指定容器内点击包含文本的元素
async function clickText(page, text, scopeSelector = 'body') {
  return page.evaluate((t, scope) => {
    const root = document.querySelector(scope) || document.body;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.children.length === 0 && node.textContent?.trim() === t) {
        node.closest('button, [role="button"], a, div[class*="cursor-pointer"]')?.click();
        return true;
      }
    }
    return false;
  }, text, scopeSelector);
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
  await new Promise(r => setTimeout(r, 1200));

  // 1) 展开侧边栏：左栏第4个按钮（»）
  await page.evaluate(() => {
    const rail = document.querySelector('aside') || document.body;
    const btns = [...rail.querySelectorAll('button')];
    // 找含两个 chevron svg 的按钮（展开图标）
    const expand = btns.find(b => b.querySelectorAll('svg').length >= 1 && (b.getAttribute('class') || '').includes('justify-center'));
    (expand || btns[3])?.click();
  });
  await new Promise(r => setTimeout(r, 900));
  await shot(page, 'sidebar-expanded');

  // 2) 进入第一个群
  await clickText(page, '智囊团会议室');
  await new Promise(r => setTimeout(r, 2200));
  await shot(page, 'group-chat');

  // 3) 发一条消息看 AI 响应与气泡样式
  const ta = await page.$('textarea');
  if (ta) {
    await ta.type('大家好，介绍一下自己吧', { delay: 15 });
    await page.keyboard.press('Enter');
    await new Promise(r => setTimeout(r, 2500));
    await shot(page, 'message-sent');
    await new Promise(r => setTimeout(r, 9000));
    await shot(page, 'ai-replied');
  }

  // 4) 命令面板
  await page.keyboard.down('Control'); await page.keyboard.press('k'); await page.keyboard.up('Control');
  await new Promise(r => setTimeout(r, 600));
  await shot(page, 'palette');
  await page.keyboard.press('Escape');
  await new Promise(r => setTimeout(r, 400));

  // 5) 打开群资料（洞察Tab）：点头部群名
  await page.evaluate(() => {
    const header = document.querySelector('[class*="ChatHeader"], header');
    if (header) header.querySelector('div[class*="cursor-pointer"], button')?.click();
  });
  await new Promise(r => setTimeout(r, 1800));
  await shot(page, 'group-info');
  await clickText(page, '洞察');
  await new Promise(r => setTimeout(r, 2000));
  await shot(page, 'insights-tab');

  browser.close();
} catch (err) {
  console.error('FATAL', err.message);
  process.exitCode = 1;
}
