// ツールの範囲（利用者の指示）を固定する。モデルに渡すのは自作の crop だけ。Pi の標準ツールは入れない。
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createFauxCore, fauxAssistantMessage, getCurrentTools, type TranscriptMessages } from '@earendil-works/pi-ai'
import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultConfig } from '../src/config.ts'
import { buildJudges } from '../src/vlm.ts'
import { createMcpHandler } from '../src/mcp.ts'
import { createRecheck, RECHECK_TOOL_NAMES } from '../src/recheck.ts'

const ROOT = resolve('.')
// 許可する Pi パッケージ（pi-ai と pi-agent-core だけ）
const ALLOWED_PI = new Set(['@earendil-works/pi-ai', '@earendil-works/pi-agent-core'])
// 禁止: コーディング用の標準ツールや UI・永続化の Pi パッケージ
const FORBIDDEN_DEP = /pi-coding-agent|pi-tui|chord|pi-durable/u

const servers: Server[] = []
const clients: Client[] = []
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => undefined)
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()))
})

describe('ツールの範囲（tool-scope）', () => {
  it('(a) faux provider でモデルに渡る文脈の tools は crop だけ', async () => {
    const faux = createFauxCore({})
    faux.setResponses([fauxAssistantMessage('完了')])
    const seen: { messages: TranscriptMessages }[] = []
    // 文脈を記録してから faux に渡す（モデルへ実際に渡る内容を見る）。
    // pi-agent-core は宣言を system メッセージの toolsAdded に載せるので、getCurrentTools で現在の宣言を読む。
    const streamFn = (model: unknown, context: unknown, opts?: object) => {
      seen.push(context as { messages: TranscriptMessages })
      return faux.streamSimple(model as never, context as never, opts as never)
    }
    const recheck = createRecheck(defaultConfig({ recheck: true }), {
      score: async () => 0.5,
      chat: { streamFn, model: faux.getModel() },
    })
    const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#808080' } }).png().toBuffer()
    await recheck(png, 0.8)
    expect(seen.length).toBeGreaterThan(0)
    const names = getCurrentTools(seen[0]?.messages ?? []).map((t) => t.name)
    expect(names).toEqual(['crop'])
    expect([...RECHECK_TOOL_NAMES]).toEqual(names)
  })

  it('(b) package.json の依存に、禁止された Pi パッケージが無い', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    const names = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]
    expect(names.filter((n) => FORBIDDEN_DEP.test(n))).toEqual([])
    expect(names.filter((n) => n.startsWith('@earendil-works/'))).toEqual(
      expect.arrayContaining(['@earendil-works/pi-ai', '@earendil-works/pi-agent-core']),
    )
  })

  it('(c) src・scripts・eval の import に、pi-ai と pi-agent-core 以外の Pi パッケージが無い', () => {
    const offenders: string[] = []
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const p = join(dir, name)
        return statSync(p).isDirectory() ? walk(p) : /\.[cm]?[jt]sx?$/u.test(name) ? [p] : []
      })
    for (const dir of ['src', 'scripts', 'eval']) {
      for (const file of walk(join(ROOT, dir))) {
        for (const m of readFileSync(file, 'utf8').matchAll(/['"](@earendil-works\/[^'"]+)['"]/gu)) {
          const spec = m[1]!
          const pkg = spec.split('/').slice(0, 2).join('/')
          if (!ALLOWED_PI.has(pkg)) offenders.push(`${file}: ${spec}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('(d) 偽 llama-server が受けた分類リクエストに tools が無い', async () => {
    const bodies: Record<string, unknown>[] = []
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = []
      for await (const c of req) chunks.push(c as Buffer)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      if (req.url === '/tokenize') {
        const piece = String(body.content)
        res.end(JSON.stringify({ tokens: [{ id: ['none', 'processed', 'forgot', 'nori'].indexOf(piece), piece }] }))
        return
      }
      bodies.push(body)
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({
          choices: [
            {
              message: { role: 'assistant', content: 'processed' },
              logprobs: {
                content: [
                  {
                    token: 'processed',
                    logprob: Math.log(0.9),
                    top_logprobs: [
                      { token: 'none', logprob: Math.log(0.05) },
                      { token: 'processed', logprob: Math.log(0.9) },
                      { token: 'forgot', logprob: Math.log(0.05) },
                    ],
                  },
                ],
              },
            },
          ],
        }),
      )
    })
    servers.push(server)
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const judges = buildJudges(
      defaultConfig({ vlmBaseUrls: [url], vlmModel: 'test-model', rulesPath: join(ROOT, 'rules.md'), vlmTimeoutMs: 5000 }),
    )
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#ffffff' } }).png().toBuffer()
    await judges[0]!.judge(png)
    expect(bodies.length).toBeGreaterThan(0)
    for (const b of bodies) {
      expect(b).not.toHaveProperty('tools')
      expect(b).not.toHaveProperty('tool_choice')
    }
  })

  it('(e) MCP の listTools は check_mosaic だけ', async () => {
    const handler = createMcpHandler(async () => 0.5, defaultConfig({ maxImageMb: 15 }))
    const server = createServer((req, res) => {
      handler(req, res).catch(() => {
        if (!res.headersSent) res.statusCode = 500
        res.end()
      })
    })
    servers.push(server)
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as AddressInfo).port
    const client = new Client({ name: 'tool-scope', version: '0.0.0' })
    clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/`)))
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual(['check_mosaic'])
  })
})
