# Changelog

本项目的发布记录。版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## 0.2.2 - 2026-11-05

首个公开版本，仓库与 GitHub Release 从这一版开始维护。

### 新增

- `llm-pi-ai/request-headers` waterfall 接入：只对配置的 provider 与 OpenCode 端点注入
  每会话稳定的 `x-opencode-session`。
- 配置项 `providers`、`host`、`pathPrefix`、`headerName`、`prefix`、`debugLog`。
- 真实 Cordis 挂载 / 卸载测试、打包内容检查、`SHA256SUMS` 发布脚本与 tag 驱动的
  GitHub Release 工作流。
- 中文 README、MIT LICENSE 与仓库开发指南 `AGENTS.md`。

### 变更

- 配置在插件加载时校验：非法 header 名、前缀、host、路径、provider 或日志路径会直接报
  明确的 `TypeError`，不再等到模型请求阶段才失败。
- 不安全或超过 128 字符的会话 ID 改为 `prefix + "h-" + SHA-256(id)`，避免字符替换或截断
  造成的确定性碰撞；正常的安全 ID 仍输出 `prefix + sessionId`。`h-` 加 64 位小写十六进制
  保留给摘要，安全 ID 恰好长成这样时也会被哈希，避免跨分支同值。
- 空字符串、`null`、缺失的会话 ID 统一使用插件实例级 `aux-<uuid>` 回退值。
- `host` 支持裸主机名、`host:port` 与完整 HTTP(S) URL，统一归一化为 hostname；协议和端口
  不参与匹配。裸主机带路径、URL 带凭据等歧义写法在加载时报错。
- 调试日志字段做控制字符转义，保证一次注入只写一行；写日志失败不影响请求。

### 说明

- 最低支持 DSH `0.2.2-rc.1`，Node.js `>= 24.9.0`（与 DSH 0.2.2-rc.1 的要求一致）。已发布的
  `0.2.1-rc.1` 至 `0.2.1-rc.5` 没有 `llm-pi-ai/request-headers` 事件，本插件不能在这些版本上
  提供注入；没有引入旧版回退。
- 不发布到 npm；安装包只通过 GitHub Release 的 `.tgz` 与 `SHA256SUMS` 分发。
