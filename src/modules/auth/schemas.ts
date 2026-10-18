/** Request schemas (Python app/auth/schemas.py and passkeys.py). Objects are non-strict, like pydantic. */
import * as z from "zod";

const email = z.email();
const password = z.string().min(16).max(256);
const anyPassword = z.string().min(1).max(256);
const sixDigits = z
  .string()
  .min(6)
  .max(6)
  .regex(/^\d{6}$/);
const turnstile = z.string().nullable().optional();

export const Credentials = z.object({ email, password, turnstile_token: turnstile });
export const EmailIn = z.object({ email, turnstile_token: turnstile });
export const EmailCode = z.object({ email, code: sixDigits });
export const ResetPassword = z.object({ email, code: sixDigits, new_password: password });
export const ChangePassword = z.object({ current_password: anyPassword, new_password: password });
export const SessionParam = z.object({ session_id: z.uuid() });
export const TotpWithPassword = z.object({ password: anyPassword, code: z.string().min(6).max(10) });
export const TotpCode = z.object({ code: z.string().min(6).max(10) });
export const MfaVerify = z.object({
  mfa_token: z.string().min(1).max(4096),
  code: z.string().min(6).max(11),
});
export const Recover = z.object({
  email,
  recovery_code: z.string().min(6).max(64),
  new_password: password,
  turnstile_token: turnstile,
});
export const ChangeEmail = z.object({ password: anyPassword, new_email: email });

// ---- passkeys ----
export const PasswordOnly = z.object({ password: anyPassword });
export const RegisterPasskey = z.object({
  challenge_id: z.string().max(128),
  credential: z.record(z.string(), z.unknown()),
  name: z.string().max(60).nullable().optional(),
});
export const RenamePasskey = z.object({ name: z.string().min(1).max(60) });
export const PasskeyParam = z.object({ passkey_id: z.uuid() });
export const PasskeySignIn = z.object({
  challenge_id: z.string().max(128),
  credential: z.record(z.string(), z.unknown()),
});

export type CredentialsIn = z.output<typeof Credentials>;
