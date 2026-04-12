# Tasks

## 阶段一：多用户架构改造

- [ ] Task 1: 创建用户认证中间件
  - [ ] SubTask 1.1: 创建 backend/src/middleware/auth.js，实现用户ID识别逻辑
  - [ ] SubTask 1.2: 从请求头或localStorage token中提取用户ID
  - [ ] SubTask 1.3: 为未识别用户生成唯一用户ID

- [ ] Task 2: 改造数据库架构支持多用户
  - [ ] SubTask 2.1: 修改 backend/src/models/db.js，支持按用户ID创建独立数据文件
  - [ ] SubTask 2.2: 实现用户数据库初始化函数 `initUserDatabase(userId)`
  - [ ] SubTask 2.3: 实现用户数据库获取函数 `getUserDb(userId)`
  - [ ] SubTask 2.4: 创建数据迁移脚本，将现有数据迁移到默认用户

- [ ] Task 3: 更新所有API路由支持用户隔离
  - [ ] SubTask 3.1: 修改 backend/src/routes/groups.js，添加用户ID过滤
  - [ ] SubTask 3.2: 修改 backend/src/routes/messages.js，添加用户ID过滤
  - [ ] SubTask 3.3: 修改 backend/src/routes/files.js，添加用户ID过滤
  - [ ] SubTask 3.4: 修改 backend/src/routes/social.js，添加用户ID过滤
  - [ ] SubTask 3.5: 修改 backend/src/routes/profile.js，添加用户ID过滤
  - [ ] SubTask 3.6: 修改 backend/src/routes/personas.js，添加用户ID过滤

- [ ] Task 4: 更新前端支持用户认证
  - [ ] SubTask 4.1: 创建 frontend/src/utils/userId.ts，生成和管理用户ID
  - [ ] SubTask 4.2: 修改 frontend/src/services/api.ts，在请求头中添加用户ID
  - [ ] SubTask 4.3: 更新 WebSocket 连接，传递用户ID参数

## 阶段二：部署配置

- [ ] Task 5: 创建环境变量配置
  - [ ] SubTask 5.1: 创建 backend/.env.example 模板文件
  - [ ] SubTask 5.2: 创建 frontend/.env.example 模板文件
  - [ ] SubTask 5.3: 修改 backend/src/services/ai/index.js，确保从环境变量读取API密钥

- [ ] Task 6: 创建Docker部署配置
  - [ ] SubTask 6.1: 创建 Dockerfile（后端）
  - [ ] SubTask 6.2: 创建 Dockerfile（前端）
  - [ ] SubTask 6.3: 创建 docker-compose.yml
  - [ ] SubTask 6.4: 创建 .dockerignore 文件

- [ ] Task 7: 创建部署脚本和文档
  - [ ] SubTask 7.1: 创建 deploy/deploy.sh 一键部署脚本
  - [ ] SubTask 7.2: 创建 deploy/README.md 部署指南
  - [ ] SubTask 7.3: 创建 deploy/ngrok-guide.md 内网穿透指南
  - [ ] SubTask 7.4: 创建 deploy/cloud-server-guide.md 云服务器部署指南

- [ ] Task 8: 创建生产环境构建配置
  - [ ] SubTask 8.1: 修改 frontend/vite.config.ts，支持生产环境API地址配置
  - [ ] SubTask 8.2: 创建 frontend/.env.production 生产环境配置
  - [ ] SubTask 8.3: 创建 build.sh 生产环境构建脚本

## 阶段三：测试和验证

- [ ] Task 9: 多用户功能测试
  - [ ] SubTask 9.1: 测试用户数据隔离功能
  - [ ] SubTask 9.2: 测试多用户并发访问
  - [ ] SubTask 9.3: 测试API密钥共享功能

- [ ] Task 10: 部署验证
  - [ ] SubTask 10.1: 验证Docker部署流程
  - [ ] SubTask 10.2: 验证内网穿透方案
  - [ ] SubTask 10.3: 编写用户使用说明

# Task Dependencies
- [Task 2] depends on [Task 1]
- [Task 3] depends on [Task 2]
- [Task 4] depends on [Task 1]
- [Task 9] depends on [Task 1, Task 2, Task 3, Task 4]
- [Task 10] depends on [Task 5, Task 6, Task 7, Task 8]
