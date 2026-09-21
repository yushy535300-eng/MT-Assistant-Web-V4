import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { ensureWhitelistTables, getPool } from "./whitelist";

export type TrackerSession = { sessionId: string; platform: string; username: string };

const memory = new Map<string, TrackerSession>();
const filePath = path.resolve(process.cwd(), ".data", "tracker-sessions.json");

function userKey(platform: string, username: string) {
  return `${String(platform || "TZ").toUpperCase()}:${String(username || "").trim().toLowerCase()}`;
}

function persistFile() {
  try {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify([...memory.values()]));
  } catch {}
}

function restoreFile() {
  if (memory.size) return;
  try {
    const rows = JSON.parse(readFileSync(filePath, "utf8"));
    if (!Array.isArray(rows)) return;
    for (const row of rows) {
      if (!row?.sessionId || !row?.username) continue;
      remember({
        sessionId: String(row.sessionId),
        platform: String(row.platform || "TZ"),
        username: String(row.username),
      }, false);
    }
  } catch {}
}

function remember(session: TrackerSession, write = true) {
  memory.set(userKey(session.platform, session.username), session);
  if (write) persistFile();
}

restoreFile();

export function hasActiveTrackerSession(sessionId: string) {
  if (!sessionId) return false;
  restoreFile();
  for (const value of memory.values()) if (value.sessionId === sessionId) return true;
  return false;
}

export async function restoreTrackerSessions() {
  restoreFile();
  const db = getPool();
  if (!db) return;
  await ensureWhitelistTables();
  const result = await db.query(`SELECT session_id, platform, username FROM tracker_sessions`);
  for (const row of result.rows) {
    if (!row?.session_id || !row?.username) continue;
    remember({
      sessionId: String(row.session_id),
      platform: String(row.platform || "TZ"),
      username: String(row.username),
    }, false);
  }
  persistFile();
}

export async function findTrackerSessionByUser(platform: string, username: string): Promise<TrackerSession | null> {
  restoreFile();
  const key = userKey(platform, username);
  const mem = memory.get(key);
  if (mem) return mem;
  const db = getPool();
  if (!db) return null;
  await ensureWhitelistTables();
  const result = await db.query(
    `SELECT session_id, platform, username FROM tracker_sessions WHERE UPPER(platform)=UPPER($1) AND LOWER(username)=LOWER($2) LIMIT 1`,
    [platform, username],
  );
  const row = result.rows[0];
  if (!row) return null;
  const session = { sessionId: String(row.session_id), platform: String(row.platform), username: String(row.username) };
  remember(session, false);
  return session;
}

export async function saveTrackerSession(session: TrackerSession) {
  remember(session);
  const db = getPool();
  if (!db) return;
  await ensureWhitelistTables();
  await db.query(`DELETE FROM tracker_sessions WHERE UPPER(platform)=UPPER($1) AND LOWER(username)=LOWER($2)`, [
    session.platform,
    session.username,
  ]);
  await db.query(
    `INSERT INTO tracker_sessions (session_id, platform, username, updated_at) VALUES ($1,$2,$3,NOW())`,
    [session.sessionId, session.platform, session.username],
  );
}

export async function loadTrackerSession(sessionId: string): Promise<TrackerSession | null> {
  if (!sessionId) return null;
  for (const value of memory.values()) if (value.sessionId === sessionId) return value;
  const db = getPool();
  if (!db) return null;
  await ensureWhitelistTables();
  const result = await db.query(
    `SELECT session_id, platform, username FROM tracker_sessions WHERE session_id=$1 LIMIT 1`,
    [sessionId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const session = { sessionId: String(row.session_id), platform: String(row.platform), username: String(row.username) };
  remember(session);
  return session;
}

export async function deleteTrackerSession(sessionId: string) {
  for (const [key, value] of memory.entries()) {
    if (value.sessionId === sessionId) memory.delete(key);
  }
  persistFile();
  const db = getPool();
  if (!db) return;
  await ensureWhitelistTables();
  await db.query(`DELETE FROM tracker_sessions WHERE session_id=$1`, [sessionId]);
}

export async function requireTrackerSession(sessionId: string) {
  return !!(await loadTrackerSession(sessionId));
}
