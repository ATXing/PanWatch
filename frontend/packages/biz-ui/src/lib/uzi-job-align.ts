/**
 * 「调研完成」卡片与当前报告是否同一次产出。
 *
 * 背景：卡片读的是 uzi_jobs 里最近一条任务的结果，报告读的是 uzi_reports
 * （由磁盘产出同步而来）。两条链路可以分叉——最典型的是直接跑 run.py 后点「仅同步」，
 * 这不会写 uzi_jobs 表，卡片就停在更早那次任务上。此时拿旧任务的分数与当前报告相减，
 * 会出现「62 → 60（6/19 维有实测）」这种跨记录的假变化：两个数字根本不是一件事。
 *
 * 判据：档位一致 + 实测维度数一致，才算同一次。任一信息缺失则不做否定判断（宁可绿卡）。
 */
export interface JobResultLike {
  tier?: string | null
  real_dims?: number | null
}

export function isJobCardAligned(
  jobResult: JobResultLike | null | undefined,
  jobTier: string | null | undefined,
  reportTier: string | null | undefined,
  reportRealDims: number | null | undefined
): boolean {
  if (!jobResult) return true
  if (!reportTier) return true
  const tier = jobResult.tier || jobTier || null
  if (tier && tier !== reportTier) return false
  if (jobResult.real_dims != null && reportRealDims != null && jobResult.real_dims !== reportRealDims) return false
  return true
}
