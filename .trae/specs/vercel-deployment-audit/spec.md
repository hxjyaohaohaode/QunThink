# Vercel 部署完整检查与修复 Spec

## Why
用户希望将 AI 聊天群项目部署到 Vercel（前端）+ Render（后端），分享给朋友使用。经过对项目全部代码的详细审查，发现了多个严重的安全问题、配置错误和功能缺陷，必须在部署前修复，否则项目无法正常上线或存在严重安全隐患。

## What Changes
- **🔴 严重安全修复**：移除源代码中硬编码的 API 密钥（4个AI服务的密钥泄露在代码中）
- **🔴 CORS 安全配置**：后端 CORS 从允许所有来源改为仅允许 Vercel 前端域名
- **🟡 Vercel 配置修复**：修复 vercel.json 中无效的 API 代理规则
- **🟡 前端环境变量统一**：修复 .env.example 与实际代码不一致的问题
- **🟡 数据持久化方案**：Render 免费层文件系统不持久，需要适配方案
- **🟡 加密密钥配置**：生产环境必须设置 ENCRYPTION_KEY
- **🟢 TypeScript 构建验证**：确保前端构建不会因类型错误失败
- **🟢 健康检查端点增强**：确保 Render 健康检查正常工作
- **🟢 多用户数据隔离**：当前所有用户共享同一数据库，需添加基本用户识别

## Impact
- Affected specs: vercel-deployment, multi-user-deployment
- Affected code:
  - `backend/src/services/ai/index.js` - 移除硬编码 API 密钥
  - `backend/src/services/scheduler/index.js` - 移除硬编码 API 密钥
  - `backend/src/index.js` - CORS 配置、健康检查增强
  - `frontend/vercel.json` - 修复代理规则
  - `frontend/.env.example` - 统一环境变量名
  - `frontend/.env.production` - 确认后端地址正确
  - `backend/.env.example` - 添加 ENCRYPTION_KEY
  - `render.yaml` - 添加 ENCRYPTION_KEY 环境变量

## ADDED Requirements

### Requirement: API 密钥安全
系统 SHALL NOT 在源代码中包含任何 API 密钥的硬编码值。所有密钥必须通过环境变量传入。

#### Scenario: 源代码中无硬编码密钥
- **WHEN** 审查源代码
- **THEN** 不存在任何 API 密钥的硬编码值，所有密钥仅通过 `process.env` 读取

#### Scenario: 缺少环境变量时安全失败
- **WHEN** 必需的 API 密钥环境变量未设置
- **THEN** 系统记录警告日志并使用模拟回复，而不是使用硬编码的备用密钥

### Requirement: CORS 生产环境安全配置
后端 SHALL 在生产环境中限制 CORS 仅允许前端域名访问。

#### Scenario: 生产环境 CORS 限制
- **WHEN** NODE_ENV 为 production
- **THEN** CORS 仅允许来自 Vercel 前端域名的请求

#### Scenario: 开发环境 CORS 宽松
- **WHEN** NODE_ENV 为 development
- **THEN** CORS 允许所有来源（方便本地开发）

### Requirement: Vercel 部署配置正确
前端 SHALL 在 Vercel 上正确部署，API 请求正确路由到后端。

#### Scenario: Vercel 构建成功
- **WHEN** 推送代码到 GitHub 并触发 Vercel 部署
- **THEN** 前端成功构建，无 TypeScript 错误

#### Scenario: 前端正确连接后端
- **WHEN** 用户在 Vercel 前端发送消息
- **THEN** API 请求正确路由到 Render 后端，WebSocket 连接正常

### Requirement: 数据持久化适配
后端 SHALL 在 Render 免费层的临时文件系统上正常工作，并在重启后能恢复基本功能。

#### Scenario: Render 重启后恢复
- **WHEN** Render 服务重启（文件系统被重置）
- **THEN** 后端自动重建数据库目录和默认数据，服务正常启动

### Requirement: 加密密钥生产环境配置
后端 SHALL 在生产环境中使用安全的加密密钥。

#### Scenario: 生产环境加密密钥
- **WHEN** NODE_ENV 为 production 且 ENCRYPTION_KEY 已设置
- **THEN** 使用环境变量中的加密密钥

#### Scenario: 未设置加密密钥时警告
- **WHEN** ENCRYPTION_KEY 未设置
- **THEN** 系统记录明确警告，生产环境应拒绝启动或降级运行

### Requirement: 前端环境变量一致性
前端环境变量配置 SHALL 在 .env.example 和实际代码之间保持一致。

#### Scenario: .env.example 正确
- **WHEN** 开发者查看 .env.example
- **THEN** 变量名与代码中使用的 `import.meta.env.VITE_BACKEND_URL` 一致

## MODIFIED Requirements

### Requirement: 前端 Vercel 部署
前端 SHALL 能够部署到 Vercel 平台，vercel.json 配置正确。

**变更说明**：
- 移除无效的 API 代理规则（因为后端在 Render 上，不在 Vercel 上）
- 添加 SPA 路由回退规则，确保刷新页面不会 404

### Requirement: 后端独立部署
后端 SHALL 部署到 Render，健康检查端点正常工作。

**变更说明**：
- 健康检查端点需要返回更多状态信息
- CORS 配置需要根据环境动态调整

## REMOVED Requirements
无移除的需求。

## 发现的问题详细清单

### 🔴 P0 - 严重安全问题

1. **API 密钥硬编码** (`backend/src/services/ai/index.js` 第8-62行)
   - DeepSeek: `sk-d3a1fe234c19415c9d2ad7ac679a3c72`
   - GLM: `4d1ab3a3f2614cd5aa65b61a86c9ffe8.KKqxIjcMfMZ9TxqW`
   - MiMo: `sk-c5db8fo9m0duxxc21n0yve8fxm66qqu2nk63f052whwnk4il`
   - Qwen: `sk-4d623ee9fe964e4f972fea98da89006b`

2. **API 密钥硬编码** (`backend/src/services/scheduler/index.js` 第802行)
   - Qwen: `sk-4d623ee9fe964e4f972fea98da89006b`

3. **CORS 完全开放** (`backend/src/index.js` 第34行)
   - `app.use(cors())` 允许任何来源访问

### 🟡 P1 - 部署配置问题

4. **vercel.json 代理规则无效** (`frontend/vercel.json`)
   - `{ "source": "/api/(.*)", "destination": "/api/$1" }` 是自引用，无实际效果
   - 缺少 SPA 路由回退（刷新页面会 404）

5. **.env.example 变量名不一致** (`frontend/.env.example`)
   - 使用 `VITE_API_URL` 和 `VITE_WS_URL`，但代码实际使用 `VITE_BACKEND_URL`

6. **render.yaml 缺少 ENCRYPTION_KEY** (`render.yaml`)
   - 未配置加密密钥环境变量

7. **.env.example 缺少 ENCRYPTION_KEY** (`backend/.env.example`)
   - 未列出加密密钥配置

### 🟡 P2 - 数据与功能问题

8. **数据持久化风险** - Render 免费层文件系统临时性
   - lowdb 使用 JSON 文件存储，重启后数据丢失
   - 需要确保 initDatabase 能在空文件系统上正确重建

9. **多用户数据隔离** - 所有用户共享同一数据库
   - 当前使用 `default` 用户数据库
   - 朋友访问时会看到所有人的聊天记录

10. **加密密钥不安全** (`backend/src/utils/encryption.js`)
    - 未设置 ENCRYPTION_KEY 时使用开发密钥
    - 生产环境应强制要求设置

### 🟢 P3 - 构建与优化

11. **TypeScript 构建可能失败**
    - `prismjs` 缺少类型声明
    - `dayjs/plugin/relativeTime` 可能需要类型声明
    - 需要验证 `tsc -b && vite build` 能否成功

12. **健康检查端点简单** (`backend/src/index.js` 第51-53行)
    - 仅返回 `{ status: 'ok' }`，可增加数据库状态检查
