import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export type PersistedVendor = {
  sessionId: string;
  kind: "AB" | "DB";
  paused: boolean;
  gameUrl: string;
};

const filePath = path.resolve(process.cwd(), ".data", "vendor-runtime.json");
let rows = new Map<string, PersistedVendor>();
let loaded = false;

function keyOf(sessionId: string, kind: "AB" | "DB") {
  return `${sessionId}:${kind}`;
}

function write() {
  try {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify([...rows.values()]));
  } catch {}
}

export function loadPersistedVendors(): PersistedVendor[] {
  if (!loaded) {
    loaded = true;
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf8"));
      if (Array.isArray(parsed)) {
        for (const row of parsed) {
          if (!row?.sessionId || (row.kind !== "AB" && row.kind !== "DB")) continue;
          const next: PersistedVendor = {
            sessionId: String(row.sessionId),
            kind: row.kind,
            paused: !!row.paused,
            gameUrl: String(row.gameUrl || ""),
          };
          rows.set(keyOf(next.sessionId, next.kind), next);
        }
      }
    } catch {}
  }
  return [...rows.values()];
}

export function upsertPersistedVendor(row: PersistedVendor) {
  loadPersistedVendors();
  if (!row.sessionId || (row.kind !== "AB" && row.kind !== "DB")) return;
  rows.set(keyOf(row.sessionId, row.kind), {
    sessionId: row.sessionId,
    kind: row.kind,
    paused: !!row.paused,
    gameUrl: String(row.gameUrl || ""),
  });
  write();
}

export function removePersistedVendor(sessionId: string, kind?: "AB" | "DB") {
  loadPersistedVendors();
  let changed = false;
  for (const [key, row] of [...rows]) {
    if (row.sessionId !== sessionId) continue;
    if (kind && row.kind !== kind) continue;
    rows.delete(key);
    changed = true;
  }
  if (changed) write();
}
