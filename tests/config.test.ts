import { describe, expect, it } from 'vitest'
import { assertSafeBind, defaultConfig, loadConfig } from '../src/config.ts'

describe('config', () => {
  it('既定はループバック・CORS なし', () => {
    const c = loadConfig({}, '.')
    expect(c.bind).toBe('127.0.0.1')
    expect(c.corsOrigins).toEqual([])
    expect(c.apiKey).toBeUndefined()
  })
  it('キーがあれば CORS は既定で *', () => {
    expect(loadConfig({ MOSAIC_API_KEY: 'k' }, '.').corsOrigins).toBe('*')
    expect(loadConfig({ MOSAIC_API_KEY: 'k', MOSAIC_CORS_ORIGINS: 'http://a.test, http://b.test' }, '.').corsOrigins).toEqual([
      'http://a.test',
      'http://b.test',
    ])
  })
  it('ループバック以外でキーが無ければ起動を拒否', () => {
    expect(() => assertSafeBind({ bind: '0.0.0.0', apiKey: undefined })).toThrow()
    expect(() => assertSafeBind({ bind: '0.0.0.0', apiKey: 'k' })).not.toThrow()
    expect(() => assertSafeBind({ bind: '127.0.0.1', apiKey: undefined })).not.toThrow()
  })
  it('不正な VLM_EXTRA_BODY は値を出さずに失敗', () => {
    expect(() => loadConfig({ VLM_EXTRA_BODY: '[1]' }, '.')).toThrow(/VLM_EXTRA_BODY/)
    let message = ''
    try {
      loadConfig({ VLM_EXTRA_BODY: 'secret-token' }, '.')
    } catch (e) {
      message = String(e)
    }
    expect(message).toContain('VLM_EXTRA_BODY')
    expect(message).not.toContain('secret-token')
  })
  it('defaultConfig は上書きを適用', () => {
    expect(defaultConfig({ port: 1 }).port).toBe(1)
  })
})

describe('config v1.1: JUDGES・フレーム上限', () => {
  it('JUDGES 未指定は VLM_BASE_URL 1 件・VLM_MODEL の単一判定', () => {
    const c = loadConfig({ VLM_BASE_URL: 'http://10.0.0.5:8080/v1/', VLM_MODEL: 'm1' }, '.')
    expect(c.judges).toEqual([
      { name: 'default', model: 'm1', urls: ['http://10.0.0.5:8080'], slots: 1, weight: 1 },
    ])
  })

  it('VLM_BASE_URLS（複製）は単一判定の 1 要素として urls に入り、スロット数を持つ', () => {
    const c = loadConfig(
      { VLM_BASE_URLS: 'http://a:1, http://b:2', VLM_SLOTS_PER_BACKEND: '2', VLM_MODEL: 'm' },
      '.',
    )
    expect(c.judges).toHaveLength(1)
    expect(c.judges[0]!.urls).toEqual(['http://a:1', 'http://b:2'])
    expect(c.judges[0]!.slots).toBe(2)
  })

  it('JUDGES（JSON 配列）を読む。urls は正規化、slots と weight に既定値', () => {
    const judges = JSON.stringify([
      { name: 'x', model: 'mx', urls: ['http://a:1/v1', 'http://a:1'], slots: 2, weight: 0.5 },
      { name: 'y', model: 'my', urls: ['http://b:2'] },
    ])
    const c = loadConfig({ JUDGES: judges, VLM_BASE_URL: 'http://ignored:9' }, '.')
    expect(c.judges).toEqual([
      { name: 'x', model: 'mx', urls: ['http://a:1'], slots: 2, weight: 0.5 },
      { name: 'y', model: 'my', urls: ['http://b:2'], slots: 1, weight: 1 },
    ])
  })

  it('JUDGES が不正なら値を出さずに失敗', () => {
    expect(() => loadConfig({ JUDGES: '{"name":"x"}' }, '.')).toThrow(/JUDGES/)
    expect(() => loadConfig({ JUDGES: '[{"name":"secret-name","model":"m"}]' }, '.')).toThrow(/JUDGES/)
    let message = ''
    try {
      loadConfig({ JUDGES: '[{"name":"secret-name","model":"m","urls":[]}]' }, '.')
    } catch (e) {
      message = String(e)
    }
    expect(message).toContain('JUDGES')
    expect(message).not.toContain('secret-name')
  })

  it('defaultConfig で vlmBaseUrls を上書きすると、判定器の台（judges）も同じになる', () => {
    const c = defaultConfig({ vlmBaseUrls: ['http://fake:1'] })
    expect(c.judges).toHaveLength(1)
    expect(c.judges[0]!.urls).toEqual(['http://fake:1'])
  })

  it('CLASSIFY_TEMPERATURE は 0 より大きい必要。外れは値を出さずに失敗', () => {
    expect(loadConfig({ CLASSIFY_TEMPERATURE: '0.5' }, '.').temperature).toBe(0.5)
    expect(() => loadConfig({ CLASSIFY_TEMPERATURE: '0' }, '.')).toThrow(/CLASSIFY_TEMPERATURE/)
    let message = ''
    try {
      loadConfig({ CLASSIFY_TEMPERATURE: '-7' }, '.')
    } catch (e) {
      message = String(e)
    }
    expect(message).toContain('CLASSIFY_TEMPERATURE')
    expect(message).not.toContain('-7')
  })

  it('MAX_FRAMES 既定 100、MAX_ANIM_SECONDS 既定 10。環境変数で上書き', () => {
    const d = loadConfig({}, '.')
    expect(d.maxFrames).toBe(100)
    expect(d.maxAnimSeconds).toBe(10)
    const o = loadConfig({ MAX_FRAMES: '50', MAX_ANIM_SECONDS: '4.5' }, '.')
    expect(o.maxFrames).toBe(50)
    expect(o.maxAnimSeconds).toBe(4.5)
  })

  it('PSD の MAX_RENDERS は既定32、最小2の安全な整数', () => {
    expect(loadConfig({}, '.').maxRenders).toBe(32)
    expect(loadConfig({ MAX_RENDERS: '2' }, '.').maxRenders).toBe(2)
    for (const value of ['1', '2.5', '9007199254740992', 'invalid']) {
      expect(() => loadConfig({ MAX_RENDERS: value }, '.')).toThrow(/MAX_RENDERS/)
    }
  })
})
