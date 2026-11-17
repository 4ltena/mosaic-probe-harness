import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultConfig } from '../src/config.ts'
import { createMcpHandler } from '../src/mcp.ts'
import { CheckError } from '../src/types.ts'

type Check = (bytes: Uint8Array, signal: AbortSignal) => Promise<number>

const servers: Server[] = []
const clients: Client[] = []

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => undefined)
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()))
})

/** ローカルの偽サーバーに /mcp を載せ、SDK の Client で接続する。 */
async function connect(check: Check): Promise<Client> {
  const handler = createMcpHandler(check, defaultConfig({ maxImageMb: 15 }))
  const server = createServer((req, res) => {
    if (req.url === '/mcp') {
      handler(req, res).catch(() => {
        if (!res.headersSent) res.statusCode = 500
        res.end()
      })
      return
    }
    res.statusCode = 404
    res.end()
  })
  servers.push(server)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const { port } = server.address() as AddressInfo
  const client = new Client({ name: 'mcp-test', version: '0.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)))
  clients.push(client)
  return client
}

function textOf(result: object): string {
  const first = (result as { content: { type: string; text?: string }[] }).content[0]
  expect(first?.type).toBe('text')
  return first?.text ?? ''
}

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const PNG_B64 = PNG_BYTES.toString('base64')

describe('mcp', () => {
  it('listTools に check_mosaic が出る', async () => {
    const client = await connect(async () => 0.5)
    const { tools } = await client.listTools()
    const tool = tools.find((t) => t.name === 'check_mosaic')
    expect(tool).toBeDefined()
    expect(JSON.stringify(tool?.inputSchema)).toContain('image_base64')
  })

  it('成功時は数値だけのテキストを返す', async () => {
    const client = await connect(async () => 0.25)
    const result = await client.callTool({ name: 'check_mosaic', arguments: { image_base64: PNG_B64 } })
    expect(result.isError).not.toBe(true)
    expect(result.content).toHaveLength(1)
    const value = Number(textOf(result))
    expect(Number.isFinite(value)).toBe(true)
    expect(value).toBe(0.25)
  })

  it('data: 接頭辞と改行つきの base64 を復号して check に渡す', async () => {
    let received: Uint8Array | undefined
    const client = await connect(async (bytes) => {
      received = bytes
      return 0.9
    })
    const wrapped = `data:image/png;base64,${PNG_B64.slice(0, 8)}\n${PNG_B64.slice(8)}`
    const result = await client.callTool({ name: 'check_mosaic', arguments: { image_base64: wrapped } })
    expect(result.isError).not.toBe(true)
    expect(Buffer.from(received ?? []).equals(PNG_BYTES)).toBe(true)
  })

  it('CheckError は isError になり、本文は数値として読めない', async () => {
    const client = await connect(async () => {
      throw new CheckError('vlm', 'upstream failed')
    })
    const result = await client.callTool({ name: 'check_mosaic', arguments: { image_base64: PNG_B64 } })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('vlm')
    expect(Number(textOf(result))).toBeNaN()
  })

  it('空・不正な base64 は isError で、check を呼ばない', async () => {
    let calls = 0
    const client = await connect(async () => {
      calls++
      return 0.5
    })
    for (const bad of ['', 'data:image/png;base64,', 'not*valid*base64!', 'abc$def']) {
      const result = await client.callTool({ name: 'check_mosaic', arguments: { image_base64: bad } })
      expect(result.isError).toBe(true)
    }
    expect(calls).toBe(0)
  })

  it('ステートレス: 同じクライアントで 2 回続けて呼べる', async () => {
    const client = await connect(async () => 0.7)
    const first = await client.callTool({ name: 'check_mosaic', arguments: { image_base64: PNG_B64 } })
    const second = await client.callTool({ name: 'check_mosaic', arguments: { image_base64: PNG_B64 } })
    expect(Number(textOf(first))).toBe(0.7)
    expect(Number(textOf(second))).toBe(0.7)
  })
})
