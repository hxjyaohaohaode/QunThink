# 项目运行时问题修复 Spec

## Why
项目经过大量功能开发后，存在多个严重的运行时问题，包括前后端端口不一致导致通信失败、ESM模块中错误使用require、函数签名不匹配、消息加密与AI上下文冲突等，导致系统无法正常运行。需要系统性修复所有Critical和Warning级别的问题，确保项目能够正常启动和运行。

## What Changes
- 统一前后端端口配置（.env、vite.config.ts、api.ts、websocket.ts）
- 修复前端 api.ts 语法错误（多余的 `};`）
- 修复 interactionLogger.js 中 getDb() 初始化时序问题
- 修复 monitor.js 中 ESM 模块使用 require() 的问题
- 修复 smartLike.js 中 analyzeSentiment 返回值不一致
- 修复 social/index.js 中对 calculateSimilarity 和 analyzeSentiment 的错误调用
- 修复 evaluateMessageForLike 函数签名不匹配
- 修复消息加密后AI收到加密内容的问题
- 修复 contextAwareComments.js 中权重计算超过1.0的问题
- 修复 scheduler/index.js 中 broadcastAIMessage 参数问题
- 修复 initDatabase() 未 await 的问题
- 删除死代码 services/file/index.js
- 修复前端 messagesStore.ts 中 addComment 未调用后端API的问题

## Impact
- Affected specs: 所有后端服务模块、前端API层、WebSocket通信
- Affected code: backend/src/index.js, backend/src/services/social/*, backend/src/services/monitoring/*, backend/src/services/interactionLogger.js, backend/src/services/ai/*, backend/src/services/scheduler/index.js, backend/src/routes/messages.js, backend/src/utils/encryption.js, frontend/src/services/api.ts, frontend/src/services/websocket.ts, frontend/src/stores/messagesStore.ts, frontend/vite.config.ts

## ADDED Requirements

### Requirement: 统一端口配置
系统 SHALL 在所有配置文件中使用一致的端口号，确保前后端通信正常。

#### Scenario: 前后端端口一致
- **WHEN** 后端服务启动在 PORT 环境变量指定的端口
- **THEN** 前端 api.ts 的 BASE_URL、websocket.ts 的 WS_URL、vite.config.ts 的代理目标 SHALL 与后端端口一致

### Requirement: ESM模块兼容性
系统 SHALL 在所有 ESM 模块中使用 import/export 语法，不使用 require()。

#### Scenario: ESM模块中使用import
- **WHEN** 模块需要引用其他模块
- **THEN** SHALL 使用静态 import 或动态 import()，不使用 require()

### Requirement: 函数签名一致性
系统 SHALL 确保所有函数调用的参数与函数定义的签名一致。

#### Scenario: 函数调用参数匹配
- **WHEN** 调用 evaluateMessageForLike(message, contextMessages, senderInfo)
- **THEN** 实际函数定义 SHALL 接受3个参数并正确传递

### Requirement: 消息加密与AI上下文兼容
系统 SHALL 确保传给AI模型的对话历史是解密后的明文，而非加密后的密文。

#### Scenario: AI收到明文上下文
- **WHEN** 从数据库读取消息历史传给AI模型
- **THEN** SHALL 先解密消息内容再传递给AI

### Requirement: 数据库初始化时序安全
系统 SHALL 确保数据库初始化完成后才接受请求。

#### Scenario: 数据库就绪后启动服务
- **WHEN** 服务器启动
- **THEN** SHALL await initDatabase() 完成后再开始监听端口

## MODIFIED Requirements

### Requirement: 智能点赞评估
evaluateMessageForLike 函数 SHALL 接受 (message, contextMessages, senderInfo) 三个参数，并正确传递给 smartLikeEngine.evaluateMessage。

### Requirement: 情感分析返回值
analyzeSentiment 函数 SHALL 在所有情况下返回统一的对象格式 { score, positive, negative, magnitude }，空输入时返回 { score: 0, positive: 0, negative: 0, magnitude: 0 }。

### Requirement: 评论相关性评分
calculateOverallScore 中的权重总和 SHALL 等于1.0，确保评分在0-1范围内。
