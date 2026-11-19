import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertKnownDetectKeys, assertSafeBind, defaultConfig, loadConfig } from '../src/config.ts'

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

describe('config: 空の値は未設定、DETECT（既定オフ）', () => {
  const MARK = 'LEAK-MARK-7'
  const on = { DETECT: '1', DETECT_ANIME_MODEL: 'models/a.onnx' }
  const message = (env: Record<string, string>): string => {
    try {
      loadConfig(env, '.')
    } catch (e) {
      return String(e)
    }
    return ''
  }

  it('MOSAIC_BIND= などの空の値は既定値になる（空白だけも同じ）', () => {
    const d = loadConfig({}, '.')
    const c = loadConfig({ MOSAIC_BIND: '', VLM_BASE_URL: '', VLM_MODEL: '  ', MOSAIC_LAYER_PATTERN: '' }, '.')
    expect(c.bind).toBe('127.0.0.1')
    expect(c.vlmBaseUrl).toBe(d.vlmBaseUrl)
    expect(c.vlmModel).toBe(d.vlmModel)
    expect(c.layerPattern).toBe(d.layerPattern)
  })

  it('既定はオフで、検出器も分類器もない', () => {
    const c = loadConfig({}, '.')
    expect(c.detect).toBe(false)
    expect(c.detectAnime).toBeUndefined()
    expect(c.detectPhoto).toBeUndefined()
    expect(c.style).toBeUndefined()
    expect(defaultConfig().detect).toBe(false)
    expect(loadConfig({ DETECT: '' }, '.').detect).toBe(false)
    expect(loadConfig({ DETECT: '0' }, '.').detect).toBe(false)
  })

  it('DETECT は空・0・1 だけ。true などは変数名を示して止まり、値は出さない', () => {
    expect(loadConfig({ ...on }, '.').detect).toBe(true)
    expect(() => loadConfig({ DETECT: 'true' }, '.')).toThrow(/DETECT/)
    for (const v of ['true', '2', MARK]) {
      const m = message({ DETECT: v })
      expect(m).toContain('DETECT')
      expect(m).not.toContain(v)
    }
  })

  it('DETECT=0 なら、DETECT_* と STYLE_* の不正な値は検査しない', () => {
    const c = loadConfig({ DETECT: '0', DETECT_IOU: '9', STYLE_REAL_LO: 'x', DETECT_ANIME_RESIZE: 'q', STYLE_MODEL: 'm' }, '.')
    expect(c.detect).toBe(false)
    expect(c.style).toBeUndefined()
  })

  it('有効時の既定値。モデルのパスは resolve（相対はルートから、絶対はそのまま）', () => {
    const c = loadConfig({ ...on, DETECT_PHOTO_MODEL: resolve('/abs/p.onnx'), STYLE_MODEL: 's.onnx' }, '/root')
    expect(c.detectAnime).toEqual({
      model: resolve('/root', 'models/a.onnx'),
      sha256: undefined,
      labels: undefined,
      classes: ['penis', 'pussy'],
      threshold: 0.3,
      resize: 'stretch',
    })
    expect(c.detectPhoto).toEqual({
      model: resolve('/abs/p.onnx'),
      sha256: undefined,
      labels: undefined,
      classes: ['penis', 'vagina', 'anus'],
      threshold: 0.3,
      resize: 'letterbox',
    })
    expect(c.style).toEqual({
      model: resolve('/root', 's.onnx'),
      sha256: undefined,
      labels: ['anime', 'real'],
      realLo: 0.2,
      realHi: 0.8,
    })
    expect([c.detectMaxCrops, c.detectMargin, c.detectMinSide, c.detectIou, c.detectThreads]).toEqual([4, 0.5, 256, 0.7, 2])
  })

  it('全項目を環境変数で変えられる（SHA-256 は小文字にそろう）', () => {
    const sha = 'AB'.repeat(32)
    const c = loadConfig(
      {
        ...on,
        DETECT_ANIME_SHA256: sha,
        DETECT_ANIME_LABELS: 'a, b,c',
        DETECT_ANIME_CLASSES: 'a,b',
        DETECT_ANIME_THRESHOLD: '1',
        DETECT_ANIME_RESIZE: 'pad',
        DETECT_PHOTO_MODEL: 'p.onnx',
        DETECT_PHOTO_CLASSES: 'x',
        DETECT_PHOTO_THRESHOLD: '0.5',
        DETECT_PHOTO_RESIZE: 'stretch',
        STYLE_MODEL: 's.onnx',
        STYLE_SHA256: sha,
        STYLE_LABELS: 'real,anime',
        STYLE_REAL_LO: '0',
        STYLE_REAL_HI: '1',
        DETECT_MAX_CROPS: '32',
        DETECT_MARGIN: '4',
        DETECT_MIN_SIDE: '2048',
        DETECT_IOU: '1',
        DETECT_THREADS: '64',
      },
      '.',
    )
    expect(c.detectAnime).toMatchObject({
      sha256: sha.toLowerCase(), labels: ['a', 'b', 'c'], classes: ['a', 'b'], threshold: 1, resize: 'pad',
    })
    expect(c.detectPhoto).toMatchObject({ classes: ['x'], threshold: 0.5, resize: 'stretch' })
    expect(c.style).toMatchObject({ sha256: sha.toLowerCase(), labels: ['real', 'anime'], realLo: 0, realHi: 1 })
    expect([c.detectMaxCrops, c.detectMargin, c.detectMinSide, c.detectIou, c.detectThreads]).toEqual([32, 4, 2048, 1, 64])
  })

  it('不正な値は変数名を示して止まり、値は出さない', () => {
    const two = { ...on, DETECT_PHOTO_MODEL: 'p.onnx', STYLE_MODEL: 's.onnx' }
    // 値に目印を含めて、メッセージに出ないことを確かめる（数値の外れは目印を足せないので、値そのものを見る）
    const bad: [string, string][] = [
      ['DETECT_ANIME_SHA256', MARK],
      ['DETECT_ANIME_SHA256', 'ab'.repeat(31)],
      ['DETECT_ANIME_LABELS', ' , '],
      ['DETECT_ANIME_CLASSES', ' , '],
      ['DETECT_ANIME_CLASSES', `${MARK},${MARK}`],
      ['DETECT_ANIME_THRESHOLD', '0'],
      ['DETECT_ANIME_THRESHOLD', '1.5'],
      ['DETECT_ANIME_THRESHOLD', MARK],
      ['DETECT_ANIME_RESIZE', MARK],
      ['DETECT_PHOTO_SHA256', MARK],
      ['DETECT_PHOTO_CLASSES', `${MARK},${MARK}`],
      ['DETECT_PHOTO_THRESHOLD', '-0.1'],
      ['DETECT_PHOTO_RESIZE', MARK],
      ['STYLE_SHA256', MARK],
      ['STYLE_LABELS', `anime,${MARK}`],
      ['STYLE_REAL_LO', '-0.1'],
      ['STYLE_REAL_HI', '1.1'],
      ['STYLE_REAL_HI', MARK],
      ['DETECT_MAX_CROPS', '0'],
      ['DETECT_MAX_CROPS', '33'],
      ['DETECT_MAX_CROPS', '1.5'],
      ['DETECT_MARGIN', '4.1'],
      ['DETECT_MARGIN', MARK],
      ['DETECT_MIN_SIDE', '0'],
      ['DETECT_MIN_SIDE', '2.5'],
      ['DETECT_IOU', '0'],
      ['DETECT_IOU', '1.1'],
      ['DETECT_THREADS', '0'],
      ['DETECT_THREADS', '65'],
      ['DETECT_THREADS', MARK],
    ]
    for (const [key, value] of bad) {
      const m = message({ ...two, [key]: value })
      expect(m, `${key}=${value}`).toContain(key)
      if (value.trim() !== ',') expect(m, `${key}=${value}`).not.toContain(value)
    }
  })

  it('MODEL のパスの値もエラーに出さない', () => {
    const m = message({ DETECT: '1', DETECT_ANIME_MODEL: `${MARK}/a.onnx`, STYLE_MODEL: `${MARK}/s.onnx` })
    expect(m).toContain('STYLE_MODEL')
    expect(m).not.toContain(MARK)
  })

  it('STYLE_REAL_LO は STYLE_REAL_HI より小さい必要がある', () => {
    expect(() => loadConfig({ ...on, STYLE_REAL_LO: '0.5', STYLE_REAL_HI: '0.5' }, '.')).toThrow(/STYLE_REAL_LO/)
    expect(() => loadConfig({ ...on, STYLE_REAL_LO: '0.9' }, '.')).toThrow(/STYLE_REAL_LO/)
  })

  it('検出器の数と STYLE_MODEL の組み合わせ', () => {
    expect(() => loadConfig({ DETECT: '1' }, '.')).toThrow(/DETECT_ANIME_MODEL/)
    expect(() => loadConfig({ ...on, DETECT_PHOTO_MODEL: 'p.onnx' }, '.')).toThrow(/STYLE_MODEL/)
    expect(() => loadConfig({ ...on, STYLE_MODEL: 's.onnx' }, '.')).toThrow(/STYLE_MODEL/)
    expect(loadConfig({ DETECT: '1', DETECT_PHOTO_MODEL: 'p.onnx' }, '.').detectAnime).toBeUndefined()
    expect(loadConfig({ ...on, DETECT_PHOTO_MODEL: 'p.onnx', STYLE_MODEL: 's.onnx' }, '.').style).toBeDefined()
  })

  it('DETECT_MIN_SIDE は MAX_EDGE 以下', () => {
    expect(loadConfig({ ...on, MAX_EDGE: '512', DETECT_MIN_SIDE: '512' }, '.').detectMinSide).toBe(512)
    expect(() => loadConfig({ ...on, MAX_EDGE: '512', DETECT_MIN_SIDE: '513' }, '.')).toThrow(/DETECT_MIN_SIDE/)
  })

  it('空の DETECT_* は未設定として既定値になる', () => {
    const c = loadConfig({ ...on, DETECT_IOU: '', DETECT_ANIME_CLASSES: '  ', STYLE_REAL_LO: '' }, '.')
    expect(c.detectIou).toBe(0.7)
    expect(c.detectAnime?.classes).toEqual(['penis', 'pussy'])
    expect(c.style).toBeUndefined()
  })

  it('未知の DETECT_* / STYLE_* の項目は変数名を示して止まる（loadConfig 自身は検査しない）', () => {
    expect(() => assertKnownDetectKeys(['DETECT', 'STYLE_MODEL', 'VLM_MODEL'])).not.toThrow()
    expect(() => assertKnownDetectKeys(['DETECT_ANIME_THRESHLD'])).toThrow(/DETECT_ANIME_THRESHLD/)
    expect(() => assertKnownDetectKeys(['STYLE_X'])).toThrow(/STYLE_X/)
    expect(() => assertKnownDetectKeys(['detect_anime_model'])).toThrow(/detect_anime_model/)
    expect(loadConfig({ DETECT_X: '1' }, '.').detect).toBe(false)
  })
})
