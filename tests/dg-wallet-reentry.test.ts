import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

describe("wallet transfer around enter and leave", () => {
  it("sweeps to main then enters via TZ game login auto-wallet", () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), "app/index.tsx"), "utf8");
    const openStart = source.indexOf("const openCurrentPlatform");
    const closeStart = source.indexOf("const closeGameView");
    const execStart = source.indexOf("const executeTransferAll");
    const loginSweep = source.slice(
      source.indexOf("After TZ login: one sweep"),
      source.indexOf("DG relay follows"),
    );
    const openFn = source.slice(openStart, closeStart);
    const closeFn = source.slice(closeStart, execStart);
    expect(loginSweep).toContain("runAutoSweepToMain");
    expect(loginSweep).toContain("skipEmptyCheck: true");
    expect(loginSweep).toContain("silent: true");
    expect(loginSweep).toContain("1800");
    expect(loginSweep).not.toContain(
      "Background MTLI/DGLI just auto-pulled money into those games",
    );
    expect(openFn).toContain("pullAllGameWalletsToMain");
    expect(openFn).toContain("ensureDgAuthorization(true)");
    expect(openFn).not.toContain('fetch("/api/dg/start"');
    expect(openFn).toContain("enteringGameWalletRef.current = true");
    expect(openFn).toContain("已轉入DG");
    expect(openFn).toContain("已轉入歐博");
    expect(openFn).toContain("已轉入DB");
    expect(openFn).toContain("suppressDgRecoveryRef.current = true");
    expect(openFn).not.toContain("const needsWalletReentry");
    expect(openFn).toContain("setDgConnectEpoch");
    expect(source).not.toContain("DG 遊戲中使用原工作階段恢復牌路連線");
    expect(source).toContain("dg真人");
    expect(source).toContain("歐博真人");
    expect(source).toContain("mt真人");
    expect(source).toContain("db真人");
    expect(closeFn).toContain("pullAllGameWalletsToMain");
    expect(closeFn).toContain("void Promise.all(leaveJobs);");
    expect(source.slice(execStart, execStart + 800)).toContain("transferAllToMainWallet");
    expect(source).toContain("onPress={confirmTransferAll}");
    expect(source).not.toMatch(/hasEnteredGame\s*&&/);
    expect(source).toContain('MT: "MTLI"');
    expect(source).toContain('DG: "DGLI"');
    expect(source).toContain('AB: "AB01"');
    expect(source).toContain('DB: "YABOZR"');
    expect(source).toContain("token ? await request(true)");
  });
});
