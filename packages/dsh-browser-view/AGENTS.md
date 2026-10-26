# AGENTS.md — dsh-browser-view

DSH Web GUI 插件 dsh-browser-view（实时浏览器视图）。包级规则：只写本包特有约定，
不重复根 AGENTS.md 与 packages/AGENTS.md 的全局/包级规则。

## 本包要点

- 双半区职责：`src/index.ts` + `src/host/` 掌管 Chrome 进程、CDP 会话、标签页与
  WebSocket 分发；`src/client/` 只画帧与状态，不解析 devtools 协议。
- `src/core/protocol.ts` 是两侧唯一的线上契约（事件、命令、数据结构、版本号与
  校验函数）。改它等于同时改两侧：先改契约，再让两侧对齐，不要各自加字段。
- 席位：`sidebar.right.pane.tab`（keyed/session，标签页内容）、
  `sidebar.right.pane.tab.title`（keyed/session，chip 文字与图标）。两者都经
  `ctx.slots.inject` 声明感知注册。会话头部**不再**有入口：右栏自己的 tab strip
  与 guide 胶囊已经能开这个标签页，头部再加一个只是挤占那一行；不要再加回来。
- 标签页类型经 `ctx.sidebarRightTabs.register` 注册，由右栏按 `kind` 打开；
  `kind` 固定为 `browser-view`。**禁止**改成 `browser`：官方
  `@deepseek-ai/dsh-client-ui-sidebar-browser` 占用该 kind，extension 档位会接管它，
  等于顶掉 shipped UI。
- **禁止**注册 `rightbar` / `rightbar.session`——两者是那一栏本身的单占位，已被官方
  占用。
- 面板是右栏标签页，不是浮层也不是中央页面：不要引入 `position: fixed`、自管显隐或
  `main` / `sidebar.panellist` 注册；`keepMounted` 必须保持开启，切 chip 不能断 socket。
- 面板承载的是**帧**，不是 iframe：被控页面在宿主侧的独立 Chromium 里，浏览器半区
  既无沙箱网络也无同源权限去嵌它。
- 浏览器半区值导入只允许平台种子表成员。两个 `sidebar.right.pane.tab*` 键直接用
  owner 自己的声明，不要本地抄——抄一遍会因 `TabHookContext` 未从 barrel 导出而
  TS2717。

## 安全语义

- 面板 socket 默认只允许 loopback；非本机请求在升级前即拒绝。
  `DSH_BROWSER_VIEW_ALLOWED_CIDRS`（逗号分隔 IPv4 CIDR）是显式放宽：命中的
  远端地址按同一组请求级门禁放行（转发头依旧一票否决，跨站与跨源依旧拒绝）；
  未设置或留空即逐字节保持原行为，解析失败的条目要报错而不是静默忽略
  （`src/host/cidr.ts` 组合 `loopback.ts`，不改那份生成的同步副本）。
- 拉起模式（默认）：Chrome 用系统临时目录下的一次性 `--user-data-dir` 与随机
  调试端口启动；不得改为接管用户已登录的浏览器配置目录。
- 附着模式（`DSH_BROWSER_VIEW_ATTACH_PORT` 设为非空端口）：插件不拉起
  Chromium，改为向 `http://127.0.0.1:<port>/json/version` 取
  `webSocketDebuggerUrl` 走既有 CDP 路径（`src/core/browser.ts` 的
  `resolveBrowserHandle` 是唯一分岔点，service 与 loader 不各写一份）。失败
  信息必须带端口与最后的具体原因。附着模式下 dispose 绝不杀浏览器、绝不碰
  任何 profile：只关闭本插件经 `Target.createTarget` 创建的标签页
  （`closeSessionTargets`）与自己的 CDP 会话。
- 附着模式下的工具范围：每个会话只能操作它自己创建的标签页（allowlist 即
  TabManager 记录的 ownerSessionId），外来目标报错并列出可用标签页；
  `browser_close` 只关本会话创建的标签页，无任何回落路径。拉起模式的既有
  语义不变。
- 插件 dispose 时必须按模式收尾：拉起模式杀掉 Chromium 子进程并停掉投屏，
  附着模式只关自己的标签页与会话。修改进程生命周期要同步 README 的
  `安全模型` 与本节。
- 截图只经宿主附件服务（`ctx.get('attachments').saveImage`）落盘，因为 image part 的
  `attachment` ref 必须由该服务签发；除此之外不得把截图副本、页面文本或控制台内容
  写进插件自有目录、日志或缓存。附件服务缺席时 `browser_screenshot` 必须报错，不得
  伪造图片或改走临时文件。

- 鉴权补票（`src/host/auth.ts`）：只对 loopback 目标、且文档确实是 DSH 自己的鉴权页
  时才向 `ctx.connection.authenticatedUrl` 取令牌，每次导航最多补一次；无 connection
  服务、取票抛错、补票后仍是鉴权页都必须**静默退化**，不得报错或改变导航结果。令牌
  只经内存流转，不落盘。

## 提交前检查

```sh
pnpm --filter @linxin666/dsh-client-ui-browser-view typecheck
pnpm --filter @linxin666/dsh-client-ui-browser-view test
pnpm --filter @linxin666/dsh-client-ui-browser-view build
node scripts/verify-docs.mjs --check
node scripts/i18n-audit.mjs --check
```
