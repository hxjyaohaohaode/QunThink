# AI 群聊 · 大模型辩论场 — 任务清单

## 项目阶段划分

### 第一阶段：项目初始化（第 1~2 天）

- [x] 1.1: 初始化前端项目
  - [x] 创建 React + Vite + TypeScript 项目
  - [x] 安装依赖：Tailwind CSS、Tailwind Merge、Zustand、React Router、axios、react-markdown、prismjs、dayjs
  - [x] 配置 Tailwind CSS 和深色主题
  - [x] 创建项目目录结构

- [x] 1.2: 初始化后端项目
  - [x] 创建 Node.js + Express 项目
  - [x] 安装依赖：ws、better-sqlite3、multer、uuid、pdf-parse、mammoth、xlsx、csv-parse
  - [x] 配置 SQLite 数据库
  - [x] 创建项目目录结构

### 第二阶段：前端基础组件（第 3~5 天）

- [x] 2.1: 创建基础布局组件
  - [x] 创建主布局容器（侧边栏 + 主内容区）
  - [x] 实现响应式设计（桌面端 + 移动端）

- [x] 2.2: 创建群组侧边栏组件
  - [x] 群组列表展示
  - [x] 群组切换功能
  - [x] 在线成员列表
  - [x] 创建群组按钮

- [x] 2.3: 创建聊天区域组件
  - [x] 消息列表（支持滚动加载）
  - [x] 消息气泡（用户消息右对齐，AI 消息左对齐）
  - [x] AI 头像和名字颜色区分
  - [x] 正在输入状态展示
  - [x] 系统消息居中展示

- [x] 2.4: 创建消息输入组件
  - [x] 文本输入框
  - [x] @提及功能（输入 @ 弹出 AI 列表）
  - [x] 发送按钮
  - [x] 文件上传按钮

- [x] 2.5: 创建消息操作栏
  - [x] Hover 显示操作栏
  - [x] 讨论、认可、收藏、复制按钮

### 第三阶段：前端状态管理（第 6~7 天）

- [x] 3.1: 创建 Zustand Store
  - [x] groupsStore：群组状态管理
  - [x] messagesStore：消息状态管理
  - [x] uiStore：UI 状态管理（当前群组、辩论模式等）

- [x] 3.2: 创建 API 服务层
  - [x] groups API 服务
  - [x] messages API 服务
  - [x] files API 服务

- [x] 3.3: 创建 WebSocket 服务
  - [x] WebSocket 连接管理
  - [x] 消息接收处理
  - [x] 正在输入状态处理
  - [x] 重连机制

### 第四阶段：后端 API（第 8~10 天）

- [x] 4.1: 创建数据库模型
  - [x] groups 表模型
  - [x] messages 表模型
  - [x] files 表模型

- [x] 4.2: 创建群组 API 路由
  - [x] GET /api/groups - 获取群组列表
  - [x] GET /api/groups/:id - 获取群组详情
  - [x] PUT /api/groups/:id/debate - 切换辩论模式

- [x] 4.3: 创建消息 API 路由
  - [x] GET /api/groups/:id/messages - 获取消息列表
  - [x] POST /api/groups/:id/messages - 发送消息
  - [x] DELETE /api/messages/:id - 删除消息

- [x] 4.4: 创建文件 API 路由
  - [x] POST /api/files/upload - 上传文件
  - [x] GET /api/files/:id - 获取文件信息
  - [x] GET /api/files/:id/content - 获取文件内容

- [x] 4.5: 创建 WebSocket 处理
  - [x] 连接管理
  - [x] 消息广播
  - [x] 正在输入状态推送

### 第五阶段：AI 调度引擎（第 11~14 天）

- [x] 5.1: 创建 AI 人设配置
  - [x] DeepSeek 人设配置
  - [x] GLM 人设配置
  - [x] MiMo 人设配置
  - [x] Qwen 人设配置

- [x] 5.2: 创建 AI API 适配层
  - [x] 统一接口定义
  - [x] DeepSeek API 适配器
  - [x] GLM API 适配器
  - [x] MiMo API 适配器
  - [x] Qwen API 适配器

- [x] 5.3: 创建发言调度引擎
  - [x] 消息解析模块
  - [x] 发言队列生成模块
  - [x] 发言意愿评分模块
  - [x] 发言间隔计算模块
  - [x] 打断处理模块

- [x] 5.4: 创建辩论模式处理
  - [x] 辩论轮次管理
  - [x] 辩论强度控制
  - [x] AI 互相回应处理

### 第六阶段：文件解析服务（第 15~16 天）

- [x] 6.1: 创建文件上传处理
  - [x] 文件类型验证
  - [x] 文件大小验证
  - [x] 文件存储

- [x] 6.2: 创建文件解析服务
  - [x] PDF 解析（pdf-parse）
  - [x] Word 解析（mammoth）
  - [x] Excel 解析（xlsx）
  - [x] CSV 解析（csv-parse）
  - [x] 图片 OCR（基础 Base64 识别）

### 第七阶段：系统集成与测试（第 17~18 天）

- [x] 7.1: 前后端联调
  - [x] API 对接
  - [x] WebSocket 双向通信
  - [x] 文件上传流程

- [x] 7.2: 功能测试
  - [x] 群组切换测试
  - [x] 消息发送测试
  - [x] @提及功能测试
  - [x] 辩论模式测试
  - [x] 文件上传测试

- [x] 7.3: 界面优化
  - [x] 动画效果
  - [x] 响应式适配
  - [x] 深色主题细节调整

### 第八阶段：部署准备（第 19~20 天）

- [x] 8.1: 项目文档
  - [x] README.md 编写
  - [x] 环境变量配置说明

- [x] 8.2: 部署配置
  - [x] 前端构建配置
  - [x] 后端启动配置

---

## 任务依赖关系

```
第一阶段（项目初始化）
    ↓
第二阶段（前端基础组件）← 第二阶段（前端基础组件）
    ↓                              ↓
第三阶段（前端状态管理）    第四阶段（后端 API）
    ↓                              ↓
第五阶段（AI 调度引擎）←←←←←←←←（依赖第四阶段）
    ↓
第六阶段（文件解析服务）←←←←←←←（依赖第四阶段）
    ↓
第七阶段（系统集成与测试）
    ↓
第八阶段（部署准备）
```

---

## 并行任务说明

以下任务可以并行执行：
- 前端组件开发（第二阶段）和后端 API 开发（第四阶段）可以并行进行
- AI 调度引擎开发（第五阶段）可以在后端 API 基础完成后开始

---

## 验收标准

每个阶段完成后需要满足：
1. 代码能够正常运行，无编译错误
2. 对应功能能够按照设计文档正常工作
3. UI 表现符合设计规范
