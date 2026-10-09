# 群想 QunThink

软件材料准备见[技术材料与源码边界](docs/COPYRIGHT_CURRENT.md)及[操作手册草稿](docs/USER_MANUAL_DRAFT.md)。旧430文件工程基线及435文件首次文档同步属于2026-10-09历史记录，不是当前HEAD文件数。本轮208项生产文件身份和45项审阅顺序见[源码身份](docs/copyright-preparation/source-identity.json)与[审阅清单](docs/copyright-preparation/source-excerpt-order.json)；完整提交、tree和CI按外部最终回执或精确Git记录核对。个人登记意向已确认；法定身份、正式名称/版本、完成/发表事实及实际权属仍待核定，尚非正式提交版。

群想是一个以 AI 为核心的社交与工作空间原型。当前可用的主线是多模型群聊、单模型对话、AI 角色、智能体、辩论、文件辅助理解、语音合成和任务工作台。模型由用户在**模型中心**配置，不再受内置厂商名单限制；旧模型 ID 保留，以免历史会话失效。

项目正在向真人社交、组织协作和可执行 AI 工作流演进。现在的群聊仍以每个用户自己的数据为边界，**不等同于多人共享群聊**；工作台任务当前执行模型请求与会话摘要，尚不能自动操控浏览器、文件系统或第三方办公软件。完整能力与已知边界见 [优化记录](docs/optimization-2026-09.md)。

验证边界（2026-10-10北京时间）：本轮文档更新前的443文件代码候选已通过Node22与真实PostgreSQL后端407/407（57/57文件、0跳过）、前端556和打包9项，以及品牌、OpenAPI和构建检查。它们不代替合入文档后的精确GitHub提交CI，也不证明生产上线；代码身份与历史主线结果分列在上述源码身份文件中。

## 当前功能

- 在模型中心添加 OpenAI 兼容或 Anthropic 协议的服务商，发现模型、设置能力与默认模型、测试连接。可使用用户自己的密钥；私有或本地地址须由服务端精确允许。内置模型是兼容旧数据的预设，可禁用或更换。
- 创建工作、社交、娱乐空间，选择已连接且通过对话测试的模型；支持单模型会话、多模型对话、@提及、角色设置和辩论。旧会话中的未验证成员保留，但不会自动调用。
- 在工作台创建手动任务或显式开启定时任务，查看执行结果、失败原因和状态。多模型群的空闲主动聊天默认关闭，可在群设置中开启；模型调用可能产生费用。
- 上传常见文档并将提取的文字或图片交给具备相应能力的模型。ZIP类文档使用有界进程与资源预算，超限明确拒绝，详见[资源预算说明](docs/document-parser-resource-budgets.md)；其他格式不因此宣称已隔离。音频和视频附件目前只有元数据描述，**没有真实转写或视频内容理解**。
- 桌面与移动端界面、WebSocket 流式消息、PWA，以及按用户隔离的会话和模型配置。

## 本地启动

需要 Node.js 22.12+ 和 npm。以下示例适用于本机开发，使用 `AUTH_MODE=dev`；生产环境必须使用会话认证，且服务端会拒绝在 production 模式下启用 dev 认证。

```powershell
# 终端 1
cd backend
Copy-Item .env.example .env
npm ci
npm run dev

# 终端 2（在仓库根目录打开）
cd frontend
Copy-Item .env.example .env
npm ci
npm run dev
```

打开 http://localhost:3010。后端默认在 http://localhost:3002。初次启动不需要预置 AI 密钥，但**没有已通过对话测试的模型时不会自动获得 AI 回复**。进入“模型中心”添加服务商及模型并测试能力。后端 `.env` 中的预设服务商密钥默认不共享给账号；只有运营者显式设置 `QUNTHINK_SHARED_PROVIDER_KEYS=1` 才会开放，当前尚无完整的账号费用预占与结算机制。不要把 `.env` 提交到版本库。

本地开发时若后端与模型服务运行在同一台电脑，可在后端 `.env` 中将完整来源加入 `AI_ALLOWED_LOCAL_ORIGINS`，例如 `http://127.0.0.1:11434`。模型服务还须提供对应协议接口；允许列表只应包含你信任的地址。云端后端的 `localhost` 指云服务器，不能借此访问用户电脑上的模型；设备接力连接尚未实现。

### PostgreSQL 领域基础件与个人目标 API

`backend/db/migrations/001_foundations.sql` 提供空间、成员、对象修订、命令回执与 Outbox/Inbox；`002_agent_runtime.sql` 增加 Goal、Run、Step、Effect、Artifact、授权、预算和验收记录。迁移须显式运行；服务启动不会自动建表，也不会迁移 `kv_store` 或本地用户数据。先在隔离数据库中设置 `QUNTHINK_PG_URL` 并运行：

```powershell
cd backend
node scripts/migrate-foundations.mjs --schema qunthink_core
```

命令会校验迁移文件的 SHA-256，重复运行不会重建表。迁移完成后，可在后端设置 `QUNTHINK_FOUNDATIONS_RUNTIME_URL` 连接该数据库，启用会话认证的 `/api/goals` 个人目标 API；它从当前登录用户推导个人空间，提供目标创建、状态与验收记录。用户可在目标详情明确授权 `internal.goal_brief.v1` 生成零费用的确定性目标简报，API 为 `POST /api/goals/:goalId/briefs` 和 `GET /api/goals/:goalId/runs/:runId/brief`。简报正文、来源、哈希、Artifact、Step 与事件同事务保存；它仍须由用户核对，**不能充当目标完成验收证据**。设置 `QUNTHINK_GOAL_BRIEF_SCHEDULER=1` 可开启仅扫描此类已授权运行的恢复调度，默认关闭；还可配置 `QUNTHINK_GOAL_BRIEF_POLL_MS`、`QUNTHINK_GOAL_BRIEF_USERS_PER_TICK` 和 `QUNTHINK_GOAL_BRIEF_RUNS_PER_USER`，容量尚未压测。响应中的 `executionAvailable: false` 表示通用 Agent、模型及外部工具执行尚未接通。原有 `internal.goal_preflight.v1` 只记录目标修订核对，不生成成果。现有工作台 Task 和其他 Web API 仍使用原用户存储，尚未与目标运行表联动。生产切换还需可信身份映射、受限数据库角色、旧数据核对、回退演练、通用 Worker/工具接入及更多业务接口迁移。

模型能力测试也要求每次新意图的 UUID（`Idempotency-Key` 或 `clientRequestId`），通过 `/api/user/model-catalog/tests/:requestId` 查询当前账号的结果。同一请求号不会再次调用；同模型、能力及配置的运行中或未知请求即使换号也会返回原请求号。测试开始前撤下旧能力验证，视觉需两次正确识别；超时、断网、重启后无可靠回执时为 `unknown`，不能自动重试。记录和次数有硬上限，不会通过淘汰旧请求号释放付费重试入口。当前未知结果仅能查询，没有服务商费用核对或安全重发入口；持久存储、并发与恢复边界见 [模型测试恢复说明](docs/model-probe-recovery.md)。

语音合成要求客户端为每次意图生成 UUID `clientRequestId`。同一请求号重复提交不会再次调用供应商；同账号、同输入的未核验请求即使换了请求号，也会返回原请求号与状态。超时或结果无法确定时返回 `unknown`，可用 `/api/tts/effects/:requestId` 查询本账号的记录。该机制尚无供应商侧回执核验、未知请求的安全重发入口和准确费用结算；遇到未知结果时应先核对服务商账单。

工作台的“记忆记录”可保存、查看、更正和遗忘当前账号的个人笔记。消息摘录带来源群及消息版本，标为未经核验；来源消息或群被修改、删除时，关联摘录会撤销，正文从当前用户库清除。群资料页与会话检索只使用该群有效来源的摘录，个人笔记不会自动进入群聊上下文。本地 LowDB 记忆在删除前同步写入独立账本；即使只恢复旧用户 JSON，读取也会先核对账本并拒绝复活。账本损坏时受账本保护的读取返回 503；删除后主库写入失败可能使密文暂留在磁盘，但 API 会拒绝读取并在恢复后清除。首次启动仅在本地认证库和用户库均为空时自动初始化删除注册簿；既有安装缺注册簿需审计迁移，受账本保护的读取和删除会返回 503。新注册账号先建立账本再开放会话；未登记的旧账号不会因记忆记录为空而自动创建账本。部署时须将 `MEMORY_DELETION_DIR` 配到不随用户 JSON 旧快照回滚的持久绝对路径，并同时备份、保护该账本；整个数据卷与账本一起回滚仍不安全。当前账本只支持本地单进程，MongoDB/PostgreSQL 模式下记忆接口返回 503，待实现各自的事务性删除账本。此处还没有双时间事实、跨产物纠错传播、共享团队权限或自动语义事实确认；旧版记忆性能、配置及自动保存接口目前明确返回 501。

本地旧用户 JSON 恢复反例已覆盖消息/群列表、搜索、社交读取、主要 AI 历史上下文、消息关联 TTS、文件元数据及下载。单独删除文件也先写独立撤销标记；旧用户 JSON 和文件字节一起恢复后，文件详情、群文件列表与搜索会拒绝或过滤该文件，关联消息不再展示旧附件。正在传输的文件与同时发生的撤销、前端缓存、部分后台直读、云备份回滚及整个数据卷连账本一起回滚仍未形成完整删除传播；旧版无权音频物理文件也不会自动清扫。生产恢复必须同时核对独立账本和相关派生产物，不能只恢复用户 JSON。

## 生产部署

后端设置 `NODE_ENV=production`、`AUTH_MODE=session`、稳定的 32 字节 Base64 `ENCRYPTION_KEY`、持久化数据存储以及正确的 `CORS_ORIGINS`。注册/登录链路依赖短信服务配置；若未配置，应先完成认证部署方案再开放公网。前端设置 `VITE_AUTH_MODE=session` 与实际后端地址 `VITE_BACKEND_URL`。Render、Docker、Netlify、Vercel 的模板仍需按实际域名、认证及持久化存储检查；不能仅用默认占位符直接上线。

推送 `main` 会运行 GitHub Actions：后端测试使用临时 PostgreSQL，前端运行测试与构建，随后构建两个 Docker 镜像。仓库中的 Render API 部署工作流只在该次 `main` CI 成功且提交仍是最新版本时触发；`render.yaml` 将 Blueprint 服务的自动部署设置为检查通过后触发。已有 Render 服务的实际自动部署设置、数据迁移与运行状态须在服务端核实；GitHub CI 通过不代表生产部署成功。

## 2026-10 工作台与任务可靠性

本次改进覆盖任务请求幂等、取消/未知结果核验、消息来源修订、跨标签账号保护、任务草稿连续性和本地脱敏诊断。品牌与登录动画设有字节校验。真实实现、测试与未完成边界见 [本次迭代记录](docs/optimization-2026-10.md)。

## 验证

```powershell
cd backend
npm test
npm audit --omit=dev --registry=https://registry.npmjs.org

cd ../frontend
npm test
npm run build
npm audit --omit=dev --registry=https://registry.npmjs.org

cd ..
node scripts/validate-openapi.mjs
node scripts/verify-brand.mjs
```

真实 PostgreSQL 专项测试需另行设置隔离库的 `QUNTHINK_TEST_PG_URL`。历史 Windows Node v24.15 专项曾出现 `node --test` 跨文件 IPC 偶发反序列化失败；`npm test` 将每个测试文件放在独立进程执行，并核对全部退出码。旧隔离PostgreSQL专项记录为136/136、37/37文件、0跳过；它不是当前测试总数，也不证明多Worker生产竞争或100人团队容量。新验证须绑定具体提交与对应运行。

旧 LowDB 数据有一条**隔离导入预演**路径：`node backend/scripts/import-legacy-slice.mjs --snapshot-root <冻结数据目录> --user <账号ID> --schema <隔离schema> --dry-run`。冻结目录需包含 `auth.json`、对应账号的 `users/db_<账号ID>.json`、`memory-deletions/registry` 与该账号删除账本。真正写入隔离 PostgreSQL 前需另外配置 `QUNTHINK_PG_URL`；`--verify` 可核对已导入项。当前仅支持未撤销的群组身份与纯文本消息 staging，不切换现有 API，也不能识别整套备份同时回滚；不可直接作为真实用户迁移或生产切换工具。

[OpenAPI 3.1 文档](openapi/openapi.yaml)覆盖后端接口；`shared/` 提供前后端共用契约。后端为 Node.js/Express/WebSocket，前端为 React/TypeScript/Vite。详细的实现、验证结果和下一阶段能力缺口记录在 [优化记录](docs/optimization-2026-09.md)。

## 许可说明

仓库顶层 [LICENSE](LICENSE) 保持原有 MIT License 声明；第三方代码仍分别遵守其适用条款。Lightfall、Radar、Strands 的历史来源与 MIT + Commons Clause 许可见 [第三方告知](THIRD_PARTY_NOTICES.md)，不得将这些组件描述为纯 MIT 或全部自主原创。项目权属与其他依赖、素材授权仍须另行核对。
