# 项目运行时问题修复 — 验收检查清单

## Critical 级别修复验证

- [x] 前后端端口配置一致：后端 .env PORT=3002、vite.config.ts 代理目标 http://localhost:3002、api.ts BASE_URL='/api'（通过代理）、websocket.ts 动态构建WS_URL
- [x] 前端 api.ts 编译无语法错误（多余的 `};` 已删除）
- [x] 后端启动时 initDatabase() 在 server.listen 之前完成（使用 .then() 回调）
- [x] interactionLogger.js 的 getDb() 不在构造函数中调用，而是在方法中延迟获取
- [x] monitor.js 中不使用 require()，改用 import 静态导入 aiLoadBalancer
- [x] smartLike.js 的 analyzeSentiment 在空输入时返回对象格式 { score: 0, positive: 0, negative: 0, magnitude: 0 }
- [x] social/index.js 中 calculateSimilarity 和 analyzeSentiment 通过命名导入调用，而非 smartLikeEngine.constructor
- [x] social/index.js 中 evaluateMessageForLike 接受3个参数并正确传递给 smartLikeEngine.evaluateMessage
- [x] scheduler/index.js 中传给AI的对话历史是解密后的明文（使用 encryptionUtils.decryptText）
- [x] contextAwareComments.js 中 calculateOverallScore 权重总和等于1.0（0.4+0.15+0.15+0.3=1.0）
- [x] scheduler/index.js 中 broadcastAIMessage 参数正确访问 item.type 的属性（安全判断对象/字符串）
- [x] monitor.js 中 recordEvent 持久化数据到数据库（async + await db.write()）
- [x] db.js 的 defaultData 中包含 monitoring_events 字段，且 initDatabase 自动补全缺失字段

## Warning 级别修复验证

- [x] interactionLogger.js 中 analyzeSentiment 通过命名导入调用
- [x] services/file/index.js 死代码已删除
- [x] messagesStore.ts 中 addComment 调用后端 API（POST /api/comments）
- [x] encryption.js 中密钥派生在服务器重启后保持一致（使用确定性SHA-256派生）

## 端到端运行验证

- [x] 后端服务器启动无错误（无 TypeError、ReferenceError 等）
- [x] 前端编译成功（Vite dev server 正常运行）
- [x] GET /api/health 返回 { success: true, health: {...} }
- [x] GET /api/monitoring/health 返回系统健康状态
- [x] POST /api/social/evaluate-like 返回评估结果（无 TypeError）
- [x] GET /api/interaction/stats 返回互动统计数据
- [x] GET /api/interaction/quality 返回互动质量评估
- [x] GET /api/memory/stats 返回记忆系统统计
- [x] GET /api/ai/models 返回4个AI模型状态（deepseek/glm/mimo/qwen）
- [x] 前端代理正常工作（localhost:3000/api 代理到 localhost:3002/api）