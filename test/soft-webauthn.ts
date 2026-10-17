/**
 * A software WebAuthn authenticator (ES256, attestation "none") for passkey tests, ported in spirit from the
 * Python suite's soft authenticator. It produces the RegistrationResponseJSON / AuthenticationResponseJSON shapes
 * the browser sends, so routes are tested end to end with real signatures.
 */
import { b64urlDecode, b64urlEncode, utf8 } from "../src/lib/b64url.ts";

// ---- minimal CBOR (RFC 8949) encoder: unsigned/negative ints, byte and text strings, arrays, maps ----

type Cbor = number | string | Uint8Array | Cbor[] | Map<Cbor, Cbor> | { [k: string]: Cbor };

function head(major: number, n: number): number[] {
  if (n < 24) return [(major << 5) | n];
  if (n < 0x100) return [(major << 5) | 24, n];
  if (n < 0x10000) return [(major << 5) | 25, n >> 8, n & 0xff];
  return [(major << 5) | 26, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

export function cbor(v: Cbor): Uint8Array {
  const out: number[] = [];
  const enc = (x: Cbor): void => {
    if (typeof x === "number") {
      if (!Number.isInteger(x)) throw new Error("cbor: only integers");
      out.push(...(x >= 0 ? head(0, x) : head(1, -1 - x)));
    } else if (typeof x === "string") {
      const b = utf8(x);
      out.push(...head(3, b.length), ...b);
    } else if (x instanceof Uint8Array) {
      out.push(...head(2, x.length), ...x);
    } else if (Array.isArray(x)) {
      out.push(...head(4, x.length));
      for (const i of x) enc(i);
    } else if (x instanceof Map) {
      out.push(...head(5, x.size));
      for (const [k, val] of x) {
        enc(k);
        enc(val);
      }
    } else {
      const entries = Object.entries(x);
      out.push(...head(5, entries.length));
      for (const [k, val] of entries) {
        enc(k);
        enc(val);
      }
    }
  };
  enc(v);
  return new Uint8Array(out);
}

// ---- helpers ----

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function u32(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

/** WebCrypto ECDSA signatures are raw r||s; WebAuthn wants ASN.1 DER. */
function rawToDer(raw: Uint8Array): Uint8Array {
  const int = (b: Uint8Array): Uint8Array => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    const v = b.subarray(i);
    return (v[0] ?? 0) & 0x80 ? concat(new Uint8Array([0]), v) : v;
  };
  const r = int(raw.subarray(0, 32));
  const s = int(raw.subarray(32));
  const body = concat(new Uint8Array([0x02, r.length]), r, new Uint8Array([0x02, s.length]), s);
  return concat(new Uint8Array([0x30, body.length]), body);
}

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

export interface RegistrationJSON {
  id: string;
  rawId: string;
  type: "public-key";
  response: { clientDataJSON: string; attestationObject: string; transports: string[] };
  clientExtensionResults: Record<string, never>;
  authenticatorAttachment: "platform";
}

export interface AuthenticationJSON {
  id: string;
  rawId: string;
  type: "public-key";
  response: { clientDataJSON: string; authenticatorData: string; signature: string; userHandle?: string };
  clientExtensionResults: Record<string, never>;
  authenticatorAttachment: "platform";
}

export class SoftAuthenticator {
  private keys: CryptoKeyPair | null = null;
  readonly credentialId = crypto.getRandomValues(new Uint8Array(16));
  private signCount = 0;
  private userHandle: string | null = null;

  constructor(
    readonly origin: string,
    readonly rpId: string,
  ) {}

  get id(): string {
    return b64urlEncode(this.credentialId);
  }

  private clientData(type: "webauthn.create" | "webauthn.get", challenge: string): Uint8Array {
    return utf8(JSON.stringify({ type, challenge, origin: this.origin, crossOrigin: false }));
  }

  /** Answers `navigator.credentials.create()` options (challenge and user.id are base64url strings). */
  async register(options: { challenge: string; user: { id: string } }): Promise<RegistrationJSON> {
    this.keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    this.userHandle = options.user.id;
    const jwk = (await crypto.subtle.exportKey("jwk", this.keys.publicKey)) as JsonWebKey;
    const cose = cbor(
      new Map<Cbor, Cbor>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, b64urlDecode(jwk.x ?? "")],
        [-3, b64urlDecode(jwk.y ?? "")],
      ]),
    );
    const idLen = new Uint8Array([this.credentialId.length >> 8, this.credentialId.length & 0xff]);
    const authData = concat(
      await sha256(utf8(this.rpId)),
      new Uint8Array([FLAG_UP | FLAG_UV | FLAG_AT]),
      u32(this.signCount),
      new Uint8Array(16),
      idLen,
      this.credentialId,
      cose,
    );
    const attestationObject = cbor({ fmt: "none", attStmt: {}, authData });
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: {
        clientDataJSON: b64urlEncode(this.clientData("webauthn.create", options.challenge)),
        attestationObject: b64urlEncode(attestationObject),
        transports: ["internal"],
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }

  /** Answers `navigator.credentials.get()` options with a signed assertion. */
  async authenticate(options: { challenge: string }): Promise<AuthenticationJSON> {
    if (this.keys === null) throw new Error("register first");
    this.signCount++;
    const authData = concat(
      await sha256(utf8(this.rpId)),
      new Uint8Array([FLAG_UP | FLAG_UV]),
      u32(this.signCount),
    );
    const clientDataJSON = this.clientData("webauthn.get", options.challenge);
    const signed = concat(authData, await sha256(clientDataJSON));
    const raw = new Uint8Array(
      await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.keys.privateKey, signed),
    );
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: {
        clientDataJSON: b64urlEncode(clientDataJSON),
        authenticatorData: b64urlEncode(authData),
        signature: b64urlEncode(rawToDer(raw)),
        ...(this.userHandle === null ? {} : { userHandle: this.userHandle }),
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }
}
