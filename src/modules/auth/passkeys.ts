/**
 * Passkeys (Python app/auth/passkeys.py, spec/auth.md §3 "Passkeys") over @simplewebauthn/server.
 * Challenges live in `webauthn_challenges`; every ceremony consumes its challenge, and the success write is guarded
 * on the challenge still existing, so a challenge is single-use even under concurrency.
 */
import {
  type AuthenticationResponseJSON,
  type AuthenticatorTransport,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { Ctx } from "../../ctx.ts";
import { type AuthedBatch, abortUnless, isCondAbort, runBatch, toWire } from "../../db/batch.ts";
import { passkeys } from "../../db/schema/index.ts";
import { SETTINGS } from "../../env.ts";
import { b64urlEncode, randomBytes } from "../../lib/b64url.ts";
import { verifyPassword } from "../../lib/crypto/pbkdf2.ts";
import {
  badRequest,
  conflict,
  forbidden,
  isConstraintError,
  notFound,
  unauthorized,
} from "../../lib/errors.ts";
import { uuid7 } from "../../lib/uuid7.ts";
import * as repo from "./repo.ts";
import { describeAgent, internal, type Meta, type TokenPair } from "./service.ts";

const EXPIRED = "This passkey request expired. Try again.";
const DIDNT_WORK = "That passkey didn't work. Try again or use your password.";

type PasskeyRow = typeof passkeys.$inferSelect;

const passkeyOut = (p: PasskeyRow) => ({
  id: p.id,
  name: p.name,
  backed_up: p.backedUp,
  created_at: toWire(p.createdAt),
  last_used_at: toWire(p.lastUsedAt),
});

function uuidBytes(id: string): Uint8Array<ArrayBuffer> {
  const hex = id.replace(/-/g, "");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const transportsOf = (credential: Record<string, unknown>): string[] => {
  const t = (credential.response as { transports?: unknown } | undefined)?.transports;
  return Array.isArray(t) ? t.filter((x): x is string => typeof x === "string").slice(0, 8) : [];
};

export async function list(ctx: Ctx, authed: AuthedBatch) {
  const [, rows] = await authed.read(repo.listPasskeys(ctx.db, authed.userId));
  return rows.map(passkeyOut);
}

export async function registerOptions(ctx: Ctx, authed: AuthedBatch, body: { password: string }) {
  const [, users, existing] = await authed.read(
    repo.userById(ctx.db, authed.userId),
    repo.listPasskeys(ctx.db, authed.userId),
  );
  const u = users[0];
  if (u === undefined || !(await verifyPassword(u.hashedPassword, body.password, ctx.cfg.pepper))) {
    throw unauthorized(internal.BAD_PASSWORD);
  }
  if (existing.length >= SETTINGS.maxPasskeys) {
    throw conflict(`You can have up to ${SETTINGS.maxPasskeys} passkeys. Remove one first.`);
  }
  const now = ctx.clock.now();
  const raw = randomBytes(32) as Uint8Array<ArrayBuffer>;
  const challengeId = b64urlEncode(raw);
  const options = await generateRegistrationOptions({
    rpName: SETTINGS.webauthnRpName,
    rpID: ctx.cfg.rpId,
    userID: uuidBytes(u.id),
    userName: u.email,
    userDisplayName: u.email,
    challenge: raw,
    timeout: SETTINGS.webauthnChallengeSeconds * 1000,
    attestationType: "none",
    excludeCredentials: existing.map((p) => ({
      id: p.credentialId,
      transports: p.transports as AuthenticatorTransport[],
    })),
    authenticatorSelection: {
      residentKey: "required",
      requireResidentKey: true,
      userVerification: "required",
    },
  });
  await authed.write(
    repo.insertChallenge(
      ctx.db,
      {
        challenge: challengeId,
        userId: u.id,
        purpose: "register",
        expiresAt: now + SETTINGS.webauthnChallengeSeconds * 1000,
      },
      now,
    ),
  );
  return { challenge_id: challengeId, options };
}

export async function register(
  ctx: Ctx,
  authed: AuthedBatch,
  body: { challenge_id: string; credential: Record<string, unknown>; name?: string | null | undefined },
  meta: Meta,
) {
  const now = ctx.clock.now();
  const [, rows] = await authed.read(repo.challengeRow(ctx.db, body.challenge_id, "register"));
  const ch = rows[0];
  const drop = () => internal.commit(ctx, [repo.deleteChallenge(ctx.db, body.challenge_id)]);
  if (ch === undefined || ch.expiresAt < now || ch.userId !== authed.userId) {
    if (ch !== undefined) await drop();
    throw badRequest(EXPIRED);
  }
  let info: Awaited<ReturnType<typeof verifyRegistrationResponse>>["registrationInfo"];
  try {
    const v = await verifyRegistrationResponse({
      response: body.credential as unknown as RegistrationResponseJSON,
      expectedChallenge: body.challenge_id,
      expectedOrigin: ctx.cfg.passkeyOrigin,
      expectedRPID: ctx.cfg.rpId,
      requireUserVerification: true,
    });
    info = v.verified ? v.registrationInfo : undefined;
  } catch {
    info = undefined;
  }
  if (info === undefined) {
    await drop();
    throw badRequest("The passkey could not be verified");
  }
  const name = body.name?.trim() || `Passkey on ${describeAgent(meta.userAgent)}`.slice(0, 60);
  const passkeyId = uuid7(now);
  try {
    await authed.write(
      abortUnless(ctx.db, repo.challengeLive(body.challenge_id, "register", now)),
      repo.deleteChallenge(ctx.db, body.challenge_id),
      ctx.db.insert(passkeys).values({
        id: passkeyId,
        userId: authed.userId,
        credentialId: info.credential.id,
        publicKey: info.credential.publicKey,
        signCount: info.credential.counter,
        transports: transportsOf(body.credential),
        backedUp: info.credentialBackedUp,
        name,
        createdAt: now,
        updatedAt: now,
      }),
      internal.event(ctx, authed.userId, "passkey_added", meta, { name }),
    );
  } catch (err) {
    if (isCondAbort(err)) throw badRequest(EXPIRED);
    if (isConstraintError(err)) {
      await drop();
      throw conflict("That passkey is already registered");
    }
    throw err;
  }
  return {
    id: passkeyId,
    name,
    backed_up: info.credentialBackedUp,
    created_at: toWire(now),
    last_used_at: null,
  };
}

export async function rename(ctx: Ctx, authed: AuthedBatch, passkeyId: string, name: string) {
  const now = ctx.clock.now();
  const [rows] = await authed.write(
    ctx.db
      .update(passkeys)
      .set({ name: name.trim(), updatedAt: now })
      .where(repo.passkeyOwned(authed.userId, passkeyId))
      .returning(),
  );
  const row = rows[0];
  if (row === undefined) throw notFound("Passkey not found");
  return passkeyOut(row);
}

export async function remove(
  ctx: Ctx,
  authed: AuthedBatch,
  passkeyId: string,
  body: { password: string },
  meta: Meta,
) {
  const [, users, found] = await authed.read(
    repo.userById(ctx.db, authed.userId),
    repo.passkeyById(ctx.db, authed.userId, passkeyId),
  );
  const u = users[0];
  if (u === undefined || !(await verifyPassword(u.hashedPassword, body.password, ctx.cfg.pepper))) {
    throw unauthorized(internal.BAD_PASSWORD);
  }
  const p = found[0];
  if (p === undefined) throw notFound("Passkey not found");
  await authed.write(
    ctx.db.delete(passkeys).where(repo.passkeyOwned(authed.userId, passkeyId)),
    internal.event(ctx, authed.userId, "passkey_removed", meta, { name: p.name }),
  );
}

export async function signInOptions(ctx: Ctx) {
  const now = ctx.clock.now();
  const raw = randomBytes(32) as Uint8Array<ArrayBuffer>;
  const challengeId = b64urlEncode(raw);
  const options = await generateAuthenticationOptions({
    rpID: ctx.cfg.rpId,
    challenge: raw,
    timeout: SETTINGS.webauthnChallengeSeconds * 1000,
    userVerification: "required",
    allowCredentials: [],
  });
  await internal.commit(ctx, [
    repo.insertChallenge(
      ctx.db,
      {
        challenge: challengeId,
        userId: null,
        purpose: "sign_in",
        expiresAt: now + SETTINGS.webauthnChallengeSeconds * 1000,
      },
      now,
    ),
  ]);
  return { challenge_id: challengeId, options };
}

/** Usernameless sign-in. A passkey is a second factor in itself, so TOTP is not asked for (Python parity). */
export async function signIn(
  ctx: Ctx,
  body: { challenge_id: string; credential: Record<string, unknown> },
  meta: Meta,
): Promise<TokenPair> {
  const now = ctx.clock.now();
  const credId = body.credential.id;
  const lookupId = typeof credId === "string" && credId.length <= 1400 ? credId : "";
  const [challenges, found] = await runBatch(ctx.db, [
    repo.challengeRow(ctx.db, body.challenge_id, "sign_in"),
    repo.passkeyByCredential(ctx.db, lookupId),
  ] as const);
  const ch = challenges[0];
  const drop = () => internal.commit(ctx, [repo.deleteChallenge(ctx.db, body.challenge_id)]);
  if (ch === undefined || ch.expiresAt < now || ch.userId !== null) {
    if (ch !== undefined) await drop();
    throw badRequest(EXPIRED);
  }
  const p = found[0];
  const fail = async () => {
    await drop();
    await internal.recordFailure(ctx, "passkey", meta, p === undefined ? {} : { userId: p.userId });
    return unauthorized(DIDNT_WORK);
  };
  if (p === undefined) throw await fail();
  let auth: Awaited<ReturnType<typeof verifyAuthenticationResponse>>["authenticationInfo"] | undefined;
  try {
    const v = await verifyAuthenticationResponse({
      response: body.credential as unknown as AuthenticationResponseJSON,
      expectedChallenge: body.challenge_id,
      expectedOrigin: ctx.cfg.passkeyOrigin,
      expectedRPID: ctx.cfg.rpId,
      credential: {
        id: p.credentialId,
        publicKey: p.publicKey as Uint8Array<ArrayBuffer>,
        counter: p.signCount,
        transports: p.transports as AuthenticatorTransport[],
      },
      requireUserVerification: true,
    });
    auth = v.verified ? v.authenticationInfo : undefined;
  } catch {
    auth = undefined;
  }
  if (auth === undefined || !p.isActive) throw await fail();
  if (ctx.cfg.requireVerifiedEmail && !p.isVerified) {
    await drop();
    throw forbidden("Email address not verified");
  }
  const [hist] = await runBatch(ctx.db, [
    repo.loginHistory(ctx.db, { id: p.userId }, meta.userAgent),
  ] as const);
  try {
    return await internal.startSession(ctx, { id: p.userId, tokenVersion: p.tokenVersion }, meta, hist[0], [
      abortUnless(ctx.db, repo.challengeLive(body.challenge_id, "sign_in", now)),
      repo.deleteChallenge(ctx.db, body.challenge_id),
      ctx.db
        .update(passkeys)
        .set({
          signCount: auth.newCounter,
          backedUp: auth.credentialBackedUp,
          lastUsedAt: now,
          updatedAt: now,
        })
        .where(repo.passkeyOwned(p.userId, p.id)),
    ]);
  } catch (err) {
    if (isCondAbort(err)) throw badRequest(EXPIRED);
    throw err;
  }
}
