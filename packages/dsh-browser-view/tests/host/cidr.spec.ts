/**
 * The socket fence and its opt-in CIDR widening: parsing, the allow and deny
 * matrix, and the default (unset or empty means loopback-only, unchanged).
 * Requests are plain objects shaped like IncomingMessage; only the fields the
 * fence reads are present.
 */

import type { IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'
import {
  ALLOWED_CIDRS_ENV,
  cidrMatches,
  parseCidr,
  parseCidrList,
  parseIPv4,
  requestAllowedByCidr,
} from '../../src/host/cidr.ts'
import { isRequestFenced } from '../../src/host/routes.ts'

/** A minimal stand-in for one incoming request. */
function requestOf(address: string | undefined, headers: Record<string, string>): IncomingMessage {
  return { socket: { remoteAddress: address }, headers } as unknown as IncomingMessage
}

describe('parseIPv4', () => {
  it('accepts dotted quads and rejects everything else', () => {
    expect(parseIPv4('192.168.1.7')).toBe(((192 << 24) + (168 << 16) + (1 << 8) + 7) >>> 0)
    expect(parseIPv4('0.0.0.0')).toBe(0)
    expect(parseIPv4('256.1.1.1')).toBeUndefined()
    expect(parseIPv4('1.2.3')).toBeUndefined()
    expect(parseIPv4('::1')).toBeUndefined()
    expect(parseIPv4('a.b.c.d')).toBeUndefined()
  })
})

describe('parseCidr', () => {
  it('defaults to /32 and zeroes host bits', () => {
    expect(parseCidr('192.168.1.7')).toEqual({ network: parseIPv4('192.168.1.7'), bits: 32 })
    expect(parseCidr('192.168.1.7/24')).toEqual({ network: parseIPv4('192.168.1.0'), bits: 24 })
    expect(parseCidr('0.0.0.0/0')).toEqual({ network: 0, bits: 0 })
    expect(parseCidr('10.0.0.0/33')).toBeUndefined()
    expect(parseCidr('10.0.0.0/xx')).toBeUndefined()
    expect(parseCidr('10.0.0.0/8/9')).toBeUndefined()
  })
})

describe('parseCidrList', () => {
  it('unset and empty mean no widening', () => {
    expect(parseCidrList(undefined)).toEqual([])
    expect(parseCidrList('')).toEqual([])
    expect(parseCidrList('  ')).toEqual([])
  })

  it('splits on commas and tolerates blank entries', () => {
    expect(parseCidrList('192.168.0.0/16, ,10.0.0.0/8')).toHaveLength(2)
  })

  it('refuses an invalid entry loudly, naming the variable', () => {
    expect(() => parseCidrList('192.168.0.0/16,banana')).toThrow(new RegExp(ALLOWED_CIDRS_ENV))
  })
})

describe('cidrMatches', () => {
  const list = parseCidrList('192.168.1.0/24,127.0.0.0/8')

  it('allows addresses inside a listed range and denies the rest', () => {
    expect(cidrMatches(list, '192.168.1.7')).toBe(true)
    expect(cidrMatches(list, '192.168.1.255')).toBe(true)
    expect(cidrMatches(list, '192.168.2.1')).toBe(false)
    expect(cidrMatches(list, '10.0.0.1')).toBe(false)
  })

  it('unwraps IPv4-mapped forms and never matches pure IPv6', () => {
    expect(cidrMatches(list, '::ffff:192.168.1.7')).toBe(true)
    expect(cidrMatches(list, '::ffff:127.0.0.1')).toBe(true)
    expect(cidrMatches(list, '::1')).toBe(false)
    expect(cidrMatches(list, 'fd00::1')).toBe(false)
  })

  it('a missing address or an empty list admits nothing', () => {
    expect(cidrMatches(list, undefined)).toBe(false)
    expect(cidrMatches([], '192.168.1.7')).toBe(false)
  })
})

describe('requestAllowedByCidr', () => {
  const list = parseCidrList('192.168.1.0/24')

  it('admits a same-origin request from a listed range', () => {
    const req = requestOf('192.168.1.7', { host: '192.168.1.5:3082', origin: 'http://192.168.1.5:3082' })
    expect(requestAllowedByCidr(req, list)).toBe(true)
  })

  it('admits a request without Origin but not a cross-site one', () => {
    expect(requestAllowedByCidr(requestOf('192.168.1.7', { host: '192.168.1.5' }), list)).toBe(true)
    expect(requestAllowedByCidr(requestOf('192.168.1.7', {
      host: '192.168.1.5',
      'sec-fetch-site': 'cross-site',
      origin: 'http://evil.test',
    }), list)).toBe(false)
  })

  it('an address outside the list is denied', () => {
    expect(requestAllowedByCidr(requestOf('10.9.9.9', { host: '192.168.1.5' }), list)).toBe(false)
  })

  it('a forwarded request is denied even inside a listed range', () => {
    const req = requestOf('192.168.1.7', { host: '192.168.1.5', 'x-forwarded-for': '203.0.113.9' })
    expect(requestAllowedByCidr(req, list)).toBe(false)
  })

  it('an empty list admits nothing, keeping the default intact', () => {
    expect(requestAllowedByCidr(requestOf('192.168.1.7', { host: 'x' }), [])).toBe(false)
  })
})

describe('isRequestFenced', () => {
  it('with no widening it is exactly the loopback fence', () => {
    const loopback = requestOf('127.0.0.1', { host: '127.0.0.1:3082' })
    const lan = requestOf('192.168.1.7', { host: '192.168.1.5:3082' })
    expect(isRequestFenced(loopback, [])).toBe(true)
    expect(isRequestFenced(lan, [])).toBe(false)
  })

  it('a listed CIDR admits the LAN request while loopback stays allowed', () => {
    const list = parseCidrList('192.168.1.0/24')
    expect(isRequestFenced(requestOf('192.168.1.7', { host: '192.168.1.5:3082' }), list)).toBe(true)
    expect(isRequestFenced(requestOf('127.0.0.1', { host: '127.0.0.1:3082' }), list)).toBe(true)
    expect(isRequestFenced(requestOf('10.0.0.5', { host: '192.168.1.5:3082' }), list)).toBe(false)
  })
})
