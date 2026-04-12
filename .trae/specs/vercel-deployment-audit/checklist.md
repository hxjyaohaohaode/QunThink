# Vercel 部署完整检查与修复 — 验收检查清单

## 🔴 P0 安全修复

- [x] `backend/src/services/ai/index.js` 中所有 AI_CONFIGS 的 apiKey 不再包含硬编码默认值
- [x] `backend/src/services/scheduler/index.js` 中不再有硬编码 API 密钥
- [x] `backend/.env` 文件在 `.gitignore` 中被正确忽略
- [x] API 密钥未设置时系统使用模拟回复而非硬编码密钥

## 🟡 P1 部署配置

- [x] 后端 CORS 在生产环境仅允许配置的域名
- [x] 后端 CORS 在开发环境允许所有来源
- [x] `frontend/vercel.json` 不再包含无效的 API 代理规则
- [x] `frontend/vercel.json` 包含 SPA 路由回退规则
- [x] `frontend/.env.example` 使用 `VITE_BACKEND_URL` 变量名
- [x] `frontend/.env.production` 中的后端地址正确

## 🟡 P2 后端配置

- [x] `backend/.env.example` 包含 `ENCRYPTION_KEY` 配置项
- [x] `backend/.env.example` 包含 `CORS_ORIGIN` 配置项
- [x] `render.yaml` 包含 `ENCRYPTION_KEY` 环境变量
- [x] `render.yaml` 包含 `CORS_ORIGIN` 环境变量
- [x] 健康检查端点返回数据库和 AI 服务状态
- [x] 数据目录在空文件系统上能自动重建
- [x] uploads 目录能自动创建

## 🟢 P3 构建验证

- [x] `tsc -b` 无 TypeScript 错误
- [x] `vite build` 构建成功
- [x] 构建产物在 `frontend/dist` 目录中

## 部署验证

- [ ] 后端已部署到 Render 且 API 可访问
- [ ] 后端健康检查端点返回正常
- [ ] WebSocket 端点可访问（wss://）
- [ ] 前端已部署到 Vercel 且页面可访问
- [ ] 前端正确请求后端 API
- [ ] WebSocket 连接成功建立
- [ ] 页面刷新不会 404
- [ ] 跨域请求正常处理

## 线上功能验证

- [ ] 用户可以创建新群组
- [ ] 用户可以发送消息
- [ ] AI 可以正常回复消息
- [ ] 消息实时同步正常
- [ ] 辩论模式功能正常
- [ ] AI 人格编辑功能正常
- [ ] 用户资料编辑功能正常
- [ ] 点赞/评论功能正常
- [ ] 私聊功能正常
