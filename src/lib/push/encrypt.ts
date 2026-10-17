/**
 * RFC 8291 Web Push message encryption, `aes128gcm` content coding (RFC 8188), on WebCrypto. One record,
 * `rs = 4096`, padding delimiter 0x02 and no padding: push payloads are small and one record caps them.
 */
import { b64urlDecode, randomBytes, utf8 } from "../b64url.ts";

export const RECORD_SIZE = 4096;
/** Largest plaintext one record holds: rs minus the GCM tag (16) and the delimiter byte. */
export const MAX_PLAINTEXT = RECORD_SIZE - 16 - 1;

export interface PushKeys {
  /** Subscription `keys.p256dh`: base64url of the user agent's uncompressed P-256 public point. */
  p256dh: string;
  /** Subscription `keys.auth`: base64url of the 16-byte authentication secret. */
  auth: string;
}

/** Test seam: the RFC 8291 appendix fixes the sender's ephemeral key and the salt. */
export interface EncryptOptions {
  ephemeral?: CryptoKeyPair;
  salt?: Uint8Array;
}

const buf = (u: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(u);

/**
 * ECDH deriveBits parameters. workerd's generated types spell the member `$public` (an IDL keyword workaround),
 * but the runtime reads the standard `public`, so the cast sits at this library boundary.
 */
export const ecdhParams = (pub: CryptoKey): SubtleCryptoDeriveKeyAlgorithm =>
  ({ name: "ECDH", public: pub }) as unknown as SubtleCryptoDeriveKeyAlgorithm;

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", buf(ikm), "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: buf(salt), info: buf(info) },
    key,
    bytes * 8,
  );
  return new Uint8Array(bits);
}

/** The full request body: the RFC 8188 header (salt, rs, keyid = sender public key) followed by one record. */
export async function encryptPayload(
  plaintext: Uint8Array | string,
  keys: PushKeys,
  opts: EncryptOptions = {},
): Promise<Uint8Array<ArrayBuffer>> {
  const data = typeof plaintext === "string" ? utf8(plaintext) : plaintext;
  if (data.length > MAX_PLAINTEXT) throw new RangeError("push payload too large");
  const uaPublic = b64urlDecode(keys.p256dh);
  const authSecret = b64urlDecode(keys.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) throw new Error("invalid p256dh");
  if (authSecret.length !== 16) throw new Error("invalid auth secret");

  const uaKey = await crypto.subtle.importKey(
    "raw",
    buf(uaPublic),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const ephemeral =
    opts.ephemeral ??
    ((await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
      "deriveBits",
    ])) as CryptoKeyPair);
  const asPublic = new Uint8Array((await crypto.subtle.exportKey("raw", ephemeral.publicKey)) as ArrayBuffer);
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits(ecdhParams(uaKey), ephemeral.privateKey, 256),
  );

  const keyInfo = concat(utf8("WebPush: info\0"), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const salt = opts.salt ?? randomBytes(16);
  const cek = await hkdf(salt, ikm, utf8("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, utf8("Content-Encoding: nonce\0"), 12);

  const aesKey = await crypto.subtle.importKey("raw", buf(cek), "AES-GCM", false, ["encrypt"]);
  const record = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: buf(nonce) },
      aesKey,
      concat(data, Uint8Array.of(0x02)),
    ),
  );

  const header = new Uint8Array(16 + 4 + 1);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = asPublic.length;
  return concat(header, asPublic, record);
}
