# 本地开发与独立验收环境

在仓库根目录操作。前后端要求 Node.js 22.12.0 或更新版本；本次后端整合验收使用 22.12.0。分别在 `backend` 和 `frontend` 运行 `npm ci` 后，一个前台进程可启动两项服务：

```powershell
node scripts/start-local.mjs
```

普通模式读取 `backend/.env` 和原有进程环境配置，默认数据目录是 `backend/data`。它只启动已有安装，不会根据“文件不存在”推断新安装，不会自动初始化、迁移、修复或替换密钥。普通本地启动还要求认证库已有合法的 `users` / `sessions` 数组（允许为空），缺失、损坏或类型无效都会停止并保留原字节；这项检查不改变云存储认证层。缺失或损坏的账号库必须按 [账号存储生命周期](account-store-lifecycle.md) 的显式迁移或恢复流程处理。

前端为 `http://127.0.0.1:3010`，后端为 `http://127.0.0.1:3002`。两项本地服务均只监听 `127.0.0.1`。启动器检查端口和健康状态；任一子进程退出、初始化失败或超时都会停止其他子进程。Ctrl+C 会先请求关闭，再等待退出；超时的子进程会被强制停止。`.local-runtime/processes.json` 只有在全部子进程结束后才记录 `stopped`。生产部署不使用此开发启动器；后端未设置 `HOST` 时仍保持原部署监听方式。

## 首次建立独立空安装

独立模式只使用 `.local-runtime/development/data`，认证库与删除账本也固定在该目录内。它不会读取 `backend/.env`，不会继承进程环境中的密钥、认证/数据路径、删除账本、Supabase/MongoDB、短信或其他应用凭证。已有数据中的外部链接也会被拒绝。

1. 私下创建 `.local-runtime/development/backend.env`，仅设置一个专用 `ENCRYPTION_KEY`。值必须是规范 base64 编码的 32 字节随机密钥。此文件位于数据目录之外，不能写入真实生产密钥，也不要把内容贴入聊天、日志、截图或提交到 Git。
2. 保管此配置，并与独立数据一起备份。启动器不会生成、打印或更换密钥；已有独立数据必须继续使用与其配套的原密钥。
3. 仅在确认独立目标尚无任何安装数据时，显式初始化并启动：

```powershell
node scripts/start-local.mjs --isolated --init-empty
```

`--init-empty` 仅适用于 `--isolated`。它调用账号存储的显式空安装入口，成功后才启动服务。重复初始化或遇到任何已有数据会失败，不会清空目录，也不会继续启动。独立配置仅允许 `ENCRYPTION_KEY`；其他配置项会被拒绝。

后续启动必须省略初始化选项：

```powershell
node scripts/start-local.mjs --isolated
```

已有本地 `.encryption_key` 可继续读取；若同时配置独立环境密钥，两者必须一致。若原数据要求历史密钥，仍需保留完整的密钥元数据和历史文件。缺失密钥、缺失账号或损坏账号都会停止启动，不能用删除数据、元数据或换新密钥绕过。

`.local-runtime` 被 Git 忽略，不应放进源码交付包。独立环境没有云端账号、历史内容或模型凭证。可创建本地账号，测试人工写作、任务、会话、搜索与配置界面；真实 AI 生成需要用户另行在该账号的模型中心配置有效服务商。开发注册接口不能用于公网生产服务。

## 个人目标的独立数据库

个人目标使用 PostgreSQL，任务和聊天使用上述本地用户库。需要个人目标时，先按 README 的领域基础件步骤准备一个独立数据库，并授予受限运行角色对应 schema 的 USAGE 与表级 SELECT / INSERT / UPDATE / DELETE 权限。运行角色不能使用超级用户或 BYPASSRLS。

启动器只接受用户明确设置的 `QUNTHINK_LOCAL_GOALS_URL`，不会继承 `QUNTHINK_FOUNDATIONS_RUNTIME_URL`。请确认地址属于专用验收数据库，再自行设置此变量。schema 固定为 `qunthink_core`，后台简报调度保持关闭。未显式设置时不会连接目标数据库。

此启动器不会启动 Docker、读取 `.local-runtime/goals-runtime.json` 或执行其他本机辅助脚本。其他电脑上的容器、账号与私有配置不随源码提供。单独启动服务不等同于完成 Docker、MongoDB、浏览器或联网模型验收。通用 Agent 自动执行与工作台 Task 联动仍取决于上游接通情况，简报本身不代表目标已完成。

个人目标的表单、执行步骤草稿和未确认请求编号只保存在当前账号、当前标签页内存中。切换聊天或其他页面后可以继续；刷新页面或退出账号会清除。保存尚未返回时禁止重复提交；结果未确认时，保持原内容重试会使用同一请求编号。迟到的响应不会清空后来输入的草稿，也不会切回已经离开的目标。浏览器关闭或刷新前会提示未保存内容，但是否显示提示仍由浏览器决定。

## 已有加密数据启动失败

如果密钥元数据声明了上一版本，但 `.key_history` 中缺少对应密钥，服务会停止启动。恢复必须使用与数据配套的原始密钥及历史密钥。不能删除元数据、生成新钥或覆盖用户 JSON。源码同步也不等同于同步 GitHub 之外的数据库或私有配置。

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

本地启动器回归位于 `backend/test/start-local-launcher.integration.test.js`：真实后端使用临时合成账号和随机测试密钥；前端生命周期使用最小 HTTP 测试子进程。它不读取原用户数据库或私有配置，也不等同于浏览器视觉验收。

E2E 使用独立账号、数据库和协议测试服务，默认端口为 3202 / 3210。需要安装对应浏览器后另行执行，不应将命令存在理解为已经完成验收。

Windows 的 `core.autocrlf` 不能改写历史兼容性夹具：`.gitattributes` 对字节固定的历史源码禁用换行转换，原 SHA-256 和 Git blob 校验仍然执行。源码片段测试支持 CRLF；内存中的 Git 路径按 POSIX 规则解析，与本机盘符无关。WebCrypto 的不可导出密钥测试兼容 Node 22 与较新版本的原生异常名称，仍要求导出被拒绝。

后端部分文件权限、符号链接、PostgreSQL 集成用例需要相应操作系统能力和独立 PostgreSQL 测试库。完整存储门禁在 Linux + PostgreSQL 中执行；不能把平台不支持或缺少夹具的用例当作通过。
