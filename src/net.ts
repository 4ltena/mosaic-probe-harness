import { createHash, timingSafeEqual } from 'node:crypto'
import type { Config } from './config.ts'

// IP は v4 を number、v6 を bigint にして比較する。IPv4 射影は v4 として扱う。
type Addr = { v: 4; n: number } | { v: 6; n: bigint }

const V4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

function parseV4(s: string): number | undefined {
  const m = V4_RE.exec(s)
  if (!m) return undefined
  const oct = m.slice(1).map(Number)
  if (oct.some((o) => o > 255)) return undefined
  return ((oct[0]! << 24) | (oct[1]! << 16) | (oct[2]! << 8) | oct[3]!) >>> 0
}

function parseV6(s: string): bigint | undefined {
  // 末尾の IPv4 部分（::ffff:1.2.3.4 など）は 16 進 2 グループに直す
  let t = s
  const last = t.lastIndexOf(':')
  const tail = t.slice(last + 1)
  if (tail.includes('.')) {
    const v4 = parseV4(tail)
    if (v4 === undefined) return undefined
    t = `${t.slice(0, last + 1)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`
  }
  const halves = t.split('::')
  if (halves.length > 2) return undefined
  const head = halves[0] === '' ? [] : halves[0]!.split(':')
  const rest = halves.length === 2 ? (halves[1] === '' ? [] : halves[1]!.split(':')) : []
  const groups = [...head, ...rest]
  if (groups.some((g) => !/^[0-9a-fA-F]{1,4}$/.test(g))) return undefined
  const fill = 8 - groups.length
  if (halves.length === 2 ? fill < 1 : fill !== 0) return undefined
  const all = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill('0'), ...rest]
  let n = 0n
  for (const g of all) n = (n << 16n) | BigInt(parseInt(g, 16))
  return n
}

function parseAddr(s: string): Addr | undefined {
  const v4 = parseV4(s)
  if (v4 !== undefined) return { v: 4, n: v4 }
  const v6 = parseV6(s)
  if (v6 === undefined) return undefined
  // ::ffff:0:0/96 は IPv4 射影
  if (v6 >> 32n === 0xffffn) return { v: 4, n: Number(v6 & 0xffffffffn) }
  return { v: 6, n: v6 }
}

function inCidr(addr: Addr, cidr: string): boolean {
  const slash = cidr.indexOf('/')
  const base = parseAddr(slash < 0 ? cidr : cidr.slice(0, slash))
  if (!base || base.v !== addr.v) return false
  const bits = addr.v === 4 ? 32 : 128
  // プレフィックスは数字だけ許す（空や `/x` を 0 に化けさせない）。不正な項目は一致しない
  const raw = slash < 0 ? String(bits) : cidr.slice(slash + 1)
  if (!/^\d{1,3}$/.test(raw)) return false
  const prefix = Number(raw)
  if (prefix > bits) return false
  if (addr.v === 4 && base.v === 4) {
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
    return ((addr.n & mask) >>> 0) === ((base.n & mask) >>> 0)
  }
  if (addr.v === 6 && base.v === 6) {
    const full = (1n << 128n) - 1n
    const mask = prefix === 0 ? 0n : full ^ ((1n << BigInt(128 - prefix)) - 1n)
    return (addr.n & mask) === (base.n & mask)
  }
  return false
}

/** 接続元 IP が CIDR のどれかに入るか。IPv4 射影は IPv4 として判定する。不正・未定義は false。 */
export function ipAllowed(remote: string | undefined, cidrs: string[]): boolean {
  if (!remote) return false
  const addr = parseAddr(remote)
  if (!addr) return false
  return cidrs.some((c) => inCidr(addr, c))
}

/** CORS 応答ヘッダ。許可されない Origin では空を返す。 */
export function corsHeaders(
  origin: string | undefined,
  cfg: Pick<Config, 'corsOrigins'>,
  privateNetwork: boolean,
): Record<string, string> {
  const allow = cfg.corsOrigins === '*' ? '*' : origin !== undefined && cfg.corsOrigins.includes(origin) ? origin : undefined
  if (allow === undefined) return {}
  const h: Record<string, string> = {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers': 'authorization, content-type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Max-Age': '600',
  }
  if (allow !== '*') h['Vary'] = 'Origin'
  if (privateNetwork) h['Access-Control-Allow-Private-Network'] = 'true'
  return h
}

const digest = (s: string): Buffer => createHash('sha256').update(s).digest()

/** キー未設定は常に通す。設定時は `Bearer <key>` の一致だけ通す（定数時間比較）。 */
export function authOk(header: string | undefined, key: string | undefined): boolean {
  if (key === undefined) return true
  if (header === undefined || !header.startsWith('Bearer ')) return false
  // 長さの違いを漏らさないよう、両方をハッシュにしてから比較する
  return timingSafeEqual(digest(header.slice(7)), digest(key))
}
