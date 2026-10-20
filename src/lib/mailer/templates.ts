/**
 * Transactional templates, copied verbatim from the Python `app/email.py` (spec/core.md §6.2). `{app_name}` is
 * "PaceStreak", not the old default "PaceStreak API" (intentional change, DESIGN.md §19).
 *
 * The HTML is table-based and fully inline-styled: email clients strip <style>/<link> inconsistently and cannot
 * load web fonts. Lime appears only as the button background and the top bar, never as text on white (contrast).
 */
import { SETTINGS } from "../../env.ts";
import type { Mailer, MailMessage } from "./index.ts";

const APP = SETTINGS.appName;

// A PNG on the live marketing site: SVG support in email clients is poor.
const LOGO_URL = "https://www.pacestreak.com/brand/logo-512.png";
const FONT_STACK = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const INK = "#16161a";
const DIM = "#5a5a63";
const LIME = "#d3ff3e";
const BORDER = "#e7e7ea";

/** Python `html.escape(s, quote=True)`. */
export function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#x27;");
}

function buttonHtml(text: string, url: string): string {
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:28px 0;">
      <tr>
        <td style="border-radius:8px;background-color:${LIME};">
          <a href="${escapeHtml(url)}" target="_blank"
             style="display:inline-block;padding:14px 28px;font-family:${FONT_STACK};
                    font-size:16px;font-weight:700;color:${INK};text-decoration:none;
                    border-radius:8px;">
            ${escapeHtml(text)}
          </a>
        </td>
      </tr>
    </table>`;
}

export interface HtmlTemplate {
  preheader: string;
  heading: string;
  /** Already-safe <p> blocks: callers escape interpolated values (`p()` does). */
  bodyHtml: string;
  buttonText?: string;
  buttonUrl?: string;
  /** Trusted literal text; not escaped (Python parity). */
  footerNote?: string;
}

export function htmlTemplate(t: HtmlTemplate): string {
  const button = t.buttonText && t.buttonUrl ? buttonHtml(t.buttonText, t.buttonUrl) : "";
  const extraNote = t.footerNote
    ? `<p style="margin:0 0 8px;font-family:${FONT_STACK};font-size:12px;` +
      `line-height:18px;color:${DIM};">${t.footerNote}</p>`
    : "";
  const safePreheader = escapeHtml(t.preheader);
  const safeHeading = escapeHtml(t.heading);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${safeHeading}</title>
  </head>
  <body style="margin:0;padding:0;background-color:#f4f4f5;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;">
      ${safePreheader}
    </div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
           style="background-color:#f4f4f5;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"
                 style="max-width:600px;width:100%;background-color:#ffffff;
                        border:1px solid ${BORDER};border-radius:12px;overflow:hidden;">
            <tr>
              <td style="background-color:${LIME};height:4px;line-height:4px;font-size:0;">
                &nbsp;</td>
            </tr>
            <tr>
              <td style="padding:28px 32px 0;">
                <img src="${LOGO_URL}" width="36" height="36" alt="PaceStreak"
                     style="display:block;height:36px;width:36px;border:0;">
              </td>
            </tr>
            <tr>
              <td style="padding:20px 32px 8px;">
                <h1 style="margin:0;font-family:${FONT_STACK};font-size:20px;
                           line-height:28px;color:${INK};font-weight:700;">
                  ${safeHeading}
                </h1>
              </td>
            </tr>
            <tr>
              <td style="padding:8px 32px 4px;font-family:${FONT_STACK};font-size:15px;
                         line-height:23px;color:${INK};">
                ${t.bodyHtml}
                ${button}
              </td>
            </tr>
            <tr>
              <td style="padding:24px 32px 28px;border-top:1px solid ${BORDER};margin-top:8px;">
                <p style="margin:20px 0 8px;font-family:${FONT_STACK};font-size:14px;
                          line-height:20px;color:${INK};">
                  &mdash; PaceStreak
                </p>
                ${extraNote}
                <p style="margin:0;font-family:${FONT_STACK};font-size:12px;
                          line-height:18px;color:${DIM};">
                  Automated, transactional message from
                  <a href="https://www.pacestreak.com" style="color:${DIM};">pacestreak.com</a>.
                  You don't need to reply.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

/** Escape and wrap one paragraph of plain text. */
export function p(text: string): string {
  return `<p style="margin:0 0 16px;">${escapeHtml(text)}</p>`;
}

/** A large monospaced code, digits spaced out (`1 2 3 4 5 6`) for legibility. */
function codeHtml(code: string): string {
  const spaced = escapeHtml([...code].join(" "));
  return (
    '<p style="margin:0 0 16px;text-align:center;">' +
    '<span style="display:inline-block;padding:12px 20px;font-family:monospace;' +
    `font-size:28px;letter-spacing:4px;font-weight:bold;">${spaced}</span></p>`
  );
}

export function verificationEmail(to: string, code: string): MailMessage {
  const hours = SETTINGS.emailVerifyTokenHours;
  return {
    to,
    subject: `Confirm your ${APP} email address`,
    text:
      `Your verification code is: ${code}\n\n` +
      `Enter it in the app to confirm your address. It expires in ${hours} hours.\n` +
      "If you did not create this account, ignore this message.",
    html: htmlTemplate({
      preheader: "Your PaceStreak verification code.",
      heading: "Confirm your email address",
      bodyHtml:
        p("Enter this code in the app to confirm your address.") +
        codeHtml(code) +
        p(`This code expires in ${hours} hours. If you did not create this account, ignore this message.`),
      footerNote: "You're receiving this because someone used this address on PaceStreak.",
    }),
  };
}

export function passwordResetEmail(to: string, code: string): MailMessage {
  const minutes = SETTINGS.passwordResetTokenMinutes;
  return {
    to,
    subject: `Reset your ${APP} password`,
    text:
      `Your password reset code is: ${code}\n\n` +
      `Enter it in the app to choose a new password. It expires in ${minutes} minutes and can be used once.\n` +
      "If you did not request this, ignore this message - your password has not changed.",
    html: htmlTemplate({
      preheader: "Your PaceStreak password reset code.",
      heading: "Reset your password",
      bodyHtml:
        p("Enter this code in the app to choose a new password.") +
        codeHtml(code) +
        p(
          `This code expires in ${minutes} minutes and can be used once. If you did not request this, ` +
            "ignore this message - your password has not changed.",
        ),
    }),
  };
}

/** Sent after any password change: how someone learns their account was taken over without an email change. */
export function passwordChangedEmail(to: string, frontendUrl: string): MailMessage {
  return {
    to,
    subject: `Your ${APP} password was changed`,
    text:
      "Your password was just changed and all other sessions were signed out.\n\n" +
      "If this was not you, reset your password immediately.",
    html: htmlTemplate({
      preheader: "Your PaceStreak password was just changed.",
      heading: "Your password was changed",
      bodyHtml:
        p("Your password was just changed and all other sessions were signed out.") +
        p("If this was not you, reset your password immediately."),
      buttonText: "Reset password",
      buttonUrl: `${frontendUrl}/reset-password`,
    }),
  };
}

export function emailChangeEmail(to: string, code: string): MailMessage {
  const hours = SETTINGS.emailChangeTokenHours;
  return {
    to,
    subject: `Confirm your new ${APP} email address`,
    text:
      `Your confirmation code is: ${code}\n\n` +
      `Enter it in the app to use this address for your ${APP} account. It expires in ${hours} hours.\n` +
      "If you didn't ask for this, ignore this message; nothing has changed.",
    html: htmlTemplate({
      preheader: `Confirm this address for your ${APP} account.`,
      heading: "Confirm your new email address",
      bodyHtml:
        p(`Enter this code in the app to use this address for your ${APP} account.`) +
        codeHtml(code) +
        p(
          `This code expires in ${hours} hours. If you didn't ask for this, ignore this message; nothing has changed.`,
        ),
    }),
  };
}

/**
 * The second step of a password sign-in. The code is in the body only: subjects show on lock screens and in
 * notification previews, so a code there would be readable without unlocking anything.
 */
export function loginCodeEmail(to: string, code: string, device: string): MailMessage {
  const minutes = SETTINGS.loginCodeMinutes;
  return {
    to,
    subject: `Your ${APP} sign-in code`,
    text:
      `Your sign-in code is: ${code}\n\n` +
      `Someone signed in to your ${APP} account with your password from ${device}. ` +
      `Enter the code to finish. It expires in ${minutes} minutes and can be used once.\n` +
      "If this was not you, change your password now: someone knows it.",
    html: htmlTemplate({
      preheader: "Enter this code to finish signing in.",
      heading: "Finish signing in",
      bodyHtml:
        p(
          `Someone signed in to your ${APP} account with your password from ${device}. Enter this code to finish.`,
        ) +
        codeHtml(code) +
        p(
          `This code expires in ${minutes} minutes and can be used once. If this was not you, change your password ` +
            "now: someone knows it.",
        ),
    }),
  };
}

/** To the old address: the only warning someone gets if their account was moved away from them. */
export function emailChangedNotice(oldAddress: string, newAddress: string): MailMessage {
  return {
    to: oldAddress,
    subject: `Your ${APP} email address was changed`,
    text: `Your account now uses ${newAddress}. If this wasn't you, reply to this email straight away and we will help you get it back.`,
    html: htmlTemplate({
      preheader: "Your PaceStreak account email address was changed.",
      heading: "Your email address was changed",
      bodyHtml:
        p(`Your account now uses ${newAddress}.`) +
        p("If this wasn't you, reply to this email straight away and we will help you get it back."),
    }),
  };
}

export const sendVerificationEmail = (m: Mailer, to: string, code: string) =>
  m.send(verificationEmail(to, code));
export const sendPasswordResetEmail = (m: Mailer, to: string, code: string) =>
  m.send(passwordResetEmail(to, code));
export const sendPasswordChangedEmail = (m: Mailer, to: string, frontendUrl: string) =>
  m.send(passwordChangedEmail(to, frontendUrl));
export const sendEmailChangeEmail = (m: Mailer, to: string, code: string) =>
  m.send(emailChangeEmail(to, code));
export const sendEmailChangedNotice = (m: Mailer, oldAddress: string, newAddress: string) =>
  m.send(emailChangedNotice(oldAddress, newAddress));
export const sendLoginCodeEmail = (m: Mailer, to: string, code: string, device: string) =>
  m.send(loginCodeEmail(to, code, device));
