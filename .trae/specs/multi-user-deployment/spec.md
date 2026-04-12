# 多用户部署方案 Spec

## Why
当前系统是单用户版本，所有数据存储在一个JSON文件中。为了让朋友能够使用你的AI API密钥但拥有独立的数据，需要实现多用户数据隔离和远程访问部署。

## What Changes
- 添加用户认证系统（简单的用户ID识别）
- 改造数据库架构，实现按用户ID隔离数据
- 添加环境变量配置，支持生产环境部署
- 创建Docker部署配置
- 添加内网穿透和云服务器部署指南
- **BREAKING** 数据库结构变更，需要迁移现有数据

## Impact
- Affected specs: 数据存储架构、用户认证
- Affected code: 
  - backend/src/models/db.js - 数据库架构改造
  - backend/src/index.js - 添加用户识别中间件
  - backend/src/routes/*.js - 所有路由需要支持用户隔离
  - frontend/src/services/api.ts - 添加用户认证头
  - 新增部署配置文件

## ADDED Requirements

### Requirement: 用户认证系统
系统 SHALL 提供简单的用户认证机制，支持用户ID识别和数据隔离。

#### Scenario: 用户首次访问
- **WHEN** 用户首次访问系统
- **THEN** 系统生成唯一用户ID并存储在浏览器localStorage
- **AND** 为该用户创建独立的数据存储空间

#### Scenario: 用户再次访问
- **WHEN** 用户再次访问系统
- **THEN** 系统从localStorage读取用户ID
- **AND** 加载该用户的专属数据

### Requirement: 数据隔离
系统 SHALL 确保不同用户的数据完全隔离。

#### Scenario: 用户访问自己的数据
- **WHEN** 用户请求群组列表或消息
- **THEN** 系统只返回该用户自己的数据
- **AND** 用户无法访问其他用户的数据

#### Scenario: 多用户并发访问
- **WHEN** 多个用户同时使用系统
- **THEN** 每个用户看到自己的独立数据
- **AND** 用户之间的操作互不影响

### Requirement: API密钥共享
系统 SHALL 允许所有用户共享管理员的AI API密钥。

#### Scenario: 用户调用AI服务
- **WHEN** 任何用户发送消息触发AI回复
- **THEN** 系统使用管理员配置的API密钥调用AI服务
- **AND** 用户无需配置自己的API密钥

### Requirement: 部署配置
系统 SHALL 支持多种部署方式。

#### Scenario: Docker部署
- **WHEN** 管理员使用Docker部署
- **THEN** 系统自动配置所有依赖和环境变量
- **AND** 提供一键启动脚本

#### Scenario: 内网穿透部署
- **WHEN** 管理员使用内网穿透工具
- **THEN** 外部用户可以通过公网URL访问
- **AND** 保持本地开发环境的便利性

### Requirement: 环境变量配置
系统 SHALL 支持通过环境变量配置API密钥和部署参数。

#### Scenario: 生产环境配置
- **WHEN** 管理员设置环境变量
- **THEN** 系统从环境变量读取API密钥和配置
- **AND** 不在代码中硬编码敏感信息

## MODIFIED Requirements

### Requirement: 数据库架构
数据库 SHALL 支持多用户数据隔离存储。

**变更说明**：
- 原架构：单一JSON文件存储所有数据
- 新架构：按用户ID创建独立的数据文件，格式为 `db_{userId}.json`

### Requirement: API路由
所有API路由 SHALL 支持用户数据隔离。

**变更说明**：
- 原实现：直接访问全局数据
- 新实现：从请求头获取用户ID，访问对应用户的数据

## REMOVED Requirements
无移除的需求。

## 部署方案选项

### 方案A：云服务器部署（推荐）
**优点**：稳定、快速、支持多用户并发
**成本**：约100-300元/月
**适合**：长期使用，用户较多

### 方案B：本地部署+内网穿透
**优点**：免费、简单、无需购买服务器
**缺点**：依赖本地电脑运行、网速可能较慢
**适合**：临时使用、用户较少

### 方案C：Docker云部署
**优点**：易于迁移、环境一致
**适合**：有Docker经验的用户
