/**
 * Which browser the host half drives: one it spawned itself (default) or one
 * it attaches to over an already-open DevTools endpoint.
 *
 * Attach mode exists for operators who run the browser themselves: the plugin
 * never spawns Chromium, never creates a profile, and on dispose must not
 * kill anything it does not own. The resolution is a single seam
 * ({@link resolveBrowserHandle}) so the service stays ignorant of where the
 * `webSocketDebuggerUrl` came from — every caller after resolution speaks the
 * same CDP path either way.
 *
 * Failure messages carry the port and the last concrete reason (HTTP status
 * or transport error), because "attach failed" sends the operator reading
 * source code to learn the port was wrong.
 *
 * @module @linxin666/dsh-client-ui-browser-view/core/browser
 */

import { ChromeProcess, type ChromeDisposeResult } from './chrome.ts'
import { DEFAULT_VIEWPORT } from './protocol.ts'

/** Environment variable that turns attach mode on. */
export const ATTACH_PORT_ENV = 'DSH_BROWSER_VIEW_ATTACH_PORT'

/** Deadline for the DevTools endpoint query in attach mode. */
export const ATTACH_ENDPOINT_TIMEOUT_MS = 5_000

/** A browser the plugin launched and therefore owns end to end. */
export interface SpawnedBrowser {
  readonly mode: 'spawn'
  /** The running process; dispose kills it and removes the profile. */
  readonly chrome: ChromeProcess
  /** Browser-level `webSocketDebuggerUrl`. */
  readonly webSocketDebuggerUrl: string
  /** Kill the process and remove the throwaway profile. */
  dispose(): Promise<ChromeDisposeResult>
}

/** A browser the operator runs; dispose never touches it. */
export interface AttachedBrowser {
  readonly mode: 'attach'
  /** Port the DevTools endpoint answers on. */
  readonly port: number
  /** Browser-level `webSocketDebuggerUrl`. */
  readonly webSocketDebuggerUrl: string
  /** A no-op: the operator's browser is not the plugin's to stop. */
  dispose(): Promise<ChromeDisposeResult>
}

/** Either way the plugin can reach a browser. */
export type ResolvedBrowser = SpawnedBrowser | AttachedBrowser

/** What a disposal did; an attached browser is never stopped and has no profile. */
export const ATTACHED_DISPOSE_RESULT: ChromeDisposeResult = { stopped: false, profileRemoved: false }

/** Injection seams so a test can exercise resolution without a browser. */
export interface ResolveBrowserOptions {
  /** Environment to read {@link ATTACH_PORT_ENV} from. @default process.env */
  env?: NodeJS.ProcessEnv
  /** Window size used when a browser must be spawned. @default DEFAULT_VIEWPORT */
  viewport?: { width: number; height: number }
  /**
   * The DevTools endpoint query; resolves the `webSocketDebuggerUrl`.
   * @default a bounded fetch of http://127.0.0.1:<port>/json/version
   */
  fetchEndpoint?: (port: number, timeoutMs: number) => Promise<string>
  /** The spawn path, replaced by tests. @default ChromeProcess.launch */
  launchChrome?: (options: { viewport: { width: number; height: number } }) => Promise<ChromeProcess>
}

/**
 * Parse the attach port from one environment value.
 * @param raw - the env value.
 * @returns the port, or undefined when the value is unset or blank.
 * @throws Error when the value is set but not a usable port number.
 */
export function parseAttachPort(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  const value = raw.trim()
  if (!/^\d+$/.test(value)) {
    throw new Error(`${ATTACH_PORT_ENV} must be a TCP port number, got "${raw}"`)
  }
  const port = Number(value)
  if (port < 1 || port > 65535) {
    throw new Error(`${ATTACH_PORT_ENV} must be a port between 1 and 65535, got ${port}`)
  }
  return port
}

/** Default endpoint query: the same shape Chrome itself answers. */
async function defaultFetchEndpoint(port: number, timeoutMs: number): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, timeoutMs)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      headers: { host: `127.0.0.1:${port}` },
      signal: controller.signal,
    })
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from /json/version`)
    }
    const body = (await response.json()) as { webSocketDebuggerUrl?: unknown }
    if (typeof body.webSocketDebuggerUrl !== 'string' || body.webSocketDebuggerUrl === '') {
      throw new Error('the endpoint reported no webSocketDebuggerUrl')
    }
    return body.webSocketDebuggerUrl
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Resolve the browser the plugin drives: an attached one when
 * {@link ATTACH_PORT_ENV} names a port, a freshly spawned one otherwise.
 * @param options - environment and seam overrides.
 * @returns the resolved browser.
 * @throws Error naming the port and the last concrete reason when attach fails.
 */
export async function resolveBrowserHandle(options: ResolveBrowserOptions = {}): Promise<ResolvedBrowser> {
  const port = parseAttachPort((options.env ?? process.env)[ATTACH_PORT_ENV])
  if (port !== undefined) {
    const fetchEndpoint = options.fetchEndpoint ?? defaultFetchEndpoint
    let webSocketDebuggerUrl: string
    try {
      webSocketDebuggerUrl = await fetchEndpoint(port, ATTACH_ENDPOINT_TIMEOUT_MS)
    } catch (error) {
      // Whatever the seam threw, the operator reads one message that names the
      // port and the last concrete reason.
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`Could not attach to the browser DevTools endpoint on port ${port}: ${reason}`)
    }
    return { mode: 'attach', port, webSocketDebuggerUrl, dispose: async () => ATTACHED_DISPOSE_RESULT }
  }
  const launchChrome = options.launchChrome
    ?? (async (launchOptions: { viewport: { width: number; height: number } }) => await ChromeProcess.launch(launchOptions))
  const chrome = await launchChrome({
    viewport: options.viewport ?? { width: DEFAULT_VIEWPORT.width, height: DEFAULT_VIEWPORT.height },
  })
  return { mode: 'spawn', chrome, webSocketDebuggerUrl: chrome.info.webSocketDebuggerUrl, dispose: () => chrome.dispose() }
}
