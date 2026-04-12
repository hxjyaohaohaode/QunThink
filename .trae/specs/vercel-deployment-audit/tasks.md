# Tasks

## 阶段一：严重安全修复（必须最先完成）

- [x] Task 1: 移除源代码中硬编码的 API 密钥
  - [x] 1.1: 修改 `backend/src/services/ai/index.js`，移除 AI_CONFIGS 中所有 API 密钥的硬编码默认值，改为仅从 `process.env` 读取，未设置时设为空字符串
  - [x] 1.2: 修改 `backend/src/services/scheduler/index.js` 第802行，移除 Qwen API 密钥的硬编码默认值
  - [x] 1.3: 确认 `backend/.env` 文件在 `.gitignore` 中（已被忽略），确保不会被提交到 Git

## 阶段二：CORS 安全配置

- [x] Task 2: 配置生产环境 CORS 限制
  - [x] 2.1: 修改 `backend/src/index.js`，将 `app.use(cors())` 改为根据 NODE_ENV 动态配置 CORS
  - [x] 2.2: 生产环境仅允许 Vercel 前端域名和 Render 后端域名
  - [x] 2.3: 开发环境保持允许所有来源
  - [x] 2.4: 添加 `CORS_ORIGIN` 环境变量支持，方便部署时配置

## 阶段三：Vercel 部署配置修复

- [x] Task 3: 修复 vercel.json 配置
  - [x] 3.1: 移除无效的 API 代理 rewrite 规则
  - [x] 3.2: 添加 SPA 路由回退规则（`"source": "/(.*)", "destination": "/index.html"`），确保刷新页面不会 404
  - [x] 3.3: 保留安全 headers 配置

- [x] Task 4: 统一前端环境变量
  - [x] 4.1: 更新 `frontend/.env.example`，使用 `VITE_BACKEND_URL` 替代 `VITE_API_URL` 和 `VITE_WS_URL`
  - [x] 4.2: 确认 `frontend/.env.production` 中的 `VITE_BACKEND_URL` 指向正确的 Render 后端地址

## 阶段四：后端部署配置完善

- [x] Task 5: 完善加密密钥配置
  - [x] 5.1: 更新 `backend/.env.example`，添加 `ENCRYPTION_KEY` 和 `CORS_ORIGIN` 配置项
  - [x] 5.2: 更新 `render.yaml`，添加 `ENCRYPTION_KEY` 和 `CORS_ORIGIN` 环境变量配置
  - [x] 5.3: 修改 `backend/src/utils/encryption.js`，在生产环境未设置 ENCRYPTION_KEY 时输出更明确的警告

- [x] Task 6: 增强健康检查端点
  - [x] 6.1: 修改 `/api/health` 端点，返回数据库状态、AI 服务状态等更多信息
  - [x] 6.2: 确保健康检查在数据库目录不存在时也能正常返回

- [x] Task 7: 确保数据目录自动重建
  - [x] 7.1: 验证 `initDatabase()` 在空文件系统上能正确创建目录和默认数据
  - [x] 7.2: 确保 uploads 目录也能自动创建

## 阶段五：前端构建验证

- [x] Task 8: 验证前端构建成功
  - [x] 8.1: 运行 `npm run build`（即 `tsc -b && vite build`），确保无 TypeScript 错误
  - [x] 8.2: 如有类型错误，修复或添加必要的类型声明

## 阶段六：部署验证

- [ ] Task 9: 部署后端到 Render 并验证
  - [ ] 9.1: 在 Render 创建新项目，连接 GitHub 仓库
  - [ ] 9.2: 配置所有环境变量（API 密钥、ENCRYPTION_KEY、CORS_ORIGIN）
  - [ ] 9.3: 部署并验证后端 API 可访问
  - [ ] 9.4: 验证 WebSocket 端点可访问
  - [ ] 9.5: 验证健康检查端点返回正常

- [ ] Task 10: 部署前端到 Vercel 并验证
  - [ ] 10.1: 在 Vercel 创建新项目，连接 GitHub 仓库
  - [ ] 10.2: 配置 Root Directory 为 frontend
  - [ ] 10.3: 部署并验证前端页面可访问
  - [ ] 10.4: 验证前端能正确连接后端 API
  - [ ] 10.5: 验证 WebSocket 连接正常
  - [ ] 10.6: 验证页面刷新不会 404

- [ ] Task 11: 线上功能验证
  - [ ] 11.1: 验证群组管理功能
  - [ ] 11.2: 验证消息发送和 AI 回复
  - [ ] 11.3: 验证 WebSocket 实时通信
  - [ ] 11.4: 验证跨域请求正常
  - [ ] 11.5: 验证 AI 人格编辑功能
  - [ ] 11.6: 验证用户资料编辑功能

# Task Dependencies
- [Task 2] depends on [Task 1] (先修复安全问题再改 CORS)
- [Task 3] depends on [Task 1] (确保代码安全后再配置部署)
- [Task 4] depends on [Task 3]
- [Task 5] depends on [Task 1]
- [Task 6] depends on [Task 5]
- [Task 7] depends on [Task 5]
- [Task 8] depends on [Task 3, Task 4] (配置修复后再验证构建)
- [Task 9] depends on [Task 1, Task 2, Task 5, Task 6, Task 7]
- [Task 10] depends on [Task 8]
- [Task 11] depends on [Task 9, Task 10]
