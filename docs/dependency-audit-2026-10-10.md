# 2026-10-10 依赖审计边界与门禁补齐

基线：`cb2ee891231df975ea69e09ccc94b200eb7c008b` 的交付源码。

## 开发依赖：未修复，不能标为零风险

官方 npm registry 的全量审计仍报告 **5 high**。这是一个根因 advisory 及其依赖传播，涉及 `braces`、`chokidar`、`micromatch`、`fast-glob` 和直接开发依赖 `tailwindcss`。

- [GitHub Reviewed advisory GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) 影响 `braces <=3.0.3`，深层嵌套 pattern 可导致递归栈耗尽；页面标明没有已修复版本，最后更新于 2026-10-02。
- 2026-10-10 查询官方 npm registry：`braces` 的 latest 为 `3.0.3`，Tailwind 3 的最新版本为 `3.4.19`，均与当前 lock 一致。
- 当前依赖链：`tailwindcss@3.4.19 → chokidar@3.6.0 → braces@3.0.3`，以及 `tailwindcss → micromatch@4.0.8 → braces@3.0.3`；`fast-glob@3.3.3` 也使用该 micromatch。
- 未找到可直接采用的已发布 braces 修复版本。Tailwind 4 属于样式构建链大版本迁移，不能以一次 lock 更新视为兼容修复；需要独立的样式与真实浏览器回归验证。

本次不修改依赖清单或 lock，不增加 advisory 忽略项，不使用 `npm audit fix --force`，也不伪造修复版本。生产依赖审计零发现不代表完整构建链安全。构建和开发环境仍应仅使用经审查的仓库配置及 glob pattern；不要把用户输入作为构建 glob 配置。这是暴露面约束，不是漏洞修复。

## 可落实的门禁收紧

前端生产依赖已无已报告漏洞，因此移除旧 React Router RSC advisory 的历史通行特例。审计门禁现在：

1. 只接受完整的 npm audit v2 JSON。
2. 校验各严重等级与 total 为非负安全整数，并核对实际漏洞条目、包名、严重等级与计数一致。
3. 缺字段、矛盾计数、无效 JSON 或 registry 错误返回状态 2，不得判为通过。
4. 任意级别的实际生产漏洞返回状态 1；只有零发现报告返回状态 0。

测试覆盖全严重等级、旧特例、缺字段和矛盾报告，以及 UTF-8 BOM 和 PowerShell UTF-16LE 输入。CI 步骤名称相应改为生产依赖零发现门禁；没有修改或削弱全量审计结果。

复查命令（`frontend` 目录）：

```sh
npm ci
npm test
npm run build
npm audit --omit=dev --json --registry=https://registry.npmjs.org > audit-production.json
node scripts/check-frontend-audit.mjs audit-production.json
npm audit --json --registry=https://registry.npmjs.org
```

最后一条当前预期失败并报告 5 high，必须继续跟踪上游修复，不能描述为全量审计通过。没有修改第三方许可证、品牌素材、Logo 或界面。
