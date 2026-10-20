import { describe, expect, it } from "vitest";
import { b64urlDecode, b64urlEncode, utf8 } from "../../src/lib/b64url.ts";
import { ecdhParams, encryptPayload, MAX_PLAINTEXT } from "../../src/lib/push/encrypt.ts";
import { isGlobalIpv4, isSafePushEndpoint, parseIpv4, parseIpv6 } from "../../src/lib/push/guard.ts";
import { MAX_FAILURES, outcomeFor, sendPush } from "../../src/lib/push/send.ts";
import { createVapidSigner, VAPID_TTL_SECONDS } from "../../src/lib/push/vapid.ts";
import { T0 } from "../fixtures/clock.ts";
import { mockFetch } from "../fixtures/fetch.ts";

// RFC 8291 Appendix A.
const RFC = {
  plaintext: "When I grow up, I want to be a watermelon",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  auth: "BTBZMqHH6r4Tts7J_aSIgg", // gitleaks:allow (RFC 8291 published test vector)
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  body:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6" +
    "PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

function jwkFor(publicB64: string, privateB64: string | null): JsonWebKey {
  const p = b64urlDecode(publicB64);
  const jwk: JsonWebKey = {
    kty: "EC",
    crv: "P-256",
    x: b64urlEncode(p.subarray(1, 33)),
    y: b64urlEncode(p.subarray(33, 65)),
  };
  if (privateB64 !== null) jwk.d = privateB64;
  return jwk;
}

async function ecdhPair(publicB64: string, privateB64: string): Promise<CryptoKeyPair> {
  const alg = { name: "ECDH", namedCurve: "P-256" };
  return {
    publicKey: await crypto.subtle.importKey("jwk", jwkFor(publicB64, null), alg, true, []),
    privateKey: await crypto.subtle.importKey("jwk", jwkFor(publicB64, privateB64), alg, true, [
      "deriveBits",
    ]),
  };
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, n: number): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", new Uint8Array(ikm), "HKDF", false, ["deriveBits"]);
  const alg = { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(salt), info: new Uint8Array(info) };
  return new Uint8Array(await crypto.subtle.deriveBits(alg, k, n * 8));
}

/** Independent receiver-side decryption (what a browser does), to check bodies built with random keys. */
async function decrypt(body: Uint8Array, ua: CryptoKeyPair, auth: Uint8Array): Promise<string> {
  const salt = body.subarray(0, 16);
  const idlen = body[20] ?? 0;
  const asPublic = body.subarray(21, 21 + idlen);
  const asKey = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(asPublic),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const secret = new Uint8Array(await crypto.subtle.deriveBits(ecdhParams(asKey), ua.privateKey, 256));
  const uaPublic = new Uint8Array((await crypto.subtle.exportKey("raw", ua.publicKey)) as ArrayBuffer);
  const info = new Uint8Array([...utf8("WebPush: info\0"), ...uaPublic, ...asPublic]);
  const ikm = await hkdf(auth, secret, info, 32);
  const cek = await hkdf(salt, ikm, utf8("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, utf8("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", new Uint8Array(cek), "AES-GCM", false, ["decrypt"]);
  const plain = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: new Uint8Array(nonce) },
      key,
      new Uint8Array(body.subarray(21 + idlen)),
    ),
  );
  expect(plain[plain.length - 1]).toBe(0x02);
  return new TextDecoder().decode(plain.subarray(0, -1));
}

async function newSubscriber() {
  const ua = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", ua.publicKey)) as ArrayBuffer);
  return { ua, auth, keys: { p256dh: b64urlEncode(raw), auth: b64urlEncode(auth) } };
}

describe("encryptPayload (RFC 8291)", () => {
  it("matches the RFC 8291 appendix A test vector", async () => {
    const body = await encryptPayload(
      RFC.plaintext,
      { p256dh: RFC.uaPublic, auth: RFC.auth },
      { ephemeral: await ecdhPair(RFC.asPublic, RFC.asPrivate), salt: b64urlDecode(RFC.salt) },
    );
    expect(b64urlEncode(body)).toBe(RFC.body);
  });

  it("the RFC vector decrypts with the user agent key", async () => {
    const ua = await ecdhPair(RFC.uaPublic, RFC.uaPrivate);
    expect(await decrypt(b64urlDecode(RFC.body), ua, b64urlDecode(RFC.auth))).toBe(RFC.plaintext);
  });

  it("round-trips with a fresh ephemeral key and salt each time", async () => {
    const s = await newSubscriber();
    const a = await encryptPayload('{"title":"Hi 🔥"}', s.keys);
    const b = await encryptPayload('{"title":"Hi 🔥"}', s.keys);
    expect(b64urlEncode(a)).not.toBe(b64urlEncode(b));
    expect(await decrypt(a, s.ua, s.auth)).toBe('{"title":"Hi 🔥"}');
    expect(new DataView(a.buffer).getUint32(16)).toBe(4096);
    expect(a[20]).toBe(65);
  });

  it("rejects oversized payloads and malformed keys", async () => {
    const s = await newSubscriber();
    await expect(encryptPayload("x".repeat(MAX_PLAINTEXT + 1), s.keys)).rejects.toThrow(RangeError);
    await expect(encryptPayload("x".repeat(MAX_PLAINTEXT), s.keys)).resolves.toBeInstanceOf(Uint8Array);
    await expect(encryptPayload("x", { ...s.keys, auth: "AAAA" })).rejects.toThrow("auth");
    await expect(encryptPayload("x", { ...s.keys, p256dh: "AAAA" })).rejects.toThrow("p256dh");
  });
});

async function vapidKeys() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  return {
    pair,
    cfg: {
      privateJwk: JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey)),
      publicKey: b64urlEncode(raw),
      subject: "mailto:hello@pacestreak.com",
    },
  };
}

function parseVapid(header: string) {
  const m = /^vapid t=([^,]+), k=(.+)$/.exec(header);
  if (m === null) throw new Error(`bad header ${header}`);
  const [h = "", c = "", s = ""] = (m[1] ?? "").split(".");
  const json = (x: string) =>
    JSON.parse(new TextDecoder().decode(b64urlDecode(x))) as Record<string, unknown>;
  return { header: json(h), claims: json(c), input: `${h}.${c}`, sig: b64urlDecode(s), k: m[2] };
}

describe("VAPID (RFC 8292)", () => {
  it("signs an ES256 JWT for the endpoint origin, valid 12 hours", async () => {
    const { pair, cfg } = await vapidKeys();
    const signer = createVapidSigner(cfg, () => T0);
    const v = parseVapid(await signer.authorization("https://fcm.googleapis.com/fcm/send/abc"));
    expect(v.header).toEqual({ typ: "JWT", alg: "ES256" });
    expect(v.claims).toEqual({
      aud: "https://fcm.googleapis.com",
      exp: Math.floor(T0 / 1000) + VAPID_TTL_SECONDS,
      sub: "mailto:hello@pacestreak.com",
    });
    expect(v.k).toBe(cfg.publicKey);
    expect(v.sig.length).toBe(64);
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      pair.publicKey,
      new Uint8Array(v.sig),
      utf8(v.input),
    );
    expect(ok).toBe(true);
  });

  it("caches one token per audience origin and re-signs near expiry", async () => {
    const { cfg } = await vapidKeys();
    let now = T0;
    const signer = createVapidSigner(cfg, () => now);
    const a = await signer.authorization("https://fcm.googleapis.com/a");
    expect(await signer.authorization("https://fcm.googleapis.com/b")).toBe(a);
    const other = await signer.authorization("https://updates.push.services.mozilla.com/x");
    expect(parseVapid(other).claims.aud).toBe("https://updates.push.services.mozilla.com");
    now = T0 + 11.5 * 3600 * 1000;
    expect(await signer.authorization("https://fcm.googleapis.com/a")).not.toBe(a);
  });
});

const ALLOW = ["fcm.googleapis.com", "push.apple.com", "push.services.mozilla.com", "notify.windows.com"];

describe("isSafePushEndpoint", () => {
  it.each([
    // IPv4 literals
    ["https://8.8.8.8/push/abc", true],
    ["https://1.1.1.1/x", true],
    ["https://0.0.0.0/x", false],
    ["https://10.1.2.3/x", false],
    ["https://100.64.0.1/x", false],
    ["https://100.128.0.1/x", true],
    ["https://127.0.0.1/x", false],
    ["https://169.254.169.254/latest/meta-data/", false],
    ["https://172.16.0.1/x", false],
    ["https://172.31.255.255/x", false],
    ["https://172.32.0.1/x", true],
    ["https://192.0.2.1/x", false],
    ["https://192.168.1.1/x", false],
    ["https://198.18.0.1/x", false],
    ["https://198.51.100.7/x", false],
    ["https://203.0.113.9/x", false],
    ["https://224.0.0.1/x", false],
    ["https://240.0.0.1/x", false],
    ["https://255.255.255.255/x", false],
    // shorthand forms the URL parser canonicalises
    ["https://2130706433/x", false],
    ["https://0x7f.1/x", false],
    ["https://127.1/x", false],
    // IPv6 literals
    ["https://[::1]/x", false],
    ["https://[::]/x", false],
    ["https://[fc00::1]/x", false],
    ["https://[fd12:3456::1]/x", false],
    ["https://[fe80::1]/x", false],
    ["https://[ff02::1]/x", false],
    ["https://[2001:db8::1]/x", false],
    ["https://[3fff::1]/x", false],
    ["https://[2001::1]/x", false],
    ["https://[::ffff:127.0.0.1]/x", false],
    ["https://[::ffff:169.254.169.254]/x", false],
    ["https://[::ffff:8.8.8.8]/x", true],
    ["https://[::127.0.0.1]/x", false],
    ["https://[64:ff9b::10.0.0.1]/x", false],
    ["https://[64:ff9b::8.8.8.8]/x", true],
    ["https://[2002:a00:1::]/x", false],
    ["https://[2001:4860:4860::8888]/x", true],
    // scheme, credentials, port
    ["http://fcm.googleapis.com/x", false],
    ["https://user:pw@fcm.googleapis.com/x", false],
    ["https://fcm.googleapis.com:8443/x", false],
    ["https://fcm.googleapis.com:443/fcm/send/abc", true],
    ["not-a-url", false],
    // hostnames
    ["https://localhost/x", false],
    ["https://push.localhost/x", false],
    ["https://printer.local/x", false],
    ["https://metadata.google.internal/x", false],
    ["https://intranet/x", false],
    ["https://pacestreak.com/x", false],
    ["https://api.pacestreak.com/x", false],
    ["https://fcm.googleapis.com/fcm/send/abc", true],
    ["https://FCM.googleapis.com./fcm/send/abc", true],
    ["https://web.push.apple.com/abc", true],
    ["https://updates.push.services.mozilla.com/wpush/v2/abc", true],
    ["https://evil-fcm.googleapis.com.attacker.example/x", false],
    ["https://notfcm.googleapis.com.example/x", false],
    ["https://xfcm.googleapis.com/x", false],
    ["https://example.com/x", false],
  ])("%s -> %s", (url, ok) => {
    expect(isSafePushEndpoint(url, ALLOW)).toBe(ok);
  });

  it("parses IP literals strictly", () => {
    expect(parseIpv4("8.8.8.8")).toBe(0x08080808);
    expect(parseIpv4("08.8.8.8")).toBeNull();
    expect(parseIpv4("256.0.0.1")).toBeNull();
    expect(isGlobalIpv4(0x08080808)).toBe(true);
    expect(parseIpv6("::")).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(parseIpv6("1:2:3:4:5:6:7:8")).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(parseIpv6("::ffff:1.2.3.4")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x102, 0x304]);
    expect(parseIpv6("1::2::3")).toBeNull();
    expect(parseIpv6("1:2:3:4:5:6:7:8:9")).toBeNull();
    expect(parseIpv6("1:2:3:4::5:6:7:8")).toBeNull();
    expect(parseIpv6("fe80::1%eth0")).toBeNull();
  });
});

describe("parity: test_push_ssrf", () => {
  it("internal_targets_are_rejected", () => {
    for (const bad of [
      "https://169.254.169.254/latest/meta-data/",
      "https://127.0.0.1/x",
      "https://localhost/x",
      "https://10.0.0.5/x",
      "https://192.168.1.1/x",
      "http://fcm.googleapis.com/x",
      "https://[::1]/x",
      "not-a-url",
    ]) {
      expect(isSafePushEndpoint(bad, ALLOW), bad).toBe(false);
    }
  });

  it("a_public_literal_is_allowed", () => {
    expect(isSafePushEndpoint("https://8.8.8.8/push/abc", ALLOW)).toBe(true);
  });
});

describe("sendPush", () => {
  let deps: Parameters<typeof sendPush>[0];
  let target: Parameters<typeof sendPush>[1];
  const endpoint = "https://fcm.googleapis.com/fcm/send/abc";

  async function setup(failures = 0) {
    const { cfg } = await vapidKeys();
    const s = await newSubscriber();
    deps = { signer: createVapidSigner(cfg, () => T0), allowlist: ALLOW };
    target = { endpoint, failures, ...s.keys };
    return s;
  }

  it("posts an encrypted, VAPID-signed body and resets failures on 2xx", async () => {
    const s = await setup(3);
    const mock = mockFetch(endpoint, () => new Response(null, { status: 201 }));
    expect(await sendPush(deps, target, '{"title":"t"}')).toEqual({ kind: "delivered" });
    const req = mock.calls[0];
    if (req === undefined) throw new Error("no request");
    expect(req.method).toBe("POST");
    expect(req.headers.get("content-encoding")).toBe("aes128gcm");
    expect(req.headers.get("ttl")).toBe("43200");
    expect(req.headers.get("authorization")).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
    expect(req.redirect).toBe("manual");
    const body = new Uint8Array(await req.arrayBuffer());
    expect(await decrypt(body, s.ua, s.auth)).toBe('{"title":"t"}');
  });

  it.each([404, 410])("deletes the subscription on %i", async (status) => {
    await setup(0);
    mockFetch(endpoint, () => new Response(null, { status }));
    expect(await sendPush(deps, target, "{}")).toEqual({ kind: "delete", reason: "gone" });
  });

  it.each([500, 429, 413, 301, 302])("counts %i as a failure", async (status) => {
    await setup(2);
    mockFetch(endpoint, () => new Response(null, { status, headers: { Location: "https://10.0.0.1/" } }));
    expect(await sendPush(deps, target, "{}")).toEqual({ kind: "failed", failures: 3, status });
  });

  it("counts a transport error or timeout as a failure", async () => {
    await setup(0);
    mockFetch(endpoint, () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    });
    expect(await sendPush(deps, target, "{}")).toEqual({ kind: "failed", failures: 1, status: 0 });
  });

  it("deletes at the tenth failure", async () => {
    await setup(MAX_FAILURES - 1);
    mockFetch(endpoint, () => new Response(null, { status: 503 }));
    expect(await sendPush(deps, target, "{}")).toEqual({ kind: "delete", reason: "failures" });
  });

  it("re-checks the guard at send time and never fetches an unsafe endpoint", async () => {
    await setup(0);
    // No mock registered: a fetch would throw "unmocked outbound fetch" and come back as a failure instead.
    const out = await sendPush(deps, { ...target, endpoint: "https://api.pacestreak.com/x" }, "{}");
    expect(out).toEqual({ kind: "delete", reason: "unsafe" });
  });

  it("outcomeFor maps statuses", () => {
    expect(outcomeFor(200, 5)).toEqual({ kind: "delivered" });
    expect(outcomeFor(0, 8)).toEqual({ kind: "failed", failures: 9, status: 0 });
    expect(outcomeFor(0, 9)).toEqual({ kind: "delete", reason: "failures" });
  });
});
