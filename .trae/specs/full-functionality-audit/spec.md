# 全面功能与代码质量审计 Spec

## Why
用户要求确保项目所有功能完整、AI对话像真人一样自然、所有文件无红色报错或黄色警告、本地和部署后都能完美运行。经过全面审查，发现之前的 API 密钥修复未生效（10处硬编码密钥仍存在），以及前端存在多处 TypeScript `any` 类型警告需要修复。

## What Changes
- **🔴 关键修复**：移除 `ai/index.js` 和 `loadBalancer.js` 中共 10 处硬编码 API 密钥（之前修复未生效）
- **🟡 TypeScript 类型安全**：修复前端 11 处 `any` 类型使用，消除潜在的类型警告
- **🟢 AI 对话质量验证**：确保 AI 系统提示词和回复逻辑能产生真人般的对话

## Impact
- Affected code:
  - `backend/src/services/ai/index.js` - 5处硬编码密钥
  - `backend/src/services/ai/loadBalancer.js` - 5处硬编码密钥
  - `frontend/src/services/api.ts` - 6处 any 类型
  - `frontend/src/services/websocket.ts` - 1处 any 类型
  - `frontend/src/types/index.ts` - 1处 any 类型
  - `frontend/src/stores/messagesStore.ts` - 1处 any 类型
  - `frontend/src/hooks/useAutoScroll.ts` - 1处 any 类型

## ADDED Requirements

### Requirement: 源代码中无硬编码 API 密钥
系统 SHALL NOT 在任何源代码文件中包含 API 密钥的硬编码默认值。

#### Scenario: Grep 搜索无密钥
- **WHEN** 在 backend/src 目录中搜索已知 API 密钥模式
- **THEN** 搜索结果为零

### Requirement: TypeScript 代码无 any 类型警告
前端代码 SHALL NOT 使用 `any` 类型（除非在 `Record<string, any>` 等标准泛型中）。

#### Scenario: 无 any 类型
- **WHEN** 在前端 TypeScript 文件中搜索 `any` 类型使用
- **THEN** 仅在 `Record<string, any>` 等标准泛型中出现，不作为函数参数或变量类型

### Requirement: AI 对话真人化
AI 回复 SHALL 像真人在群聊中对话一样自然，具有个性化和上下文感知能力。

#### Scenario: AI 回复自然
- **WHEN** 用户发送消息
- **THEN** AI 回复具有个性化风格、上下文感知、口语化表达，不使用模板化格式

## MODIFIED Requirements
无修改的需求。

## REMOVED Requirements
无移除的需求。
