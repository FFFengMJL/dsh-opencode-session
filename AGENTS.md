# dsh-opencode-session 开发指南

## 项目边界

- 本仓库是一个零运行依赖的 DSH Cordis 插件：入口 [`lib/index.js`](lib/index.js)，bundle 插入
  行在 [`cordis.patch.yml`](cordis.patch.yml)，使用说明在 [`README.md`](README.md)。
- 不引入构建步骤、TypeScript 或运行时依赖；`lib/` 是手写源码，不是生成产物。
- 面向已发布的 DSH 版本维护。当前基线 `0.2.2-rc.1`，Node.js `>=24.9.0`（DSH 自身要求），
  兼容范围写在 [`package.json`](package.json) 的 `engines`；不要为了旧版改变代码路径。

## 宿主契约

- 只通过 `llm-pi-ai/request-headers` 同步 waterfall 接入。`0.2.1-rc.1` 至 `0.2.1-rc.5`
  没有该事件；不要添加 fetch 劫持、`AsyncLocalStorage` 或其他旧版回退来假装兼容。
- 监听器必须先调用且只调用一次 `next()`，再在其结果上追加头；任何下游错误都要原样抛出。
- 已有同名头（大小写不敏感）优先于插件值；下游写入的其他头必须保留；不要修改下游返回的
  `Headers` 对象。
- 卸载时只移除本插件注册的监听器；不要调用宿主或其他插件的清理逻辑。

## 行为不变量

- 只匹配 `providers` 中的路由，且 `baseURL` 为 HTTP(S)、hostname 精确等于 `host`、
  `pathname` 以 `pathPrefix` 字面开头。协议、端口和子域不构成匹配条件。
- 安全会话 ID（`[A-Za-z0-9._:-]{1,128}`）输出 `prefix + id`；其他非空 ID 输出
  `prefix + "h-" + SHA-256(id)`。`h-` + 64 位小写十六进制是保留命名空间，安全 ID 命中它时
  也必须哈希；空值/缺失使用每实例稳定回退，不要退回字符替换或截断。
- 所有配置在 `apply()` 阶段校验并抛出具名字段的 `TypeError`；不要把非法配置留到请求期。
- 调试日志默认关闭，字段必须转义控制字符，写失败不得影响请求；日志含会话标识，不入库。

## 命令与验证

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm verify
pnpm release:pack
```

- `pnpm test` 运行 mock 单测与真实 Cordis 挂载/卸载测试；新增行为必须同时覆盖请求匹配、
  头优先级、配置校验和生命周期。
- `pnpm verify` 是提交门槛：语法检查、测试、真实打包并检查 `files` 白名单及打包入口。
  测试与打包检查使用模拟端点，不代表真实 OpenCode 或 DSH GUI 已验证；不要如此声称。
- 依赖变更后用 pnpm 更新 [`pnpm-lock.yaml`](pnpm-lock.yaml)；CI 使用
  `--frozen-lockfile`，锁文件过期会直接失败。

## 打包与发布

- [`package.json`](package.json) 的 `files` 是发布白名单：只允许运行入口、bundle patch、
  README 与 LICENSE。测试、`scripts/`、`AGENTS.md`、日志和旧 `dist/` 不得进入 tarball。
- `private: true` 是有意为之：本项目不发布到 npm，只通过 GitHub Release 分发 `.tgz` 与
  `SHA256SUMS`。不要添加 npm publish 步骤。
- Release 只由与 `package.json` 版本一致的 `v<version>` tag 触发。工作流从该 tag 打包、
  校验摘要并创建 draft；必须先从 draft 下载资产、核对 `SHA256SUMS`，再手动公开并复查公开
  下载，不能跳过 draft 直接发布。
- 已发布版本不覆盖资产、不重写 tag 历史；需要修正时发布新版本。
