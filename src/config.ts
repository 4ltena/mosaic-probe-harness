import { existsSync } from 'node:fs'
import { join } from 'node:path'

export interface Config {
  // --- llama.cpp (llama-server) ---
  /** 単一台の既定値（VLM_BASE_URL）。台の一覧は vlmBaseUrls を使う（VLM_BASE_URLS 未設定なら、これ 1 件）。 */
  vlmBaseUrl: string
  /** 判定サーバーの台（正規化済み: 末尾の / と /v1 を除き、重複を除く）。 */
  vlmBaseUrls: string[]
  /** 1 台あたりの同時実行数。llama-server の --parallel に合わせる。 */
  vlmSlotsPerBackend: number
  vlmModel: string
  vlmApiKey: string | undefined
  vlmTimeoutMs: number
  vlmExtraBody: Record<string, unknown>
  rulesPath: string
  temperature: number // 分類 logits を割る温度。1 より大きいと確率が柔らかくなる
  /** true なら nori（黒い帯・枠）を問題としない（ng でなく ok に数える）。既定 false（要確認として厳しく扱う）。 */
  noriAsOk: boolean
  // --- 画像 ---
  maxEdge: number
  maxImageMb: number
  maxPixels: number
  maxRenders: number
  layerPattern: string
  // --- 公開（LAN） ---
  bind: string
  port: number
  apiKey: string | undefined
  corsOrigins: string[] | '*'
  allowCidrs: string[]
  queueTimeoutMs: number
  // --- 再判定（Pi の agent。既定オフ） ---
  recheck: boolean
  recheckLo: number
  recheckHi: number
  recheckMaxCrops: number
  // --- 較正 ---
  calibrationPath: string
}

const num = (v: string | undefined, d: number): number => {
  if (v === undefined || v.trim() === '') return d
  const n = Number(v)
  if (!Number.isFinite(n)) throw new Error('数値でない環境変数があります（値は表示しません）')
  return n
}

const list = (v: string | undefined, d: string[]): string[] =>
  v === undefined || v.trim() === '' ? d : v.split(',').map((s) => s.trim()).filter(Boolean)

/** カンマ区切りの URL 列を正規化する（空要素・末尾の / と /v1・重複を除く）。 */
export function normalizeBaseUrls(raw: string): string[] {
  const out: string[] = []
  for (const s of raw.split(',')) {
    const u = s.trim().replace(/\/+$/u, '').replace(/\/v1$/u, '').replace(/\/+$/u, '')
    if (u !== '' && !out.includes(u)) out.push(u)
  }
  return out
}

export const DEFAULT_LAYER_PATTERN = 'モザイク|mosaic|pixel|ぼかし|blur|censor|修正|規制'
export const DEFAULT_ALLOW_CIDRS = ['127.0.0.0/8', '::1/128', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16']

export function isLoopbackBind(bind: string): boolean {
  return bind === '127.0.0.1' || bind === 'localhost' || bind === '::1'
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, root: string = process.cwd()): Config {
  let extra: Record<string, unknown> = {}
  if (env.VLM_EXTRA_BODY && env.VLM_EXTRA_BODY.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(env.VLM_EXTRA_BODY)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not object')
      extra = parsed as Record<string, unknown>
    } catch {
      throw new Error('VLM_EXTRA_BODY は JSON オブジェクトではありません（値は表示しません）')
    }
  }
  const local = join(root, 'rules.local.md')
  const apiKey = env.MOSAIC_API_KEY && env.MOSAIC_API_KEY !== '' ? env.MOSAIC_API_KEY : undefined
  const corsRaw = env.MOSAIC_CORS_ORIGINS?.trim()
  // 既定: キーが設定されているときだけ '*'（Bearer が守る）。キー無し（ループバック運用）では CORS を許可しない。
  const corsOrigins: string[] | '*' =
    corsRaw === undefined || corsRaw === '' ? (apiKey ? '*' : []) : corsRaw === '*' ? '*' : list(corsRaw, [])
  const vlmBaseUrl = env.VLM_BASE_URL ?? 'http://127.0.0.1:8080'
  const multi = normalizeBaseUrls(env.VLM_BASE_URLS ?? '')
  return {
    vlmBaseUrl,
    vlmBaseUrls: multi.length > 0 ? multi : normalizeBaseUrls(vlmBaseUrl),
    vlmSlotsPerBackend: Math.max(1, Math.floor(num(env.VLM_SLOTS_PER_BACKEND, 1))),
    vlmModel: env.VLM_MODEL ?? 'qwen3.8-flash-next',
    vlmApiKey: env.VLM_API_KEY && env.VLM_API_KEY !== '' ? env.VLM_API_KEY : undefined,
    vlmTimeoutMs: num(env.VLM_TIMEOUT_MS, 120_000),
    vlmExtraBody: extra,
    rulesPath: existsSync(local) ? local : join(root, 'rules.md'),
    temperature: num(env.CLASSIFY_TEMPERATURE, 1),
    noriAsOk: env.NORI_AS_OK === '1',
    maxEdge: num(env.MAX_EDGE, 2048),
    maxImageMb: num(env.MAX_IMAGE_MB, 15),
    maxPixels: num(env.MAX_PIXELS, 100_000_000),
    maxRenders: num(env.MAX_RENDERS, 8),
    layerPattern: env.MOSAIC_LAYER_PATTERN ?? DEFAULT_LAYER_PATTERN,
    bind: env.MOSAIC_BIND ?? '127.0.0.1',
    port: num(env.MOSAIC_PORT, 8790),
    apiKey,
    corsOrigins,
    allowCidrs: list(env.MOSAIC_ALLOW_CIDRS, DEFAULT_ALLOW_CIDRS),
    queueTimeoutMs: num(env.QUEUE_TIMEOUT_S, 60) * 1000,
    recheck: env.RECHECK === '1',
    recheckLo: num(env.RECHECK_LO, 0.2),
    recheckHi: num(env.RECHECK_HI, 0.9),
    recheckMaxCrops: num(env.RECHECK_MAX_CROPS, 3),
    calibrationPath: join(root, 'calibration.json'),
  }
}

/** ループバック以外に待ち受けるのにキーが無ければ、起動を拒否する。 */
export function assertSafeBind(cfg: Pick<Config, 'bind' | 'apiKey'>): void {
  if (!isLoopbackBind(cfg.bind) && !cfg.apiKey) {
    throw new Error('MOSAIC_BIND がループバック以外のときは MOSAIC_API_KEY が必須です')
  }
}

/** テスト用。環境変数を読まず、既定値に上書きだけ適用する。 */
export function defaultConfig(overrides: Partial<Config> = {}): Config {
  return { ...loadConfig({}, '.'), ...overrides }
}
