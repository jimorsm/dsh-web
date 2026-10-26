/**
 * Attach-mode resolution: the env var decides between the spawned path and the
 * attached handle, failures name the port and the last reason, and an attached
 * handle's dispose never touches the operator's browser. The service-level
 * dispose semantics for an attached session are covered in attach-scoping.spec.
 */

import { describe, expect, it } from 'vitest'
import {
  ATTACH_PORT_ENV,
  ATTACHED_DISPOSE_RESULT,
  parseAttachPort,
  resolveBrowserHandle,
} from '../../src/core/browser.ts'
import type { ChromeProcess } from '../../src/core/chrome.ts'

/** A ChromeProcess stand-in that only records dispose calls. */
function fakeChrome(): { chrome: ChromeProcess; disposals: () => number } {
  let disposals = 0
  const chrome = {
    info: { chromePath: '/fake/chrome', port: 9, userDataDir: '/tmp/fake', webSocketDebuggerUrl: 'ws://127.0.0.1:9/devtools/browser/x', pid: 1 },
    isDisposed: false,
    lastDispose: undefined,
    async dispose() {
      disposals += 1
      return { stopped: true, profileRemoved: true }
    },
  } as unknown as ChromeProcess
  return { chrome, disposals: () => disposals }
}

describe('parseAttachPort', () => {
  it('unset and blank values mean spawn mode', () => {
    expect(parseAttachPort(undefined)).toBeUndefined()
    expect(parseAttachPort('')).toBeUndefined()
    expect(parseAttachPort('   ')).toBeUndefined()
  })

  it('accepts a plain port number', () => {
    expect(parseAttachPort('9222')).toBe(9222)
    expect(parseAttachPort(' 9222\n')).toBe(9222)
  })

  it('refuses values that are not a usable port', () => {
    expect(() => parseAttachPort('abc')).toThrow(/DSH_BROWSER_VIEW_ATTACH_PORT/)
    expect(() => parseAttachPort('92.5')).toThrow(/DSH_BROWSER_VIEW_ATTACH_PORT/)
    expect(() => parseAttachPort('0')).toThrow(/between 1 and 65535/)
    expect(() => parseAttachPort('70000')).toThrow(/between 1 and 65535/)
  })
})

describe('resolveBrowserHandle', () => {
  it('with the env unset it spawns and carries the endpoint of the launched process', async () => {
    // Given no attach port in the environment
    // When the handle is resolved
    // Then the spawn seam built the browser and the endpoint comes from it
    const { chrome } = fakeChrome()
    const handle = await resolveBrowserHandle({
      env: {},
      launchChrome: async () => chrome,
    })
    expect(handle.mode).toBe('spawn')
    expect(handle.webSocketDebuggerUrl).toBe('ws://127.0.0.1:9/devtools/browser/x')
    if (handle.mode === 'spawn') expect(handle.chrome).toBe(chrome)
  })

  it('with a port it attaches to that endpoint and never spawns', async () => {
    // Given DSH_BROWSER_VIEW_ATTACH_PORT names a listening port
    // When the handle is resolved
    // Then the endpoint query answered the URL and the spawn seam was not called
    let spawned = 0
    const handle = await resolveBrowserHandle({
      env: { [ATTACH_PORT_ENV]: '9223' },
      fetchEndpoint: async (port) => {
        expect(port).toBe(9223)
        return 'ws://127.0.0.1:9223/devtools/browser/attached'
      },
      launchChrome: async () => {
        spawned += 1
        throw new Error('must not spawn in attach mode')
      },
    })
    expect(spawned).toBe(0)
    expect(handle.mode).toBe('attach')
    expect(handle.webSocketDebuggerUrl).toBe('ws://127.0.0.1:9223/devtools/browser/attached')
  })

  it('a failed endpoint query names the port and the last error', async () => {
    // Given nothing answers on the port
    // When resolution runs
    // Then the error carries the port and the connection error text
    await expect(resolveBrowserHandle({
      env: { [ATTACH_PORT_ENV]: '9224' },
      fetchEndpoint: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:9224') },
    })).rejects.toThrow(/port 9224.*ECONNREFUSED/s)
  })

  it('an HTTP failure surfaces the status in the message', async () => {
    // Given the endpoint answers 404
    // When resolution runs
    // Then the error names the port and the status
    await expect(resolveBrowserHandle({
      env: { [ATTACH_PORT_ENV]: '9225' },
      fetchEndpoint: async () => { throw new Error('HTTP 404 from /json/version') },
    })).rejects.toThrow(/port 9225.*HTTP 404/s)
  })

  it('an attached handle disposes as a no-op', async () => {
    // Given an attached browser
    // When it is disposed twice
    // Then both calls report nothing stopped, no profile removed, and nothing throws
    const handle = await resolveBrowserHandle({
      env: { [ATTACH_PORT_ENV]: '9226' },
      fetchEndpoint: async () => 'ws://127.0.0.1:9226/devtools/browser/x',
    })
    await expect(handle.dispose()).resolves.toEqual(ATTACHED_DISPOSE_RESULT)
    await expect(handle.dispose()).resolves.toEqual({ stopped: false, profileRemoved: false })
    expect(handle.mode).toBe('attach')
  })

  it('a spawned handle dispose kills the process and removes the profile', async () => {
    // Given a spawned browser
    // When it is disposed
    // Then the process handle reports stopped and profile removed
    const { chrome } = fakeChrome()
    const handle = await resolveBrowserHandle({ env: {}, launchChrome: async () => chrome })
    await expect(handle.dispose()).resolves.toEqual({ stopped: true, profileRemoved: true })
  })
})
