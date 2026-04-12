# 群聊核心问题修复与功能增强 — 任务清单

## 第一批：核心Bug修复

- [x] Task 1: 修复消息重复传入AI上下文
  - [x] 1.1: 修改 `backend/src/services/scheduler/index.js` 的 `generateAIResponse`，在调用 `callAI` 前从 `recentMessages` 中排除当前用户消息（通过内容+时间戳匹配）
  - [x] 1.2: 修改 `backend/src/services/scheduler/index.js` 的 `triggerMentionedAIResponses` 和 `triggerSpontaneousReply`，同样排除当前用户消息
  - [x] 1.3: 修改 `backend/src/services/ai/index.js` 的 `buildAPIMessages`，添加去重逻辑：如果 recentMessages 中最后一条用户消息与 userMessage 相同，则跳过

- [x] Task 2: 修复AI复制粘贴其他AI回复
  - [x] 2.1: 修改 `backend/src/services/ai/index.js` 的 `buildSystemPrompt`，添加防抄袭指令："绝对禁止复制粘贴其他成员的原话。你可以引用他们的观点，但必须用自己的风格和语言重新表达。"
  - [x] 2.2: 修改 `buildAPIMessages` 中其他AI消息的格式，从 `[AIName说]: content` 改为 `[AIName的观点]: content摘要`，对长消息截断为摘要，减少直接复制可能
  - [x] 2.3: 在 `buildSystemPrompt` 中添加："你的回复必须是原创的。如果你同意某个成员的观点，用你自己的话重新阐述，而不是照搬。"

## 第二批：AI时间感知与引用功能

- [x] Task 3: AI感知当前时间
  - [x] 3.1: 修改 `backend/src/services/ai/index.js` 的 `buildSystemPrompt`，在prompt开头注入当前时间
  - [x] 3.2: 在prompt中添加时间使用指引

- [x] Task 4: AI回复时自动引用对应发言
  - [x] 4.1: 修改 `backend/src/services/scheduler/index.js` 的 `generateAIResponse`，在调用AI时传入被回复消息的信息
  - [x] 4.2: 修改 `buildSystemPrompt`，当存在引用消息时，添加引用上下文
  - [x] 4.3: 修改 `buildAPIMessages`，当存在引用消息时，在用户消息前插入引用上下文
  - [x] 4.4: 修改 `callAI` 函数签名，新增 `replyToMessage` 参数
  - [x] 4.5: 修改 `broadcastAIMessage`，传递 `reply_to` 信息到前端

## 第三批：停止对话功能

- [x] Task 5: 后端停止对话机制
  - [x] 5.1: 在 `backend/src/websocket/index.js` 中添加 `stop_generation` 消息处理，收到后调用 scheduler 的取消函数
  - [x] 5.2: 在 `backend/src/services/scheduler/index.js` 中导出 `cancelGroupGeneration(groupId)` 函数，设置 activeGroups 中对应 group 的 cancel=true，并清除所有 typing 状态
  - [x] 5.3: 添加 `generation_stopped` WebSocket 广播，通知前端生成已停止

- [x] Task 6: 前端停止对话按钮
  - [x] 6.1: 在 `frontend/src/components/Chat/MessageInput.tsx` 中添加停止按钮，当有AI正在typing时显示
  - [x] 6.2: 点击停止按钮时通过 WebSocket 发送 `stop_generation` 消息
  - [x] 6.3: 在 `frontend/src/services/websocket.ts` 中添加 `stopGeneration(groupId)` 函数
  - [x] 6.4: 处理 `generation_stopped` WebSocket消息，清除所有typing状态

## 第四批：消息侧边操作面板

- [x] Task 7: 后端消息互动API增强
  - [x] 7.1: 在消息数据模型中添加 `dislikes` 和 `disliked_by` 字段
  - [x] 7.2: 添加 `POST /api/messages/:id/dislike` API端点
  - [x] 7.3: 添加 `DELETE /api/messages/:id/dislike` API端点（取消点踩）
  - [x] 7.4: 修改 `backend/src/routes/messages.js`，添加点踩路由
  - [x] 7.5: 在 `frontend/src/services/api.ts` 中添加 dislikeMessage 和 undislikeMessage API调用

- [x] Task 8: 前端消息操作面板重构
  - [x] 8.1: 重构 `frontend/src/components/Chat/MessageBubble.tsx`，添加消息侧边操作面板组件
  - [x] 8.2: 面板包含：点赞👍、点踩👎、评论💬、回复引用↩️ 四个按钮
  - [x] 8.3: 点赞/点踩按钮支持切换状态（已点赞/未点赞，已点踩/未点踩）
  - [x] 8.4: 评论按钮点击后展开评论区域
  - [x] 8.5: 回复引用按钮点击后设置replyingTo状态，输入框显示引用预览
  - [x] 8.6: 操作面板在hover时显示，或始终显示为小图标

- [x] Task 9: AI对点赞/点踩的反馈
  - [x] 9.1: 修改 `backend/src/services/scheduler/index.js`，当AI消息被点赞/点踩时，记录到消息metadata
  - [x] 9.2: 在 `buildSystemPrompt` 中注入AI最近收到的点赞/点踩反馈："你最近的一条消息收到了X个赞/Y个踩"
  - [x] 9.3: AI在后续回复中自然地回应反馈（通过prompt引导，不强制）

## 第五批：私聊模式

- [ ] Task 10: 后端私聊API与数据结构
  - [ ] 10.1: 在数据库中添加 `private_chats` 集合，结构：`{ id, ai_id, messages: [], created_at, updated_at }`
  - [ ] 10.2: 添加 `GET /api/private-chats` API，获取用户所有私聊列表
  - [ ] 10.3: 添加 `GET /api/private-chats/:aiId/messages` API，获取与某AI的私聊消息
  - [ ] 10.4: 添加 `POST /api/private-chats/:aiId/messages` API，发送私聊消息
  - [ ] 10.5: 创建 `backend/src/routes/privateChat.js` 路由文件
  - [ ] 10.6: 在 `backend/src/index.js` 中注册私聊路由

- [ ] Task 11: 私聊AI调用逻辑
  - [ ] 11.1: 创建 `backend/src/services/scheduler/privateChatScheduler.js`，处理私聊消息的AI调用
  - [ ] 11.2: 私聊时构建独立的system prompt，强调1对1对话场景
  - [ ] 11.3: 私聊时注入该AI与用户的历史私聊记忆
  - [ ] 11.4: 群聊时注入AI与用户的私聊记忆摘要（作为额外上下文，AI自行决定是否使用）

- [ ] Task 12: 前端私聊界面
  - [ ] 12.1: 修改 `frontend/src/components/Layout/Sidebar.tsx`，在AI成员列表中添加私聊入口（点击AI名称进入私聊）
  - [ ] 12.2: 修改 `frontend/src/stores/groupsStore.ts`，添加私聊状态管理
  - [ ] 12.3: 修改 `frontend/src/services/api.ts`，添加私聊API调用
  - [ ] 12.4: 修改 `frontend/src/components/Chat/ChatHeader.tsx`，区分群聊和私聊标题
  - [ ] 12.5: 修改 `frontend/src/services/websocket.ts`，支持私聊频道订阅
  - [ ] 12.6: 修改 `frontend/src/App.tsx`，支持私聊和群聊切换

## 第六批：类型定义与样式更新

- [x] Task 13: 前端类型与样式更新
  - [x] 13.1: 修改 `frontend/src/types/index.ts`，Message接口添加 `dislikes`、`disliked_by` 字段
  - [x] 13.2: 修改 `frontend/src/stores/messagesStore.ts`，添加 `dislikeMessage`、`undislikeMessage` 方法
  - [x] 13.3: 修改 `frontend/src/index.css`，添加操作面板和引用卡片的样式

## 第七批：验证

- [ ] Task 14: 端到端验证
  - [ ] 14.1: 验证用户消息在AI上下文中不重复
  - [ ] 14.2: 验证AI不复制粘贴其他AI的原话
  - [ ] 14.3: 验证停止按钮功能正常
  - [ ] 14.4: 验证消息引用功能正常（AI回复引用、用户回复引用）
  - [ ] 14.5: 验证AI能感知和引用当前时间
  - [ ] 14.6: 验证私聊功能正常（发消息、记忆持久化、群聊中使用私聊记忆）
  - [ ] 14.7: 验证消息操作面板功能正常（点赞、点踩、评论、回复引用）
  - [ ] 14.8: 验证AI对点赞/点踩有反馈
  - [ ] 14.9: 验证前后端编译无错误

# Task Dependencies
- Task 1-2 是核心Bug修复，需最先完成
- Task 3 独立，可随时执行
- Task 4 依赖 Task 1（上下文修复后才能正确添加引用）
- Task 5-6 可并行执行（前后端停止功能）
- Task 7-9 可并行执行（消息操作面板）
- Task 10-12 依赖 Task 1（私聊也需要修复上下文重复问题）
- Task 13 可与 Task 7-12 并行执行
- Task 14 依赖所有其他 Task 完成
