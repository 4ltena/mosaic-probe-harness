// DocBase の投稿を rules/docbase/ に取り込む。トークンは環境変数 DOCBASE_TOKEN からだけ読み、出力しない。
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_BASE_URL = 'https://api.docbase.io'
const ID_PATTERN = /^[A-Za-z0-9_-]+$/

interface DocbasePost {
  title?: unknown
  url?: unknown
  body?: unknown
}

/** 指定した投稿を取得して `{outDir}/{id}.md` に書き、書いたファイル名を返す。失敗時はそこで例外（それまでのファイルは残す）。 */
export async function syncRules(opts: {
  baseUrl?: string
  team: string
  token: string
  postIds: string[]
  outDir: string
}): Promise<string[]> {
  const base = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
  const written: string[] = []
  for (const id of opts.postIds) {
    if (!ID_PATTERN.test(id)) throw new Error(`投稿 ID が不正です: ${id}`)
    const url = `${base}/teams/${encodeURIComponent(opts.team)}/posts/${encodeURIComponent(id)}`
    let res: Response
    try {
      // リダイレクトは追わない（トークンを別ホストへ送らない）
      res = await fetch(url, {
        headers: { 'X-DocBaseToken': opts.token },
        redirect: 'manual',
        signal: AbortSignal.timeout(30_000),
      })
    } catch {
      throw new Error(`投稿 ${id} の取得に失敗しました（接続エラー）`)
    }
    if (res.status >= 300 && res.status < 400) throw new Error(`投稿 ${id}: リダイレクトは追いません（HTTP ${res.status}）`)
    if (!res.ok) throw new Error(`投稿 ${id}: 取得に失敗しました（HTTP ${res.status}）`)

    let post: DocbasePost | null
    try {
      post = (await res.json()) as DocbasePost | null
    } catch {
      throw new Error(`投稿 ${id}: 応答が JSON ではありません`)
    }
    // 本文が無い応答を空ファイルとして成功扱いにしない
    if (typeof post?.body !== 'string') throw new Error(`投稿 ${id}: 応答に body がありません`)
    const title = typeof post.title === 'string' ? post.title : id
    const postUrl = typeof post.url === 'string' ? post.url : ''
    const body = post.body
    const name = `${id}.md`

    await mkdir(opts.outDir, { recursive: true })
    await writeFile(join(opts.outDir, name), `# ${title}\n\n${postUrl}\n\n${body}\n`, 'utf8')
    written.push(name)
  }
  return written
}

async function main(): Promise<void> {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const token = process.env.DOCBASE_TOKEN
  if (!token) throw new Error('環境変数 DOCBASE_TOKEN が未設定です')
  const cfg = JSON.parse(await readFile(join(root, 'docbase.json'), 'utf8')) as { team?: unknown; postIds?: unknown }
  if (typeof cfg.team !== 'string' || !Array.isArray(cfg.postIds) || !cfg.postIds.every((x) => typeof x === 'string')) {
    throw new Error('docbase.json は {team: string, postIds: string[]} の形式が必要です')
  }
  const written = await syncRules({
    team: cfg.team,
    token,
    postIds: cfg.postIds,
    outDir: join(root, 'rules', 'docbase'),
  })
  console.log(`取得: ${written.length} 件 → rules/docbase/`)
  for (const name of written) console.log(`  ${name}`)
}

// テストから import されたときは実行しない
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : '不明なエラー')
    process.exitCode = 1
  })
}
