/** 列表和模型选项共享同一请求时刻；未指定起始日期时保留全部历史。 */
export function recentGenerationQuery<T extends { dateFrom?: string; dateTo?: string }>(
  query: T,
  now: Date
): T & { dateFrom: string; dateTo: string } {
  const from = query.dateFrom ? new Date(query.dateFrom).getTime() : 0
  let to = query.dateTo ? new Date(query.dateTo).getTime() : now.getTime()
  if (query.dateTo && !query.dateTo.includes("T")) {
    const nextDay = new Date(query.dateTo)
    nextDay.setDate(nextDay.getDate() + 1)
    to = nextDay.getTime() - 1
  }
  return {
    ...query,
    dateFrom: new Date(from).toISOString(),
    dateTo: new Date(Math.min(now.getTime(), to)).toISOString(),
  }
}
