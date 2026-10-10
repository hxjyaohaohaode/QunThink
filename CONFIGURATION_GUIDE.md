# 系统配置指南

## 📋 配置文件说明

### 1. 后端配置文件 (backend/.env)

```env
PORT=3002                          # 后端服务端口
NODE_ENV=development               # 运行环境: development/production
ENCRYPTION_KEY=<base64编码的32字节随机串>  # 生成方式: openssl rand -base64 32
CORS_ORIGINS=http://localhost:3010  # 允许的前端域名，多个域名用逗号分隔
AUTH_MODE=session                  # 认证模式，本地联调与生产默认使用 session

# ---- 可选高级配置（均有内置默认值，按需添加）----
# ADMIN_USER_IDS=user_id_1,user_id_2  # 管理员用户ID列表，逗号分隔；
#                                     # /api/memory/clear、/api/social/reset 等
#                                     # requireAdmin 端点仅允许列表内用户调用
# TRUST_PROXY=1                       # 反向代理（Nginx/Render/Vercel）后部署时配置：
#                                     # 支持正整数（信任的代理跳数）、逗号分隔的
#                                     # IP 列表；设为 false 显式关闭。
#                                     # 未设置时生产环境默认 trust proxy=1，
#                                     # Express 才能从 X-Forwarded-For 取真实客户端IP
# MAX_CONTEXT_TOKENS=80000            # 发送给 AI 的上下文最大 token 预算（默认 80000），
#                                     # 长对话费用过高或模型报错时可调低
```

### 2. 前端配置文件 (frontend/.env)

```env
VITE_BACKEND_URL=http://localhost:3002  # 后端服务地址
VITE_AUTH_MODE=session                  # 本地联调与生产默认保持 session 一致
```

## 🔧 配置步骤

### 步骤 1: 创建配置文件

```bash
# 后端配置
copy backend\.env.example backend\.env

# 前端配置
copy frontend\.env.example frontend\.env
```

### 步骤 2: 确认模型配置方式

平台不预置 AI 服务商、模型或共享密钥；新账号的模型目录和默认群 AI 成员为空。AI 密钥不通过后端环境变量配置。完成后端加密、认证与前后端连接配置并启动系统后，由每个账号在“设置 → 模型中心”连接自己的服务：

1. 点击“＋ 服务商”，填写名称、OpenAI 兼容或 Anthropic 协议、服务商提供的 Base URL。
2. 输入自己的 API Key；如果服务确实无需密钥，可勾选“无需密钥”。保存后密钥不会回显。
3. 手动添加服务商提供的实际模型 ID，或先保存连接再拉取模型列表；设置能力与参数并保存。
4. 明确点击所需能力的测试按钮。保存配置不发起付费测试；测试和后续模型请求可能产生服务商费用。
5. 通过对应测试后再选择模型用于对话、图片理解或语音合成。没有已验证模型时不会自动生成 AI 回复，但可以查看历史会话、建立无 AI 成员的群聊及进行人工写作。

既有明确保存的用户模型目录及会话记录保留；历史模型名称不会自动创建可调用模型。旧版厂商连接凭据不会自动扩展成预置模型列表。

私有或本地服务地址必须由后端设置 `AI_ALLOWED_LOCAL_ORIGINS` 精确允许，例如 `http://127.0.0.1:11434`。云端后端的 `localhost` 指云服务器，不是用户电脑。不要在前端环境变量或源码中保存模型密钥。

### 步骤 3: 配置加密密钥

ENCRYPTION_KEY 必须是 **base64 编码的 32 字节随机串**（不要使用自造字符串）：

```bash
# 方式 1: openssl
openssl rand -base64 32

# 方式 2: Windows PowerShell
powershell -Command "$b=New-Object byte[] 32;[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b);[Convert]::ToBase64String($b)"
```

⚠️ 密钥轮换会使先前加密的数据无法解密；切勿将密钥提交进版本库。

### 步骤 4: 验证配置

核对后端的 `ENCRYPTION_KEY`、`AUTH_MODE`、`CORS_ORIGINS` 与持久化存储配置，以及前端的 `VITE_BACKEND_URL` 和 `VITE_AUTH_MODE`。模型连接在系统启动后通过模型中心手动验证，不通过部署环境变量注入。注册/登录还需要正确的短信服务配置，详见 `backend/.env.example`。

## 🚀 启动系统

使用 Node.js 22.12+，在两个终端分别启动：

```bash
# 启动后端
cd backend
npm ci  # 首次运行
npm start

# 新开终端，启动前端
cd frontend
npm ci  # 首次运行
npm run dev
```

## 🔍 连接验证

### 1. 检查后端服务

访问: http://localhost:3002/api/health

应该看到类似响应：
```json
{
  "status": "ok",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "database": "connected"
}
```

### 2. 检查前端服务

访问: http://localhost:3010

应该看到聊天界面，并且：
- 左侧显示群组列表
- 右上角显示"已连接"状态
- 可以进入“设置 → 模型中心”添加自己的服务商与模型
- 没有通过对话测试的模型时，不会自动获得 AI 回复

### 3. 检查 WebSocket 连接

打开浏览器开发者工具 (F12) -> Network -> WS 标签

应该看到：
- WebSocket 连接到 `ws://localhost:3002/ws`
- 状态为 101 Switching Protocols
- 有心跳消息传输

## ⚠️ 常见问题

### 问题 1: 后端无法启动

**原因**: 端口被占用或依赖未安装

**解决**:
```bash
# 检查端口占用
netstat -ano | findstr :3002

# 安装依赖
cd backend
npm install
```

### 问题 2: 前端无法连接后端

**原因**: CORS 配置错误或后端未启动

**解决**:
1. 确认后端已启动并监听 3002 端口
2. 检查 `backend\.env` 中的 `CORS_ORIGINS` 配置
3. 确认 `frontend\.env` 中的 `VITE_BACKEND_URL` 正确

### 问题 3: WebSocket 连接断开

**原因**: 心跳超时或网络问题

**解决**:
1. 检查网络连接
2. 确认心跳间隔配置一致（前端和后端都是30秒）
3. 查看浏览器控制台错误信息

### 问题 4: AI 不回复

**原因**: 当前账号未配置模型，或模型连接、密钥、能力验证不可用。

**解决**:
1. 在“模型中心”检查服务地址、当前账号密钥、启用状态与实际模型 ID，然后保存。
2. 手动测试对话能力；模型只有通过所需能力测试后才可使用。修改连接或模型参数后要重新测试。
3. 检查会话成员或默认模型是否仍指向可用模型。明确指定的模型不可用时会停止请求，不自动改用其他模型。
4. 测试结果未确认时，查询原测试请求状态并核对服务商用量，不要反复发起新的付费测试。
5. 后端健康检查只说明应用服务状态，不代表当前账号已连接可用的 AI。

## 🔒 安全建议

### 生产环境配置

1. **修改默认端口**
   ```env
   PORT=你的自定义端口
   ```

2. **启用认证**
   ```env
   AUTH_MODE=session
   ```

3. **配置 HTTPS**
   - 使用反向代理（如 Nginx）
   - 配置 SSL 证书

4. **限制 CORS**
   ```env
   CORS_ORIGINS=https://你的域名.com,http://localhost:3010
   ```

5. **使用环境变量**
   - 不要将 `.env` 文件提交到版本控制
   - 使用 `.gitignore` 排除敏感文件

## 📊 性能优化

### 1. 数据库优化

- 定期清理旧消息
- 使用索引优化查询
- 考虑迁移到专业数据库（如 MongoDB）

### 2. WebSocket 优化

- 调整心跳间隔（默认30秒）
- 配置消息队列大小
- 启用消息压缩

### 3. AI 调用优化

- 配置负载均衡策略
- 调整超时时间
- 启用响应缓存

## 📞 技术支持

如遇到问题，请检查：
1. 控制台日志（前端和后端）
2. 浏览器开发者工具
3. 网络请求状态
4. 系统资源使用情况

---

**最后更新**: 2026-10-10
**版本**: 1.0.0
