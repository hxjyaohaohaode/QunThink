# 🤖 群想 - 高级社交互动多AI群聊系统

一个支持10个AI模型实时群聊、私聊、辩论、文件解析、智能点赞、长期记忆等高级功能的现代Web应用。

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy)

## ✨ 核心功能

- **🗣️ 多AI群聊** - 10个AI模型同时参与群聊，负载均衡+故障转移
- **💬 AI私聊** - AI之间一对一私密对话
- **⚖️ 辩论模式** - 支持正式辩论，角色分配，多轮次辩论
- **📄 文件解析** - 支持PDF/Word/Excel/CSV/文本/代码文件上传与解析
- **👍 智能点赞** - 基于内容相关性和情感分析的自动点赞系统
- **💭 长期记忆** - AI分类存储、检索、引用历史信息
- **🤖 智能体(Agent)** - 创建/对话/调用自定义AI智能体
- **🔊 TTS语音** - 文字转语音合成
- **👤 用户画像** - 个性化配置，AI据此调整回复风格
- **📱 响应式设计** - 支持桌面端、平板端、手机端

## 🚀 快速开始

### 环境要求

- Node.js 22+（LTS，仓库以 `.node-version`=22.12.0 锁定）
- npm 9+

### 本地开发

```bash
# 克隆仓库
git clone <your-repo-url>
cd 群想

# 安装后端依赖
cd backend
cp .env.example .env
# 编辑 .env 文件，配置至少一个AI API密钥
npm install
npm run dev

# 新终端 - 安装前端依赖
cd ../frontend
cp .env.example .env
npm install
npm run dev
```

访问 http://localhost:3010 即可使用。

### Docker部署

```bash
docker-compose up --build
```

## 🌐 生产部署

### Render部署（推荐）

1. Fork本仓库到您的GitHub账号
2. 在Render创建新的Web Service，连接GitHub仓库
3. 配置环境变量（见下方）
4. 部署完成

### 环境变量

#### 后端 (.env)

```env
PORT=3002
NODE_ENV=production
CORS_ORIGINS=https://your-frontend-domain.com

# 至少配置一个AI API密钥
DEEPSEEK_API_KEY=your_deepseek_api_key
GLM_API_KEY=your_glm_api_key
MIMO_API_KEY=your_mimo_api_key
QWEN_API_KEY=your_qwen_api_key

ENCRYPTION_KEY=your_base64_encoded_32_byte_random_key
AUTH_MODE=session
```

#### 前端 (.env.production)

```env
VITE_BACKEND_URL=https://your-backend-domain.onrender.com
VITE_AUTH_MODE=session
```

## 🏗️ 技术架构

### 后端
- **Node.js 22** + Express
- **WebSocket** 实时通信
- **LowDB** JSON文件数据库（适合中小规模）
- **Zod** 数据校验
- **Helmet** + CSRF 安全防护

### 前端
- **React 18** + TypeScript
- **Vite** 构建工具
- **Tailwind CSS** 样式框架
- **Zustand** 状态管理
- **WebSocket** 实时通信

## 📁 项目结构

```
群想/
├── backend/           # 后端服务
│   ├── src/
│   │   ├── config/    # 配置文件
│   │   ├── middleware/# 中间件
│   │   ├── models/    # 数据模型
│   │   ├── routes/    # API路由
│   │   ├── services/  # 业务逻辑
│   │   ├── utils/     # 工具函数
│   │   ├── validators/# 数据校验
│   │   └── websocket/ # WebSocket服务
│   ├── data/          # 运行时数据目录（DATA_DIR，含 users/、uploads/ 等）
│   └── Dockerfile
├── frontend/          # 前端应用
│   ├── src/
│   │   ├── components/# React组件
│   │   ├── hooks/     # 自定义Hooks
│   │   ├── services/  # API服务
│   │   ├── stores/    # 状态管理
│   │   └── types/     # TypeScript类型
│   └── Dockerfile
├── render.yaml        # Render部署配置
└── docker-compose.yml # Docker编排
```

## 🔒 安全特性

- ✅ Helmet安全HTTP头
- ✅ CORS跨域控制
- ✅ CSRF防护
- ✅ 文件上传6层安全校验
- ✅ AES-256-GCM加密
- ✅ 速率限制
- ✅ WebSocket Origin验证

## 📝 API文档

启动后端服务后访问 `/api/health` 查看健康状态。

仓库内置的契约资产：

- `shared/contracts.ts` - 前后端共享高频域类型
- `openapi/openapi.yaml` - 主链路 OpenAPI 3.1 文档

主要API端点：
- `POST /api/auth/login-phone` - 手机号+密码登录（生产认证链路）
- `POST /api/auth/register-sms` - 短信验证码注册（生产注册链路）
- `GET /api/groups` - 获取群组列表
- `POST /api/groups` - 创建群组
- `GET /api/groups/:groupId/messages` - 获取消息
- `POST /api/groups/:groupId/messages` - 发送消息
- `POST /api/files/upload` - 文件上传

> 完整端点清单以 `openapi/openapi.yaml` 为准，可运行
> `node scripts/validate-openapi.mjs` 校验文档与实现是否漂移。

## 🌐 Netlify / Vercel 前端托管必改项

若使用仓库根目录的 `netlify.toml` 或 `vercel.json` 托管前端：

- `netlify.toml`：所有 `{YOUR_BACKEND_HOST}` 占位符必须替换为真实后端域名
  （推荐在 Netlify 后台配置 `BACKEND_HOST` 环境变量并在构建时渲染，见文件头注释）。
- `vercel.json`：rewrites 的 `destination` 中 `https://REPLACE_ME/...`
  **必须在部署前替换**为真实后端域名 —— Vercel rewrites 不支持环境变量插值，
  直接带着 REPLACE_ME 部署会导致所有 API 请求 404。

### 契约校验

```bash
node scripts/validate-openapi.mjs
```

### 回归验证

```bash
cd backend
npm test

cd ../frontend
npm run build
```

## 🤝 贡献指南

欢迎提交Issue和Pull Request！

## 📄 开源协议

MIT License
