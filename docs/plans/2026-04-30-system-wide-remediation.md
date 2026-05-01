# 系统级重构与缺陷歼灭实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 以“零容忍标准”推进系统级重构，优先消除高风险缺陷，建立接口契约、文件链路、性能体验与 CI 门禁的长期治理基础。

**Architecture:** 采用分阶段收敛策略，而不是一次性无边界大改。先统一接口契约和共享类型，再收敛文件与聊天主链路，最后补性能、测试、CI 门禁与发布回滚能力，确保每个阶段都可编译、可测试、可回退。

**Tech Stack:** React 18 + TypeScript + Zustand + Vite，Express + Node.js + Zod + LowDB，GitHub Actions，OpenAPI 3.1，契约测试/集成测试/前端构建验证。

---

### Task 1: 建立契约基线与改造边界

**Files:**
- Modify: `frontend/src/services/api.ts`
- Modify: `frontend/src/types/index.ts`
- Modify: `backend/src/routes/*.js`
- Modify: `backend/src/validators/index.js`
- Create: `shared/`
- Create: `docs/plans/contract-matrix.md`

**Step 1: 盘点前端 API 调用与后端路由**

输出一份矩阵，至少包含：
- 路径
- Method
- 前端调用方法名
- 请求参数
- 返回结构
- 已知偏差

**Step 2: 标注阻断级契约问题**

必须优先锁定：
- 群组创建字段漂移
- 点赞/点踩数据结构不一致
- 文件 `uploader_id` 来源不一致
- 评论、引用、搜索等返回结构差异

**Step 3: 建立共享类型目录最小骨架**

先只放高频域类型：
- `Group`
- `Message`
- `Comment`
- `UploadedFile`
- `ApiEnvelope`

**Step 4: 确认编译边界**

要求：
- 前端可消费共享类型
- 后端可以通过 JSDoc/Zod schema 与共享类型映射
- 不在第一阶段强行把整个后端迁移为 TypeScript

**Step 5: 验证基线**

Run:

```bash
cd frontend
npm run build
cd ../backend
npm test
```

Expected:
- 前端构建成功
- 后端现有测试可运行

### Task 2: 修复接口与契约阻断项

**Files:**
- Modify: `backend/src/validators/index.js`
- Modify: `backend/src/routes/groups.js`
- Modify: `backend/src/routes/messages.js`
- Modify: `backend/src/routes/social.js`
- Modify: `frontend/src/services/api.ts`
- Modify: `frontend/src/stores/groupsStore.ts`
- Modify: `frontend/src/stores/messagesStore.ts`
- Modify: `frontend/src/types/index.ts`
- Create: `backend/test/contracts/`

**Step 1: 为群组创建补 failing tests**

覆盖：
- 普通群创建
- 私聊/AI 群创建
- 不合法字段拒绝
- 返回结构稳定

**Step 2: 统一群组创建 schema 与实现**

要求：
- 删除重复字段别名
- 只保留单一请求格式
- 前后端类型同步

**Step 3: 为点赞/点踩链路补 failing tests**

覆盖：
- 手动点赞
- 取消点赞
- 自动点赞
- 计数与状态同步

**Step 4: 收敛点赞数据模型**

要求：
- `liked_by` 作为唯一事实源
- `likes_count` 由服务端派生
- 删除重复请求与歧义参数

**Step 5: 跑契约测试**

Run:

```bash
cd backend
npm test
```

Expected:
- 新增契约测试通过

### Task 3: 收敛文件与聊天主链路

**Files:**
- Modify: `backend/src/routes/files.js`
- Modify: `backend/src/routes/groups.js`
- Modify: `backend/src/routes/messages.js`
- Modify: `backend/src/services/fileParser/index.js`
- Modify: `backend/src/services/fileAnnotation/index.js`
- Modify: `frontend/src/services/api.ts`
- Modify: `frontend/src/components/Chat/AttachmentStack.tsx`
- Modify: `frontend/src/components/Chat/MessageInput.tsx`
- Modify: `frontend/src/components/Chat/GroupInfoPage.tsx`
- Modify: `frontend/src/stores/messagesStore.ts`
- Create: `backend/test/files-chat.integration.test.js`

**Step 1: 为上传-读取-分析-展示链路写 failing tests**

覆盖：
- 上传后下载成功
- AI 分析成功
- 消息附件展示成功
- 群文件列表与聊天附件来自同一数据源

**Step 2: 修复 `uploader_id` 与存储路径问题**

要求：
- 后端只信任 `req.userId`
- 下载/分析不依赖客户端伪造字段

**Step 3: 合并文件模型**

要求：
- 群文件与聊天文件统一落在单一文件表
- `group.files` 仅保留引用或迁移清理

**Step 4: 修复引用与评论完整性**

要求：
- 写入前校验 `reply_to` / `parent_id`
- 缺失目标返回明确错误
- 为评论补删除/修改能力或明确移除对应 UI

**Step 5: 跑集成测试**

Run:

```bash
cd backend
npm test
```

Expected:
- 文件与聊天链路测试通过

### Task 4: 修复前端稳定性与性能关键路径

**Files:**
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/services/websocket.ts`
- Modify: `frontend/src/components/Chat/MessageInput.tsx`
- Modify: `frontend/src/components/Common/SwipeTransition.tsx`
- Modify: `frontend/src/hooks/useReducedMotion.ts`
- Modify: `frontend/src/index.css`
- Modify: `frontend/index.html`

**Step 1: 为 WebSocket 生命周期与移动端输入补 failing checks**

覆盖：
- 登出后无重连
- 输入框聚焦不被键盘遮挡
- 弱网恢复时无重复轮询风暴

**Step 2: 修复连接与清理逻辑**

要求：
- 认证失效与登出统一走销毁路径
- 全局监听安装与卸载成对出现

**Step 3: 修复移动端与交互体验问题**

要求：
- 输入滚动改为 ref 驱动
- 手势返回只允许边缘触发
- 移除全局禁缩放

**Step 4: 做主路径懒加载与动画收敛**

要求：
- 非首屏页面按需加载
- 主题过渡不再作用于所有子节点
- 保留最小必要动画

**Step 5: 构建验证**

Run:

```bash
cd frontend
npm run build
```

Expected:
- 构建通过
- 打包体积和主包入口下降

### Task 5: 安全基线与部署门禁

**Files:**
- Modify: `frontend/nginx.conf`
- Modify: `backend/src/index.js`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/deploy.yml`
- Create: `openapi/openapi.yaml`
- Create: `scripts/`

**Step 1: 删除前端开发者登录分支**

要求：
- 生产构建中不再包含前端开发凭据校验

**Step 2: 补齐安全头与基础策略**

要求：
- CSP
- `X-Content-Type-Options`
- `Referrer-Policy`
- `frame-ancestors`

**Step 3: 引入 OpenAPI 3.1 最小文档**

先覆盖高频域：
- auth
- groups
- messages
- files

**Step 4: 扩展 CI 门禁**

要求：
- 前端 build
- 后端 test
- OpenAPI 基础校验
- 禁止 `npm audit --audit-level=moderate || true` 这种无条件忽略

**Step 5: 部署与回滚预案文档化**

要求：
- 灰度思路
- 失败回滚步骤
- 配置差异说明

### Task 6: 统一回归验证与交付报告

**Files:**
- Create: `docs/reports/`
- Create: `docs/reports/一次性修复总览报告.md`
- Modify: `.github/workflows/ci.yml`
- Modify: `README.md`

**Step 1: 汇总缺陷、RCA、修复与影响面**

每条至少包含：
- 问题
- 根因
- 修复点
- 风险
- 验证方式

**Step 2: 记录未达成项**

必须显式列出：
- 尚未达成的“零缺陷”目标
- 未覆盖的浏览器矩阵/压测/混沌实验
- 需要后续资源支持的项

**Step 3: 形成统一交付文档**

包含：
- 修复清单
- 性能前后对比
- 安全项处理结果
- 回归结果
- 发布/回滚方案

**Step 4: 最终全量验证**

Run:

```bash
cd backend
npm test
cd ../frontend
npm run build
```

Expected:
- 当前仓库在修复范围内通过构建与测试
- 报告与 CI 门禁同步更新
