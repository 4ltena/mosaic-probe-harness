import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../src/config.ts'
import { decodeEnvBytes, loadEnvFile, mergeEnv, parseEnvText, readEnvFile } from '../src/env-file.ts'

const MARK = 'LEAK-MARK-9'
const ENC = /文字コードが不正/

describe('env-file: 純関数', () => {
  it('UTF-8（日本語を含む）は読める', () => {
    expect(decodeEnvBytes(Buffer.from('A=モザイク\n', 'utf8'))).toBe('A=モザイク\n')
  })

  it('BOM（UTF-8・UTF-16 LE/BE）・NUL・CP932 は、文字コードが不正として止まる', () => {
    const bad: Record<string, Uint8Array> = {
      'UTF-8 BOM': Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('A=1\n')]),
      'UTF-16 LE BOM': Buffer.from([0xff, 0xfe, 0x41, 0x00]),
      'UTF-16 BE BOM': Buffer.from([0xfe, 0xff, 0x00, 0x41]),
      NUL: Buffer.from('A=1\0\n'),
      // 「モザイク」の CP932（Shift_JIS）
      CP932: Buffer.concat([Buffer.from('A='), Buffer.from([0x83, 0x82, 0x83, 0x55, 0x83, 0x43, 0x83, 0x4e]), Buffer.from('\n')]),
    }
    for (const [name, buf] of Object.entries(bad)) expect(() => decodeEnvBytes(buf), name).toThrow(ENC)
  })

  it('引用符つきの JSON（JUDGES）が読める', () => {
    const judges = '[{"name":"a","model":"m1","urls":["http://127.0.0.1:8080"],"slots":2}]'
    const parsed = parseEnvText(`JUDGES='${judges}'\nVLM_MODEL=x # コメント\n`)
    expect(parsed.JUDGES).toBe(judges)
    expect(loadConfig(parsed, '.').judges).toEqual([
      { name: 'a', model: 'm1', urls: ['http://127.0.0.1:8080'], slots: 2, weight: 1 },
    ])
    expect(parsed.VLM_MODEL).toBe('x')
  })

  it('mergeEnv: 環境変数が勝つ。環境変数が空ならファイルの値が効く。ファイルの空の値は除かれる', () => {
    const m = mergeEnv(
      { A: 'file', B: 'file', C: '', D: '   ' },
      { A: 'env', B: '', C: 'env', E: undefined },
      false,
    )
    expect(m).toEqual({ A: 'env', B: 'file', C: 'env' })
  })

  it('mergeEnv: Windows ではキーを大文字にそろえてから重ねる', () => {
    expect(mergeEnv({ VLM_MODEL: 'file' }, { vlm_model: 'env', Path: 'p' }, true)).toEqual({ VLM_MODEL: 'env', PATH: 'p' })
    expect(mergeEnv({ VLM_MODEL: 'file' }, { vlm_model: '' }, true)).toEqual({ VLM_MODEL: 'file' })
    // 大文字にそろえない環境では、別の名前のまま
    expect(mergeEnv({}, { vlm_model: 'env' }, false)).toEqual({ vlm_model: 'env' })
  })

  it('mergeEnv: 未知の DETECT_・STYLE_ の項目は、DETECT=0 でも変数名を示して止まる（空の値でも）', () => {
    expect(() => mergeEnv({ DETECT_X: '1' }, { DETECT: '0' }, false)).toThrow(/DETECT_X/)
    expect(() => mergeEnv({}, { STYLE_REAL_LOW: '' }, false)).toThrow(/STYLE_REAL_LOW/)
    expect(() => mergeEnv({ detect_anime_model: 'x' }, {}, false)).toThrow(/detect_anime_model/)
    expect(() => mergeEnv({ DETECT: '1', DETECT_IOU: '0.5', STYLE_MODEL: 's' }, {}, false)).not.toThrow()
  })

  it('mergeEnv: 未知の項目のエラーに値を含めない', () => {
    let message = ''
    try {
      mergeEnv({ DETECT_X: MARK }, {}, false)
    } catch (e) {
      message = String(e)
    }
    expect(message).toContain('DETECT_X')
    expect(message).not.toContain(MARK)
  })
})

describe('env-file: ファイルの入出力', () => {
  let dir = ''
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'env-file-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })
  const write = (body: string | Uint8Array): void => writeFileSync(join(dir, '.env'), body)

  it('ファイルがなければ何もしない（環境変数だけ）', () => {
    expect(readEnvFile(join(dir, '.env'))).toBeUndefined()
    expect(loadEnvFile(dir, { VLM_MODEL: 'env', EMPTY: '' })).toEqual({ VLM_MODEL: 'env' })
  })

  it('ファイルだけにある値が効く', () => {
    write('VLM_MODEL=file\nMOSAIC_PORT=9000\n')
    const cfg = loadConfig(loadEnvFile(dir, {}), dir)
    expect(cfg.vlmModel).toBe('file')
    expect(cfg.port).toBe(9000)
  })

  it('ファイルと環境変数の両方にあれば環境変数が勝つ。空の環境変数はファイルの値を消さない', () => {
    write('VLM_MODEL=file\nMOSAIC_PORT=9000\nMOSAIC_BIND=\n')
    const cfg = loadConfig(loadEnvFile(dir, { VLM_MODEL: 'env', MOSAIC_PORT: '' }), dir)
    expect(cfg.vlmModel).toBe('env')
    expect(cfg.port).toBe(9000)
    expect(cfg.bind).toBe('127.0.0.1')
  })

  it('process.env は書き換えない', () => {
    write('ENV_FILE_TEST_ONLY_KEY=1\n')
    loadEnvFile(dir)
    expect(process.env.ENV_FILE_TEST_ONLY_KEY).toBeUndefined()
  })

  it('BOM・NUL・CP932 のファイルは止まり、パスも値も出さない', () => {
    const files: Uint8Array[] = [
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`A=${MARK}\n`)]),
      Buffer.from(`A=${MARK}\0\n`),
      Buffer.concat([Buffer.from(`A=${MARK}\nB=`), Buffer.from([0x83, 0x82, 0x83, 0x55, 0x83, 0x43, 0x83, 0x4e]), Buffer.from('\n')]),
    ]
    for (const f of files) {
      write(f)
      let message = ''
      try {
        loadEnvFile(dir, {})
      } catch (e) {
        message = String(e)
      }
      expect(message).toMatch(ENC)
      expect(message).not.toContain(MARK)
      expect(message).not.toContain(dir)
    }
  })

  it('未知の DETECT_X がファイルにあれば、DETECT=0 でも止まる', () => {
    write('DETECT=0\nDETECT_X=1\n')
    expect(() => loadEnvFile(dir, {})).toThrow(/DETECT_X/)
  })

  it('読み込みに失敗（.env がディレクトリ）したら、パスを出さずに止まる', () => {
    mkdirSync(join(dir, '.env'))
    let message = ''
    try {
      loadEnvFile(dir, {})
    } catch (e) {
      message = String(e)
    }
    expect(message).toContain('.env')
    expect(message).not.toContain(dir)
  })
})

describe('.env.example', () => {
  const text = readFileSync(new URL('../.env.example', import.meta.url), 'utf8')
  const example = parseEnvText(text)

  it('キー 2 つは空', () => {
    expect(example.VLM_API_KEY).toBe('')
    expect(example.MOSAIC_API_KEY).toBe('')
  })

  it('そのまま読み込むと、既定の設定と同じになる（未知の項目もない）', () => {
    expect(loadConfig(mergeEnv(example, {}, false), '.')).toEqual(loadConfig({}, '.'))
  })

  it('既存の項目と新しい項目のすべてが載っている（コメントアウトも含む）', () => {
    const listed = new Set([...text.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gmu)].map((m) => m[1]))
    const src = readFileSync(new URL('../src/config.ts', import.meta.url), 'utf8')
    const used = [...src.matchAll(/\benv\.([A-Z][A-Z0-9_]*)/gu)].map((m) => m[1]!)
    const detect = ['DETECT_ANIME', 'DETECT_PHOTO'].flatMap((p) =>
      ['MODEL', 'SHA256', 'LABELS', 'CLASSES', 'THRESHOLD', 'RESIZE'].map((k) => `${p}_${k}`),
    )
    const detectScalars = ['DETECT', 'STYLE_MODEL', 'STYLE_SHA256', 'STYLE_LABELS', 'STYLE_REAL_LO', 'STYLE_REAL_HI',
      'DETECT_MAX_CROPS', 'DETECT_MARGIN', 'DETECT_MIN_SIDE', 'DETECT_IOU', 'DETECT_THREADS']
    for (const k of [...used, ...detect, ...detectScalars]) expect(listed.has(k), k).toBe(true)
  })
})

describe('eval/run_eval.ts', () => {
  it('import しても main() は動かない', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const before = process.exitCode
    await import('../eval/run_eval.ts')
    expect(err).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(before)
    err.mockRestore()
  })
})
