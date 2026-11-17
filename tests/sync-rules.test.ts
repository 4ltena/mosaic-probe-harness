import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { syncRules } from '../scripts/sync-rules.ts'

const TOKEN = 'test-token-XYZ-123'

interface Seen {
  path: string
  token: string | undefined
}

// 偽の DocBase サーバー。投稿 ID ごとに応答を決める。
function startFake(
  respond: (id: string, res: ServerResponse, token: string | undefined) => void,
  seen: Seen[] = [],
): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = req.url ?? ''
    const token = req.headers['x-docbasetoken'] as string | undefined
    seen.push({ path, token })
    const m = /\/posts\/([^/?]+)$/.exec(path)
    const id = m?.[1] ?? ''
    respond(id, res, token)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (addr === null || typeof addr === 'string') throw new Error('address')
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` })
    })
  })
}

const okPost = (id: string, res: ServerResponse): void => {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(
    JSON.stringify({
      id: Number(id),
      title: `タイトル ${id}`,
      url: `https://team.example.test/posts/${id}`,
      body: `本文 ${id}\n\n- モザイク層の基準`,
    }),
  )
}

describe('syncRules', () => {
  let dir: string
  let server: Server | undefined

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sync-rules-'))
  })

  afterEach(async () => {
    if (server) {
      await new Promise<void>((r) => server!.close(() => r()))
      server = undefined
    }
    await rm(dir, { recursive: true, force: true })
  })

  it('X-DocBaseToken を付けて投稿を取得し、タイトル・URL・本文を書く', async () => {
    const seen: Seen[] = []
    const fake = await startFake(okPost, seen)
    server = fake.server
    const outDir = join(dir, 'out')

    const written = await syncRules({ baseUrl: fake.baseUrl, team: 'team', token: TOKEN, postIds: ['11'], outDir })

    expect(written).toEqual(['11.md'])
    expect(seen).toHaveLength(1)
    expect(seen[0]?.path).toBe('/teams/team/posts/11')
    expect(seen[0]?.token).toBe(TOKEN)

    const text = await readFile(join(outDir, '11.md'), 'utf8')
    expect(text.startsWith('# タイトル 11')).toBe(true)
    expect(text).toContain('https://team.example.test/posts/11')
    expect(text).toContain('本文 11')
    expect(text).toContain('- モザイク層の基準')
  })

  it('出力・例外メッセージ・書いたファイルにトークンが含まれない', async () => {
    const fake = await startFake((id, res, token) => {
      if (id === '2') {
        // 404 の本文に受け取ったトークンを載せ、エラー経路で漏れないことを確かめる
        res.writeHead(404)
        res.end(`not found ${token}`)
        return
      }
      okPost(id, res)
    })
    server = fake.server
    const outDir = join(dir, 'out')

    let message = ''
    try {
      await syncRules({ baseUrl: fake.baseUrl, team: 'team', token: TOKEN, postIds: ['1', '2'], outDir })
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).not.toBe('')
    expect(message).not.toContain(TOKEN)

    const names = await readdir(outDir)
    for (const n of names) {
      expect(await readFile(join(outDir, n), 'utf8')).not.toContain(TOKEN)
    }

    // 成功時も同様
    const ok = await syncRules({ baseUrl: fake.baseUrl, team: 'team', token: TOKEN, postIds: ['3'], outDir: join(dir, 'ok') })
    expect(ok).toEqual(['3.md'])
    expect(await readFile(join(dir, 'ok', '3.md'), 'utf8')).not.toContain(TOKEN)
  })

  it('401 は例外で、ファイルを書かない', async () => {
    const fake = await startFake((_id, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end('{"error":"unauthorized"}')
    })
    server = fake.server
    const outDir = join(dir, 'out')

    await expect(
      syncRules({ baseUrl: fake.baseUrl, team: 'team', token: TOKEN, postIds: ['5'], outDir }),
    ).rejects.toThrow(/5/)
    await expect(readdir(outDir)).rejects.toThrow()
  })

  it('404 は例外で、ファイルを書かない', async () => {
    const fake = await startFake((_id, res) => {
      res.writeHead(404)
      res.end()
    })
    server = fake.server
    const outDir = join(dir, 'out')

    await expect(
      syncRules({ baseUrl: fake.baseUrl, team: 'team', token: TOKEN, postIds: ['6'], outDir }),
    ).rejects.toThrow(/6/)
    await expect(readdir(outDir)).rejects.toThrow()
  })

  it('リダイレクトは追わず、例外にし、ファイルを書かない', async () => {
    const seen: Seen[] = []
    const fake = await startFake((id, res) => {
      if (id === '7') {
        // 同じ偽サーバーの /leak へ誘導する。追えば seen が増える
        res.writeHead(302, { Location: '/leak' })
        res.end()
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('leaked')
    }, seen)
    server = fake.server
    const outDir = join(dir, 'out')

    let caught: Error | undefined
    try {
      await syncRules({ baseUrl: fake.baseUrl, team: 'team', token: TOKEN, postIds: ['7'], outDir })
    } catch (e) {
      caught = e as Error
    }
    // 接続エラーではなく、リダイレクトとして例外になっていること
    expect(caught?.message).toContain('投稿 7')
    expect(caught?.message).toContain('HTTP 302')
    // /leak には行っていない（要求は投稿パスへの 1 回だけ、トークン付き）
    expect(seen).toEqual([{ path: '/teams/team/posts/7', token: TOKEN }])
    await expect(readdir(outDir)).rejects.toThrow()
  })

  it('body が無い 200 応答は例外にし、ファイルを書かない', async () => {
    const fake = await startFake((id, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ id: Number(id), title: 'x', url: 'y' }))
    })
    server = fake.server
    const outDir = join(dir, 'out')

    await expect(
      syncRules({ baseUrl: fake.baseUrl, team: 'team', token: TOKEN, postIds: ['8'], outDir }),
    ).rejects.toThrow('投稿 8: 応答に body がありません')
    await expect(readdir(outDir)).rejects.toThrow()
  })

  it('JSON でない 200 応答は、ID を含む例外にする', async () => {
    const fake = await startFake((_id, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<html>maintenance</html>')
    })
    server = fake.server
    const outDir = join(dir, 'out')

    await expect(
      syncRules({ baseUrl: fake.baseUrl, team: 'team', token: TOKEN, postIds: ['9'], outDir }),
    ).rejects.toThrow('投稿 9: 応答が JSON ではありません')
    await expect(readdir(outDir)).rejects.toThrow()
  })

  it('途中の 1 件が失敗しても、それまでのファイルは消さず、例外に失敗した ID を含める', async () => {
    const fake = await startFake((id, res) => {
      if (id === 'bad') {
        res.writeHead(404)
        res.end()
        return
      }
      okPost(id, res)
    })
    server = fake.server
    const outDir = join(dir, 'out')

    let caught: Error | undefined
    try {
      await syncRules({ baseUrl: fake.baseUrl, team: 'team', token: TOKEN, postIds: ['21', 'bad', '23'], outDir })
    } catch (e) {
      caught = e as Error
    }
    expect(caught).toBeDefined()
    expect(caught!.message).toContain('bad')

    // 最初の 1 件は残り、失敗より後の 1 件は書かれない
    expect(await readFile(join(outDir, '21.md'), 'utf8')).toContain('本文 21')
    const names = await readdir(outDir)
    expect(names).toEqual(['21.md'])
  })
})
