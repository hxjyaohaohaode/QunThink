# 系统全面修复 Spec

## Why
系统存在多个严重问题导致功能异常：监控模块 `overallLoad` 持续输出 NaN、负载均衡器使用错误的模型名称导致健康检查失败、`getDb()` 返回 Promise 但被同步调用导致数据库操作失败、personas.js 编码损坏导致 AI 人格配置乱码、前端点赞/评论功能未与后端持久化等。需要系统性修复所有问题，确保系统正常运行。

## What Changes
- 修复 `getDb()` 返回 Promise 但被同步调用的问题，改为同步返回已缓存的数据库对象
- 统一 `loadBalancer.js` 与 `ai/index.js` 的模型配置，修正模型名称
- 在 `loadBalancer.js` 中添加 `deepseek_reasoner` 模型
- 修复 `personas.js` 中文编码损坏问题
- 修复 `monitor.js` 中 `overallLoad` 计算产生 NaN 的问题
- 添加监控事件数量上限，防止数据库无限增长
- 添加 `POST /api/comments` 路由端点
- 修复前端点赞/取消点赞未调用后端 API 持久化的问题
- 清理测试数据库文件
- 移除重复的健康检查系统，统一使用 `ai/index.js` 的健康检查

## Impact
- Affected specs: 后端数据库层、AI服务层、监控模块、社交互动模块、前端消息存储
- Affected code: backend/src/models/db.js, backend/src/services/ai/loadBalancer.js, backend/src/services/ai/index.js, backend/src/services/monitoring/monitor.js, backend/src/config/personas.js, backend/src/routes/messages.js, backend/src/routes/social.js, frontend/src/stores/messagesStore.ts, frontend/src/services/api.ts

## ADDED Requirements

### Requirement: 数据库访问同步化
系统 SHALL 确保 `getDb()` 在数据库初始化完成后同步返回数据库对象，而非 Promise。

#### Scenario: 数据库已初始化后同步获取
- **WHEN** `initDatabase()` 已完成且数据库对象已缓存
- **THEN** `getDb()` SHALL 同步返回 Low 数据库实例，调用方可直接访问 `db.data` 和 `db.read()`/`db.write()`

### Requirement: 负载均衡器模型配置一致性
系统 SHALL 确保负载均衡器的模型配置与 AI 服务主模块的模型配置完全一致。

#### Scenario: 模型名称和端点一致
- **WHEN** 负载均衡器执行健康检查
- **THEN** SHALL 使用与 `ai/index.js` 中 `AI_CONFIGS` 相同的模型名称、API 端点和 API 密钥

#### Scenario: 包含所有AI模型
- **WHEN** 系统支持 5 个 AI 模型（deepseek, deepseek_reasoner, glm, mimo, qwen）
- **THEN** 负载均衡器 SHALL 包含所有 5 个模型的配置

### Requirement: 监控指标计算正确性
系统 SHALL 确保所有监控指标计算结果为有效数值，不产生 NaN。

#### Scenario: overallLoad 计算有效
- **WHEN** 系统收集监控指标
- **THEN** `overallLoad` SHALL 为 0-100 之间的有效数值，不出现 NaN

#### Scenario: 数据库状态获取正确
- **WHEN** 监控模块获取数据库状态
- **THEN** SHALL 正确获取数据库大小和集合数量，不因异步问题导致错误

### Requirement: 监控事件数据量控制
系统 SHALL 限制监控事件存储数量，防止数据库无限增长。

#### Scenario: 监控事件数量上限
- **WHEN** `monitoring_events` 数组长度超过 1000
- **THEN** SHALL 自动清理最旧的事件，保留最新的 1000 条

### Requirement: 评论 API 端点
系统 SHALL 提供 `POST /api/comments` 端点用于创建评论。

#### Scenario: 创建评论成功
- **WHEN** 前端发送 `POST /api/comments` 请求，包含 `message_id` 和 `content`
- **THEN** SHALL 创建评论并保存到对应消息的 `comments` 数组中，返回评论对象

### Requirement: 前端点赞持久化
系统 SHALL 确保前端点赞/取消点赞操作同时更新后端数据。

#### Scenario: 点赞持久化
- **WHEN** 用户点击点赞按钮
- **THEN** 前端 SHALL 调用后端 API 持久化点赞状态，同时更新本地状态

## MODIFIED Requirements

### Requirement: AI 人格配置编码
`personas.js` 中的中文内容 SHALL 使用正确的 UTF-8 编码，确保 AI 人格的关键词、风格、说话方式等配置可正确读取。

### Requirement: 健康检查统一
系统 SHALL 仅使用 `ai/index.js` 中的 `checkAllAIHealth()` 作为健康检查入口，`loadBalancer.js` 的健康检查 SHALL 委托给 `ai/index.js` 或与其保持完全一致。

## REMOVED Requirements

### Requirement: 负载均衡器独立健康检查
**Reason**: 与 `ai/index.js` 的健康检查重复且配置不一致，导致 GLM 等模型健康检查误报失败
**Migration**: 负载均衡器改为从 `ai/index.js` 的 `aiHealthStatus` 获取健康状态
