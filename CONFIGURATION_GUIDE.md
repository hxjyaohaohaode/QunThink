# 系统配置指南

## 📋 配置文件说明

### 1. 后端配置文件 (backend/.env)

```env
PORT=3002                          # 后端服务端口
NODE_ENV=development               # 运行环境: development/production
DEEPSEEK_API_KEY=your_key_here     # DeepSeek API密钥
GLM_API_KEY=your_key_here          # GLM API密钥
MIMO_API_KEY=your_key_here         # MiMo API密钥
QWEN_API_KEY=your_key_here         # 通义千问 API密钥
ENCRYPTION_KEY=32_chars_min        # 数据加密密钥（至少32字符）
CORS_ORIGINS=http://localhost:5173  # 允许的前端域名，多个域名用逗号分隔
AUTH_MODE=session                  # 认证模式，本地联调与生产默认使用 session
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

### 步骤 2: 配置 API 密钥

编辑 `backend\.env` 文件，填入你的 API 密钥：

- **DeepSeek**: 访问 https://platform.deepseek.com/ 获取
- **GLM**: 访问 https://open.bigmodel.cn/ 获取
- **MiMo**: 访问 https://api.xiaomimimo.com/ 获取
- **通义千问**: 访问 https://dashscope.aliyun.com/ 获取

### 步骤 3: 配置加密密钥

生成一个至少32字符的随机字符串作为加密密钥：

```bash
# Windows PowerShell
[Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }))

# 或者使用任意32+字符的字符串
```

### 步骤 4: 验证配置

运行配置检查工具：

```bash
check-config.bat
```

## 🚀 启动系统

### 方式 1: 使用启动脚本

```bash
start-system.bat
```

### 方式 2: 手动启动

```bash
# 启动后端
cd backend
npm install  # 首次运行
npm start

# 新开终端，启动前端
cd frontend
npm install  # 首次运行
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
- 可以发送消息

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

**原因**: API 密钥未配置或无效

**解决**:
1. 检查 `backend\.env` 中的 API 密钥
2. 访问后端健康检查接口查看 AI 状态
3. 查看后端控制台日志

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
   CORS_ORIGINS=https://你的域名.com
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

**最后更新**: 2024-01-01
**版本**: 1.0.0
