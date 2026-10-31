import { describe, it, expect } from 'vitest'
import { extractConfidencePercent } from '../../packages/biz-ui/src/components/suggestion-action'

/**
 * 建议池置信度：meta.plan.confidence 是 0~1，展示时 ×100 取整。
 * 这条测试同时是「不要误用 0~10 体系」的护栏 —— 顶层 confidence、越界值一律不采信。
 */
describe('extractConfidencePercent', () => {
  it('把 0~1 的真值换算成百分数', () => {
    expect(extractConfidencePercent({ plan: { confidence: 0.6 } })).toBe(60)
    expect(extractConfidencePercent({ plan: { confidence: 0.45 } })).toBe(45)
    expect(extractConfidencePercent({ plan: { confidence: 0.35 } })).toBe(35)
    expect(extractConfidencePercent({ plan: { confidence: 0.62 } })).toBe(62)
    expect(extractConfidencePercent({ plan: { confidence: 0.5 } })).toBe(50)
  })

  it('边界 0 和 1 都算有效值（不写死默认值）', () => {
    expect(extractConfidencePercent({ plan: { confidence: 0 } })).toBe(0)
    expect(extractConfidencePercent({ plan: { confidence: 1 } })).toBe(100)
  })

  it('四舍五入取整，不产生小数', () => {
    expect(extractConfidencePercent({ plan: { confidence: 0.456 } })).toBe(46)
    expect(extractConfidencePercent({ plan: { confidence: 0.581 } })).toBe(58)
  })

  it('缺字段一律返回 null —— 宁可不显示也不编造', () => {
    expect(extractConfidencePercent(undefined)).toBeNull()
    expect(extractConfidencePercent(null)).toBeNull()
    expect(extractConfidencePercent({})).toBeNull()
    expect(extractConfidencePercent({ plan: {} })).toBeNull()
    expect(extractConfidencePercent({ plan: null })).toBeNull()
  })

  it('不采信字符串（防止有人把 0~10 的 "5.0" 塞进来）', () => {
    expect(extractConfidencePercent({ plan: { confidence: '0.5' } })).toBeNull()
    expect(extractConfidencePercent({ plan: { confidence: '5.0' } })).toBeNull()
  })

  it('越界值返回 null（1.5 若当 0~1 会算出 150，必须挡掉）', () => {
    expect(extractConfidencePercent({ plan: { confidence: 1.5 } })).toBeNull()
    expect(extractConfidencePercent({ plan: { confidence: -0.1 } })).toBeNull()
    expect(extractConfidencePercent({ plan: { confidence: 12 } })).toBeNull()
  })

  it('NaN / Infinity 返回 null', () => {
    expect(extractConfidencePercent({ plan: { confidence: NaN } })).toBeNull()
    expect(extractConfidencePercent({ plan: { confidence: Infinity } })).toBeNull()
  })

  it('顶层 confidence（deep-analysis 的 0~10 体系）不被读取', () => {
    // 函数只认 meta.plan.confidence；顶层那个 5.0 属另一套量纲，混用会显示成 500
    expect(extractConfidencePercent({ confidence: 5.0 })).toBeNull()
    expect(extractConfidencePercent({ confidence: 0.6 })).toBeNull()
  })
})
