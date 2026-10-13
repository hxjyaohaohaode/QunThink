// One foreground process owns both local services. Ctrl+C stops every child.
import { spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import net from 'node:net';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const usage = 'node scripts/start-local.mjs [--isolated [--init-empty]]';
const osVariables = ['PATH', 'Path', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'SystemRoot', 'WINDIR',
  'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'USER', 'USERNAME'];

function regularFile(file, optional = true) {
  let stat;
  try { stat = lstatSync(file); }
  catch (error) { if (optional && error.code === 'ENOENT') return false; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) {
    throw new Error('配置、密钥或运行回执必须是无外部链接的普通文件。');
  }
  return true;
}
function checkDirectories(root, names) {
  let current = root;
  for (const name of names) {
    current = join(current, name);
    try {
      const stat = lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('独立运行目录必须是本地普通目录，不能使用符号链接。');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
function checkDataTree(directory) {
  let stat;
  try { stat = lstatSync(directory); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink > 1))) {
    throw new Error('独立数据中存在外部链接或特殊文件；请核对原安装，不会跟随链接写入。');
  }
  if (stat.isDirectory()) for (const entry of readdirSync(directory)) checkDataTree(join(directory, entry));
}
function canonicalKey(value) {
  return typeof value === 'string' && Buffer.from(value, 'base64').length === 32
    && Buffer.from(value, 'base64').toString('base64') === value;
}

// The isolated branch never reads backend/.env or spreads inherited app config.
// Only its explicitly configured encryption key and opt-in goals URL may enter.
export function localConfiguration({ root = repository, env = process.env, args = process.argv.slice(2) } = {}) {
  if (new Set(args).size !== args.length || args.some(arg => !['--isolated', '--init-empty', '--help'].includes(arg))
    || (args.includes('--init-empty') && !args.includes('--isolated'))
    || (args.includes('--help') && args.length !== 1)) throw new Error(`用法：${usage}`);
  if (args.includes('--help')) return { help: true };
  const isolated = args.includes('--isolated'), initialize = args.includes('--init-empty');
  const runtime = join(root, '.local-runtime');
  checkDirectories(root, ['.local-runtime']);
  if (isolated) checkDirectories(root, ['.local-runtime', 'development', 'data']);
  const configFile = isolated ? join(runtime, 'development', 'backend.env') : join(root, 'backend', '.env');
  const require = createRequire(join(root, 'backend', 'package.json'));
  const configured = regularFile(configFile) ? require('dotenv').parse(readFileSync(configFile)) : {};
  if (isolated && Object.keys(configured).some(key => key !== 'ENCRYPTION_KEY')) {
    throw new Error('独立配置 backend.env 仅允许 ENCRYPTION_KEY；数据库与账本路径由启动器固定。');
  }
  const inherited = isolated ? Object.fromEntries(osVariables.filter(key => env[key] !== undefined).map(key => [key, env[key]])) : env;
  const backendEnv = { ...configured, ...inherited, NODE_ENV: 'development', AUTH_MODE: 'session', HOST: '127.0.0.1',
    DOTENV_CONFIG_PATH: configFile };
  // dotenv/config forwards this variable as a string; even "false" is truthy.
  // Config was already parsed above. Its second load must not overwrite the
  // validated environment or the launcher's fixed listener/authentication.
  delete backendEnv.DOTENV_CONFIG_OVERRIDE;
  const data = isolated ? join(runtime, 'development', 'data') : resolve(root, 'backend', backendEnv.DATA_DIR || 'data');
  if (isolated) Object.assign(backendEnv, {
    DATA_DIR: data, AUTH_DB_PATH: join(data, 'auth.json'), MEMORY_DELETION_DIR: join(data, 'memory-deletions'),
    SUPABASE_DB_URL: '', MONGODB_URI: '', MEMORY_DELETION_DATABASE_URL: '',
    QUNTHINK_FOUNDATIONS_RUNTIME_URL: env.QUNTHINK_LOCAL_GOALS_URL || '', QUNTHINK_FOUNDATIONS_SCHEMA: 'qunthink_core',
    QUNTHINK_GOAL_BRIEF_SCHEDULER: '0'
  });
  if (isolated) checkDataTree(data);
  const keyFile = join(data, '.encryption_key');
  const hasStoredKey = regularFile(keyFile);
  if (!backendEnv.ENCRYPTION_KEY && !hasStoredKey) {
    throw new Error(isolated
      ? '独立加密密钥未配置。请私下在 .local-runtime/development/backend.env 设置专用 ENCRYPTION_KEY；已有数据必须恢复原密钥。不会自动生成或替换密钥。'
      : '原加密密钥缺失。请恢复原 ENCRYPTION_KEY 或原 .encryption_key；不会自动生成或替换密钥。');
  }
  if (isolated && backendEnv.ENCRYPTION_KEY && !canonicalKey(backendEnv.ENCRYPTION_KEY)) {
    throw new Error('独立 ENCRYPTION_KEY 必须是规范 base64 编码的 32 字节专用密钥。');
  }
  if (hasStoredKey) {
    const stored = readFileSync(keyFile, 'utf8').trim();
    if (!canonicalKey(stored)) throw new Error('原加密密钥损坏，请恢复原密钥；不会覆盖或生成新密钥。');
    if (isolated && backendEnv.ENCRYPTION_KEY && stored !== backendEnv.ENCRYPTION_KEY) {
      throw new Error('独立配置与已有密钥不一致，请核对原配置；不会替换已有密钥。');
    }
  }
  if (initialize && !backendEnv.ENCRYPTION_KEY) throw new Error('显式新空安装必须先在独立配置中提供专用 ENCRYPTION_KEY。');
  // The server's legacy auth initializer can create/repair local auth files.
  // Refuse that implicit path for normal local launches; explicit init is the
  // only launcher operation authorized to create this installation's auth.
  if (!initialize && !backendEnv.SUPABASE_DB_URL && !backendEnv.MONGODB_URI) {
    const auth = resolve(root, 'backend', backendEnv.AUTH_DB_PATH || join(data, 'auth.json'));
    let value;
    try {
      if (!regularFile(auth)) throw new Error('missing');
      value = JSON.parse(readFileSync(auth, 'utf8'));
    } catch {
      throw new Error('本地认证库缺失、损坏或不可读；请恢复原文件。普通启动不会创建或修复认证库。');
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || !Array.isArray(value.users) || !Array.isArray(value.sessions)) {
      throw new Error('本地认证库结构无效；请恢复原文件。普通启动不会修复认证库。');
    }
  }
  const frontendEnv = { ...inherited, VITE_BACKEND_URL: '', VITE_AUTH_MODE: 'session' };
  return { root, runtime, data, isolated, initialize, backendEnv, frontendEnv };
}

function available(port) {
  return new Promise((accept, reject) => {
    const server = net.createServer();
    server.once('error', () => reject(new Error(`本机端口 ${port} 已占用，请先关闭对应的旧服务。`)));
    server.listen(port, '127.0.0.1', () => server.close(accept));
  });
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function runLocal({ root = repository, env = process.env, args = process.argv.slice(2),
  backendPort = 3002, frontendPort = 3010, healthTimeoutMs = 45000, stopTimeoutMs = 12000 } = {}) {
  let configuration;
  try {
    configuration = localConfiguration({ root, env, args });
    if (configuration.help) {
      console.log(`${usage}\n普通启动只读取已有安装。--isolated 使用独立数据与专用配置；首次安装需明确添加 --init-empty。`);
      return 0;
    }
    for (const directory of ['backend/node_modules', 'frontend/node_modules']) {
      if (!existsSync(join(root, directory))) throw new Error(`缺少 ${directory}，请先分别在 backend 和 frontend 运行 npm ci。`);
    }
    await Promise.all([available(backendPort), available(frontendPort)]);
    regularFile(join(configuration.runtime, 'processes.json'));
    mkdirSync(configuration.runtime, { recursive: true });
  } catch (error) { console.error(error.message); return 1; }
  const { runtime, data, isolated, initialize, backendEnv, frontendEnv } = configuration;
  backendEnv.PORT = String(backendPort);
  frontendEnv.VITE_BACKEND_URL = `http://127.0.0.1:${backendPort}`;
  const children = [], cancelled = new AbortController();
  let stopping = false, stopped = false, result = 0, finish;
  const completed = new Promise(resolve => { finish = resolve; });
  const receipt = () => writeFileSync(join(runtime, 'processes.json'), JSON.stringify({
    launcherPid: process.pid, status: stopped ? 'stopped' : stopping ? 'stopping' : 'running', dataDirectory: data,
    frontend: `http://127.0.0.1:${frontendPort}`,
    children: children.map(({ label, child }) => ({ label, pid: child.pid, exitCode: child.exitCode, signal: child.signalCode }))
  }, null, 2));
  async function stop(code = 0) {
    if (stopping) return completed;
    stopping = true; result = code; cancelled.abort();
    const alive = entry => !entry.exited;
    for (const entry of children.filter(alive)) entry.child.kill('SIGTERM');
    try { receipt(); } catch { result = 1; }
    const exits = Promise.all(children.map(entry => entry.done));
    let timer;
    await Promise.race([exits, new Promise(resolve => { timer = setTimeout(resolve, stopTimeoutMs); })]);
    clearTimeout(timer);
    if (children.some(alive)) {
      console.error('子进程未及时退出，正在强制停止。');
      for (const entry of children.filter(alive)) entry.child.kill('SIGKILL');
      await exits;
    }
    stopped = true;
    try { receipt(); } catch { result = 1; }
    finish(result);
    return result;
  }
  const interrupt = () => { void stop(0); };
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, interrupt);
  function start(label, directory, argv, childEnv, service = true) {
    if (stopping) throw new Error('本地启动已取消。');
    const child = spawn(process.execPath, argv, { cwd: join(root, directory), env: childEnv, stdio: 'inherit', windowsHide: true });
    const entry = { label, child, exited: false };
    entry.done = new Promise(resolve => {
      child.once('error', error => {
        entry.exited = true; resolve({ code: 1 });
        console.error(`${label} 启动失败：${error.code || 'SPAWN_FAILED'}`); void stop(1);
      });
      child.once('exit', (code, signal) => {
        entry.exited = true; resolve({ code, signal });
        if (!stopping && (service || code !== 0)) {
          console.error(`${label} 已退出（${code ?? signal}）`); void stop(code || 1);
        }
      });
    });
    children.push(entry); receipt();
    return entry;
  }
  async function waitFor(url) {
    const deadline = Date.now() + healthTimeoutMs;
    while (!stopping && Date.now() < deadline) {
      try {
        const response = await fetch(url, { signal: AbortSignal.any([cancelled.signal, AbortSignal.timeout(1000)]) });
        if (response.ok) return;
      } catch { /* Bounded readiness check; stopped children are never restarted. */ }
      await delay(100);
    }
    throw new Error('本地服务未能启动，请查看上方错误；已有数据不会被重置。');
  }
  try {
    console.log(isolated ? `独立本地环境：${data}` : `本地数据：${data}`);
    if (initialize) {
      const setup = start('init-empty', 'backend', ['scripts/account-store-maintenance.mjs', 'init-empty'], backendEnv, false);
      let deadline;
      let outcome;
      try {
        outcome = await Promise.race([setup.done, new Promise((_, reject) => {
          deadline = setTimeout(() => reject(new Error('显式初始化超时，正在停止初始化进程。')), healthTimeoutMs);
        })]);
      } finally { clearTimeout(deadline); }
      if (outcome.code !== 0 || stopping) throw new Error('显式初始化未完成；不会重置已有安装，也不会启动服务。');
    }
    start('backend', 'backend', ['src/index.js'], backendEnv);
    await waitFor(`http://127.0.0.1:${backendPort}/api/health`);
    start('frontend', 'frontend', ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(frontendPort), '--strictPort'], frontendEnv);
    await waitFor(`http://127.0.0.1:${frontendPort}`);
    console.log(`\n群想已就绪：http://127.0.0.1:${frontendPort}\n按 Ctrl+C 关闭前后端。\n`);
  } catch (error) {
    if (!stopping) console.error(error.message);
    void stop(stopping ? result : 1);
  }
  try { return await completed; }
  finally { for (const signal of ['SIGINT', 'SIGTERM']) process.removeListener(signal, interrupt); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await runLocal();
