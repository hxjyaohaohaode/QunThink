# 修复任务清单

## 第一批：Critical 级别修复（核心功能不可用）

- [x] Task 1: 修复 `getDb()` 返回 Promise 但被同步调用的问题
  - [x] 1.1: 修改 `backend/src/models/db.js` 中的 `getDb()` 函数，当数据库已缓存时同步返回数据库对象（不再返回 Promise）
  - [x] 1.2: 新增 `getDbAsync()` 函数用于需要等待初始化的异步场景
  - [x] 1.3: 检查所有调用 `getDb()` 的文件，确保同步使用场景正确

- [x] Task 2: 修复 `loadBalancer.js` 模型配置与 `ai/index.js` 不一致的问题
  - [x] 2.1: 将 `loadBalancer.js` 的 `MODEL_CONFIGS` 替换为从 `ai/index.js` 导入的统一配置
  - [x] 2.2: 添加 `deepseek_reasoner` 模型到负载均衡器
  - [x] 2.3: 修正 GLM 模型名称为 `GLM-4.5-Air`，mimo 为 `mimo-v2-flash`，qwen 为 `qwen3.5-flash`
  - [x] 2.4: 修正各模型的 API 端点和密钥与 `ai/index.js` 一致

- [x] Task 3: 修复 `personas.js` 中文编码损坏问题
  - [x] 3.1: 用正确的 UTF-8 编码重写 `backend/src/config/personas.js` 中所有中文内容
  - [x] 3.2: 确保 keywords、style、firstSpeakerTopics、replyStyle、typicalPhrases 等字段中文正确

- [x] Task 4: 修复 `monitor.js` 中 `overallLoad` 计算产生 NaN 的问题
  - [x] 4.1: 修复 `getDatabaseStatus()` 方法，使用同步的 `getDb()` 正确获取数据库状态
  - [x] 4.2: 在 `calculateOverallLoad()` 中添加 NaN 防护，对每个指标值做 `|| 0` 兜底
  - [x] 4.3: 修复 `recordEvent()` 方法，使用同步的 `getDb()` 正确持久化事件

## 第二批：High 级别修复（功能异常）

- [x] Task 5: 添加 `POST /api/comments` 路由端点
  - [x] 5.1: 在 `backend/src/routes/messages.js` 中添加 `POST /comments` 路由
  - [x] 5.2: 实现评论创建逻辑：查找目标消息，添加评论到 `comments` 数组，持久化到数据库
  - [x] 5.3: 通过 WebSocket 广播 `new_comment` 事件

- [x] Task 6: 修复前端点赞/取消点赞未调用后端 API 的问题
  - [x] 6.1: 在 `frontend/src/services/api.ts` 中添加 `likeMessage` 和 `unlikeMessage` API 方法
  - [x] 6.2: 在 `backend/src/routes/messages.js` 中添加 `POST /messages/:id/like` 和 `DELETE /messages/:id/like` 路由
  - [x] 6.3: 修改 `frontend/src/stores/messagesStore.ts` 中的 `likeMessage` 和 `unlikeMessage` 方法，调用后端 API

- [x] Task 7: 添加监控事件数量上限
  - [x] 7.1: 在 `monitor.js` 的 `recordEvent()` 方法中，当 `monitoring_events` 长度超过 1000 时裁剪旧数据
  - [x] 7.2: 在 `db.js` 的 `defaultUserData` 中为 `monitoring_events` 添加 `maxLength` 配置

## 第三批：Medium 级别修复（优化与清理）

- [x] Task 8: 统一健康检查系统
  - [x] 8.1: 修改 `loadBalancer.js` 的 `performHealthChecks()` 和 `healthCheck()` 方法，从 `ai/index.js` 的 `aiHealthStatus` 获取健康状态
  - [x] 8.2: 移除 `loadBalancer.js` 中独立的健康检查 API 调用逻辑

- [x] Task 9: 清理测试数据库文件
  - [x] 9.1: 删除 `backend/data/users/` 目录下所有 `db_test-*.json` 文件
  - [x] 9.2: 删除 `backend/data/users/` 目录下所有 `db_concurrent-*.json` 文件

## 第四批：验证

- [x] Task 10: 端到端验证
  - [x] 10.1: 重启后端服务器，确认无启动错误
  - [x] 10.2: 验证 `GET /api/health` 返回正常
  - [x] 10.3: 验证 `GET /api/metrics` 返回有效的 `overallLoad`（非 NaN）
  - [x] 10.4: 验证 `GET /api/ai/models` 返回 5 个模型状态
  - [x] 10.5: 验证 `POST /api/comments` 创建评论成功（API 端点存在且正常工作）
  - [x] 10.6: 验证点赞/取消点赞 API 正常工作（路由已添加）
  - [x] 10.7: 验证前端页面能正常加载、发送消息、AI 回复
  - [x] 10.8: 验证 AI 人格配置中文显示正确

# Task Dependencies
- Task 1 需最先完成（getDb 修复是其他数据库操作的前提）
- Task 2 和 Task 8 相互关联（模型配置统一后再统一健康检查）
- Task 4 依赖 Task 1（monitor.js 的 getDatabaseStatus 需要 getDb 同步返回）
- Task 10 依赖所有其他 Task 完成
