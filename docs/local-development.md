# 本地开发与独立验收环境

在仓库根目录操作。依赖要求见前后端 `package.json`；本次 Windows 验收使用 Node.js 24.19.0。分别在 `backend` 和 `frontend` 运行 `npm ci` 后，可用一个前台进程启动两项服务：

```powershell
node scripts/start-local.mjs
```

前端入口为 `http://127.0.0.1:3010`，后端为 `http://127.0.0.1:3002`。启动脚本会检查端口和健康状态；按 Ctrl+C 关闭其启动的前后端。开发服务器仅用于本机开发，生产部署仍按 README 的部署配置执行。

## 在不改动原数据的情况下验收新代码

```powershell
node scripts/start-local.mjs --isolated
```

此模式将认证库、用户数据和新安装密钥放入 `.local-runtime/development/data`，并禁用继承的远程数据库连接。再次运行会复用该独立目录。`backend/data` 及其原有密钥不会被替换。运行进程记录写入 `.local-runtime/processes.json`；该目录整体被 Git 忽略。

独立环境没有云端账号、历史内容或模型密钥。可创建本地账号，测试人工写作、任务保存、会话、搜索、模型配置界面等；真实 AI 生成需要在该账号的模型中心配置有效服务商。不要将开发模式注册接口用于公网生产服务。

## 个人目标的独立数据库

个人目标使用 PostgreSQL，任务与聊天使用上述本地用户库。先按 README 的领域基础件步骤迁移一个独立数据库，并授予运行角色对应 schema 的 USAGE 与表级 SELECT / INSERT / UPDATE / DELETE 权限。运行角色不要使用超级用户或 BYPASSRLS。独立模式只接收明确设置的 `QUNTHINK_LOCAL_GOALS_URL`，不会继承生产环境的目标数据库地址；schema 固定为 `qunthink_core`，后台简报调度保持关闭。

这台电脑已建立独立容器 `qunthink-local-goals-20261013`，仅监听 `127.0.0.1:55433`；其数据卷同名，运行角色受限。连接配置保存在被 Git 忽略的 `.local-runtime/goals-runtime.json`。已经启动的本地验收环境包含该服务。关闭服务后，可在仓库根目录重新启动：

```powershell
node .local-runtime/start-with-goals.mjs
```

该本机辅助脚本会启动自己的目标数据库容器，再启动独立前后端；需要 Docker Desktop 正常运行。Ctrl+C 关闭前后端，数据库容器保留运行。需要停止数据库时运行 `docker stop qunthink-local-goals-20261013`；不要删除数据卷来“重置”已有目标。其他电脑须自行创建独立数据库，不能复制此机的账号配置作为共享凭证。

已验证目标创建、目标读取及内部确定性简报。通用 Agent 自动执行与工作台 Task 联动仍是上游未接通的能力；简报仅整理目标要求，不代表目标已经完成。

## 已有加密数据启动失败

如果原数据目录的密钥元数据声明了上一版本，但 `.key_history` 中缺少对应密钥，新代码会停止启动。这是保护已有密文的预期行为。恢复必须使用与数据配套的原始密钥及历史密钥，不能通过删除元数据、生成新钥或覆盖用户 JSON 绕过。

2026-10-13 在这台开发电脑发现原数据声明 `previousKeyVersion: 2`，但历史密钥目录为空。原数据已保留，当前本地演示使用独立模式。源代码同步并不等同于同步 GitHub 之外的生产数据库或密钥。

## 验证命令

```powershell
# 仓库根目录
node scripts/verify-brand.mjs
node scripts/validate-openapi.mjs

# backend 目录
npm test

# frontend 目录
npm test
npm run build
npm run test:e2e
```

E2E 自建隔离账号、数据库和协议测试服务，使用 3202 / 3210 端口；不会读取原用户数据库。默认包括桌面 Chromium 和移动端减少动画两组。安装了完整 Chromium 但未安装 headless shell 时，可先设置 `$env:PLAYWRIGHT_CHROMIUM_CHANNEL='chromium'`。依赖沙盒诊断的用例使用本机 Chrome，并保持 Chromium 沙盒开启。

后端部分文件权限、符号链接、PostgreSQL 集成用例需要相应的操作系统能力和独立 PostgreSQL 测试库。完整后端验收在 Linux + PostgreSQL 中执行；不能将 Windows 不支持的符号链接操作默认为测试通过。

Windows 的旧 Node.js 24.15.0 在本次环境中曾触发 Playwright 子进程异常退出。若遇到相同问题，应使用已验证的 Node.js 24.19.0 或经过项目测试的新版本，不要关闭浏览器沙盒规避。
