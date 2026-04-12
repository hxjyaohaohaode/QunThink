# Tasks

- [x] Task 1: 后端 - 用户画像数据模型与API
  - [x] SubTask 1.1: 在 db.js 中添加 userProfile 数据结构（昵称、性别、年龄、身高、体重、职业、学历、爱好、性格、目标、自我介绍）
  - [x] SubTask 1.2: 创建 routes/profile.js，实现 GET/PUT /api/profile 接口
  - [x] SubTask 1.3: 在 index.js 中注册 profile 路由

- [x] Task 2: 后端 - AI人设自定义数据模型与API
  - [x] SubTask 2.1: 在 db.js 中添加 customPersonas 数据结构（每个AI的自定义人设覆盖）
  - [x] SubTask 2.2: 创建 routes/personas.js，实现 GET/PUT /api/personas/:aiId 接口和 PUT /api/personas/:aiId/reset 重置接口
  - [x] SubTask 2.3: 在 index.js 中注册 personas 路由

- [x] Task 3: 后端 - 重构系统提示词与上下文窗口
  - [x] SubTask 3.1: 修改 buildSystemPrompt()，注入用户画像摘要和自定义AI人设
  - [x] SubTask 3.2: 修改 buildAPIMessages()，上下文窗口增加到1000条，增加智能截断逻辑（当token超限时保留最近消息并对早期消息生成摘要）
  - [x] SubTask 3.3: 修改 buildSystemPrompt()，对话摘要增加到200条
  - [x] SubTask 3.4: 修改调度器 getRecentMessages()，读取消息增加到1000条
  - [x] SubTask 3.5: 重写系统提示词规则，强调去模板化、口语化、真人化表达

- [x] Task 4: 后端 - callAI函数适配自定义人设
  - [x] SubTask 4.1: 修改 callAI() 和相关函数，从数据库读取自定义人设覆盖默认人设
  - [x] SubTask 4.2: 修改调度器中的人设读取逻辑，优先使用自定义人设

- [x] Task 5: 前端 - 侧边栏AI人设设置UI
  - [x] SubTask 5.1: 创建 AIPersonaEditor 组件（弹窗形式，包含昵称、风格、回复方式、性格描述、典型用语编辑）
  - [x] SubTask 5.2: 修改 Sidebar.tsx 中AI成员列表，点击AI名称打开人设编辑弹窗
  - [x] SubTask 5.3: 创建 personasStore.ts 管理AI人设状态
  - [x] SubTask 5.4: 在 api.ts 中添加人设相关API调用

- [x] Task 6: 前端 - 侧边栏用户画像设置UI
  - [x] SubTask 6.1: 创建 UserProfileEditor 组件（弹窗形式，包含所有画像字段）
  - [x] SubTask 6.2: 修改 Sidebar.tsx 中"我"的行，点击打开用户画像编辑弹窗
  - [x] SubTask 6.3: 创建 profileStore.ts 管理用户画像状态
  - [x] SubTask 6.4: 在 api.ts 中添加用户画像相关API调用

- [x] Task 7: 集成测试与验证
  - [x] SubTask 7.1: 测试AI人设自定义功能：修改人设后AI回复风格变化
  - [x] SubTask 7.2: 测试用户画像功能：设置画像后AI回复体现个性化
  - [x] SubTask 7.3: 测试超大上下文记忆：长对话后AI仍能记住早期内容
  - [x] SubTask 7.4: 测试AI回复去模板化效果

# Task Dependencies
- [Task 3] depends on [Task 1] and [Task 2]
- [Task 4] depends on [Task 2]
- [Task 5] depends on [Task 2]
- [Task 6] depends on [Task 1]
- [Task 7] depends on [Task 3], [Task 4], [Task 5], [Task 6]
