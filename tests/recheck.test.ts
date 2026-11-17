import { describe, it, expect } from 'vitest'
import sharp from 'sharp'
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai'
import { defaultConfig } from '../src/config.ts'
import { createRecheck } from '../src/recheck.ts'
import type { ClassProbs } from '../src/types.ts'

// 400x300 の元画像（JPEG）。切り出しの短辺判定に十分な大きさ。
const jpegP = sharp({ create: { width: 400, height: 300, channels: 3, background: '#808080' } }).jpeg().toBuffer()

const probsOf = (ok: number): ClassProbs => ({ none: 0, ok, ng: 1 - ok })
const pOk = (p: ClassProbs) => p.ok

const crop = (id: string, x0: number, y0: number, x1: number, y1: number) =>
  fauxToolCall('crop', { x0, y0, x1, y1 }, { id })

/** 台本どおりに応答する偽のモデルと、呼ばれた judge の記録。judge の戻り ok 値は oks の順。 */
function setup(script: ReturnType<typeof fauxAssistantMessage>[], oks: number[]) {
  const faux = createFauxCore({})
  faux.setResponses(script)
  const judged: number[] = []
  const judge = async (_jpeg: Uint8Array): Promise<ClassProbs> => {
    const ok = oks[judged.length] ?? 0.5
    judged.push(ok)
    return probsOf(ok)
  }
  const chat = { streamFn: faux.streamSimple, model: faux.getModel() }
  return { chat, judge, judged }
}

describe('recheck（既定オフの再判定エージェント）', () => {
  it('2 回 crop を呼ぶ台本で、戻りは元の p と記録した p_ok の最小値になる', async () => {
    const { chat, judge, judged } = setup(
      [
        fauxAssistantMessage([crop('c1', 0, 0, 0.5, 0.5)], { stopReason: 'toolUse' }),
        fauxAssistantMessage([crop('c2', 0.5, 0.5, 1, 1)], { stopReason: 'toolUse' }),
        fauxAssistantMessage('完了'),
      ],
      [0.9, 0.3],
    )
    const recheck = createRecheck(defaultConfig({ recheck: true }), { judge, pOk, chat })
    const out = await recheck(await jpegP, 0.8)
    expect(judged).toHaveLength(2)
    expect(out).toBe(0.3)
  })

  it('crop を呼ばない台本では p のまま返る', async () => {
    const { chat, judge, judged } = setup([fauxAssistantMessage('完了')], [])
    const recheck = createRecheck(defaultConfig({ recheck: true }), { judge, pOk, chat })
    expect(await recheck(await jpegP, 0.8)).toBe(0.8)
    expect(judged).toHaveLength(0)
  })

  it('不正な座標・小さすぎる領域は例外にならず、judge も呼ばれない', async () => {
    const { chat, judge, judged } = setup(
      [
        // 逆順の座標（x0 > x1）
        fauxAssistantMessage([crop('c1', 0.6, 0, 0.5, 0.5)], { stopReason: 'toolUse' }),
        // 短辺が 32px 未満（400x300 の 1% は 4px 程度）
        fauxAssistantMessage([crop('c2', 0, 0, 0.01, 0.01)], { stopReason: 'toolUse' }),
        fauxAssistantMessage('完了'),
      ],
      [0.1, 0.1],
    )
    const recheck = createRecheck(defaultConfig({ recheck: true }), { judge, pOk, chat })
    await expect(recheck(await jpegP, 0.8)).resolves.toBe(0.8)
    expect(judged).toHaveLength(0)
  })

  it('上限（recheckMaxCrops=2）を超えた 3 回目以降の crop は judge を呼ばない', async () => {
    const { chat, judge, judged } = setup(
      [
        fauxAssistantMessage([crop('c1', 0, 0, 0.5, 0.5)], { stopReason: 'toolUse' }),
        fauxAssistantMessage([crop('c2', 0.5, 0.5, 1, 1)], { stopReason: 'toolUse' }),
        fauxAssistantMessage([crop('c3', 0, 0, 1, 1)], { stopReason: 'toolUse' }),
        fauxAssistantMessage('完了'),
      ],
      [0.9, 0.9, 0.1],
    )
    const recheck = createRecheck(defaultConfig({ recheck: true, recheckMaxCrops: 2 }), { judge, pOk, chat })
    const out = await recheck(await jpegP, 0.8)
    expect(judged).toHaveLength(2)
    expect(out).toBe(0.8)
  })

  it('エージェントが例外を投げたら、p を返す（数値を上げない）', async () => {
    const recheck = createRecheck(defaultConfig({ recheck: true }), {
      judge: async () => probsOf(0.5),
      pOk,
      chat: {
        streamFn: () => {
          throw new Error('boom')
        },
        model: createFauxCore({}).getModel(),
      },
    })
    await expect(recheck(await jpegP, 0.8)).resolves.toBe(0.8)
  })
})
