# Agent Note: dsh-browser-view attach mode, CIDR fence widening, and tool scoping

Status: implemented

## Problem

dsh-browser-view always spawned its own Chromium, so an operator who already runs a browser with `--remote-debugging-port` (a QA instance, a profile with the right extensions) could not point the plugin at it; the plugin killed its own browser on dispose, and would have had no contract at all for a browser it does not own. At the same time the panel socket fence was loopback-only, which is correct for a laptop but blocks the common homelab shape where the GUI is legitimately served to one trusted LAN range. And both of those widenings share a hidden risk: a browser the agent drives might be one that holds the operator's real sessions, so in attach mode the tool surface needed a narrower scope than spawn mode has ever needed. Closes upstream issues #1956 (attach mode), #1957 (configurable socket fence), #1958 (tool scoping in attach mode).

## Decision

Three environment-only opt-ins in `packages/dsh-browser-view`, no settings UI and no client strings:

- **Attach mode** (`DSH_BROWSER_VIEW_ATTACH_PORT`, issue #1956): `src/core/browser.ts` owns one resolution seam, `resolveBrowserHandle()`, which returns either a spawned `ChromeProcess` (the default path, byte-for-byte unchanged) or an attached handle — the browser-level `webSocketDebuggerUrl` fetched once from `http://127.0.0.1:<port>/json/version` with a 5 s deadline, `mode: 'attach'`, and a `dispose()` that resolves to `{ stopped: false, profileRemoved: false }` without touching the process or any profile. `openDefaultSession` in `src/host/service.ts` is the only caller; everything downstream (CdpClient, TabManager, tools, panels) is mode-blind except for the scoping rule below. Failure messages always name the port and the last concrete reason (`HTTP 404 from /json/version`, a connection error). On dispose the service additionally closes the tabs the plugin itself created via `Target.createTarget` (`closeSessionTargets`) and then its own CDP session — the operator's browser and profile are never touched.
- **CIDR fence widening** (`DSH_BROWSER_VIEW_ALLOWED_CIDRS`, issue #1957): `src/host/cidr.ts` parses a comma-separated IPv4 CIDR list (a bare address means /32; an invalid entry throws, naming the variable, instead of being silently dropped) and composes with the generated loopback copy — the copy itself is not edited, because it is a sync-shared file. A request is admitted on CIDR grounds only under the same request-level gates the loopback fence applies: no forwarding headers, a parseable Host, no cross-site fetch metadata, same-origin Origin when present. Unset or empty is exactly the previous behavior. IPv6 `::1` stays loopback-always; the list never admits pure IPv6 addresses.
- **Tool scoping in attach mode** (issue #1958): the session's allowlist is the tab ownership the TabManager already records — only tabs created via `Target.createTarget` on that session's behalf are visible to its tools. `tabFor` refuses a foreign explicit tab id with an error listing the allowed tabs, and the watched-tab fallback (spawn mode's step 3) is skipped entirely in attach mode, so a session without a tab always gets its own. `browser_close` only ever closed session-created tabs; in attach mode there is deliberately no fall-through path. Spawn mode semantics are unchanged and tested side by side.

## Alternatives considered

- A mode flag threaded through ChromeProcess instead of a separate handle type: rejected; attach has no pid, no profile, and no process to kill, so a flag would force every ChromeProcess method to guard on it and make the "dispose must not kill the operator's browser" property a convention instead of a type.
- Editing `shared/host/loopback.ts` to grow an operator-supplied CIDR list: rejected; the shared file backs several route families whose default must not move, and this change is package-scoped. Composition in `src/host/cidr.ts` keeps the shared default authoritative.
- Wide-open admission for a listed CIDR (socket address only): rejected; a tunnel in front of the host would make a public client look like a LAN address, and the forwarding-header veto plus same-origin markers are what stop that.
- Scoping by CDP session ids rather than tab ownership: rejected; TabManager already owns the ownerSessionId record the panel displays, so a second registry would drift from what the user sees.
- Making tool scoping opt-in separately from attach mode: rejected; the whole point of scoping is that attach mode points the agent at a browser with the operator's sessions, so the narrow scope is part of what makes attach mode safe to ship, not a preference.

## Consequences

- The plugin can drive an operator-run browser, but only one whose DevTools endpoint the operator deliberately opened; the plugin never enables remote debugging itself.
- Attach-mode dispose is safe by construction: the handle type cannot kill a process it does not carry, and the service closes only plugin-created targets.
- A listed CIDR range can reach the browser tools from that network; the README pair says to list the narrowest range that serves the GUI.
- Verification: `tsc -b`, `vitest run` (207 tests, including the new attach-resolution, CIDR matrix, and scoping specs) and `tsdown` build green in the package. The repo-root gates (`verify-docs`, `i18n-audit`, aggregate) were not runnable from the sparse checkout used for this change and remain for CI.
- Follow-up if asked for: a panel-visible indicator that the browser is attached rather than spawned (would be a protocol version bump, so it was deliberately left out of this change).
