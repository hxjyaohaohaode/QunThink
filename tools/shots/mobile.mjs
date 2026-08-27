import puppeteer from 'puppeteer-core';
import path from 'path';
import fs from 'fs';

const OUT = path.resolve(process.cwd(), '../../.runtime-logs/shots');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: 'new',
  args: ['--no-first-run', '--disable-gpu', '--hide-scrollbars', `--user-data-dir=${path.join(process.env.TEMP, 'edge-mob-' + Date.now())}`]
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await page.goto('http://localhost:3010/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await new Promise(r => setTimeout(r, 2000));
  const hasLogin = await page.$('input[placeholder="请输入手机号"]');
  if (hasLogin) {
    await page.type('input[placeholder="请输入手机号"]', '13800000001', { delay: 8 });
    await page.type('input[placeholder="请输入密码"]', 'QunXiang#2026', { delay: 8 });
    await page.keyboard.press('Enter');
    await new Promise(r => setTimeout(r, 5000));
  }
  await page.screenshot({ path: path.join(OUT, 'final-mobile.png') });
  console.log('SHOT final-mobile');
  await browser.close();
} catch (err) {
  console.error('FATAL', err.message);
  process.exitCode = 1;
}
