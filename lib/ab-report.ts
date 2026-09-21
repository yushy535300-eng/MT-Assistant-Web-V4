/** 歐博投注紀錄預設「今日」是台北 12:00 到隔日 12:00，不是午夜。 */
export function abReportWindow(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const pick = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value || "0";
  const y = pick("year");
  const m = pick("month");
  const d = pick("day");
  const h = Number(pick("hour"));
  let end = Date.parse(`${y}-${m}-${d}T12:00:00+08:00`);
  if (h >= 12) end += 24 * 60 * 60 * 1000;
  return { start: end - 24 * 60 * 60 * 1000, end };
}

export function abReportQueryRange(now = new Date()) {
  const { start, end } = abReportWindow(now);
  const fmt = (ms: number) => {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Taipei",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(new Date(ms));
    const pick = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((p) => p.type === type)?.value || "00";
    return `${pick("year")}-${pick("month")}-${pick("day")} ${pick("hour")}:${pick("minute")}:${pick("second")}`;
  };
  return { g: fmt(start), h: fmt(end) };
}

function num(value: any): number | null {
  if (value == null || value === "") return null;
  const n = Number(String(value).replace(/,/g, "").replace(/%/g, ""));
  return Number.isFinite(n) ? n : null;
}

function isBetLogRow(row: any) {
  return !!(
    row &&
    typeof row === "object" &&
    typeof row.GG === "string" &&
    /\d{4}-\d{2}-\d{2}/.test(row.GG) &&
    row.JJ != null &&
    row.II != null
  );
}

function betLogData(o: any) {
  const data = o?.data && typeof o.data === "object" ? o.data : o;
  if (!data || typeof data !== "object") return null;
  if (!Array.isArray(data.C)) return null;
  if (data.C.length && !data.C.every(isBetLogRow)) return null;
  return data;
}

export function abPnlFromPacket(o: any): number | null {
  const data = betLogData(o);
  if (!data) return null;
  const total = num(data.I) ?? num(data.M);
  if (total != null) return Math.round(total * 100) / 100;
  let sum = 0;
  for (const row of data.C) {
    const win = num(row.JJ);
    if (win == null) continue;
    sum += win;
  }
  return Math.round(sum * 100) / 100;
}
