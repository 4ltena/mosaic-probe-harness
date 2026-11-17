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
