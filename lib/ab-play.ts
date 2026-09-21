/** 歐博進桌／離桌與「你坐的那桌開獎」判斷。不要拿大廳全桌推播當進桌。 */

export function abPlayTableUpdate(o: any): { join: string[]; leave: boolean } {
  const cmd = String(o?.c || o?.cmd || "");
  const p = o?.p && typeof o.p === "object" ? o.p : {};
  if (/leaveGameTable/i.test(cmd)) return { join: [], leave: true };
  if (!/enterGameTable/i.test(cmd)) return { join: [], leave: false };
  const join: string[] = [];
  const table = p.C && typeof p.C === "object" ? p.C : null;
  if (table) {
    if (table.BB != null && table.BB !== "") join.push(String(table.BB));
    if (table.AA != null && table.AA !== "") join.push(String(table.AA));
  }
  if (p.a != null && typeof p.a !== "object") join.push(String(p.a));
  return { join: [...new Set(join.filter(Boolean))], leave: false };
}

export function abSettleTableIds(o: any): string[] {
  const cmd = String(o?.c || o?.cmd || "");
  const p = o?.p && typeof o.p === "object" ? o.p : {};
  if (cmd === "pushGameTableResults")
    return [p.A, p.AA, p.BB].filter((v) => v != null && v !== "").map(String);
  if (cmd === "pushPayoutInfo")
    return [p.D, p.A, p.AA, p.BB].filter((v) => v != null && v !== "").map(String);
  return [];
}

export function abSeatedIdsMatch(seated: Iterable<string>, ids: Iterable<string>) {
  const have = new Set([...seated].map(String));
  if (!have.size) return false;
  for (const id of ids) if (have.has(String(id))) return true;
  return false;
}
