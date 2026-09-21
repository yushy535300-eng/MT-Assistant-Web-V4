/** MT「今日」跟官方投注報表一樣走台北曆日 00:00–24:00，不是把本地日期硬接 Z。 */
export function mtTodayReportRange(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const pick = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value || "";
  const day = `${pick("year")}-${pick("month")}-${pick("day")}`;
  return {
    begin_at: new Date(`${day}T00:00:00+08:00`).toISOString(),
    end_at: new Date(`${day}T23:59:59.000+08:00`).toISOString(),
  };
}
