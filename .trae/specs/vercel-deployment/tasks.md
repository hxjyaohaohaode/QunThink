# Tasks

## 阶段一：系统功能验证

- [x] Task 1: 验证核心功能正常
  - [x] 1.1: 验证群组管理功能（创建、切换、删除群组）
  - [x] 1.2: 验证消息发送和接收功能
  - [x] 1.3: 验证 AI 回复功能（至少测试 2 个 AI 模型）
  - [x] 1.4: 验证 WebSocket 实时通信功能
  - [x] 1.5: 验证用户配置功能（AI 人格编辑、用户资料编辑）

## 阶段二：部署准备

- [x] Task 2: 准备 GitHub 仓库
  - [x] 2.1: 检查 .gitignore 确保敏感信息不被提交
  - [x] 2.2: 创建 GitHub 仓库并推送代码
  - [x] 2.3: 确保 README.md 包含项目说明

- [x] Task 3: 配置后端部署文件
  - [x] 3.1: 创建 render.yaml 配置文件
  - [x] 3.2: 确保后端 package.json 有正确的 start 脚本
  - [x] 3.3: 确保后端正确读取环境变量

- [x] Task 4: 配置前端生产环境
  - [x] 4.1: 创建/更新 frontend/.env.production 文件
  - [x] 4.2: 创建 vercel.json 配置文件
  - [x] 4.3: 更新 api.ts 和 websocket.ts 支持生产环境配置

## 阶段三：后端部署

- [ ] Task 5: 部署后端到 Render
  - [ ] 5.1: 在 Render 创建新项目
  - [ ] 5.2: 连接 GitHub 仓库，选择 backend 目录
  - [ ] 5.3: 配置环境变量（API 密钥等）
  - [ ] 5.4: 部署并获取后端 URL
  - [ ] 5.5: 验证后端 API 可访问

## 阶段四：前端部署

- [ ] Task 6: 配置前端 API 地址
  - [ ] 6.1: 更新 frontend/.env.production 中的 VITE_BACKEND_URL
  - [ ] 6.2: 更新 WebSocket 连接地址为 wss://

- [ ] Task 7: 部署前端到 Vercel
  - [ ] 7.1: 在 Vercel 创建新项目
  - [ ] 7.2: 连接 GitHub 仓库，选择 frontend 目录
  - [ ] 7.3: 配置构建命令和输出目录
  - [ ] 7.4: 部署并获取前端 URL

## 阶段五：线上验证

- [ ] Task 8: 验证线上系统功能
  - [ ] 8.1: 访问 Vercel 前端 URL，验证页面加载
  - [ ] 8.2: 验证群组管理功能正常
  - [ ] 8.3: 验证消息发送和 AI 回复功能
  - [ ] 8.4: 验证 WebSocket 连接正常
  - [ ] 8.5: 验证跨域请求正常

- [ ] Task 9: 分享给朋友
  - [ ] 9.1: 发送 Vercel 前端 URL 给朋友
  - [ ] 9.2: 确认朋友可以正常访问和使用

# Task Dependencies
- [Task 5] depends on [Task 2, Task 3]
- [Task 6] depends on [Task 5]
- [Task 7] depends on [Task 6]
- [Task 8] depends on [Task 7]
- [Task 9] depends on [Task 8]
