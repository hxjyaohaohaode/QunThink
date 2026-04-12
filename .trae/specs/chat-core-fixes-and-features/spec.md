# 群聊核心问题修复与功能增强 Spec

## Why
当前群聊存在多个严重问题：用户发送一条消息后AI认为发了多遍（消息重复传入上下文）、AI互相复制粘贴对方的话、缺少停止对话按钮、消息引用功能不完善、AI不知道当前时间、无法与单个AI私聊、消息互动操作不完整。这些问题严重影响了聊天体验的真实性和可用性，需要系统性修复和增强。

## What Changes
- **BREAKING**: 修复消息重复传入AI上下文的bug，确保用户消息在上下文中只出现一次
- **BREAKING**: 修复AI复制粘贴其他AI回复的问题，增强system prompt防止内容抄袭
- 新增手动停止当前对话按钮，点击后所有AI立即停止回复
- 增强消息引用功能，AI回复时自动引用对应的发言，支持引用历史消息
- AI system prompt注入当前时间信息
- 新增私聊模式：用户可与单个AI进行1对1对话，AI记忆私聊内容并可在群聊中使用
- 重构消息互动操作：每条消息侧边添加操作面板（点赞、点踩、评论、回复引用），AI对点赞/点踩有反馈

## Impact
- Affected specs: AI调用流程、消息上下文构建、WebSocket通信、消息展示组件、侧边栏导航
- Affected code:
  - `backend/src/services/ai/index.js` - 修复上下文重复、增强prompt
  - `backend/src/services/scheduler/index.js` - 修复消息重复、添加停止机制、引用功能
  - `backend/src/websocket/index.js` - 添加停止对话WebSocket消息类型
  - `backend/src/routes/messages.js` - 添加停止对话API、私聊API
  - `backend/src/services/ai/index.js` - 注入当前时间、防抄袭prompt
  - `frontend/src/components/Chat/MessageBubble.tsx` - 消息操作面板重构
  - `frontend/src/components/Chat/MessageInput.tsx` - 停止按钮、引用回复
  - `frontend/src/components/Chat/MessageList.tsx` - 引用显示
  - `frontend/src/components/Layout/Sidebar.tsx` - 私聊入口
  - `frontend/src/stores/messagesStore.ts` - 新增互动操作
  - `frontend/src/services/api.ts` - 新增API
  - `frontend/src/services/websocket.ts` - 停止对话WebSocket
  - `frontend/src/types/index.ts` - 类型扩展

## ADDED Requirements

### Requirement: 消息不重复传入AI上下文
系统应确保用户发送的消息在AI的对话上下文中只出现一次，不因同时存在于recentMessages和userMessage参数中而导致重复。

#### Scenario: 用户发送单条消息
- **WHEN** 用户发送一条消息
- **THEN** AI收到的上下文中该消息只出现一次
- **AND** AI不会说"你说了好几遍"或"你重复发了"

#### Scenario: AI读取历史消息
- **WHEN** AI从数据库读取recentMessages构建上下文
- **THEN** 应排除当前正在处理的用户消息，避免与userMessage参数重复

### Requirement: AI不复制粘贴其他AI的回复
系统应确保每个AI生成原创内容，不直接复制其他AI的回复文本。

#### Scenario: AI看到其他AI的回复
- **WHEN** AI在上下文中看到其他AI的回复
- **THEN** AI应基于自己的风格和观点生成原创回复
- **AND** 不直接复制粘贴其他AI的原话
- **AND** 可以引用其他AI的观点但必须用自己的话重新表达

#### Scenario: System Prompt防抄袭
- **WHEN** 构建AI的system prompt
- **THEN** 应包含明确的防抄袭指令
- **AND** 要求AI用自己的风格和语言表达，不得照搬他人原话

### Requirement: 手动停止对话按钮
系统应提供手动停止当前对话的功能，点击后所有正在回复的AI立即停止。

#### Scenario: 用户点击停止按钮
- **WHEN** 用户在AI正在回复时点击停止按钮
- **THEN** 所有正在生成回复的AI立即停止
- **AND** 正在输入的AI的typing状态清除
- **AND** 已生成的部分消息不保存

#### Scenario: 停止按钮显示条件
- **WHEN** 有AI正在回复（typing状态）
- **THEN** 停止按钮可见
- **AND** 没有AI在回复时停止按钮隐藏

### Requirement: 消息引用功能增强
AI回复其他发言时应自动引用对应的发言，用户可引用聊天框中的历史发言，功能对标微信群聊。

#### Scenario: AI回复特定发言
- **WHEN** AI回复某条特定的发言
- **THEN** AI的消息应包含reply_to字段，指向被回复的消息ID
- **AND** 前端显示引用卡片，展示被引用消息的发送者和内容摘要

#### Scenario: AI引用历史发言
- **WHEN** AI在对话中提到之前的某条发言
- **THEN** AI可以在回复中引用该历史消息
- **AND** 引用显示为可点击的引用卡片

#### Scenario: 用户引用消息回复
- **WHEN** 用户点击某条消息的"回复引用"按钮
- **THEN** 输入框显示引用预览
- **AND** 用户发送的消息自动关联被引用的消息
- **AND** AI收到引用上下文，知道用户在回复哪条消息

### Requirement: AI感知当前时间
系统应在每次AI调用时注入当前时间信息，使AI能够感知和引用当前时间。

#### Scenario: AI知道当前时间
- **WHEN** AI生成回复
- **THEN** system prompt中包含当前日期和时间
- **AND** AI可以自然地引用时间（如"现在已经是晚上了"、"今天XX"）

### Requirement: 私聊模式
用户可以与单个AI进行1对1私聊，AI记忆私聊内容并可在群聊中参考使用。

#### Scenario: 发起私聊
- **WHEN** 用户在侧边栏点击某个AI的头像/名称
- **THEN** 进入与该AI的私聊界面
- **AND** 私聊界面与群聊界面风格一致但只有用户和该AI

#### Scenario: 私聊记忆持久化
- **WHEN** 用户与AI进行私聊
- **THEN** 私聊内容独立存储，AI记住之前的私聊内容
- **AND** 下次打开私聊时可以看到历史记录

#### Scenario: 私聊记忆在群聊中使用
- **WHEN** AI在群聊中回复
- **THEN** AI可以参考与用户的私聊记忆
- **AND** AI自行决定是否使用私聊记忆（不需要强制使用）
- **AND** 私聊记忆作为额外上下文注入，不影响群聊主要上下文

#### Scenario: 私聊与群聊切换
- **WHEN** 用户在侧边栏切换私聊和群聊
- **THEN** 聊天界面平滑切换
- **AND** WebSocket正确订阅/取消订阅对应频道

### Requirement: 消息侧边操作面板
每条消息侧边添加操作面板，支持点赞、点踩、评论、回复引用功能。

#### Scenario: 操作面板显示
- **WHEN** 用户hover或点击消息
- **THEN** 消息侧边显示操作面板
- **AND** 面板包含：点赞👍、点踩👎、评论💬、回复引用↩️ 四个按钮

#### Scenario: 点赞操作
- **WHEN** 用户点击点赞按钮
- **THEN** 该消息的点赞数+1，按钮高亮
- **AND** 被点赞的AI收到反馈，可能回复感谢或继续讨论
- **AND** 再次点击取消点赞

#### Scenario: 点踩操作
- **WHEN** 用户点击点踩按钮
- **THEN** 该消息的点踩数+1，按钮高亮
- **AND** 被点踩的AI收到反馈，可能调整观点或表达不满
- **AND** 再次点击取消点踩

#### Scenario: 评论操作
- **WHEN** 用户点击评论按钮
- **THEN** 在消息侧边展开评论区域
- **AND** 用户可以输入评论文字
- **AND** 评论保存到该消息下，其他AI也可以跟着评论
- **AND** 评论显示发送者头像和名称

#### Scenario: 回复引用操作
- **WHEN** 用户点击回复引用按钮
- **THEN** 输入框上方显示被引用消息的预览
- **AND** 用户发送的下一条消息自动引用该消息
- **AND** AI收到引用上下文，知道用户在回复哪条消息

#### Scenario: AI对点赞/点踩的反馈
- **WHEN** AI的消息被点赞或点踩
- **THEN** AI在后续回复中可能自然地提及反馈
- **AND** 点赞时AI可能表达感谢或继续深入
- **AND** 点踩时AI可能反思调整或表达不同意见

## MODIFIED Requirements

### Requirement: AI上下文构建
原有buildAPIMessages函数将recentMessages（含用户刚发的消息）和userMessage（同一消息）同时传入，导致用户消息在上下文中出现两次。修改为：构建上下文时从recentMessages中排除当前用户消息，仅通过userMessage参数传入一次。

**原逻辑**：
- recentMessages包含所有最近消息（含刚发的用户消息）
- userMessage是同一用户消息的副本
- 两者都被加入messages数组，导致重复

**新逻辑**：
- recentMessages排除当前正在处理的用户消息
- userMessage作为唯一的当前用户消息传入
- 确保用户消息在上下文中只出现一次

### Requirement: System Prompt
增强system prompt，添加防抄袭指令、当前时间信息、引用上下文支持。

**新增内容**：
- 当前日期和时间（精确到分钟）
- 防抄袭指令：不得复制其他AI的原话，必须用自己的风格重新表达
- 引用上下文：当回复特定消息时，包含被引用消息的信息

### Requirement: 消息数据模型
Message类型新增dislikes和disliked_by字段，支持点踩功能。

**新增字段**：
- `dislikes: number` - 点踩数
- `disliked_by: string[]` - 点踩用户列表

### Requirement: WebSocket消息类型
新增stop_generation和private_chat相关WebSocket消息类型。

**新增类型**：
- `stop_generation` - 用户请求停止当前对话生成
- `generation_stopped` - 服务器确认已停止
