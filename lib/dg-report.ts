export type DgDailyPnl = { value: number; day: string; updatedAt: number };

export function dgReportDay(now = Date.now()) {
  return new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// The native report echoes list. Its UI uses page size 12; our read-only
// all-lobby/all-game query uses 11 to distinguish its replies from UI queries.
export const DG_PNL_REPORT_LIST = ["", "", "11", "1"];
export function isDgPnlReply(bean: any) {
  return bean?.cmd === 13 && bean?.type === 1 &&
    Array.isArray(bean.list) && bean.list.length === 4 &&
    bean.list.every((v: unknown, i: number) => v === DG_PNL_REPORT_LIST[i]);
}

export function parseDgDailyPnl(bean: any, requestDay: string, now = Date.now()): DgDailyPnl | null {
  if (bean?.cmd !== 13 || bean?.type !== 1 || bean?.codeId !== 0 || requestDay !== dgReportDay(now)) return null;
  if (Number(bean.lobbyId ?? 0) !== 0 || Number(bean.tableId ?? 0) !== 0) return null;
  if (!Array.isArray(bean.dList) || bean.dList.length !== 3 || !bean.dList.every((n: unknown) => typeof n === "number" && Number.isFinite(n))) return null;
  try {
    const report = typeof bean.object === "string" ? JSON.parse(bean.object) : bean.object;
    if (!report || !Array.isArray(report.records)) return null;
  } catch { return null; }
  // Verified in DG's showTotal(e): e[0]=bets, e[1]=valid bets, e[2]=net win/loss.
  return { value: bean.dList[2], day: requestDay, updatedAt: now };
}

export function platformTodayPnl(platform: string, mt: number | null, dg: DgDailyPnl | null, now = Date.now()) {
  return platform === "DG" ? (dg?.day === dgReportDay(now) ? dg.value : null) : mt;
}
