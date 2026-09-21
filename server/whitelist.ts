import pg from "pg";

const { Pool } = pg;
let pool: pg.Pool | null = null;
let initialized = false;
const INITIAL_WHITELIST = ["sdfg56sd", "fqfq761126", "frank9026133", "a0928a", "s870053", "asd58678", "Hua80pp", "heheheh0", "0929785252", "ljt922", "aigste", "0966555961", "Miao9487", "sam828021", "a0970648", "fredapple83", "qi511", "coco51788", "0970259733", "aopop198611", "Aw2025", "zzz6118", "a2395057", "az5539856", "Lei875869", "zz1127", "sray0720", "a755160z", "jasony07", "d95637820", "ap93217", "xaing1028", "a0988773822", "Switch", "yuyun0417", "sks5120", "Amc564423", "Ray0715", "qqq19882001", "tt1026", "890906xx", "fgjxu1738", "f0983821969", "Kct103010", "Kai0119", "Doggo", "055512681", "ben910416", "moke88", "zx7417410", "Joe16588", "sheng1028", "k095695100", "lin11112222", "peterfus", "Remix1110", "win8899", "hugo38735028", "0919474047", "Qwer1234567", "Wu0817", "run970417", "bess86688", "EEE888", "Miyavi89", "Nien2003", "asd830901", "Zzyy1322", "0955552794", "z9601196", "Zz520776", "ean1029", "winnie927", "andybdm01", "hao0315", "shuai111", "Gtr6688", "Xiang0614", "hy9500", "kiss791111", "hp963508", "Aa950831", "Aa991203", "a0906733338", "Sheng5138", "yzlin818", "A42437", "zxc123456", "vn1128", "frank0518", "love0985441113", "Hwc25136792", "zzz930611", "love0985441114", "patrickph", "Fang0524", "Jin021", "Hsiao"];

export function getPool() {
  const url = String(process.env.DATABASE_URL || "").trim();
  if (!url) return null;
  if (!/^postgres(ql)?:\/\//i.test(url)) throw new Error("DATABASE_URL 必須使用 Render PostgreSQL 連線網址");
  if (!pool) pool = new Pool({ connectionString: url, ssl: url.includes("localhost") ? false : { rejectUnauthorized: false } });
  return pool;
}

export function whitelistEnabled() {
  return String(process.env.TZ_WHITELIST_ENABLED ?? "false").toLowerCase() === "true";
}

export async function ensureWhitelistTables() {
  const db = getPool();
  if (!db) return false;
  if (initialized) return true;
  await db.query(`CREATE TABLE IF NOT EXISTS tz_whitelist (
    id BIGSERIAL PRIMARY KEY,
    username VARCHAR(128) NOT NULL,
    platform VARCHAR(16) NOT NULL DEFAULT 'TZ',
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    expires_at TIMESTAMPTZ NULL,
    max_devices INTEGER NOT NULL DEFAULT 1,
    note VARCHAR(255) NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await db.query(`ALTER TABLE tz_whitelist ADD COLUMN IF NOT EXISTS platform VARCHAR(16) NOT NULL DEFAULT 'TZ'`);
  // 舊版本曾用「帳號本身」作唯一鍵；雙平台後必須改成「平台 + 帳號」。
  await db.query(`DROP INDEX IF EXISTS tz_whitelist_username_ci`);
  await db.query(`DROP INDEX IF EXISTS tz_whitelist_username_lower_idx`);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS tz_whitelist_platform_username_ci ON tz_whitelist (UPPER(platform), LOWER(username))`);
  await db.query(`CREATE TABLE IF NOT EXISTS mt_app_meta (
    meta_key VARCHAR(128) PRIMARY KEY,
    meta_value VARCHAR(255) NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS tracker_sessions (
    session_id VARCHAR(64) PRIMARY KEY,
    platform VARCHAR(16) NOT NULL,
    username VARCHAR(128) NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS tracker_sessions_platform_username_ci ON tracker_sessions (UPPER(platform), LOWER(username))`);

  const seed = await db.query(`SELECT meta_value FROM mt_app_meta WHERE meta_key=$1 LIMIT 1`, ["tz_whitelist_initial_seed_pg_v1"]);
  if (!seed.rowCount) {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      for (const username of INITIAL_WHITELIST) {
        await client.query(`INSERT INTO tz_whitelist (username, enabled, expires_at, max_devices, note)
          VALUES ($1,TRUE,NULL,1,$2) ON CONFLICT DO NOTHING`, [username, "第一批白名單"]);
      }
      await client.query(`INSERT INTO mt_app_meta (meta_key, meta_value) VALUES ($1,$2)
        ON CONFLICT (meta_key) DO UPDATE SET meta_value=EXCLUDED.meta_value, updated_at=NOW()`, ["tz_whitelist_initial_seed_pg_v1", String(INITIAL_WHITELIST.length)]);
      await client.query("COMMIT");
      console.log(`[MT Whitelist] PostgreSQL initial seed completed: ${INITIAL_WHITELIST.length} accounts`);
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally { client.release(); }
  }
  initialized = true;
  return true;
}

export async function authorizeWhitelist(usernameRaw: string, platformRaw = "TZ") {
  if (!whitelistEnabled()) return { allowed: true, reason: "whitelist_disabled" } as const;
  const db = getPool();
  if (!db) return { allowed: false, reason: "database_unavailable" } as const;
  await ensureWhitelistTables();
  const username = usernameRaw.trim();
  const platform = String(platformRaw || "TZ").trim().toUpperCase();
  const result = await db.query(`SELECT * FROM tz_whitelist WHERE UPPER(platform)=UPPER($1) AND LOWER(username)=LOWER($2) LIMIT 1`, [platform, username]);
  const row = result.rows[0];
  if (!row) return { allowed: false, reason: "not_whitelisted" } as const;
  if (!row.enabled) return { allowed: false, reason: "disabled" } as const;
  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) return { allowed: false, reason: "expired" } as const;
  return { allowed: true, reason: "ok" } as const;
}

export async function getWhitelistPlatform(usernameRaw:string) {
  if (!whitelistEnabled()) return { found:true, platform:"TZ", reason:"whitelist_disabled" } as const;
  const db=getPool(); if(!db) return { found:false, platform:"", reason:"database_unavailable" } as const;
  await ensureWhitelistTables();
  const username=usernameRaw.trim();
  const r=await db.query(`SELECT platform,enabled,expires_at FROM tz_whitelist WHERE LOWER(username)=LOWER($1) ORDER BY CASE WHEN UPPER(platform)='OFA' THEN 0 ELSE 1 END LIMIT 1`,[username]);
  const row=r.rows[0];
  if(!row) return { found:false, platform:"", reason:"not_whitelisted" } as const;
  if(!row.enabled) return { found:false, platform:String(row.platform||"TZ").toUpperCase(), reason:"disabled" } as const;
  if(row.expires_at && new Date(row.expires_at).getTime()<=Date.now()) return { found:false, platform:String(row.platform||"TZ").toUpperCase(), reason:"expired" } as const;
  return { found:true, platform:String(row.platform||"TZ").toUpperCase(), reason:"ok" } as const;
}

export async function listWhitelist() {
  const db=getPool(); if(!db) throw new Error("DATABASE_URL 尚未設定"); await ensureWhitelistTables();
  const r=await db.query(`SELECT w.* FROM tz_whitelist w ORDER BY w.updated_at DESC`);
  return r.rows;
}

export async function upsertWhitelist(input:{username:string; platform?:string; days?:number|null; permanent?:boolean; note?:string}) {
  const db=getPool(); if(!db) throw new Error("DATABASE_URL 尚未設定"); await ensureWhitelistTables();
  const username=input.username.trim(); if(!username) throw new Error("請輸入平台帳號");
  const platform=String(input.platform||"TZ").trim().toUpperCase();
  if(!["TZ","OFA"].includes(platform)) throw new Error("不支援的平台");
  const expiresAt=input.permanent ? null : new Date(Date.now()+Math.max(1,Number(input.days)||30)*86400000);
  const note=(input.note||"").slice(0,255);

  // PostgreSQL 的 expression unique index（UPPER/LOWER）不能用先前那種
  // ON CONFLICT (UPPER(...), LOWER(...)) 寫法可靠地做 conflict inference。
  // 先用相同的大小寫不敏感條件查找，再 UPDATE / INSERT，避免新增授權時報：
  // “there is no unique or exclusion constraint matching the ON CONFLICT specification”。
  const existing=await db.query(
    `SELECT id FROM tz_whitelist WHERE UPPER(platform)=UPPER($1) AND LOWER(username)=LOWER($2) LIMIT 1`,
    [platform,username]
  );
  if(existing.rowCount){
    await db.query(
      `UPDATE tz_whitelist SET username=$1,platform=$2,enabled=TRUE,expires_at=$3,note=$4,updated_at=NOW() WHERE id=$5`,
      [username,platform,expiresAt,note,existing.rows[0].id]
    );
    return;
  }

  try {
    await db.query(
      `INSERT INTO tz_whitelist (username,platform,enabled,expires_at,max_devices,note,updated_at) VALUES ($1,$2,TRUE,$3,1,$4,NOW())`,
      [username,platform,expiresAt,note]
    );
  } catch (e:any) {
    // 若剛好有兩個新增請求同時進來，unique index 仍會保護資料；
    // 23505 時直接改為更新同一筆授權。
    if(e?.code!=="23505") throw e;
    await db.query(
      `UPDATE tz_whitelist SET username=$1,enabled=TRUE,expires_at=$2,note=$3,updated_at=NOW() WHERE UPPER(platform)=UPPER($4) AND LOWER(username)=LOWER($1)`,
      [username,expiresAt,note,platform]
    );
  }
}
export async function setWhitelistEnabled(id:number, enabled:boolean) { const db=getPool(); if(!db) throw new Error("DATABASE_URL 尚未設定"); await ensureWhitelistTables(); await db.query(`UPDATE tz_whitelist SET enabled=$1,updated_at=NOW() WHERE id=$2`,[enabled,id]); }
export async function extendWhitelist(id:number, days:number) { const db=getPool(); if(!db) throw new Error("DATABASE_URL 尚未設定"); await ensureWhitelistTables(); await db.query(`UPDATE tz_whitelist SET expires_at=(CASE WHEN expires_at IS NULL OR expires_at < NOW() THEN NOW() ELSE expires_at END)+($1::text || ' days')::interval,enabled=TRUE,updated_at=NOW() WHERE id=$2`,[Math.max(1,days),id]); }
export async function deleteWhitelist(id:number) { const db=getPool(); if(!db) throw new Error("DATABASE_URL 尚未設定"); await ensureWhitelistTables(); await db.query(`DELETE FROM tz_whitelist WHERE id=$1`,[id]); }
