import { describe, expect, it } from 'vitest'
import { createGate } from '../src/gate.ts'
import { CheckError } from '../src/types.ts'

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('createGate', () => {
  it('同時実行数が max を超えない', async () => {
    const gate = createGate(2, 1000)
    let active = 0
    let peak = 0
    const job = () =>
      gate.run(async () => {
        active++
        peak = Math.max(peak, active)
        await tick(15)
        active--
        return 1
      })
    const results = await Promise.all([job(), job(), job(), job(), job()])
    expect(results).toEqual([1, 1, 1, 1, 1])
    expect(peak).toBe(2)
  })

  it('待ちが timeoutMs を超えたら CheckError(busy)', async () => {
    const gate = createGate(1, 30)
    let release!: () => void
    const held = gate.run(() => new Promise<void>((r) => (release = r)))
    const err = await gate.run(async () => 1).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CheckError)
    expect((err as CheckError).kind).toBe('busy')
    release()
    await held
  })

  it('fn が投げてもスロットが解放される', async () => {
    const gate = createGate(1, 1000)
    await expect(gate.run(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    await expect(gate.run(async () => 7)).resolves.toBe(7)
  })

  it('実行中に signal が abort されたら fn が抜けてスロットが解放される', async () => {
    const gate = createGate(1, 1000)
    const ac = new AbortController()
    const running = gate.run(
      (): Promise<number> =>
        new Promise((_, reject) => ac.signal.addEventListener('abort', () => reject(new Error('aborted')))),
      ac.signal,
    )
    await tick(5)
    ac.abort()
    await expect(running).rejects.toThrow('aborted')
    await expect(gate.run(async () => 9)).resolves.toBe(9)
  })

  it('待ち中に abort されても待ち列に残らず、後続が通る', async () => {
    const gate = createGate(1, 1000)
    let release!: () => void
    const held = gate.run(() => new Promise<void>((r) => (release = r)))
    const ac = new AbortController()
    const waiting = gate.run(async () => 1, ac.signal)
    await tick(5)
    ac.abort()
    await expect(waiting).rejects.toBeDefined()
    release()
    await held
    await expect(gate.run(async () => 2)).resolves.toBe(2)
  })
})
