# dsh-opencode-session

给**自定义的 OpenCode Go 路由**（默认 `opencode-go-extra`）注入每会话稳定的
`x-opencode-session`，让不同 DSH 会话在 OpenCode 侧拿到不同的路由 / 缓存 ID。

> 要求 **DSH ≥ 0.2.2-rc.1**（`llm-pi-ai/request-headers` waterfall 从这一版开始提供），
> Node.js ≥ 24.9.0（DSH 0.2.2-rc.1 自身的要求）。当前版本 `0.2.2`，首个公开版本，只通过
> GitHub Release 分发，不发布到 npm。

## 为什么需要

三层各自合理的设计叠在一起，出现了一个缺口：

1. **pi-ai 的模型目录是静态打包的**。`opencode-go` 的模型表来自 `@earendil-works/pi-ai`
   里的 `data/opencode-go.json`，新模型不会自动出现；对有目录的 provider，模型刷新也直接
   返回这份静态表。
2. **DSH 的协议和端点只能写在路由级**。模型条目只支持
   `id / name / contextWindow / maxTokens / input / reasoningEfforts / compat`，没有
   `api` / `baseURL`。`opencode-go` 又是多协议目录（anthropic / google / openai-completions /
   openai-responses），给路由写死一个 `api` 会覆盖全部模型，所以新模型加不进这条内置路由。
3. **OpenCode 按会话路由**，而 pi-ai 只在**内置**的 `opencode` / `opencode-go`
   provider 上包了 `withOpenCodeSessionHeader`。

于是想要新模型的人会自建一条路由（`api: openai-completions` + OpenCode 的
`baseURL`），这条路由却没有上面那层包装。静态写一个 `x-opencode-session` 能让请求通过，
但所有会话共用一个 ID，路由与 prompt cache 的隔离就没了——这个插件补的正是这一段。

## 适用与不适用

| 场景 | 需要本插件 | 原因 |
| --- | --- | --- |
| 内置 `opencode-go` / `opencode` 路由 | 否 | pi-ai 的 catalog provider 自带该头 |
| 自定义路由指向 `opencode.ai/inference/go` | 是 | DSH 从配置拼装 provider，没有原生包装 |
| 自定义路由 + 静态 `x-opencode-session` | 否，但不理想 | 插件见到已有头会跳过；全会话共用一个 ID |
| 非 OpenCode 端点 | 否 | 只匹配配置的 host 与路径前缀 |
| DSH `0.2.1-rc.1` 至 `0.2.1-rc.5` | 不支持 | 这些版本没有 `llm-pi-ai/request-headers` 事件 |

## 工作方式

1. 监听 `llm-pi-ai/request-headers` waterfall。每次推理请求都会带上
   `{ provider, model, sessionId, purpose, baseURL }`，不存在并发串话问题。
2. 只对 `providers` 里列出的路由、且 `baseURL` 命中配置 host 与路径前缀的请求，补上
   `x-opencode-session`。`baseURL` 必须是 HTTP(S)，hostname 精确匹配，路径按字面前缀匹配。
3. 已有的同名头（大小写不敏感）保持原值，方便从静态头平滑迁移；下游监听器写入的其他头
   也会保留。
4. 会话 ID 的取值规则：
   - 匹配 `[A-Za-z0-9._:-]` 且不超过 128 字符：`prefix + sessionId`，默认即 `dsh-<sessionId>`；
   - 其他非空值：`prefix + "h-" + SHA-256(sessionId)`，完整摘要，不做截断；
   - 空字符串、`null`、缺失：插件实例级 `aux-<uuid>` 回退，同一实例内稳定。
   - `h-` 加 64 位小写十六进制是保留的摘要命名空间；安全 ID 恰好长成这样时也走摘要
     分支，避免它与另一个非法 ID 的摘要值相同。
5. 不修改 `globalThis.fetch`，也不使用 `AsyncLocalStorage`；卸载时只移除自己的监听器。

## 配置

```yaml
- id: opencode-session
  name: dsh-opencode-session
  config:
    providers:
      - opencode-go-extra
    # host: opencode.ai            # 反代时改成自己的域名，可写 host:port 或完整 URL
    # pathPrefix: /inference/go/    # 字面前缀，省略开头斜杠会自动补
    # headerName: x-opencode-session
    # prefix: dsh-
    # debugLog: /tmp/opencode-session.log   # 仅排查时开
```

- `providers`：路由名列表，必须是字符串数组；省略或空数组时使用默认的
  `opencode-go-extra`。
- `host`：裸主机名、`host:port` 或 HTTP(S) URL；只取 hostname，**协议和端口不参与匹配**。
  裸主机带路径、URL 带凭据、非 HTTP(S) 协议都会在加载时报错。
- `pathPrefix`：与 `url.pathname` 做字面 `startsWith` 比较。想限定一个路径段时请带尾斜杠
  （`/v1/` 不会匹配 `/v10`，但 `/v1` 会匹配 `/v10`）。只能包含可打印 ASCII，不能包含空白、
  查询串或 fragment。
- `headerName`：必须是合法 HTTP token（RFC 9110）。
- `prefix`：最多 64 个可打印 ASCII 字符，不能以空白开头或结尾；允许空字符串。
- `debugLog`：每注入一次追加一行
  `时间<TAB>provider<TAB>sessionId<TAB>headerValue`，字段中的控制字符会被转义。写失败不会
  影响请求。日志包含会话标识，生产环境不要开启，也不要提交到仓库。

配置在插件加载时校验，非法值会抛出指明字段的 `TypeError`，而不是等到模型请求时才失败。

## 安装

从 GitHub Release 下载并校验（推荐）：

```sh
curl -fLO https://github.com/FFFengMJL/dsh-opencode-session/releases/download/v0.2.2/dsh-opencode-session-0.2.2.tgz
curl -fLO https://github.com/FFFengMJL/dsh-opencode-session/releases/download/v0.2.2/SHA256SUMS
sha256sum -c SHA256SUMS

dsh plugin --profile web add ./dsh-opencode-session-0.2.2.tgz
```

Windows PowerShell 把最后一行换成下载后的本地路径即可：

```powershell
dsh plugin --profile web add C:\path\to\dsh-opencode-session-0.2.2.tgz
```

从本机源码目录安装（开发时）：

```sh
dsh plugin --profile web add /path/to/dsh-opencode-session
```

安装后把目标路由的静态 `headers.x-opencode-session` 删掉，让插件接管。目标机器上的 provider
路由名如果不是 `opencode-go-extra`，在 profile 的 `cordis.patch.yml` 里覆盖插件行的
`providers` 列表即可（不要改插件包内的默认值）。安装/更新插件应使用 `dsh plugin` 命令，
不要手改 profile 的依赖清单或 `node_modules`。

## 已知边界

- 只处理配置的 host + 路径前缀；换域名或换协议路径要同步改 `host` / `pathPrefix`。
- 协议（HTTP/HTTPS）和端口不参与匹配；同一 hostname 的不同端口会命中同一条规则。
- 不保证 OpenCode 内部的路由 / 缓存一定按会话隔离；插件只保证发出去的 ID
  每会话稳定且不同，不承诺数学意义上的绝对无碰撞。
- 如果路由已经带静态 `x-opencode-session`，插件会跳过，方便迁移和回退。
- 缺少该头时 OpenCode 是否拒绝请求取决于服务端；能确定的是 pi-ai 把它当作
  必需的路由头，而静态头能满足“有头”但牺牲隔离。
- 已发布的 DSH `0.2.1` 系列没有所需 waterfall。放宽 `engines.dsh` 并不能让它工作；
  本项目不为旧版提供 fetch 劫持等回退。

## 开发与验证

```sh
pnpm install --frozen-lockfile
pnpm test          # 单测 + 真实 Cordis 挂载/卸载
pnpm verify        # 语法、测试、打包内容检查
pnpm release:pack  # 生成 .release/*.tgz 与 SHA256SUMS
```

测试使用模拟的 OpenCode 端点，不发送真实付费请求；这些检查也不等同于真实 DSH Web GUI
或 OpenCode 线上行为验证。

## 何时可以退役

以下任一变化落地后，这个插件就不再必要：

- DSH 允许在 catalog 基础上**增量追加**模型，或允许按模型声明 `api` / `baseURL`；
- pi-ai 对自定义 provider 也按 `baseURL` 补 OpenCode 会话头；
- OpenCode 不再要求按会话的路由头。

在此之前，它是“自定义路由 + 按会话隔离”这一组合的补丁。
