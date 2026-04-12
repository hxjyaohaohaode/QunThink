# Vercel 部署与功能验证 Spec

## Why
用户希望将 AI 聊天群系统分享给朋友使用，需要验证系统功能正常并部署到公网。Vercel 是一个免费的前端托管平台，适合部署 React 应用，但后端需要单独部署到支持 WebSocket 的服务器。

## What Changes
- 验证系统核心功能（群组管理、消息发送、AI 回复、WebSocket 实时通信）
- 配置前端生产环境构建，适配 Vercel 部署
- 配置后端部署到 Railway/Render（支持 WebSocket 的免费平台）
- 创建 Vercel 部署配置文件
- 配置前端 API 和 WebSocket 地址指向后端服务器

## Impact
- Affected specs: 前端构建配置、环境变量配置
- Affected code: 
  - frontend/vite.config.ts - 生产环境配置
  - frontend/.env.production - 生产环境 API 地址
  - 新增 vercel.json - Vercel 部署配置
  - 新增 railway.json 或 render.yaml - 后端部署配置

## ADDED Requirements

### Requirement: 系统功能验证
在部署前 SHALL 验证系统核心功能正常工作。

#### Scenario: 验证群组管理
- **WHEN** 用户创建、切换、删除群组
- **THEN** 操作成功且数据持久化

#### Scenario: 验证消息发送
- **WHEN** 用户发送消息
- **THEN** 消息显示在聊天界面并通过 WebSocket 实时同步

#### Scenario: 验证 AI 回复
- **WHEN** 用户发送消息触发 AI 回复
- **THEN** AI 正确生成回复并显示在聊天界面

### Requirement: 前端 Vercel 部署
前端 SHALL 能够部署到 Vercel 平台。

#### Scenario: Vercel 构建成功
- **WHEN** 推送代码到 GitHub 并触发 Vercel 部署
- **THEN** 前端成功构建并部署到 Vercel 域名

#### Scenario: 前端访问后端 API
- **WHEN** 前端部署到 Vercel 后访问后端 API
- **THEN** API 请求正确路由到后端服务器

### Requirement: 后端独立部署
后端 SHALL 部署到支持 WebSocket 的云平台。

#### Scenario: Railway/Render 部署
- **WHEN** 后端部署到 Railway 或 Render
- **THEN** 服务正常启动，WebSocket 连接可用

#### Scenario: 环境变量配置
- **WHEN** 在云平台设置环境变量
- **THEN** 后端正确读取 API 密钥等配置

### Requirement: 跨域和 WebSocket 配置
系统 SHALL 支持跨域访问和 WebSocket 连接。

#### Scenario: CORS 配置
- **WHEN** 前端从 Vercel 域名访问后端 API
- **THEN** 后端正确处理 CORS 请求

#### Scenario: WebSocket 连接
- **WHEN** 前端通过 wss:// 协议连接后端
- **THEN** WebSocket 连接成功建立

## MODIFIED Requirements

### Requirement: 前端环境变量
前端生产环境 SHALL 使用正确的后端 API 地址。

**变更说明**：
- 开发环境：API 地址为 localhost:3002
- 生产环境：API 地址为后端云服务器地址

## REMOVED Requirements
无移除的需求。

## 部署架构

```
┌─────────────────┐     ┌─────────────────┐
│   Vercel        │     │   Railway/      │
│   (前端)        │────▶│   Render        │
│   React SPA     │     │   (后端)        │
│                 │     │   Express + WS  │
└─────────────────┘     └─────────────────┘
        │                       │
        │                       │
        ▼                       ▼
   用户浏览器              AI API 服务
                          (DeepSeek/GLM等)
```

## 部署步骤概览

1. **验证系统功能** - 确保本地运行正常
2. **准备 GitHub 仓库** - 推送代码到 GitHub
3. **部署后端到 Railway** - 配置环境变量，获取后端 URL
4. **配置前端生产环境** - 设置后端 API 地址
5. **部署前端到 Vercel** - 连接 GitHub 仓库，自动部署
6. **测试线上系统** - 验证所有功能正常
