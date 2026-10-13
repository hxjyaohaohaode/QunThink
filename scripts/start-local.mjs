// One foreground process owns both local services. Ctrl+C stops both children.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import net from 'node:net';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.some(arg => arg !== '--isolated' && arg !== '--help')) {
  console.error('用法：node scripts/start-local.mjs [--isolated]'); process.exit(2);
}
if (args.includes('--help')) {
  console.log('node scripts/start-local.mjs：使用 backend/data 和 backend/.env。\n添加 --isolated：使用独立的 .local-runtime/development/data，保留原数据。'); process.exit(0);
}
const isolated = args.includes('--isolated');
const data = isolated ? join(root, '.local-runtime/development/data') : join(root, 'backend/data');
const runtime = join(root, '.local-runtime');
const backendPort = 3002, frontendPort = 3010;
for (const directory of ['backend/node_modules', 'frontend/node_modules']) {
  if (!existsSync(join(root, directory))) throw new Error(`缺少 ${directory}，请先分别在 backend 和 frontend 运行 npm ci。`);
}
function available(port) {
  return new Promise((accept, reject) => {
    const server = net.createServer();
    server.once('error', () => reject(new Error(`本机端口 ${port} 已占用，请先关闭对应的旧服务。`)));
    server.listen(port, '127.0.0.1', () => server.close(accept));
  });
}
await Promise.all([available(backendPort), available(frontendPort)]);
mkdirSync(runtime, { recursive: true });
if (isolated) mkdirSync(data, { recursive: true });
const children = [];
let stopping = false;
const receipt = () => writeFileSync(join(runtime, 'processes.json'), JSON.stringify({
  launcherPid: process.pid, status: stopping ? 'stopped' : 'running', dataDirectory: data,
  frontend: `http://127.0.0.1:${frontendPort}`, children: children.map(({ label, process: child }) => ({ label, pid: child.pid })),
}, null, 2));
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const { process: child } of children) if (child.exitCode === null) child.kill('SIGTERM');
  receipt(); process.exitCode = code;
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop());
function start(label, directory, argv, env) {
  const child = spawn(process.execPath, argv, { cwd: join(root, directory), env: { ...process.env, ...env }, stdio: 'inherit', windowsHide: true });
  children.push({ label, process: child }); receipt();
  child.on('error', error => { console.error(`${label} 启动失败：${error.message}`); stop(1); });
  child.on('exit', code => { if (!stopping) { console.error(`${label} 已退出（${code ?? 'signal'}）`); stop(code || 1); } });
}
async function waitFor(url) {
  const deadline = Date.now() + 45000;
  while (!stopping && Date.now() < deadline) {
    try { const response = await fetch(url, { signal: AbortSignal.timeout(1000) }); if (response.ok) return; } catch { /* Startup is still in progress. */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('本地服务未能启动，请查看上方错误；已有加密数据不会被重置。');
}
try {
  console.log(isolated ? `独立本地环境：${data}\n原 backend/data 保持原样。` : `本地数据：${data}`);
  start('backend', 'backend', ['src/index.js'], {
    NODE_ENV: 'development', AUTH_MODE: 'session', PORT: String(backendPort),
    ...(isolated ? { DATA_DIR: data, AUTH_DB_PATH: join(data, 'auth.json'), SUPABASE_DB_URL: '', MONGODB_URI: '',
      QUNTHINK_FOUNDATIONS_RUNTIME_URL: process.env.QUNTHINK_LOCAL_GOALS_URL || '', QUNTHINK_FOUNDATIONS_SCHEMA: 'qunthink_core',
      QUNTHINK_GOAL_BRIEF_SCHEDULER: '0' } : {}),
  });
  await waitFor(`http://127.0.0.1:${backendPort}/api/health`);
  start('frontend', 'frontend', ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(frontendPort), '--strictPort'], {
    VITE_BACKEND_URL: `http://127.0.0.1:${backendPort}`, VITE_AUTH_MODE: 'session',
  });
  await waitFor(`http://127.0.0.1:${frontendPort}`);
  console.log(`\n群想已就绪：http://127.0.0.1:${frontendPort}\n按 Ctrl+C 关闭前后端。\n`);
} catch (error) { console.error(error.message); stop(1); }
