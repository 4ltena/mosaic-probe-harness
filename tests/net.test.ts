import { describe, expect, it } from 'vitest'
import { authOk, corsHeaders, ipAllowed } from '../src/net.ts'
import { DEFAULT_ALLOW_CIDRS, defaultConfig } from '../src/config.ts'

describe('ipAllowed', () => {
  it('IPv4 の CIDR 判定', () => {
    expect(ipAllowed('192.168.1.5', ['192.168.0.0/16'])).toBe(true)
    expect(ipAllowed('8.8.8.8', ['192.168.0.0/16'])).toBe(false)
    expect(ipAllowed('172.31.1.1', ['172.16.0.0/12'])).toBe(true)
    expect(ipAllowed('172.32.0.1', ['172.16.0.0/12'])).toBe(false)
  })
  it('プレフィックスが空・数字でない CIDR は一致させない（fail-closed）', () => {
    expect(ipAllowed('8.8.8.8', ['10.0.0.0/'])).toBe(false)
    expect(ipAllowed('8.8.8.8', ['10.0.0.0/x'])).toBe(false)
    expect(ipAllowed('8.8.8.8', ['10.0.0.0/-1'])).toBe(false)
  })
  it('IPv4 射影 ::ffff:x.x.x.x を IPv4 として判定', () => {
    expect(ipAllowed('::ffff:192.168.1.5', ['192.168.0.0/16'])).toBe(true)
    expect(ipAllowed('::ffff:8.8.8.8', ['192.168.0.0/16'])).toBe(false)
  })
  it('IPv6 の ::1 と既定リスト', () => {
    expect(ipAllowed('::1', DEFAULT_ALLOW_CIDRS)).toBe(true)
    expect(ipAllowed('127.0.0.1', DEFAULT_ALLOW_CIDRS)).toBe(true)
    expect(ipAllowed('::2', DEFAULT_ALLOW_CIDRS)).toBe(false)
  })
  it('不正・undefined は false（例外にしない）', () => {
    expect(ipAllowed(undefined, DEFAULT_ALLOW_CIDRS)).toBe(false)
    expect(ipAllowed('', DEFAULT_ALLOW_CIDRS)).toBe(false)
    expect(ipAllowed('garbage', DEFAULT_ALLOW_CIDRS)).toBe(false)
    expect(ipAllowed('999.1.1.1', DEFAULT_ALLOW_CIDRS)).toBe(false)
  })
})

describe('corsHeaders', () => {
  it('* なら ACAO: *、他の共通ヘッダと Max-Age を付ける', () => {
    const h = corsHeaders('http://a.test', defaultConfig({ corsOrigins: '*' }), false)
    expect(h['Access-Control-Allow-Origin']).toBe('*')
    expect(h['Access-Control-Allow-Headers']).toBe('authorization, content-type')
    expect(h['Access-Control-Allow-Methods']).toBe('GET, POST, OPTIONS')
    expect(h['Access-Control-Max-Age']).toBe('600')
    expect(h['Access-Control-Allow-Private-Network']).toBeUndefined()
  })
  it('列挙では一致した Origin だけ echo し Vary: Origin を付ける', () => {
    const cfg = defaultConfig({ corsOrigins: ['http://a.test'] })
    const h = corsHeaders('http://a.test', cfg, false)
    expect(h['Access-Control-Allow-Origin']).toBe('http://a.test')
    expect(h['Vary']).toBe('Origin')
  })
  it('不一致・Origin 無しは空', () => {
    const cfg = defaultConfig({ corsOrigins: ['http://a.test'] })
    expect(corsHeaders('http://b.test', cfg, false)).toEqual({})
    expect(corsHeaders(undefined, cfg, false)).toEqual({})
    expect(corsHeaders(undefined, defaultConfig({ corsOrigins: [] }), false)).toEqual({})
  })
  it('privateNetwork なら Allow-Private-Network を付ける', () => {
    const h = corsHeaders('http://a.test', defaultConfig({ corsOrigins: '*' }), true)
    expect(h['Access-Control-Allow-Private-Network']).toBe('true')
  })
})

describe('authOk', () => {
  it('キー未設定は常に true', () => {
    expect(authOk(undefined, undefined)).toBe(true)
    expect(authOk('Bearer x', undefined)).toBe(true)
  })
  it('Bearer の一致だけ true', () => {
    expect(authOk('Bearer secret', 'secret')).toBe(true)
    expect(authOk('Bearer wrong', 'secret')).toBe(false)
    expect(authOk('secret', 'secret')).toBe(false)
    expect(authOk(undefined, 'secret')).toBe(false)
  })
  it('長さが違っても例外にしない', () => {
    expect(authOk('Bearer sec', 'secret')).toBe(false)
    expect(authOk('Bearer secret-longer', 'secret')).toBe(false)
    expect(authOk('Bearer ', 'secret')).toBe(false)
  })
})
