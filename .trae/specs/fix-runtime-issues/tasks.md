# 修复任务清单

## 第一批：Critical 级别修复（系统无法运行）

- [x] Task 1: 统一前后端端口配置
  - [x] 1.1: 修改 frontend/vite.config.ts 代理目标为 http://localhost:3002
  - [x] 1.2: 修改 frontend/src/services/api.ts 中 BASE_URL 为 '/api'（使用代理相对路径）
  - [x] 1.3: 修改 frontend/src/services/websocket.ts 中 WS_URL 动态构建（基于当前页面协议和主机）

- [x] Task 2: 修复前端 api.ts 语法错误
  - [x] 2.1: 删除 api.ts 文件末尾多余的 `};`

- [x] Task 3: 修复 backend/src/index.js 中 initDatabase() 未 await 的问题
  - [x] 3.1: 将 server.listen 移到 initDatabase().then() 回调中

- [x] Task 4: 修复 interactionLogger.js 中 getDb() 初始化时序问题
  - [x] 4.1: 将构造函数中的 this.db = getDb() 改为延迟获取模式
  - [x] 4.2: 在每个需要 db 的方法中调用 getDb()，而非构造函数中缓存

- [x] Task 5: 修复 monitor.js 中 ESM 使用 require() 的问题
  - [x] 5.1: 将 `require('../ai/loadBalancer.js').default` 改为静态 import
  - [x] 5.2: 修复 getAIModelStatus 方法使用导入的模块

- [x] Task 6: 修复 smartLike.js 中 analyzeSentiment 返回值不一致
  - [x] 6.1: 空输入时返回 { score: 0, positive: 0, negative: 0, magnitude: 0 } 而非数字 0

- [x] Task 7: 修复 social/index.js 中对 calculateSimilarity 和 analyzeSentiment 的错误调用
  - [x] 7.1: 从 smartLike.js 中额外导入 calculateSimilarity 和 analyzeSentiment 命名导出
  - [x] 7.2: 修改 calculateSocialMetrics 方法使用直接导入的函数

- [x] Task 8: 修复 evaluateMessageForLike 函数签名不匹配
  - [x] 8.1: 修改 social/index.js 中 evaluateMessageForLike 方法接受3个参数并正确传递

## 第二批：Critical 级别修复（功能异常）

- [x] Task 9: 修复消息加密后AI收到加密内容的问题
  - [x] 9.1: 在 scheduler/index.js 的 processQueueItem 中，读取 recentMessages 后解密 content
  - [x] 9.2: 确保 encryptionUtils.decrypt 在解密失败时返回原始内容（容错）

- [x] Task 10: 修复 contextAwareComments.js 中权重计算超过1.0的问题
  - [x] 10.1: 修正 calculateOverallScore 中权重分配，使总和等于1.0

- [x] Task 11: 修复 scheduler/index.js 中 broadcastAIMessage 参数问题
  - [x] 11.1: 修正 item.type.reply_to 为正确的属性访问逻辑

- [x] Task 12: 修复 monitor.js 中 recordEvent 不持久化的问题
  - [x] 12.1: 在 recordEvent 中添加 await db.write()（使用异步方式）
  - [x] 12.2: 在 db.js 的 defaultData 中添加 monitoring_events 字段

## 第三批：Warning 级别修复

- [x] Task 13: 修复 interactionLogger.js 中 analyzeSentiment 调用方式
  - [x] 13.1: 从 smartLike.js 导入 analyzeSentiment 命名导出，而非通过实例调用

- [x] Task 14: 删除死代码 services/file/index.js
  - [x] 14.1: 删除 backend/src/services/file/index.js 文件

- [x] Task 15: 修复前端 messagesStore.ts 中 addComment 未调用后端API
  - [x] 15.1: 在 addComment 方法中添加调用 POST /api/comments 的逻辑

- [x] Task 16: 修复 encryption.js 中密钥派生不一致问题
  - [x] 16.1: 使用确定性SHA-256派生替代随机盐值派生，确保重启后密钥一致

## 第四批：验证

- [x] Task 17: 端到端验证
  - [x] 17.1: 启动后端服务器，确认无启动错误
  - [x] 17.2: 启动前端开发服务器，确认编译成功
  - [x] 17.3: 验证 /api/health 端点返回正常
  - [x] 17.4: 验证 /api/monitoring/metrics 端点返回正常
  - [x] 17.5: 验证 /api/social/evaluate-like 端点返回正常
  - [x] 17.6: 验证前端页面能正常加载和显示

# Task Dependencies
- Task 1 需最先完成（端口问题是其他测试的前提）
- Task 3 需在 Task 4 之前完成（数据库初始化顺序）
- Task 6 需在 Task 7 和 Task 13 之前完成（analyzeSentiment 返回值修复是其他调用的前提）
- Task 9 依赖 Task 16（加密修复后才能正确解密）
- Task 17 依赖所有其他 Task 完成