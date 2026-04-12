# Tasks

## 阶段一：关键安全修复（最高优先级）

- [x] Task 1: 移除 ai/index.js 中 5 处硬编码 API 密钥
  - [x] 1.1: 第8行 deepseek apiKey 改为 `process.env.DEEPSEEK_API_KEY || ''`
  - [x] 1.2: 第23行 deepseek_reasoner apiKey 改为 `process.env.DEEPSEEK_API_KEY || ''`
  - [x] 1.3: 第36行 glm apiKey 改为 `process.env.GLM_API_KEY || ''`
  - [x] 1.4: 第49行 mimo apiKey 改为 `process.env.MIMO_API_KEY || ''`
  - [x] 1.5: 第62行 qwen apiKey 改为 `process.env.QWEN_API_KEY || ''`

- [x] Task 2: 移除 loadBalancer.js 中 5 处硬编码 API 密钥
  - [x] 2.1: 第14行 deepseek apiKey 改为 `process.env.DEEPSEEK_API_KEY || ''`
  - [x] 2.2: 第22行 deepseek_reasoner apiKey 改为 `process.env.DEEPSEEK_API_KEY || ''`
  - [x] 2.3: 第30行 glm apiKey 改为 `process.env.GLM_API_KEY || ''`
  - [x] 2.4: 第38行 mimo apiKey 改为 `process.env.MIMO_API_KEY || ''`
  - [x] 2.5: 第46行 qwen apiKey 改为 `process.env.QWEN_API_KEY || ''`

## 阶段二：TypeScript 类型安全修复

- [x] Task 3: 修复前端 TypeScript any 类型使用
  - [x] 3.1: 修复 `services/api.ts` 中函数参数的 any 类型（evaluateSmartLike、updateSmartLikeConfig、updatePersona、updateProfile）
  - [x] 3.2: 修复 `services/websocket.ts` 中 handleWebSocketMessage 的 any 参数，定义 WSMessage 接口
  - [x] 3.3: 修复 `hooks/useAutoScroll.ts` 中 dependencies 的 any[] 类型
  - [x] 3.4: 保留 `Record<string, any>` 用法（这是 TypeScript 标准泛型用法，不需要修改）

## 阶段三：构建验证

- [x] Task 4: 验证前端构建无错误
  - [x] 4.1: 运行 `tsc -b` 确认无 TypeScript 错误
  - [x] 4.2: 运行 `vite build` 确认构建成功

- [x] Task 5: 验证后端启动无错误
  - [x] 5.1: 修复 dotenv 加载顺序（改为 `import 'dotenv/config'` 确保环境变量在模块导入前加载）
  - [x] 5.2: 运行 `node src/index.js` 确认后端正常启动
  - [x] 5.3: 确认所有 5 个 AI 服务健康检查通过

## 阶段四：AI 对话功能验证

- [x] Task 6: 验证 AI 对话系统完整性
  - [x] 6.1: 确认 AI 系统提示词包含真人化规则
  - [x] 6.2: 确认 callAI 函数的 API 调用链完整
  - [x] 6.3: 确认辩论模式 callAIDebate 函数正常
  - [x] 6.4: 确认模拟回复 getMockResponse 在 API 不可用时正常工作
  - [x] 6.5: 确认 WebSocket 消息推送正常

# Task Dependencies
- [Task 2] depends on [Task 1]
- [Task 3] depends on [Task 1, Task 2]
- [Task 4] depends on [Task 3]
- [Task 5] depends on [Task 1, Task 2]
- [Task 6] depends on [Task 4, Task 5]
