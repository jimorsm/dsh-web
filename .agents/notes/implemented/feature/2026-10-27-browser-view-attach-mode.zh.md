# Agent Note: dsh-browser-view 附着模式、CIDR 围栏放宽与工具范围

Status: implemented

## Problem

dsh-browser-view 此前只会自己拉起 Chromium，于是已经带着 `--remote-debugging-port` 跑浏览器的操作者（QA 实例、装好所需扩展的 profile）无法把插件指过去；插件在 dispose 时杀掉的是自己的浏览器，对一个不属于它的浏览器根本没有契约。与此同时，面板 socket 围栏只有 loopback——这在笔记本上正确，却挡住了常见家庭服务器形态：GUI 本来就该服务给一个受信的局域网段。这两项放宽还共享一个隐性风险：agent 驱动的浏览器可能载着操作者的真实会话，所以附着模式下的工具面需要一个拉起模式从未需要过的更窄范围。对应上游 issue #1956（附着模式）、#1957（可配置 socket 围栏）、#1958（附着模式下的工具范围）。

## Decision

三个纯环境变量的显式选项，落在 `packages/dsh-browser-view`，不做设置界面、不加客户端文案：

- **附着模式**（`DSH_BROWSER_VIEW_ATTACH_PORT`，issue #1956）：`src/core/browser.ts` 拥有唯一的解析分岔点 `resolveBrowserHandle()`，返回拉起的 `ChromeProcess`（默认路径，逐字节不变）或附着句柄——从 `http://127.0.0.1:<port>/json/version` 以 5 秒期限取一次 browser 级 `webSocketDebuggerUrl`，`mode: 'attach'`，`dispose()` 恒返回 `{ stopped: false, profileRemoved: false }`、绝不碰进程或任何 profile。`src/host/service.ts` 的 `openDefaultSession` 是唯一调用方；下游（CdpClient、TabManager、工具、面板）除下述范围规则外全部对模式无感。失败信息始终带端口与最后的具体原因（`HTTP 404 from /json/version`、连接错误）。dispose 时 service 额外关闭本插件经 `Target.createTarget` 创建的标签页（`closeSessionTargets`），再关自己的 CDP 会话——操作者的浏览器与 profile 不被触碰。
- **CIDR 围栏放宽**（`DSH_BROWSER_VIEW_ALLOWED_CIDRS`，issue #1957）：`src/host/cidr.ts` 解析逗号分隔的 IPv4 CIDR 列表（裸地址按 /32；非法条目报错并点名环境变量，而不是静默丢弃），并与生成的 loopback 副本组合——不直接改那份副本，因为它是 sync-shared 文件。请求凭 CIDR 放行时仍要过 loopback 围栏的同一组请求级门禁：带转发头拒绝、Host 必须可解析、跨站 fetch 元数据拒绝、有 Origin 时必须同源。未设置或留空与原行为完全一致。IPv6 `::1` 始终按 loopback 放行；列表永远不会放行纯 IPv6 地址。
- **附着模式下的工具范围**（issue #1958）：会话的 allowlist 就是 TabManager 已在记录的标签页归属——只有经 `Target.createTarget` 替该会话创建的标签页对它的工具可见。`tabFor` 对外来显式 tab id 报错并列出可用标签页；附着模式下完全跳过「被观看标签页回落」（拉起模式的第 3 步），没有标签页的会话总是拿到自己的。`browser_close` 本来就只关本会话创建的标签页；附着模式下刻意没有任何回落路径。拉起模式语义不变，测试并列覆盖。

## Alternatives considered

- 在 ChromeProcess 上穿一个模式开关而不是独立句柄类型：被否决；附着没有 pid、没有 profile、没有可杀的进程，开关会逼每个 ChromeProcess 方法都加卫语句，让「dispose 不得杀操作者的浏览器」从类型保证退化成约定。
- 改 `shared/host/loopback.ts` 让它吃操作者提供的 CIDR 列表：被否决；这份共享文件背后有多个路由家族，它们的默认值不能动，而且本改动只属于这个包。在 `src/host/cidr.ts` 组合能让共享默认继续作数。
- 列表命中即放行（只看 socket 地址）：被否决；宿主前挂一条隧道会让公网客户端看起来像局域网地址，转发头否决与同源标记正是挡这个的。
- 按 CDP session id 划范围而不是按标签页归属：被否决；TabManager 已持有面板展示用的 ownerSessionId 记录，另立登记会与用户所见漂移。
- 工具范围做成与附着模式互相独立的开关：被否决；范围的意义正在于附着模式把 agent 指向了载有操作者会话的浏览器，窄范围是附着模式能安全交付的一部分，不是偏好项。

## Consequences

- 插件可以驱动操作者自己跑的浏览器，但只能驱动那个操作者刻意打开 DevTools 端点的浏览器；插件不会替任何人打开远程调试。
- 附着模式的 dispose 由构造保证安全：句柄类型根本不带进程，service 只关插件自建的 target。
- 被列出的 CIDR 网段可以从该网络驱动浏览器工具；README 双语对写明只列真正服务 GUI 的最小范围。
- 验证：包内 `tsc -b`、`vitest run`（207 个测试，含新增的附着解析、CIDR 矩阵与范围规格）与 `tsdown` 构建全绿。本次改动所在的稀疏检出跑不了仓库根门禁（`verify-docs`、`i18n-audit`、聚合），留给 CI。
- 如有后续需求：面板可见的「附着中」标识（需要协议版本号升级，本次刻意不做）。
