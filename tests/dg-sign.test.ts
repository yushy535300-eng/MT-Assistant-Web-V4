import { describe, expect, it } from "vitest";

import { encryptDgToken, signedDgWsUrl } from "../server/dg-relay";

describe("DG vendor WebSocket sign", () => {
  it("matches the verified TripleDES vector", () => {
    expect(encryptDgToken("0123456789abcdef0123456789abcdef")).toBe(
      "BJXvl/9+wy+xRLeXaHZ45QSV75f/fsMvsUS3l2h2eOXHN5v/fcjYeQ==",
    );
  });

  it("keeps Base64 query characters literal like the vendor browser", () => {
    const url = signedDgWsUrl(
      "wss://hwdata-new.taxyss.com",
      "0123456789abcdef0123456789abcdef",
    );

    expect(url).toBe(
      "wss://hwdata-new.taxyss.com/?sign=BJXvl/9+wy+xRLeXaHZ45QSV75f/fsMvsUS3l2h2eOXHN5v/fcjYeQ==",
    );
    expect(url).not.toContain("%2F");
    expect(url).not.toContain("%3D");
  });
});
