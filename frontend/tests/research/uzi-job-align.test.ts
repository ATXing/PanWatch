import { describe, expect, it } from 'vitest'
import { isJobCardAligned } from '@panwatch/biz-ui/lib/uzi-job-align'

describe('isJobCardAligned（调研完成卡片 vs 当前报告）', () => {
  it('档位不同 ⇒ 不是同一次（lite 任务的 6/19 不能贴到 medium 报告的 15/19 旁边）', () => {
    expect(isJobCardAligned({ tier: 'lite', real_dims: 6 }, 'lite', 'medium', 15)).toBe(false)
  })

  it('档位相同但实测维度数不同 ⇒ 不是同一次', () => {
    expect(isJobCardAligned({ tier: 'medium', real_dims: 12 }, 'medium', 'medium', 15)).toBe(false)
  })

  it('档位与实测维度数都一致 ⇒ 是同一次，可以显示分数变化', () => {
    expect(isJobCardAligned({ tier: 'medium', real_dims: 15 }, 'medium', 'medium', 15)).toBe(true)
  })

  it('没有 job result（例如任务还在排队）⇒ 不做否定判断', () => {
    expect(isJobCardAligned(null, null, 'medium', 15)).toBe(true)
  })

  it('报告还没同步过（reportTier 为空）⇒ 不做否定判断', () => {
    expect(isJobCardAligned({ tier: 'medium', real_dims: 15 }, 'medium', undefined, undefined)).toBe(true)
  })

  it('result 里没有 tier 时回落到任务行的 tier', () => {
    expect(isJobCardAligned({ real_dims: 6 }, 'lite', 'medium', 15)).toBe(false)
    expect(isJobCardAligned({ real_dims: 6 }, 'medium', 'medium', 6)).toBe(true)
  })
})
