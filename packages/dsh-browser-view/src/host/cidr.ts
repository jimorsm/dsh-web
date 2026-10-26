/**
 * The opt-in widening of the panel socket fence beyond loopback.
 *
 * The default fence is and stays loopback-only (the generated
 * `loopback.ts` copy, whose semantics this module composes with instead of
 * editing). An operator whose GUI is legitimately reached from a trusted
 * network range — a home LAN, a wireguard interface — can list IPv4 CIDRs in
 * `DSH_BROWSER_VIEW_ALLOWED_CIDRS`; a request from an address inside any
 * listed range is then admitted by the same gates the loopback fence applies
 * to its socket half (no forwarding headers, a parseable Host header, no
 * cross-site fetch metadata, same-origin Origin when present).
 *
 * Unset or empty means exactly the previous behavior: widening is opt-in and
 * listable, never implicit. IPv6 ::1 stays loopback always; the list is IPv4
 * only, because the requests that motivate it come from LAN interfaces.
 *
 * @module @linxin666/dsh-client-ui-browser-view/host/cidr
 */

import type { IncomingMessage } from 'node:http'
import { isProxiedRequest } from './loopback.ts'

/** Environment variable carrying the comma-separated CIDR list. */
export const ALLOWED_CIDRS_ENV = 'DSH_BROWSER_VIEW_ALLOWED_CIDRS'

/** One IPv4 CIDR range, address and mask as 32-bit integers. */
export interface Cidr4 {
  /** Network address as a 32-bit integer, host bits already zeroed. */
  network: number
  /** Prefix length, 0 to 32. */
  bits: number
}

/**
 * Parse one dotted-quad IPv4 address into a 32-bit integer.
 * @param text - `a.b.c.d`.
 * @returns the integer, or undefined when the octets are not a valid IPv4 address.
 */
export function parseIPv4(text: string): number | undefined {
  const parts = text.split('.')
  if (parts.length !== 4) return undefined
  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined
    const octet = Number(part)
    if (octet > 255) return undefined
    value = (value * 256) + octet
  }
  return value >>> 0
}

/**
 * Parse one CIDR entry: `a.b.c.d` (host bits implicitly zero) or `a.b.c.d/len`.
 * @param text - one entry, surrounding whitespace allowed.
 * @returns the range, or undefined when the entry is not valid IPv4 CIDR syntax.
 */
export function parseCidr(text: string): Cidr4 | undefined {
  const [addressText, bitsText, extra] = text.trim().split('/')
  if (extra !== undefined) return undefined
  const address = parseIPv4(addressText ?? '')
  if (address === undefined) return undefined
  if (bitsText === undefined) return { network: address, bits: 32 }
  if (!/^\d{1,2}$/.test(bitsText)) return undefined
  const bits = Number(bitsText)
  if (bits > 32) return undefined
  const mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0
  return { network: (address & mask) >>> 0, bits }
}

/**
 * Parse the whole environment value: comma-separated entries; an empty or
 * unset value is an empty list (default fence).
 * @param raw - the env value.
 * @returns the parsed ranges, in order.
 * @throws Error naming the offending entry when one is not valid CIDR syntax.
 */
export function parseCidrList(raw: string | undefined): Cidr4[] {
  if (raw === undefined || raw.trim() === '') return []
  const list: Cidr4[] = []
  for (const entry of raw.split(',')) {
    if (entry.trim() === '') continue
    const parsed = parseCidr(entry)
    if (parsed === undefined) {
      throw new Error(`${ALLOWED_CIDRS_ENV} entry "${entry.trim()}" is not an IPv4 CIDR range like 192.168.1.0/24`)
    }
    list.push(parsed)
  }
  return list
}

/**
 * Whether one socket remote address falls inside any listed range. An
 * IPv4-mapped IPv6 form (`::ffff:192.168.1.7`) is unwrapped first, as the
 * loopback fence already does; a pure IPv6 address (::1 included) never
 * matches an IPv4 list.
 * @param list - the parsed ranges.
 * @param address - the socket remote address.
 * @returns true when the address is inside a listed range.
 */
export function cidrMatches(list: readonly Cidr4[], address: string | undefined): boolean {
  if (address === undefined || list.length === 0) return false
  const normalized = address.toLowerCase()
  const v4 = normalized.startsWith('::ffff:') ? normalized.slice('::ffff:'.length) : normalized
  const value = parseIPv4(v4)
  if (value === undefined) return false
  return list.some(({ network, bits }) => {
    const mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0
    return ((value & mask) >>> 0) === network
  })
}

/**
 * The CIDR half of the widened fence: same request-level gates as the
 * loopback fence, but the socket address must sit inside a listed range
 * instead of being loopback. A forwarded request is still refused outright —
 * a proxy in front of the host makes the socket address describe the proxy,
 * and X-Forwarded-For is never evidence for trust.
 * @param request - node HTTP request.
 * @param list - the parsed ranges; an empty list admits nothing.
 * @returns true when the request may pass on CIDR grounds.
 */
export function requestAllowedByCidr(request: IncomingMessage, list: readonly Cidr4[]): boolean {
  if (list.length === 0) return false
  if (isProxiedRequest(request)) return false
  if (!cidrMatches(list, request.socket.remoteAddress)) return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl: URL
  try {
    hostUrl = new URL('http://' + host)
  } catch {
    return false
  }
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}
