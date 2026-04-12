# 微信风格群聊交互体验优化 Spec

## Why
当前应用的群聊交互体验与微信原生体验存在差距，用户期望获得与微信一致的流畅交互体验，包括消息气泡样式、AI输入状态显示、消息操作功能等。同时存在AI身份与内容不匹配的严重问题（如GLM显示DeepSeek的内容）。

## What Changes
- **BREAKING**: 重构AI调用逻辑，确保每个AI身份严格绑定对应API，不再跨模型调用
- 优化消息气泡样式，实现微信风格的左右对齐和气泡形状
- 增强AI输入状态显示，支持单AI和多AI并发显示
- 实现消息时间戳自动分组显示
- 添加消息右键菜单操作（复制、回复、撤回）
- 实现消息发送状态指示（已发送✓）
- 增强AI身份确认的system prompt

## Impact
- Affected specs: AI调用流程、消息显示组件、WebSocket通信
- Affected code: 
  - `backend/src/services/ai/index.js` - AI调用逻辑
  - `frontend/src/components/Chat/MessageBubble.tsx` - 消息气泡
  - `frontend/src/components/Chat/MessageList.tsx` - 消息列表
  - `frontend/src/components/Chat/TypingIndicator.tsx` - 输入状态
  - `frontend/src/index.css` - 样式定义

## ADDED Requirements

### Requirement: AI身份与内容一致性
系统应确保每个AI的身份与其发布的内容严格匹配，不得出现身份混淆。

#### Scenario: AI身份正确匹配
- **WHEN** GLM AI生成回复
- **THEN** 消息显示GLM头像、GLM名称、GLM风格的内容
- **AND** 内容中不会出现"我是DeepSeek"等错误身份声明

#### Scenario: AI API调用失败
- **WHEN** 某个AI的API调用失败
- **THEN** 系统使用该AI的模拟回复，而非调用其他AI的API
- **AND** 保持该AI的身份标识不变

### Requirement: 微信风格消息气泡
系统应提供与微信一致的消息气泡展示样式。

#### Scenario: 用户消息显示
- **WHEN** 用户发送消息
- **THEN** 消息气泡右对齐显示
- **AND** 使用微信绿色渐变背景
- **AND** 右上角有小尾巴设计

#### Scenario: AI消息显示
- **WHEN** AI发送消息
- **THEN** 消息气泡左对齐显示
- **AND** 使用白色背景
- **AND** 左上角有小尾巴设计
- **AND** 显示AI头像和名称

### Requirement: AI输入状态实时显示
系统应实时显示AI的输入状态，提供清晰的视觉反馈。

#### Scenario: 单个AI输入
- **WHEN** 一个AI正在生成回复
- **THEN** 显示该AI的头像、名称和三点动画
- **AND** 动画效果类似微信的"..."输入提示

#### Scenario: 多个AI并发输入
- **WHEN** 多个AI同时生成回复
- **THEN** 显示聚合的输入状态指示
- **AND** 显示所有输入AI的头像堆叠
- **AND** 显示"X位AI正在输入..."文本

#### Scenario: AI完成回复
- **WHEN** AI完成回复发送
- **THEN** 输入状态提示自动消失
- **AND** 新消息立即显示在聊天列表中

### Requirement: 消息时间戳分组
系统应按时间自动分组显示消息。

#### Scenario: 时间间隔分组
- **WHEN** 两条消息间隔超过5分钟
- **THEN** 在消息之间显示时间分隔线
- **AND** 时间格式智能显示（刚刚、X分钟前、昨天等）

### Requirement: 消息操作功能
系统应支持常用的消息操作功能。

#### Scenario: 右键菜单操作
- **WHEN** 用户右键点击消息
- **THEN** 显示操作菜单（复制、回复、撤回）
- **AND** 用户消息可撤回，AI消息不可撤回

#### Scenario: 消息发送状态
- **WHEN** 用户发送消息
- **THEN** 显示发送状态指示（✓已发送）
- **AND** 状态指示显示在消息旁边

## MODIFIED Requirements

### Requirement: AI调用流程
原有AI调用流程在API失败时会回退到其他AI的API，现已修改为严格绑定身份。

**原逻辑**：
- 首选模型失败 → 尝试其他健康模型 → 使用模拟回复

**新逻辑**：
- 首选模型失败 → 直接使用该AI的模拟回复
- 不再跨模型调用，确保身份一致性

### Requirement: System Prompt
增强AI身份确认的system prompt，防止AI声称自己是其他身份。

**新增内容**：
- 明确身份确认声明
- 群聊环境介绍
- 回复要求规范
