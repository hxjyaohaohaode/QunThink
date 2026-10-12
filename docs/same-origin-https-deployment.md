# 同源 HTTPS 安装与恢复准备

本地候选，不代表已上线。完整应用优先采用一个公开 HTTPS origin，同时提供前端、`/api`、`/ws`、媒体和背景。原 Logo、UI 与模型连接行为不变。

## 数据、身份和前置条件

- Node.js 22.12+；容器新镜像使用 `node` 身份（官方 Node Alpine 默认 UID/GID 1000）。当前源码采用单后端进程，不能通过多副本共享本地 JSON 卷获得可靠扩容。
- `DATA_DIR=/app/data` 的整个内容须持久保存，包括 auth/users JSON、上传原件、背景、TTS/元数据、当前文件加密密钥（若使用）、历史密钥和元数据、限流及缓存状态。使用云 PostgreSQL 也不能替代这些文件字节。
- `MEMORY_DELETION_DIR` 必须是持久绝对路径，备份/恢复独立于旧业务快照。恢复业务时保留最新账本，不得把整个卷与删除账本一起回滚。默认本地账本位于 DATA_DIR；若使用默认路径，恢复操作也必须选择性保留其最新状态。
- 稳定 `ENCRYPTION_KEY`（32字节 Base64）由运维通过安全渠道配置。保留 `.key_history` 和 `.encryption_key.meta`，不能删历史或换新钥“修复”解密错误。历史与元数据损坏、无法读取或矛盾时启动应失败。
- `AUTH_MODE=session`、`NODE_ENV=production`、单个真实 `CORS_ORIGINS`。短信变量 `ALIYUN_ACCESS_KEY_ID`、`ALIYUN_ACCESS_KEY_SECRET`、`ALIYUN_SMS_SIGN_NAME`、`ALIYUN_SMS_TEMPLATE_CODE` 默认空，须由用户配置；缺失服务明确拒绝，不能开启 dev 认证补登录。
- 模型中心由账号自行连接国内或其他支持的服务商；没有预置收费调用。`SERVER_AI_ENABLED=false` 默认保持关闭；若显式开启站点基础AI，还需独立授权费用与提供有效变量，不能把测试替代供应商限额。

## 同源容器路线

需要已获授权的持久 Linux 主机、Docker Compose、真实域名、受信任 TLS fullchain/private key 和 DNS。此仓库不会自动创建云服务、域名或证书。以下仅为操作者安装步骤，不表示本次已执行。

1. 核对源码包 SHA256、逐文件清单和测试回执；安装前备份已有数据库、整个数据目录、独立删除账本及密钥，记录对应版本。
2. 设置 `APP_ORIGIN=https://your-real-domain`（无尾斜杠/路径/凭据），在受控目录执行 `node scripts/render-same-origin-https.mjs "$APP_ORIGIN" > /absolute/private-config/nginx.conf`。
3. 配置 `NGINX_HTTPS_CONFIG`、`TLS_CERT_FILE`、`TLS_KEY_FILE` 为该配置和真实证书文件的绝对路径。它们只读挂载，缺文件拒绝，不自动创建目录。不要提交或打包实际私钥和 `.env*`。
4. 设置安全的后端变量；运行 `docker compose -f docker-compose.yml -f deploy/compose.https.yml config` 本地核验。该输出可能含环境值，不应上传日志或分享。随后在用户授权发布窗口构建、启动和验收。
5. `docker compose -f docker-compose.yml -f deploy/compose.https.yml up -d --build`。HTTP 80 固定重定向到 APP_ORIGIN，443 提供前端/API/WSS。应用健康 `/api/health`；前端内部健康 `/nginx-health` 仅loopback开放。

该模板只适用于 Nginx 直接终止公网 TLS 的单跳路线。后端不发布宿主3002，`TRUST_PROXY=1` 且Nginx覆盖XFF为实际对端，客户端不能直连后端伪造IP。若再加入 CDN、负载均衡器或外层TLS代理，必须重新定义可信IP边界和CORS，不能原样套用；否则记录/限流看到的可能是代理IP。

Nginx限制普通API请求6MiB（应用JSON5MiB），群文件和agent附件总请求512MiB（保留最多10×50MiB文件及multipart包络），背景11MiB（应用单件10MiB）。应用仍检查文件大小/数量。上传使用临时磁盘；512MiB RAM实例的临时盘、并发上传、超时和实际代理体积限制须真机容量验收，不能仅凭单次通过承诺容量。

## 旧卷升级和回退

镜像构建只给新镜像内空目录设置node所有权，不自动递归chown旧挂载卷。旧root-owned卷可能无法由新身份读取。先只读核对UID/GID和权限、做可恢复备份，建立明确拥有者的独立恢复目录再经过授权复制/恢复。不要自动chmod777、递归修改未知卷或以删除key/meta/账本绕过启动错误。

恢复按序：停止写入并保全现状；恢复匹配的旧应用与业务数据；保持最新独立删除账本和正确加密历史；用受控身份启动。先验 A/B 权限、删除历史不复活、原文件/背景/TTS字节、账号与会话，再放流量。轮换/迁移后的数据不能仅靠回退镜像保证兼容。PG领域迁移和独立账本安装器是显式写库操作，不应自动塞入build/start；详见 `POSTGRES_MEMORY_LEDGER.md`。

## 可复验的本地协议测试

先安装前后端锁定依赖并构建前端。使用来自官方来源、带SSL模块的Nginx设置绝对路径 `QUNTHINK_TEST_NGINX_BIN`、`QUNTHINK_TEST_NGINX_MIME` 和可选 `QUNTHINK_TEST_OUTPUT_DIR`，执行 `node scripts/verify-same-origin-https.mjs`。

验证器仅在随机loopback端口创建合成账号、文件、音频和短期测试CA；每个HTTPS/WSS客户端显式信任该测试CA并校验域名，不关闭证书校验或修改系统信任。它验证协议、真实应用和Nginx，不等同于原生浏览器、Docker、云端受信证书或供应商调用验收。临时密钥/账号不会进入报告。真实浏览器受系统能力限制时必须单列未验，不能关闭浏览器sandbox或绕过安全警告充数。

## 发布前尚需操作者核验

实际主机/镜像与新空卷及旧卷权限；持久盘和独立备份恢复；TLS域名与证书续期；浏览器cookie/媒体/PWA缓存/WSS；有效短信登录和用户自有模型；高并发与500MiB批上传容量；上线费用及用户所在地区网络。Render免费静态模板不具备同源动态代理，不能据此宣称本应用分站媒体可用。

## 会话截止时间边界

WebSocket按认证时的会话期限设置有界定时器，30天会话不会因Node计时器溢出立即断开。出站排队、实际flush、入站和心跳均检查截止时间；事件循环迟到或时钟前跳不能据此发送新的私人消息。退出和登录上限淘汰会即时终止相应token的连接及待发缓冲，不连带其他有效会话。已经写入网络的字节不能撤回。

权威会话每60秒在入站时复查并更新期限。HTTP若续期但socket纯闲置、尚未复查，socket可能在原截止时间安全断开，重新认证连接可继续。时钟异常前跳且完全无出入站时，关闭时机受已安排计时器/最多30秒心跳影响；不声称对任意系统时钟变化瞬间关闭。
