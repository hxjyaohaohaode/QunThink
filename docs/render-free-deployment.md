# Render 免费静态前端准备方案

核验日期：2026-10-10。此文和 `render.free.yaml` 是本地准备材料，未创建、修改、重启或部署任何云资源，也未读取真实凭据。

## 结论和可用范围

**当前可提供的是免费静态前端，连接用户已有、经过验证的持久后端。当前全功能后端不适合 Render Free Web Service。**

- `render.free.yaml` 仅定义一个 `runtime: static` 前端；`VITE_BACKEND_URL` 留给用户填写已有后端的真实 HTTPS origin。没有 Node 后端、数据库、持久盘或自动生成的密钥。
- 原有 `render.yaml` 的付费 `starter` 后端、`/var/data` 持久盘及其他设置保持不变；不要用免费模板覆盖它，也不要把已有服务改为 free 后继续接收上传。
- 没有可用的持久后端时，本方案尚不能成为可用的完整应用。免费静态站点不能运行 `/api` 或 `/ws`；SPA rewrite 也不是 API/WebSocket 代理。
- 不能只接入外部 PostgreSQL 就宣称后端已经无状态。数据库保存业务记录，上传和生成文件的字节仍依赖后端文件系统。
- 没有关闭上传/TTS 的临时开关，没有假对象存储，没有改变任何既有功能行为。若以后要使用免费无盘后端，需先实现并测试真正的持久对象存储，包括鉴权、下载、背景图、TTS、删除及恢复语义；这不在本次模板工作内。

## 为什么不提供免费全栈 Blueprint

Render 官方说明：Free Web Service 无入站流量 15 分钟后休眠；重启、重新部署及休眠会丢失本地文件，且不能挂载持久盘。每工作区每月共享 750 免费实例小时。静态站点可免费部署，但静态站点和 Web 服务均计入带宽与构建额度；超额可能收费或被暂停。大量主动访问外部数据库/API/对象存储也可能触发限制。

Render Free Postgres 创建 30 天后到期，再有 14 天付费升级宽限期，之后删除数据，并且不支持备份，因此不应作为长期业务库或删除账本。外部 PG、文件存储、模型调用、域名及其他供应商是否免费须分别核验，不能保证整个应用“全免费”。参见 [Render 免费服务限制](https://render.com/docs/free)。

服务区域、用户网络和数据库区域尚未实测；不承诺中国大陆或其他跨境网络可用性、延迟、合规性或稳定性。也不能用保活请求替代持久化和可靠性设计。

## 已审计的持久化边界

以下结论来自当前源码，不能替代真实部署检查：

| 数据/能力 | 当前实现 | 无持久盘的后果 |
| --- | --- | --- |
| 账号、会话、用户业务 JSON | 设置 `SUPABASE_DB_URL` 后使用 PostgreSQL `kv_store`；`backend/src/models/authDb.js`、`db.js`、`supabaseAdapter.js` | 可由外部持久 PG 保存；其备份、恢复与可达性仍需独立验证 |
| 上传原件、图片、群文件 | `backend/src/routes/files.js` 写 `DATA_DIR/uploads/<用户>/`，数据库记录文件名/路径等 | 文件字节丢失，而数据库记录可能仍然存在；下载或后续读取失败 |
| 群背景图 | `backend/src/routes/groups.js` 写 `DATA_DIR/uploads/backgrounds/` | 原图丢失，已有背景记录不能还原原图 |
| TTS 音频 | `backend/src/routes/tts.js` 写 `DATA_DIR/tts/`，关联元数据和调用结果在业务库 | 音频丢失；已成功调用/幂等记录不会自动恢复字节，不能通过盲目重试避免可能的再次费用 |
| 智能体文件聊天 | `backend/src/routes/agents.js` 临时写入 uploads，正常结束时清理 | 本来就是请求期临时文件；重启可中断处理，不能当持久附件库 |
| 加密密钥历史 | `backend/src/utils/keyManager.js` 的 `.key_history`、密钥元数据是本地文件 | 仅保存当前环境密钥不足以保住历史轮换密钥；已有历史必须另行安全保全 |
| 限流、连接及后台调度 | `.rate_limits.json` 与进程内状态，调度器依赖活跃进程 | 重启可重置本地限流/状态；休眠不提供持续后台执行保证 |
| 个人目标基础模块 | 另需 foundations 数据库配置、迁移和权限 | 免费静态模板不会提供这些基础设施或启用调度器 |

PG 故障不应通过清空 `SUPABASE_DB_URL` 回退到另一份本地用户数据。已有 Local LowDB 数据也不会因为填入 PG URL 自动迁移；切换前要核验原数据、密钥及删除历史。

## 已有后端必须核验的项目

以下是准备要求，不是已执行的更改，也不是免费模板会自动配置的资源：

1. 确认后端属于用户、运行版本正确、上传和 TTS 所在 `DATA_DIR` 确实位于持久存储，且备份及恢复经过验证。原付费模板的磁盘声明不是实际已挂载或已备份的证明。
2. 使用 `NODE_ENV=production` 和 `AUTH_MODE=session`。固定保存现有 `ENCRYPTION_KEY`；新安装需要由用户安全配置 32 字节随机密钥的 Base64 值，之后保持稳定。不得在构建/重启时再生成、在 Git 中提交、放到前端，或为了启动而替换旧密钥。已有历史密钥要一起保全。
3. 如果选择 PostgreSQL，配置真实、长期持久的 `SUPABASE_DB_URL`。这是后端连接字符串，不是浏览器端 Supabase URL/anon key。确认账户费用、容量、休眠/删除政策、TLS、权限和备份。不要创建临时到期库后冒充长期存储。
4. PostgreSQL 必须保留证书链及主机名验证。必要时使用供应商可信来源的根 CA，后端 `SUPABASE_DB_CA_FILE` 指向运行时文件；代码接受单个有效 CA 证书，不接受私钥/叶证书。Render Secret File 的运行时绝对路径为 `/etc/secrets/<文件名>`，例如 `/etc/secrets/business-ca.pem`。不要关闭 `rejectUnauthorized`、设置 TLS 绕过变量或使用 `sslmode=disable`。参见 [Render 环境变量和 Secret Files](https://render.com/docs/configure-environment-variables) 以及 `backend/src/models/postgresTls.js`。
5. 后端 `CORS_ORIGINS` 要包含实际前端 HTTPS origin；多个值使用逗号分隔，不加路径、末尾斜杠或空格。当前 HTTP 与 WebSocket 均按精确 origin 检查。不要填通配符或猜测域名。
6. 前端与后端的跨站 session cookie、CSRF、退出登录及 WebSocket 要在目标浏览器真实验收。两者分域不能保证所有浏览器允许相关 cookie；失败时应评估经授权的同源/同站部署，不降低认证安全要求。

### PostgreSQL memory 删除账本是独立的必要条件

普通 PG 聊天存储与持久记忆不是同一准备条件。**默认 `MEMORY_DELETION_MODE=legacy` 时，持久记忆接口返回 503。** 加上一个 PG URL 不会自动启用 memory。

若要启用独立账本，必须完整遵循 [PostgreSQL 独立删除账本说明](POSTGRES_MEMORY_LEDGER.md)：

- 后端配置 `MEMORY_DELETION_MODE=independent`、`MEMORY_DELETION_DATABASE_URL`、稳定的 `MEMORY_DELETION_INSTALLATION_ID` 和 `MEMORY_DELETION_CONNECTION_MODE=session`；CA 必要时另设 `MEMORY_DELETION_DATABASE_CA_FILE`。
- 业务库与账本必须是不同的真实数据库，不能仅换域名/URL 指向同一库。两者都要可验证数据库身份；管理员按最小权限开放必要函数，不需要假定托管供应商提供 superuser。
- 连接应为 direct 或 session pooling，不能是 transaction pooler；严格 TLS、`fsync=on` 及同步提交等要求不因免费方案放宽。声明 session 不会自动证明连接服务确实保留会话状态。
- 停止所有应用实例、保全数据及密钥、预先准备业务 `kv_store` 后，由获授权的离线运维环境执行安装。全新且确认为空的安装使用 `cd backend && node scripts/install-postgres-memory-ledger.mjs --fresh`。已有安装只能用完整、独立核验的删除历史执行 `--import-verified-history manifest.json`；不能伪造空历史。该安装器会连接并写数据库，**它不是离线配置预检，不能放到本模板的 build/start 命令中**。
- 安装 owner 与运行时最小权限角色应分开；运行时不应有账本 UPDATE/DELETE/TRUNCATE/DDL 权限。Render 免费 Web 不提供 shell/one-off jobs，本模板也不建立安装环境。
- 业务库恢复必须保留最新账本和独立配置。同集群的两个库只在数据库级逻辑恢复下分离；整集群 PITR/快照同时回退会丢删除历史。迁移到新库 OID/新集群需审计恢复/重绑定，不能自动信任。已经授权的在途响应也无法事后撤回。
- 丢失配置、身份、表、账号登记或连接时，受保护功能按设计拒绝；不要把 mode 改回 legacy 或删除 marker/账本来“修好”503。已有业务标记不会被 mode=legacy 覆盖。

## 免费前端的准备和人工发布步骤

1. 先确认上述既有后端可用。没有持久后端时停在准备阶段，不为凑齐演示而创建免费无盘后端。
2. 在获授权的源码发布之后，创建 Blueprint 时明确选择 `render.free.yaml` 作为 Blueprint Path，核对变更列表**只有一个新静态前端**。不要把同一服务交给两个 Blueprint 管理。参见 [Render Blueprint 创建和自定义路径](https://render.com/docs/infrastructure-as-code)。
3. 在前端设置 `VITE_BACKEND_URL` 为已核验后端的 HTTPS origin，不带 `/api`、路径、查询或凭据；保持 `VITE_AUTH_MODE=session`。所有 `VITE_*` 值会进入浏览器，不放数据库 URL、密钥或用户凭据。
4. 模板从仓库根目录执行 `cd frontend` 后安装锁定依赖并构建，发布 `frontend/dist`，从而保留对根目录 `shared/` 的访问。不要再设置 `rootDir: frontend`。后端 origin 缺失时 build guard 会提前失败；非空值仍需人工核验真实性与格式。
5. 把实际新前端 origin 加到既有后端 `CORS_ORIGINS` 需单独确认再执行；不能因为创建了静态站就视为后端已更新。修改 `VITE_BACKEND_URL` 后需要重新构建前端。
6. `autoDeployTrigger: off` 只控制服务的 Git 自动部署，不等于关闭 Blueprint Auto Sync。若要保持人工控制，另在 Blueprint Settings 检查 Auto Sync；创建、同步、发布和费用确认均不由这次本地准备自动执行。

## 离线预检与发布验收

安装开发依赖后，在仓库根目录运行：

```sh
node --test backend/test/deployment-config-contract.test.js
node backend/scripts/deployment-preflight.mjs render-free
node backend/scripts/deployment-preflight.mjs render
node backend/scripts/deployment-preflight.mjs compose
```

预检只读取仓库配置，不加载 `.env`、读取真实凭据或访问供应商。它会拒绝免费文件中出现 Node 后端、数据库、持久盘、额外资源、后端凭据、缺少人工 backend URL 输入或 dev 认证。锁定的官方 schema 摘录测试只是服务结构契约，**不等于完整官方 schema 验证或 Render 接受发布**。旧 `vercel` 目标仍独立处理其未解决的后端地址占位符。

真正发布后的人工验收仍需覆盖：

- 静态页面与 SPA 深链接，实际后端 `/api/health`，登录、CSRF、退出后失效和 WebSocket 重连。
- 账号、消息、上传原件、背景图、TTS 在后端受控重启后仍可访问；不得用数据行还在代替文件字节验收。
- PG/TLS 故障拒绝错误存储回退；按所选模式核验 memory 503 或已安装独立账本的正常读写。
- 若启用账本，在专用测试数据中核验业务库恢复后删除内容不会复活；生产数据不用于破坏性演练。
- 后端健康 200 只说明当前健康路径检查通过，不证明删除账本、文件备份、浏览器 cookie、外部模型或跨境网络全部可用。

本次未执行云端发布、真实 PG/账本安装、上传/TTS外部调用、线上重启或浏览器验收；不要把配置测试通过标为“全功能免费上线”。
