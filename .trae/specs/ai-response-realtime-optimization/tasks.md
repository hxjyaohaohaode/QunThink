# AI 响应实时优化任务清单

## 第一批：AI连接稳定性修复

- [x] Task 1: 增强AI连接状态检查机制
  - [x] 1.1: 在 backend/src/services/ai/index.js 中添加AI健康检查函数
  - [x] 1.2: 实现API连接测试功能，验证每个AI的endpoint和apiKey有效性
  - [x] 1.3: 添加启动时的自动健康检查，记录所有AI的连接状态
  - [x] 1.4: 为每个AI添加状态标识（healthy/unhealthy/checking）

- [x] Task 2: 优化AI调用失败处理
  - [x] 2.1: 改进 callAI 函数的错误处理逻辑
  - [x] 2.2: 实现智能重试机制（最多3次，指数退避）
  - [x] 2.3: 确保模拟响应机制在API失败时正常工作
  - [x] 2.4: 添加详细的错误日志记录

## 第二批：AI响应质量控制

- [x] Task 3: 增强意图识别和上下文理解
  - [x] 3.1: 优化 buildSystemPrompt 函数，增强AI对上下文的理解
  - [x] 3.2: 改进 recentMessages 的传递逻辑，确保解密后的内容正确传递
  - [x] 3.3: 添加用户意图关键词提取功能
  - [x] 3.4: 在 system prompt 中明确要求AI关注用户意图

- [x] Task 4: 实现响应相关性校验
  - [x] 4.1: 创建响应相关性评分函数
  - [x] 4.2: 在AI响应生成后进行相关性检查
  - [x] 4.3: 对于低相关性响应，触发重新生成或调整提示词

## 第三批：实时推送优化

- [x] Task 5: 增强WebSocket连接稳定性
  - [x] 5.1: 在 backend/src/websocket/index.js 中添加心跳检测机制
  - [x] 5.2: 实现客户端心跳响应，每30秒发送一次ping
  - [x] 5.3: 添加连接超时处理，自动断开无响应的客户端
  - [x] 5.4: 优化重连逻辑，减少连接中断时间

- [x] Task 6: 优化消息推送机制
  - [x] 6.1: 确保 broadcastAIMessage 在消息存储后立即执行
  - [x] 6.2: 添加消息推送确认机制
  - [x] 6.3: 实现推送失败时的消息队列缓存
  - [x] 6.4: 添加备用轮询API，确保消息不丢失

## 第四批：输入状态显示优化

- [x] Task 7: 完善AI输入状态广播
  - [x] 7.1: 在 scheduler/index.js 中，确保在调用AI前立即发送typing状态
  - [x] 7.2: 验证 broadcastTypingStatus 函数的正确性
  - [x] 7.3: 确保typing状态在AI响应完成或失败后立即关闭
  - [x] 7.4: 添加typing状态超时自动清理机制（30秒）

- [x] Task 8: 优化前端输入状态显示
  - [x] 8.1: 在 frontend/src/services/websocket.ts 中确保正确处理 ai_typing 和 ai_typing_stop 消息
  - [x] 8.2: 验证 frontend/src/stores/uiStore.ts 中 setTyping 函数的实现
  - [x] 8.3: 确保 TypingIndicator 组件能够正确显示单个和多个AI的输入状态
  - [x] 8.4: 添加输入状态的动画效果，提升用户体验

## 第五批：@提及功能增强

- [x] Task 9: 优化@提及识别逻辑
  - [x] 9.1: 改进 extractMentions 函数，支持中英文AI名称
  - [x] 9.2: 在 buildMessageQueue 中确保被@的AI获得最高优先级（score += 100）
  - [x] 9.3: 确保被@的AI总是参与响应，不受其他条件限制
  - [x] 9.4: 添加@提及的日志记录，便于调试

- [x] Task 10: 增强AI间的@提及响应
  - [x] 10.1: 在AI响应内容中识别对其他AI的@提及
  - [x] 10.2: 当AI提及另一个AI时，触发被提及AI的响应队列
  - [x] 10.3: 确保所有AI都能看到完整的对话内容
  - [x] 10.4: 添加AI间互动的延迟控制，避免响应冲突

## 第六批：消息换行显示优化

- [x] Task 11: 优化前端消息渲染
  - [x] 11.1: 在 MessageBubble.tsx 中改进 markdown-content 的CSS样式
  - [x] 11.2: 确保换行符（\n）正确渲染为段落分隔
  - [x] 11.3: 优化 ReactMarkdown 的渲染配置
  - [x] 11.4: 添加合理的段落间距（margin-bottom）

- [x] Task 12: 统一消息格式化
  - [x] 12.1: 在后端AI响应中统一换行符格式
  - [x] 12.2: 确保模拟响应中的换行格式正确
  - [x] 12.3: 添加消息内容的预处理，规范化换行符

## 第七批：验证测试

- [x] Task 13: 端到端功能验证
  - [x] 13.1: 验证四个AI都能稳定参与对话
  - [x] 13.2: 验证AI响应内容与用户问题高度相关
  - [x] 13.3: 验证AI响应能够实时显示，无需刷新
  - [x] 13.4: 验证用户发送消息后立即显示AI输入状态
  - [x] 13.5: 验证被@的AI能够优先响应
  - [x] 13.6: 验证消息换行显示合理

- [x] Task 14: 性能和稳定性测试
  - [x] 14.1: 测试WebSocket连接的稳定性（长时间运行）
  - [x] 14.2: 测试单个AI失败时的降级处理
  - [x] 14.3: 测试多AI并发响应的性能
  - [x] 14.4: 测试大量消息时的系统响应速度

# Task Dependencies
- Task 1-2 是基础修复，需最先完成
- Task 3-4 依赖 Task 1-2 的稳定性
- Task 5-6 可与 Task 3-4 并行执行
- Task 7-8 依赖 Task 5-6 的WebSocket优化
- Task 9-10 可与 Task 7-8 并行执行
- Task 11-12 可独立执行
- Task 13-14 依赖所有其他Task完成
