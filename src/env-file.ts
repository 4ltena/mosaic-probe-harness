import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import { assertKnownDetectKeys, dropBlank } from './config.ts'

// .env の読み取り。サーバーと評価 CLI の main() からだけ呼ぶ（loadConfig の中やモジュールの最上位では読まない）。
// 前半は純関数、末尾の readEnvFile / loadEnvFile だけが入出力を行う。値はどのエラーにも含めない。

const ENCODING_ERR = '.env の文字コードが不正です（UTF-8 で保存してください）'

/** 先頭の BOM（UTF-8・UTF-16 LE/BE）、NUL、UTF-8 として不正なバイト列を弾き、文字列にする。 */
export function decodeEnvBytes(buf: Uint8Array): string {
  const [a, b, c] = buf
  if ((a === 0xef && b === 0xbb && c === 0xbf) || (a === 0xff && b === 0xfe) || (a === 0xfe && b === 0xff)) {
    throw new Error(ENCODING_ERR)
  }
  if (buf.includes(0)) throw new Error(ENCODING_ERR)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    throw new Error(ENCODING_ERR)
  }
}

/** `util.parseEnv` で読む。 */
export function parseEnvText(text: string): Record<string, string> {
  return Object.fromEntries(Object.entries(parseEnv(text)).filter((e): e is [string, string] => e[1] !== undefined))
}

/**
 * ファイルの値と環境変数を重ねる（同じ名前なら環境変数が勝つ）。重ねる前に、双方から空（空白だけ）の値を除く。
 * upperKeys が真なら環境変数のキーを先に大文字にそろえる（Windows の process.env は大文字小文字を区別しないが、展開したオブジェクトは区別するため）。
 * 未知の DETECT_・STYLE_ の項目は、空の値を除く前に検査する（DETECT の値に関係なく止める）。
 */
export function mergeEnv(
  file: Record<string, string>,
  env: Record<string, string | undefined>,
  upperKeys: boolean,
): Record<string, string> {
  const e = upperKeys ? Object.fromEntries(Object.entries(env).map(([k, v]) => [k.toUpperCase(), v])) : env
  assertKnownDetectKeys([...Object.keys(file), ...Object.keys(e)])
  return { ...dropBlank(file), ...dropBlank(e) }
}

/** `.env` を読む。ファイルがなければ undefined。ほかの読み込みの失敗は、パスも値も出さずに止める。 */
export function readEnvFile(path: string): Record<string, string> | undefined {
  let buf: Buffer
  try {
    buf = readFileSync(path)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error('.env を読み込めません')
  }
  return parseEnvText(decodeEnvBytes(buf))
}

/** main() 用。`<cwd>/.env` と環境変数を重ねた設定を返す。process.env は書き換えない。 */
export function loadEnvFile(
  cwd: string = process.cwd(),
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  return mergeEnv(readEnvFile(join(cwd, '.env')) ?? {}, env, process.platform === 'win32')
}
