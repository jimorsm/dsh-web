/**
 * Tool scoping in attach mode: a session may only operate tabs it created via
 * Target.createTarget; a foreign tab is refused with the allowed list. Spawn
 * mode keeps the old semantics for comparison. The attach-mode dispose
 * semantics (close own targets, never kill the browser) are exercised here too.
 */

import { describe, expect, it } from 'vitest'
import { BrowserViewService, closeSessionTargets, type BrowserSession } from '../../src/host/service.ts'
import { TabManager } from '../../src/core/tabs.ts'
import { FakeTransport } from '../helpers/fake-cdp.ts'

/** What the local session fixture exposes. */
interface Fixture {
  service: BrowserViewService
  transport: FakeTransport
  /** Target.closeTarget calls recorded by the transport. */
  closeCalls: () => Array<Record<string, unknown>>
}

/**
 * Build a service whose session runs over a scripted transport in the given
 * mode. Only the process boundary is faked; tab creation and disposal are the
 * production path.
 */
function makeService(mode: 'spawn' | 'attach'): Fixture {
  const transport = new FakeTransport()
  let tabCounter = 0
  const closeCalls: Array<Record<string, unknown>> = []
  transport.responses.set('Target.createTarget', () => ({ targetId: `tab-${++tabCounter}` }))
  transport.responses.set('Target.attachToTarget', () => ({ sessionId: `session-${tabCounter}` }))
  transport.responses.set('Page.captureScreenshot', { data: 'JPEG-BYTES' })
  transport.responses.set('Runtime.evaluate', { result: { value: JSON.stringify({ url: 'https://a.test/', title: 'A' }) } })
  transport.onSend = (call) => {
    if (call.method === 'Target.closeTarget') closeCalls.push(call.params)
    if (call.method === 'Page.navigate') transport.emit('Page.loadEventFired', {}, call.sessionId)
  }
  const service = new BrowserViewService({
    now: () => 500,
    openSession: async (opts): Promise<BrowserSession> => {
      const tabs = new TabManager({
        transport,
        onFrame: opts.onFrame,
        onTabsChanged: opts.onTabsChanged,
      })
      return {
        transport,
        tabs,
        mode,
        async dispose() { await tabs.dispose() },
      }
    },
  })
  return { service, transport, closeCalls: () => closeCalls }
}

describe('tool scoping in attach mode', () => {
  it('a session naming another session\'s tab is refused and shown its own tabs', async () => {
    // Given two sessions with one tab each in attach mode
    // When the first session names the second session's tab
    // Then the call is refused and the message lists the allowed tab
    const { service } = makeService('attach')
    await service.ensureTab('session-a')
    const b = await service.ensureTab('session-b')
    await expect(service.tabFor('session-a', b.id)).rejects.toThrow(
      new RegExp(`"${b.id}" was not opened by this session.*allowed tabs: "tab-1"`),
    )
  })

  it('a session with no tab of its own is told how to get one', async () => {
    // Given session-a has no tab
    // When it names a tab created without a session
    // Then the refusal points at creating one
    const { service } = makeService('attach')
    const orphan = await service.ensureTab(undefined)
    await expect(service.tabFor('session-a', orphan.id)).rejects.toThrow(/none yet/)
  })

  it('a session may keep using the tab it created', async () => {
    // Given session-a created a tab
    // When it resolves a tab twice
    // Then the same tab comes back and no error is raised
    const { service } = makeService('attach')
    const own = await service.ensureTab('session-a')
    const again = await service.tabFor('session-a', own.id)
    expect(again.id).toBe(own.id)
  })

  it('the watched-tab fallback is skipped, so a session gets its own tab', async () => {
    // Given an unowned tab is the one the panel watches
    // When session-a asks for a tab without naming one
    // Then a fresh tab is created instead of taking the watched one
    const { service, transport } = makeService('attach')
    await service.ensureTab(undefined)
    const own = await service.tabFor('session-a')
    expect(own.sessionId).toBe('session-a')
    expect(transport.callsOf('Target.createTarget')).toHaveLength(2)
  })

  it('a session acting without a tab id lands on its own bound tab even after naming a foreign one failed', async () => {
    // Given a refused foreign attempt
    // When session-a asks for a tab without an id
    // Then it still gets its own tab, never the foreign one
    const { service } = makeService('attach')
    const a = await service.ensureTab('session-a')
    const b = await service.ensureTab('session-b')
    await expect(service.tabFor('session-a', b.id)).rejects.toThrow()
    expect((await service.tabFor('session-a')).id).toBe(a.id)
  })

  it('browser_close closes only session-created tabs and never anything else', async () => {
    // Given two sessions with one tab each
    // When session-a closes its tabs
    // Then only its own target id reaches Target.closeTarget
    const { service, closeCalls } = makeService('attach')
    const a = await service.ensureTab('session-a')
    await service.ensureTab('session-b')
    await expect(service.closeOwnTabs('session-a')).resolves.toEqual([a.id])
    expect(closeCalls()).toEqual([{ targetId: a.id }])
  })
})

describe('spawn mode is unchanged', () => {
  it('a session may still name another session\'s tab explicitly', async () => {
    // Given two sessions in spawn mode
    // When the first names the second's tab
    // Then the call succeeds, as it always has
    const { service } = makeService('spawn')
    await service.ensureTab('session-a')
    const b = await service.ensureTab('session-b')
    await expect(service.tabFor('session-a', b.id)).resolves.toMatchObject({ id: b.id })
  })

  it('the watched-tab fallback still binds an unowned watched tab', async () => {
    // Given an unowned watched tab in spawn mode
    // When a session asks for a tab
    // Then it binds the watched one instead of creating a second
    const { service, transport } = makeService('spawn')
    await service.ensureTab(undefined)
    const picked = await service.tabFor('session-a')
    expect(picked.sessionId).toBeUndefined()
    expect(transport.callsOf('Target.createTarget')).toHaveLength(1)
  })
})

describe('attach-mode dispose', () => {
  it('closes the tabs the plugin created and never the browser process', async () => {
    // Given two plugin-created tabs in an attached browser session
    // When the production dispose helper runs
    // Then every created target is closed by id and nothing else is torn down
    const { service, transport, closeCalls } = makeService('attach')
    const first = await service.ensureTab('session-a')
    const second = await service.ensureTab('session-b')
    const session = (service as unknown as { session: BrowserSession }).session
    await closeSessionTargets(session)
    expect(closeCalls().map(call => call.targetId).sort()).toEqual([first.id, second.id].sort())
    // No process kill exists on this path: only target closes happened; the
    // caller still closes the plugin's own protocol socket afterwards.
    expect(transport.closed).toBe(false)
  })

  it('a spawned session closes no targets here; the process kill covers them', async () => {
    // Given two tabs in a spawned session
    // When the dispose helper runs
    // Then it sends nothing
    const { service, closeCalls } = makeService('spawn')
    await service.ensureTab('session-a')
    const session = (service as unknown as { session: BrowserSession }).session
    await closeSessionTargets({ ...session, mode: 'spawn' })
    expect(closeCalls()).toEqual([])
  })
})
