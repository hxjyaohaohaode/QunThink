# 全面功能与代码质量审计 — 验收检查清单

## 🔴 关键安全修复

- [x] `backend/src/services/ai/index.js` 中 5 处 apiKey 无硬编码默认值
- [x] `backend/src/services/ai/loadBalancer.js` 中 5 处 apiKey 无硬编码默认值
- [x] Grep 搜索 backend/src 目录确认无任何硬编码密钥残留

## 🟡 TypeScript 类型安全

- [x] `services/api.ts` 中函数参数无裸 any 类型
- [x] `services/websocket.ts` 中定义了 WSMessage 接口替代 any
- [x] `hooks/useAutoScroll.ts` 中无裸 any 类型
- [x] `tsc -b` 无错误
- [x] `vite build` 成功

## 🟢 后端运行验证

- [x] 后端启动无红色错误
- [x] dotenv 加载顺序正确（`import 'dotenv/config'` 在最前面）
- [x] 所有 5 个 AI 服务健康检查通过（deepseek、deepseek_reasoner、glm、mimo、qwen）
- [x] 健康检查端点返回正常
- [x] WebSocket 连接正常

## 🟢 AI 对话功能验证

- [x] AI 系统提示词包含真人化对话规则（13条核心规则）
- [x] callAI 函数 API 调用链完整（含重试、去重、相关性检查）
- [x] 辩论模式 callAIDebate 函数正常
- [x] 模拟回复 getMockResponse 在 API 不可用时正常工作
- [x] WebSocket 消息推送正常
- [x] 前端消息列表正确显示 AI 回复
