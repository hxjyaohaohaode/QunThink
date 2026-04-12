# 微信风格群聊交互体验优化 — 任务清单

## 第一批：核心问题修复

- [x] Task 1: 修复AI身份与内容不匹配问题
  - [x] 1.1: 修改 backend/src/services/ai/index.js，移除跨模型调用逻辑
  - [x] 1.2: 每个AI身份严格绑定对应API，失败时使用模拟回复
  - [x] 1.3: 增强 system prompt，明确AI身份信息

## 第二批：消息气泡样式优化

- [x] Task 2: 实现微信风格消息气泡
  - [x] 2.1: 修改 frontend/src/index.css，添加微信风格气泡样式
  - [x] 2.2: 用户消息右对齐，绿色渐变背景，右上角小尾巴
  - [x] 2.3: AI消息左对齐，白色背景，左上角小尾巴

- [x] Task 3: 优化消息气泡组件
  - [x] 3.1: 重构 frontend/src/components/Chat/MessageBubble.tsx
  - [x] 3.2: 添加右键菜单支持（复制、回复、撤回）
  - [x] 3.3: 实现消息发送状态指示（✓已发送）

## 第三批：AI输入状态显示

- [x] Task 4: 优化AI输入状态组件
  - [x] 4.1: 重构 frontend/src/components/Chat/TypingIndicator.tsx
  - [x] 4.2: 单AI输入显示头像、名称、三点动画
  - [x] 4.3: 多AI并发输入显示聚合状态

- [x] Task 5: 确保输入状态实时性
  - [x] 5.1: 验证 WebSocket 正确传递 typing 状态
  - [x] 5.2: 验证 typing 状态在 AI 响应完成后自动关闭

## 第四批：消息时间戳分组

- [x] Task 6: 实现消息时间分组
  - [x] 6.1: 修改 frontend/src/components/Chat/MessageList.tsx
  - [x] 6.2: 添加时间分隔线逻辑（间隔5分钟以上）
  - [x] 6.3: 实现智能时间格式显示

## 第五批：UI细节优化

- [x] Task 7: 修复侧边栏高度问题
  - [x] 7.1: 设置群组列表区域最小高度400px

## 第六批：验证

- [x] Task 8: 端到端验证
  - [x] 8.1: 验证AI身份与内容正确匹配
  - [x] 8.2: 验证消息气泡样式符合微信风格
  - [x] 8.3: 验证AI输入状态正确显示和消失
  - [x] 8.4: 验证消息时间分组正确显示
  - [x] 8.5: 验证右键菜单功能正常工作
  - [x] 8.6: 验证消息发送状态指示正确显示

# Task Dependencies
- Task 1 是核心修复，需最先完成
- Task 2-3 可并行执行
- Task 4-5 可并行执行
- Task 6 独立执行
- Task 8 依赖所有其他 Task 完成
