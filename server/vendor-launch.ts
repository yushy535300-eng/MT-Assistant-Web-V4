export type VendorKind = "AB" | "DB";

function platformBase(platform: "TZ" | "OFA") {
  return platform === "OFA" ? "https://www.ofa1188.net" : "https://www.tz6868.cc";
}

export function pickLaunchUrl(data: any, kind: VendorKind, device: "Desktop" | "Mobile" = "Desktop") {
  const providerName = kind === "AB" ? "歐博" : "DB";
  const rawCandidates: any[] = [
    data?.data?.game_url,
    data?.data?.url,
    data?.raw?.url,
    data?.raw?.game_url,
    typeof data?.raw === "string" ? data.raw : undefined,
  ];
  const cleaned = rawCandidates
    .filter((v) => typeof v === "string" && v.trim())
    .map((v) =>
      String(v)
        .trim()
        .replace(/\\\//g, "/")
        .replace(/^['"]|['"]$/g, ""),
    );
  for (const candidate of cleaned) {
    try {
      const u = new URL(candidate);
      const credentialOk =
        kind === "AB" ? !!u.searchParams.get("sessionId") : !!u.searchParams.get("params");
      if (u.protocol === "https:" && credentialOk) {
        if (kind === "DB") return device === "Mobile" ? preferDbMobileUrl(u.toString()) : preferDbVueUrl(u.toString());
        return u.toString();
      }
    } catch {}
  }
  throw new Error(`找不到 ${providerName} 有效授權網址`);
}

export function vendorLaunchIsReady(kind: VendorKind, url: string) {
  try {
    const u = new URL(url);
    return kind === "AB" ? !!u.searchParams.get("sessionId") : !!u.searchParams.get("params");
  } catch {
    return false;
  }
}

export function preferDbMobileUrl(url: string) {
  try {
    const u = new URL(url);
    if (/\/egret\/hall/i.test(u.pathname) || /\/play\/?$/i.test(u.pathname) || u.pathname === "/" || u.pathname === "") {
      u.pathname = "/h5/";
    }
    return u.toString();
  } catch {
    return url;
  }
}

export function preferDbVueUrl(url: string) {
  try {
    const u = new URL(url);
    if (/egret\/hall/i.test(u.pathname) && /jhui100\.com$/i.test(u.hostname)) return u.toString();
    if (/jhui100\.com$/i.test(u.hostname)) {
      const next = new URL("https://pc.jhui100.com:2053/egret/hall");
      next.search = u.search;
      return next.toString();
    }
    return u.toString();
  } catch {
    return url;
  }
}

export async function fetchVendorLaunchUrl(opts: {
  platform: "TZ" | "OFA";
  platformToken: string;
  kind: VendorKind;
  device?: "Desktop" | "Mobile";
}) {
  const provider = opts.kind === "AB" ? "AB01" : "YABOZR";
  const providerName = opts.kind === "AB" ? "歐博" : "DB";
  const device = opts.device === "Mobile" ? "Mobile" : "Desktop";
  const base = platformBase(opts.platform);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`${base}/api/v2/game/${provider}/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/plain, */*",
        Authorization: `Bearer ${opts.platformToken}`,
      },
      body: JSON.stringify({
        game_return_url: base,
        game_kind: "",
        game_type: "",
        device,
        game_device: device,
      }),
      signal: controller.signal,
    });
    let data: any = null;
    try {
      data = await response.json();
    } catch {}
    if (!response.ok || Number(data?.code) !== 200) {
      throw new Error(
        String(data?.message ?? data?.msg ?? `取得 ${providerName} 授權失敗`),
      );
    }
    const launchUrl = pickLaunchUrl(data, opts.kind, device);
    try {
      const u = new URL(launchUrl);
      console.log(`[Vendor launch] kind=${opts.kind}｜device=${device}｜host=${u.host}｜path=${u.pathname}`);
    } catch {}
    return launchUrl;
  } catch (error: any) {
    if (error?.name === "AbortError") throw new Error(`${providerName} 授權逾時`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
