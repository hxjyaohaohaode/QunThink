# 前端安全基线与依赖例外

## 当前基线

- 生产构建使用 Vite 7.3.x，已避开 Vite 6.4.2 及以下的开发服务器路径穿越/UNC 路径问题及其 esbuild 依赖链。
- React Router 已升级至 7.18.2，已避开 7.18.0 以前的 backslash open redirect 与 SSR hydration 构造注入公告。
- 本应用仅是静态 SPA，不启用 React Server Components、SSR、framework mode、loader 或 action。
- API/WS 通过同源网关代理；浏览器只持有会话状态，不接收模型供应商密钥。

## React Router 审计例外

截至 2026-08-04，`npm audit --omit=dev` 仅报告
`GHSA-qwww-vcr4-c8h2`（React Router RSC 模式 CSRF）。该公告描述的服务端执行面不在本项目架构中。
`scripts/check-frontend-audit.mjs` 将例外限制为精确 advisory、精确包名和 high 严重度；CI 发现任何其他
包、版本范围、severity 或 advisory 都会失败。上游发布修复版本后必须升级并重新执行构建与审计；若未来
引入 SSR/RSC/action，必须先移除例外并完成专项 CSRF 审查。
