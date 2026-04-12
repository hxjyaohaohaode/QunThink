# AI 群聊 · 大模型辩论场

一个让多个大模型（DeepSeek、GLM、MiMo、Qwen）围绕同一问题展开讨论、辩论甚至互相质疑的群聊式交互平台，用户扮演"群主"和"裁判"的角色。

## 功能特点

- **多 AI 群聊**：同时与 4 个 AI 模型对话
- **真实群聊体验**：AI 轮流发言，有先后、有节奏、有沉默、有插话
- **AI 人设系统**：每个 AI 有独特的人设和发言风格
- **辩论模式**：AI 之间互相回应、质疑、补充
- **文件共读**：上传文件，所有 AI 共同阅读并从不同角度分析
- **@提及**：@指定 AI 只有被@的 AI 回复
- **深色主题**：符合设计规范的深色主题

## 技术栈

### 前端
- React 18 + Vite + TypeScript
- Zustand（状态管理）
- React Router（路由）
- Tailwind CSS（样式）
- React Markdown + Prism.js（Markdown 渲染和代码高亮）
- Axios（HTTP 客户端）
- Day.js（日期处理）

### 后端
- Node.js + Express
- WebSocket（实时通信）
- SQLite（数据存储）
- Multer（文件上传）
- Axios（AI API 调用）
- 文件解析：pdf-parse、mammoth、xlsx、csv-parse

## 项目结构

```
AI聊天群/
├── frontend/              # 前端项目
├── backend/               # 后端项目
├── 设计方案.md            # 产品设计方案
└── README.md             # 项目说明文档
```

## 快速开始

### 1. 后端启动

```bash
cd backend
npm install
npm run dev
# 服务器运行在 http://localhost:3001
```

### 2. 前端启动

```bash
cd frontend
npm install
npm run dev
# 前端运行在 http://localhost:3000
```

## API 配置

项目已配置好你的 API keys，如需修改请编辑 `backend/.env` 文件：

```env
DEEPSEEK_API_KEY=your_deepseek_api_key
GLM_API_KEY=your_glm_api_key
MIMO_API_KEY=your_minimax_api_key
QWEN_API_KEY=your_qwen_api_key
```

## AI 成员介绍

| AI | 风格 | 特点 |
|----|------|------|
| DeepSeek | 逻辑派 | 逻辑严谨、数据驱动、推理分析 |
| GLM | 博学派 | 知识渊博、旁征博引、人文视角 |
| MiMo | 务实派 | 务实落地、用户导向、简洁直接 |
| Qwen | 综合派 | 综合全面、结构化、善于总结 |

## 核心功能使用

### 发送消息
在输入框中输入文字，按 Enter 发送消息，AI 会轮流回复。

### @提及 AI
输入 `@` 后选择 AI，只有被 @ 的 AI 会回复。

### 辩论模式
点击聊天头部的辩论模式开关，AI 之间会互相回应和质疑。

### 文件上传
点击文件图标上传文件，支持 PDF、Word、Excel、CSV、TXT、代码文件等。

## 设计方案

详细的产品设计方案请查看 `设计方案.md`。

## 开发说明

### 环境变量

后端需要在 `.env` 文件中配置：
- API keys（可选，没有配置会使用模拟回复）
- PORT（可选，默认 3001）

### 数据库

项目使用 SQLite 数据库，数据存储在 `backend/data/` 目录下，首次启动会自动创建默认群组。

## 许可证

MIT License
