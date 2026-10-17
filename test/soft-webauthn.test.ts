/**
 * Gate G-4: @simplewebauthn/server runs on workerd without nodejs_compat, and the soft authenticator's output
 * verifies with it (registration, then two sign-ins with an increasing counter).
 */
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { describe, expect, it } from "vitest";
import { SoftAuthenticator } from "./soft-webauthn.ts";

const RP_ID = "app.pacestreak.com";
const ORIGIN = "https://app.pacestreak.com";

describe("soft WebAuthn authenticator + @simplewebauthn/server (gate G-4)", () => {
  it("registers and signs in with ES256", async () => {
    const auth = new SoftAuthenticator(ORIGIN, RP_ID);
    const reg = await generateRegistrationOptions({
      rpName: "PaceStreak",
      rpID: RP_ID,
      userName: "runner@example.com",
      attestationType: "none",
    });
    const regRes = await auth.register(reg);
    const verified = await verifyRegistrationResponse({
      response: regRes,
      expectedChallenge: reg.challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
    });
    expect(verified.verified).toBe(true);
    const info = verified.registrationInfo;
    if (info === undefined) throw new Error("no registration info");
    expect(info.credential.id).toBe(auth.id);

    let counter = info.credential.counter;
    for (let i = 0; i < 2; i++) {
      const opts = await generateAuthenticationOptions({ rpID: RP_ID, allowCredentials: [{ id: auth.id }] });
      const assertion = await auth.authenticate(opts);
      const ok = await verifyAuthenticationResponse({
        response: assertion,
        expectedChallenge: opts.challenge,
        expectedOrigin: ORIGIN,
        expectedRPID: RP_ID,
        credential: { id: info.credential.id, publicKey: info.credential.publicKey, counter },
      });
      expect(ok.verified).toBe(true);
      expect(ok.authenticationInfo.newCounter).toBeGreaterThan(counter);
      counter = ok.authenticationInfo.newCounter;
    }
  });

  it("a signature over a different challenge does not verify", async () => {
    const auth = new SoftAuthenticator(ORIGIN, RP_ID);
    const reg = await generateRegistrationOptions({
      rpName: "PaceStreak",
      rpID: RP_ID,
      userName: "x@example.com",
    });
    const v = await verifyRegistrationResponse({
      response: await auth.register(reg),
      expectedChallenge: reg.challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
    });
    const info = v.registrationInfo;
    if (info === undefined) throw new Error("no registration info");
    const assertion = await auth.authenticate({ challenge: "c29tZXRoaW5nLWVsc2U" });
    await expect(
      verifyAuthenticationResponse({
        response: assertion,
        expectedChallenge: "ZXhwZWN0ZWQ",
        expectedOrigin: ORIGIN,
        expectedRPID: RP_ID,
        credential: { id: info.credential.id, publicKey: info.credential.publicKey, counter: 0 },
      }),
    ).rejects.toThrow();
  });
});
