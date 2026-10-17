import { describe, expect, it } from "vitest";
import { b64urlDecode, b64urlEncode, hex, utf8 } from "../../src/lib/b64url.ts";
import { decryptString, encryptString } from "../../src/lib/crypto/aesgcm.ts";
import { timingSafeEqualBytes, timingSafeEqualStr } from "../../src/lib/crypto/consttime.ts";
import { hmacSha256, hmacSha256Hex, hmacSha256Verify, sha256Hex } from "../../src/lib/crypto/hmac.ts";
import { type JwtClaims, JwtError, type KeyRing, signJwt, verifyJwt } from "../../src/lib/crypto/hs256.ts";
import {
  dummyPasswordHash,
  hashPassword,
  needsRehash,
  PBKDF2_ITERATIONS,
  parsePasswordHash,
  verifyPassword,
} from "../../src/lib/crypto/pbkdf2.ts";
import {
  base32Decode,
  base32Encode,
  findTotpStep,
  generateTotpSecret,
  hotp,
  totpAt,
  totpProvisioningUri,
} from "../../src/lib/crypto/totp.ts";

const PEPPER = utf8("pepper-pepper-pepper-pepper-32b!");
const KEY32 = utf8("data-key-data-key-data-key-32by!");

describe("consttime", () => {
  it("compares bytes and strings", () => {
    expect(timingSafeEqualBytes(utf8("abc"), utf8("abc"))).toBe(true);
    expect(timingSafeEqualBytes(utf8("abc"), utf8("abd"))).toBe(false);
    expect(timingSafeEqualBytes(utf8("abc"), utf8("abcd"))).toBe(false);
    expect(timingSafeEqualStr("", "")).toBe(true);
    expect(timingSafeEqualStr("tok", "tok ")).toBe(false);
  });
});

describe("hmac", () => {
  it("matches RFC 4231 test case 2", async () => {
    const mac = await hmacSha256Hex(utf8("Jefe"), "what do ya want for nothing?");
    expect(mac).toBe("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
    expect(
      await hmacSha256Verify(
        utf8("Jefe"),
        "what do ya want for nothing?",
        await hmacSha256(utf8("Jefe"), "what do ya want for nothing?"),
      ),
    ).toBe(true);
    expect(await hmacSha256Verify(utf8("Jefe"), "what do ya want", await hmacSha256(utf8("Jefe"), "x"))).toBe(
      false,
    );
  });

  it("hashes SHA-256 as lowercase hex", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("pbkdf2", () => {
  it("round-trips in the self-describing format", async () => {
    const h = await hashPassword("correct horse", PEPPER);
    expect(h).toMatch(/^pbkdf2-sha256\$v=1\$i=100000\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
    expect(await verifyPassword(h, "correct horse", PEPPER)).toBe(true);
    expect(await verifyPassword(h, "correct horsE", PEPPER)).toBe(false);
    expect(needsRehash(h)).toBe(false);
  });

  it("peppers the input: the same hash fails under another pepper", async () => {
    const h = await hashPassword("pw", PEPPER, 1000);
    expect(await verifyPassword(h, "pw", KEY32)).toBe(false);
  });

  it("matches an independent derivation (Node: pbkdf2(HMAC(pepper, pw), salt, 1000))", async () => {
    const stored =
      "pbkdf2-sha256$v=1$i=1000$BwcHBwcHBwcHBwcHBwcHBw$AsWgF2EAylJPZeXFY9eaOSJO04xTd1t7DEmkYf7SxY4";
    expect(await verifyPassword(stored, "correct horse", PEPPER)).toBe(true);
    expect(needsRehash(stored)).toBe(true);
    expect(needsRehash(stored, 1000)).toBe(false);
  });

  it("rejects malformed strings without throwing", async () => {
    for (const bad of [
      "",
      "$argon2id$v=19$m=65536,t=3,p=4$abc$def",
      "pbkdf2-sha256$v=2$i=1000$BwcHBwcHBwcHBwcHBwcHBw$AsWgF2EAylJPZeXFY9eaOSJO04xTd1t7DEmkYf7SxY4",
      "pbkdf2-sha256$v=1$i=0$BwcHBwcHBwcHBwcHBwcHBw$AsWgF2EAylJPZeXFY9eaOSJO04xTd1t7DEmkYf7SxY4",
      "pbkdf2-sha256$v=1$i=100001$BwcHBwcHBwcHBwcHBwcHBw$AsWgF2EAylJPZeXFY9eaOSJO04xTd1t7DEmkYf7SxY4",
      "pbkdf2-sha256$v=1$i=1000$BwcH$AsWgF2EAylJPZeXFY9eaOSJO04xTd1t7DEmkYf7SxY4",
    ]) {
      expect(parsePasswordHash(bad)).toBeNull();
      expect(needsRehash(bad)).toBe(true);
      expect(await verifyPassword(bad, "correct horse", PEPPER)).toBe(false);
    }
    await expect(hashPassword("x", PEPPER, 100_001)).rejects.toThrow(RangeError);
  });

  it("caches a dummy hash per pepper", async () => {
    const a = await dummyPasswordHash(PEPPER);
    expect(a).toBe(await dummyPasswordHash(PEPPER));
    expect(parsePasswordHash(a)?.iterations).toBe(PBKDF2_ITERATIONS);
  });

  // G-1 local measurement. Wall time in local workerd (vitest pool) is a proxy for cpuTime; the staging
  // `wrangler tail` measurement is still owed.
  it("measures 100k-iteration hash time locally", async () => {
    const runs = 5;
    const t0 = performance.now();
    for (let i = 0; i < runs; i++) await hashPassword("measure me", PEPPER);
    const ms = (performance.now() - t0) / runs;
    console.log(`PBKDF2-SHA256 100k: ${ms.toFixed(1)} ms per hash (local workerd, mean of ${runs})`);
    expect(ms).toBeGreaterThanOrEqual(0);
  });
});

describe("hs256", () => {
  const k1 = utf8("k1-k1-k1-k1-k1-k1-k1-k1-k1-k1-32");
  const k2 = utf8("k2-k2-k2-k2-k2-k2-k2-k2-k2-k2-32");
  const ring1: KeyRing = { current: "a", keys: new Map([["a", k1]]) };
  const ring2: KeyRing = {
    current: "b",
    keys: new Map([
      ["a", k1],
      ["b", k2],
    ]),
  };
  const now = 1_800_000_000_000;
  const iat = now / 1000;
  const claims = (over: Partial<JwtClaims> = {}): JwtClaims => ({
    sub: "u1",
    type: "access",
    ver: 0,
    sid: "s1",
    jti: "j1",
    iss: "api.pacestreak.com",
    aud: "pacestreak",
    iat,
    exp: iat + 900,
    ...over,
  });
  const opts = {
    type: "access",
    issuer: "api.pacestreak.com",
    audience: "pacestreak",
    nowMs: now,
    required: ["sub", "ver", "sid", "jti"],
  };
  const code = async (p: Promise<unknown>) => {
    try {
      await p;
      return "ok";
    } catch (e) {
      return e instanceof JwtError ? e.code : "other";
    }
  };

  it("signs with the kid header and verifies", async () => {
    const t = await signJwt(ring1, claims());
    const header = JSON.parse(new TextDecoder().decode(b64urlDecode(t.split(".")[0] ?? "")));
    expect(header).toEqual({ alg: "HS256", typ: "JWT", kid: "a" });
    expect((await verifyJwt(t, ring1, opts)).sub).toBe("u1");
  });

  it("verifies tokens from a retired-but-kept key after rotation, and rejects removed kids", async () => {
    const old = await signJwt(ring1, claims());
    expect((await verifyJwt(old, ring2, opts)).sub).toBe("u1");
    const fresh = await signJwt(ring2, claims());
    expect(await code(verifyJwt(fresh, ring1, opts))).toBe("unknown_kid");
  });

  it("matches a known HS256 signature (jwt.io style, independent of signJwt)", async () => {
    const h = b64urlEncode(utf8(JSON.stringify({ alg: "HS256", typ: "JWT", kid: "a" })));
    const p = b64urlEncode(utf8(JSON.stringify(claims())));
    const sig = b64urlEncode(await hmacSha256(k1, `${h}.${p}`));
    expect(await signJwt(ring1, claims())).toBe(`${h}.${p}.${sig}`);
  });

  it("rejects expiry, tampering, wrong type, iss, aud, alg, and missing claims", async () => {
    expect(await code(verifyJwt(await signJwt(ring1, claims({ exp: iat })), ring1, opts))).toBe("expired");
    expect(await code(verifyJwt(await signJwt(ring1, claims({ exp: iat + 1 })), ring1, opts))).toBe("ok");
    expect(await code(verifyJwt(await signJwt(ring1, claims({ type: "mfa" })), ring1, opts))).toBe(
      "invalid_claims",
    );
    expect(await code(verifyJwt(await signJwt(ring1, claims({ iss: "x" })), ring1, opts))).toBe(
      "invalid_claims",
    );
    expect(await code(verifyJwt(await signJwt(ring1, claims({ aud: "x" })), ring1, opts))).toBe(
      "invalid_claims",
    );
    expect(await code(verifyJwt(await signJwt(ring1, claims({ nbf: iat + 10 })), ring1, opts))).toBe(
      "invalid_claims",
    );
    const { sid: _sid, ...noSid } = claims();
    expect(await code(verifyJwt(await signJwt(ring1, noSid as JwtClaims), ring1, opts))).toBe(
      "invalid_claims",
    );

    const t = await signJwt(ring1, claims());
    const [h, , s] = t.split(".");
    const forged = b64urlEncode(utf8(JSON.stringify(claims({ sub: "admin" }))));
    expect(await code(verifyJwt(`${h}.${forged}.${s}`, ring1, opts))).toBe("bad_signature");
    const none = b64urlEncode(utf8(JSON.stringify({ alg: "none", typ: "JWT", kid: "a" })));
    expect(await code(verifyJwt(`${none}.${t.split(".")[1]}.`, ring1, opts))).toBe("malformed");
    expect(await code(verifyJwt("a.b", ring1, opts))).toBe("malformed");
    expect(await code(verifyJwt("!!.!!.!!", ring1, opts))).toBe("malformed");
  });
});

describe("aesgcm", () => {
  it("round-trips in the v1.<iv>.<ct> format with fresh IVs", async () => {
    const a = await encryptString(KEY32, "JBSWY3DPEHPK3PXP");
    const b = await encryptString(KEY32, "JBSWY3DPEHPK3PXP");
    expect(a).toMatch(/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
    expect(a).not.toBe(b);
    expect(await decryptString(KEY32, a)).toBe("JBSWY3DPEHPK3PXP");
  });

  it("returns null on wrong key, tampering, wrong aad and garbage", async () => {
    const c = await encryptString(KEY32, "secret", "user-1");
    expect(await decryptString(KEY32, c, "user-1")).toBe("secret");
    expect(await decryptString(KEY32, c, "user-2")).toBeNull();
    expect(await decryptString(KEY32, c)).toBeNull();
    expect(await decryptString(PEPPER, c, "user-1")).toBeNull();
    const [v, iv, ct] = c.split(".");
    const bytes = b64urlDecode(ct ?? "");
    bytes[0] = (bytes[0] ?? 0) ^ 1;
    expect(await decryptString(KEY32, `${v}.${iv}.${b64urlEncode(bytes)}`, "user-1")).toBeNull();
    for (const bad of ["", "v1..", "v2.a.b", "gAAAAABfernet", "v1.!!.!!"]) {
      expect(await decryptString(KEY32, bad)).toBeNull();
    }
    await expect(encryptString(utf8("short"), "x")).rejects.toThrow(RangeError);
  });
});

describe("totp", () => {
  const RFC_SHA1 = utf8("12345678901234567890");
  const RFC_SHA256 = utf8("12345678901234567890123456789012");
  const vectors: [number, string, string][] = [
    [59, "94287082", "46119246"],
    [1111111109, "07081804", "68084774"],
    [1111111111, "14050471", "67062674"],
    [1234567890, "89005924", "91819424"],
    [2000000000, "69279037", "90698825"],
    [20000000000, "65353130", "77737706"],
  ];

  it("matches the RFC 6238 appendix B vectors (8 digits, SHA-1 and SHA-256)", async () => {
    for (const [t, sha1, sha256] of vectors) {
      const step = Math.floor(t / 30);
      expect(await hotp(RFC_SHA1, step, 8)).toBe(sha1);
      expect(await hotp(RFC_SHA256, step, 8, "SHA-256")).toBe(sha256);
    }
  });

  it("matches the RFC 4226 appendix D HOTP vectors (6 digits)", async () => {
    const expected = [
      "755224",
      "287082",
      "359152",
      "969429",
      "338314",
      "254676",
      "287922",
      "162583",
      "399871",
      "520489",
    ];
    for (const [i, want] of expected.entries()) expect(await hotp(RFC_SHA1, i)).toBe(want);
  });

  it("base32 round-trips (RFC 4648 vectors) and generates 32-char secrets", () => {
    expect(base32Encode(utf8("foobar"))).toBe("MZXW6YTBOI");
    expect(base32Encode(utf8("f"))).toBe("MY");
    expect(hex(base32Decode("mzxw6ytboi======"))).toBe(hex(utf8("foobar")));
    expect(() => base32Decode("01")).toThrow();
    const s = generateTotpSecret();
    expect(s).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(s).length).toBe(20);
  });

  it("accepts the ±1 window and returns the matched step", async () => {
    const secret = base32Encode(RFC_SHA1);
    const now = 59_000; // step 1
    expect(await totpAt(secret, now)).toBe("287082");
    expect(await findTotpStep(secret, "287082", now)).toBe(1);
    expect(await findTotpStep(secret, " 755 224 ", now)).toBe(0);
    expect(await findTotpStep(secret, "359152", now)).toBe(2);
    expect(await findTotpStep(secret, "969429", now)).toBeNull();
    expect(await findTotpStep(secret, "", now)).toBeNull();
    expect(await findTotpStep("", "287082", now)).toBeNull();
    expect(await findTotpStep("!!", "287082", now)).toBeNull();
  });

  it("builds a pyotp-shaped provisioning URI", () => {
    expect(totpProvisioningUri("JBSWY3DPEHPK3PXP", "a@b.co", "PaceStreak")).toBe(
      "otpauth://totp/PaceStreak:a%40b.co?secret=JBSWY3DPEHPK3PXP&issuer=PaceStreak",
    );
  });
});
