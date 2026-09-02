import type {
  EmailDispatchStatus,
  EmailProvider,
  EmailTemplateKey,
  EmailTransportKind,
} from "@constructos/shared";
import type { Config } from "../config.js";

/**
 * Outbound email — the transport this platform has never had.
 *
 * Until now nothing on ConstructOS could send a message. `POST
 * /company/users/invite` creates a user, returns a temporary password to the
 * INVITER, and tells the invitee nothing at all; there is no verification
 * mail, no reset mail, and no way for a user to learn that their MFA changed.
 * An invitation that reaches nobody is worse than a refusal, because it looks
 * like it worked.
 *
 * ------------------------------------------------------------------------
 * THE RULE THIS FILE EXISTS TO ENFORCE
 * ------------------------------------------------------------------------
 * When no transport is configured, the platform SAYS SO. The no-op transport
 * records what it would have sent and returns `dispatched: false` with a
 * `reasons` array naming the environment variable that would fix it — the same
 * discipline benchmarks/metrics.ts applies to a figure it cannot compute:
 * never fabricate the result, return the absence with its reasons. A route
 * that invites somebody must put `deliveryReport(result)` in its response, so
 * the caller can see the message was recorded and not delivered.
 *
 * ------------------------------------------------------------------------
 * SHAPE
 * ------------------------------------------------------------------------
 * - `EmailTransport` is the interface every sender implements.
 * - `createRecordingTransport()` is the no-op: it records, it never sends, and
 *   it is what runs by default and in every test.
 * - `createHttpTransport()` is the real sender: a Resend/Postmark-shaped REST
 *   call behind an INJECTED `EmailHttpClient`, so the provider contract is
 *   unit-testable without a network. The injected-client idiom is the one
 *   integrations/dispatcher.ts already uses for webhooks.
 * - `createSmtpTransport()` is a documented adapter SLOT. No SMTP client ships
 *   in this repo (adding one means an npm dependency this work may not take),
 *   so it reports itself unavailable per message rather than pretending. It is
 *   still wired to config so the deployment surface is stable when an adapter
 *   is added.
 *
 * ------------------------------------------------------------------------
 * WHAT MUST NOT BE PERSISTED
 * ------------------------------------------------------------------------
 * A reset or invitation body contains a link with a LIVE token in it.
 * Persisting the body verbatim would undo the hash-only storage in
 * packages/db/src/schema/auth.ts one table over — a database reader could lift
 * the reset link straight out of the log. Every body that reaches
 * `email_dispatches` goes through `redactForStorage()` first. The usable link
 * exists in the composed message and, where no transport is configured, in the
 * transient API response; never at rest.
 */

/* ------------------------------------------------------------------ */
/* Message and result shapes                                           */
/* ------------------------------------------------------------------ */

export interface EmailAddress {
  email: string;
  name?: string | null;
}

export interface EmailMessage {
  to: EmailAddress;
  subject: string;
  /** plain-text body — always present; some recipients never render HTML */
  text: string;
  html: string;
  replyTo?: EmailAddress | null;
  /** which template produced this, carried through to the dispatch row */
  template?: EmailTemplateKey;
  /** provider-side tags for deliverability reporting; never secrets */
  tags?: Record<string, string>;
}

/**
 * The outcome of one send attempt.
 *
 * `dispatched` is the field callers must branch on, not `status`: a transport
 * that recorded a message and a transport that failed both leave the recipient
 * with nothing, and only `dispatched === true` means a provider accepted it.
 * `reasons` is non-empty whenever `dispatched` is false and empty whenever it
 * is true — the same contract as MetricComputation.
 */
export interface EmailSendResult {
  /** EmailDispatchStatus — recorded | sent | failed | suppressed */
  status: EmailDispatchStatus;
  transport: EmailTransportKind;
  provider: EmailProvider;
  /** true only when a provider accepted the message */
  dispatched: boolean;
  providerMessageId: string | null;
  /** why nothing reached the recipient; empty iff dispatched */
  reasons: string[];
  error: string | null;
  /** ISO instant of the attempt */
  at: string;
  /** rendered text body with token-bearing URLs redacted, ready to persist */
  redactedBody: string;
  subject: string;
  toEmail: string;
}

export interface EmailTransport {
  /** EmailTransportKind — noop | http | smtp */
  readonly kind: EmailTransportKind;
  readonly provider: EmailProvider;
  /** false when this transport cannot reach the outside world at all */
  readonly dispatches: boolean;
  /** one sentence an API response or a health check can return verbatim */
  describe(): string;
  /**
   * Attempt delivery. NEVER throws for a delivery failure — a failed send
   * returns `dispatched: false` with reasons, so a caller cannot accidentally
   * roll back an invitation that was correctly created just because the mail
   * provider was down. It throws only on programmer error.
   *
   * `secrets` are raw token values appearing in the body; they are redacted
   * out of `redactedBody` so the caller can persist the result safely.
   */
  send(message: EmailMessage, secrets?: readonly string[]): Promise<EmailSendResult>;
}

/** A message the no-op transport captured instead of sending. */
export interface RecordedEmail {
  at: string;
  to: EmailAddress;
  subject: string;
  /** the FULL text, links intact — in memory only, never persisted */
  text: string;
  html: string;
  template: EmailTemplateKey | null;
}

/** The no-op transport, plus the log that makes it useful in tests and dev. */
export interface RecordingEmailTransport extends EmailTransport {
  recorded(): RecordedEmail[];
  lastRecorded(): RecordedEmail | null;
  clear(): void;
}

/* ------------------------------------------------------------------ */
/* Redaction                                                           */
/* ------------------------------------------------------------------ */

export const REDACTED = "[redacted]";

/**
 * Blank out anything that looks like a credential in a query string:
 * `?token=…`, `&code=…`, `?secret=…`. Belt to `redactSecrets`' braces, which
 * catches the token whose exact value the caller knows.
 */
export function redactTokenParams(body: string): string {
  return body.replace(/([?&](?:token|code|secret|key|invite|t)=)[^\s&"'<>)]+/gi, `$1${REDACTED}`);
}

/** Replace known raw secret values wherever they appear, including in paths. */
export function redactSecrets(
  body: string,
  secrets: readonly (string | null | undefined)[],
): string {
  let out = body;
  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.length < 8) continue;
    out = out.split(secret).join(REDACTED);
  }
  return out;
}

/** What a caller persists: never the live link, always the shape of it. */
export function redactForStorage(
  body: string,
  secrets: readonly (string | null | undefined)[] = [],
): string {
  return redactTokenParams(redactSecrets(body, secrets));
}

/* ------------------------------------------------------------------ */
/* Link building                                                       */
/* ------------------------------------------------------------------ */

/**
 * Build an absolute link into the web app. Every message link goes through
 * here so a misconfigured APP_BASE_URL fails in one visible place rather than
 * producing five different flavours of localhost link in production mail.
 */
export function buildAppUrl(
  baseUrl: string,
  path: string,
  params: Record<string, string> = {},
): string {
  const base = baseUrl.replace(/\/+$/, "");
  const rel = path.startsWith("/") ? path : `/${path}`;
  const query = Object.entries(params)
    .filter(([, v]) => v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  return query ? `${base}${rel}?${query}` : `${base}${rel}`;
}

/**
 * Strip anything that could break out of a header. A display name or subject
 * carrying CR/LF is the classic header-injection vector: it appends headers of
 * the attacker's choosing (a second Bcc, say). Company and project names reach
 * these fields straight from user input, so they are sanitised at the boundary
 * rather than trusted.
 */
export function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n\u0000]+/g, " ").trim();
}

export function formatAddress(addr: EmailAddress): string {
  const email = sanitizeHeaderValue(addr.email);
  const name = sanitizeHeaderValue(addr.name ?? "");
  if (!name) return email;
  // Quote defensively: a display name containing a comma or angle bracket
  // splits the header and can redirect the message.
  return `"${name.replace(/["\\]/g, "")}" <${email}>`;
}

/* ------------------------------------------------------------------ */
/* Templates                                                           */
/* ------------------------------------------------------------------ */

export interface RenderedEmail {
  template: EmailTemplateKey;
  subject: string;
  text: string;
  html: string;
}

const APP_NAME = "ConstructOS";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * One plain layout for every message. Deliberately inline-styled and
 * table-free: enterprise mail clients strip <style> blocks, and a message that
 * arrives unreadable is a message that gets reported as phishing.
 */
function layout(heading: string, bodyHtml: string, footer?: string): string {
  return [
    `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;`,
    `font-size:15px;line-height:1.55;color:#1a1a1a;max-width:560px;margin:0 auto;padding:24px">`,
    `<h1 style="font-size:18px;margin:0 0 16px">${escapeHtml(heading)}</h1>`,
    bodyHtml,
    `<hr style="border:none;border-top:1px solid #e5e5e5;margin:28px 0 12px">`,
    `<p style="font-size:12px;color:#6b6b6b;margin:0">`,
    escapeHtml(footer ?? `Sent by ${APP_NAME}. If you were not expecting this, ignore it.`),
    `</p></div>`,
  ].join("");
}

function button(url: string, label: string): string {
  return (
    `<p style="margin:20px 0"><a href="${escapeHtml(url)}" ` +
    `style="background:#1a1a1a;color:#fff;text-decoration:none;padding:10px 18px;` +
    `border-radius:6px;display:inline-block">${escapeHtml(label)}</a></p>` +
    `<p style="font-size:12px;color:#6b6b6b;margin:0 0 8px">` +
    `Or paste this into your browser:<br><span style="word-break:break-all">` +
    `${escapeHtml(url)}</span></p>`
  );
}

export interface VerifyEmailVars {
  name: string;
  verifyUrl: string;
  expiresInHours: number;
}

export function renderVerifyEmail(vars: VerifyEmailVars): RenderedEmail {
  const subject = `Confirm your ${APP_NAME} email address`;
  const text = [
    `Hello ${vars.name},`,
    ``,
    `Confirm this address to finish setting up your ${APP_NAME} account:`,
    vars.verifyUrl,
    ``,
    `The link expires in ${vars.expiresInHours} hours and can be used once.`,
    `If you did not create an account, ignore this message — nothing will happen.`,
  ].join("\n");
  const html = layout(
    "Confirm your email address",
    `<p>Hello ${escapeHtml(vars.name)},</p>` +
      `<p>Confirm this address to finish setting up your ${APP_NAME} account.</p>` +
      button(vars.verifyUrl, "Confirm email address") +
      `<p style="font-size:13px;color:#6b6b6b">The link expires in ` +
      `${vars.expiresInHours} hours and can be used once.</p>`,
  );
  return { template: "verify_email", subject, text, html };
}

export interface PasswordResetVars {
  name: string;
  resetUrl: string;
  expiresInMinutes: number;
  /** where the request came from — the detail that makes a stranger's reset
   *  attempt recognisable to the account holder */
  requestIp?: string | null;
}

export function renderPasswordReset(vars: PasswordResetVars): RenderedEmail {
  const from = vars.requestIp ? ` The request came from ${vars.requestIp}.` : "";
  const subject = `Reset your ${APP_NAME} password`;
  const text = [
    `Hello ${vars.name},`,
    ``,
    `Someone asked to reset the password on this ${APP_NAME} account.${from}`,
    ``,
    vars.resetUrl,
    ``,
    `The link expires in ${vars.expiresInMinutes} minutes and can be used once.`,
    `If this was not you, no action is needed — your password has not changed.`,
  ].join("\n");
  const html = layout(
    "Reset your password",
    `<p>Hello ${escapeHtml(vars.name)},</p>` +
      `<p>Someone asked to reset the password on this ${APP_NAME} account.` +
      `${escapeHtml(from)}</p>` +
      button(vars.resetUrl, "Choose a new password") +
      `<p style="font-size:13px;color:#6b6b6b">The link expires in ` +
      `${vars.expiresInMinutes} minutes and can be used once. If this was not you, ` +
      `no action is needed — your password has not changed.</p>`,
  );
  return { template: "password_reset", subject, text, html };
}

export interface InvitationVars {
  /** may be blank: an invitation often precedes knowing the person's name */
  inviteeName?: string | null;
  inviterName: string;
  companyName: string;
  /** CompanyRole they will hold on acceptance */
  role: string;
  acceptUrl: string;
  expiresInDays: number;
  /** a note the inviter wrote; rendered escaped, never as markup */
  message?: string | null;
}

export function renderInvitation(vars: InvitationVars): RenderedEmail {
  const greeting = vars.inviteeName?.trim() ? `Hello ${vars.inviteeName.trim()},` : "Hello,";
  const subject = `${vars.inviterName} invited you to ${vars.companyName} on ${APP_NAME}`;
  const note = vars.message?.trim();
  const text = [
    greeting,
    ``,
    `${vars.inviterName} invited you to join ${vars.companyName} on ${APP_NAME} as ${vars.role}.`,
    ...(note ? [``, `"${note}"`] : []),
    ``,
    `Accept the invitation:`,
    vars.acceptUrl,
    ``,
    `The invitation expires in ${vars.expiresInDays} days.`,
    `If you do not know ${vars.inviterName}, ignore this message.`,
  ].join("\n");
  const html = layout(
    `You have been invited to ${vars.companyName}`,
    `<p>${escapeHtml(greeting)}</p>` +
      `<p>${escapeHtml(vars.inviterName)} invited you to join ` +
      `<strong>${escapeHtml(vars.companyName)}</strong> on ${APP_NAME} as ` +
      `${escapeHtml(vars.role)}.</p>` +
      (note
        ? `<blockquote style="margin:16px 0;padding:8px 14px;border-left:3px solid #e5e5e5;` +
          `color:#444">${escapeHtml(note)}</blockquote>`
        : "") +
      button(vars.acceptUrl, "Accept invitation") +
      `<p style="font-size:13px;color:#6b6b6b">The invitation expires in ` +
      `${vars.expiresInDays} days.</p>`,
  );
  return { template: "invitation", subject, text, html };
}

export interface MfaEnrolledVars {
  name: string;
  /** MfaMethod, in words */
  method: string;
  at: string;
  recoveryCodeCount: number;
  securityUrl: string;
}

export function renderMfaEnrolled(vars: MfaEnrolledVars): RenderedEmail {
  const subject = `Two-factor authentication is on for your ${APP_NAME} account`;
  const text = [
    `Hello ${vars.name},`,
    ``,
    `Two-factor authentication (${vars.method}) was enabled on your ${APP_NAME}`,
    `account at ${vars.at}. You were issued ${vars.recoveryCodeCount} recovery codes;`,
    `store them somewhere you can reach without this device.`,
    ``,
    `Review your security settings: ${vars.securityUrl}`,
    ``,
    `If you did not do this, someone else may control your account — reset your`,
    `password and sign out every device immediately.`,
  ].join("\n");
  const html = layout(
    "Two-factor authentication enabled",
    `<p>Hello ${escapeHtml(vars.name)},</p>` +
      `<p>Two-factor authentication (${escapeHtml(vars.method)}) was enabled on your ` +
      `${APP_NAME} account at ${escapeHtml(vars.at)}. You were issued ` +
      `${vars.recoveryCodeCount} recovery codes — store them somewhere you can reach ` +
      `without this device.</p>` +
      button(vars.securityUrl, "Review security settings") +
      `<p style="font-size:13px;color:#6b6b6b">If you did not do this, someone else may ` +
      `control your account: reset your password and sign out every device immediately.</p>`,
  );
  return { template: "mfa_enrolled", subject, text, html };
}

export interface NewDeviceSignInVars {
  name: string;
  deviceLabel: string;
  ip: string;
  at: string;
  /** best-effort, may be absent — never invent one */
  location?: string | null;
  securityUrl: string;
}

export function renderNewDeviceSignIn(vars: NewDeviceSignInVars): RenderedEmail {
  // No location is reported rather than guessed: "signed in from London" when
  // the platform does not know is worse than saying nothing, because the
  // account holder calibrates on it.
  const where = vars.location?.trim() ? `${vars.location.trim()} (${vars.ip})` : vars.ip;
  const subject = `New sign-in to your ${APP_NAME} account`;
  const text = [
    `Hello ${vars.name},`,
    ``,
    `Your ${APP_NAME} account was signed in to from a device we have not seen before.`,
    ``,
    `Device: ${vars.deviceLabel}`,
    `Address: ${where}`,
    `When: ${vars.at}`,
    ``,
    `If this was you, nothing to do. If it was not, sign out every device and change`,
    `your password: ${vars.securityUrl}`,
  ].join("\n");
  const html = layout(
    "New sign-in to your account",
    `<p>Hello ${escapeHtml(vars.name)},</p>` +
      `<p>Your ${APP_NAME} account was signed in to from a device we have not seen ` +
      `before.</p>` +
      `<ul style="padding-left:18px;color:#444">` +
      `<li>Device: ${escapeHtml(vars.deviceLabel)}</li>` +
      `<li>Address: ${escapeHtml(where)}</li>` +
      `<li>When: ${escapeHtml(vars.at)}</li></ul>` +
      button(vars.securityUrl, "Review sign-in activity") +
      `<p style="font-size:13px;color:#6b6b6b">If this was you, there is nothing to do.</p>`,
  );
  return { template: "new_device_sign_in", subject, text, html };
}

/* ------------------------------------------------------------------ */
/* The no-op transport — records, never sends, and says so             */
/* ------------------------------------------------------------------ */

/** Kept small; the log exists for tests and local development, not archival. */
const RECORD_LIMIT = 200;

const NO_TRANSPORT_REASON =
  "No email transport is configured: the message was composed and recorded, not " +
  "dispatched. Set EMAIL_PROVIDER (resend | postmark) with EMAIL_API_KEY and " +
  "EMAIL_FROM_ADDRESS to deliver it.";

/**
 * The default transport, and the one every test runs against.
 *
 * It exists so the platform can be HONEST rather than silent. The alternative
 * — swallowing the message and returning 201 — is what the invitation route
 * does today, and it is why an invited user is never heard from again.
 */
export function createRecordingTransport(): RecordingEmailTransport {
  const log: RecordedEmail[] = [];
  return {
    kind: "noop",
    provider: "none",
    dispatches: false,
    describe: () => NO_TRANSPORT_REASON,
    async send(message, secrets = []) {
      const at = new Date().toISOString();
      log.push({
        at,
        to: message.to,
        subject: sanitizeHeaderValue(message.subject),
        text: message.text,
        html: message.html,
        template: message.template ?? null,
      });
      if (log.length > RECORD_LIMIT) log.splice(0, log.length - RECORD_LIMIT);
      return {
        status: "recorded",
        transport: "noop",
        provider: "none",
        dispatched: false,
        providerMessageId: null,
        reasons: [NO_TRANSPORT_REASON],
        error: null,
        at,
        redactedBody: redactForStorage(message.text, secrets),
        subject: message.subject,
        toEmail: message.to.email,
      };
    },
    recorded: () => [...log],
    lastRecorded: () => log[log.length - 1] ?? null,
    clear: () => {
      log.length = 0;
    },
  };
}

/* ------------------------------------------------------------------ */
/* HTTP provider adapters (Resend / Postmark shape)                    */
/* ------------------------------------------------------------------ */

export interface EmailHttpResponse {
  status: number;
  body: string;
}

/**
 * The injected client. Same idiom as the webhook dispatcher: production wires
 * global fetch, tests wire a scripted responder, and the provider contract is
 * exercised without a network.
 */
export interface EmailHttpClient {
  post(
    url: string,
    body: string,
    headers: Record<string, string>,
  ): Promise<EmailHttpResponse>;
}

/** Production client: global fetch, bounded by a timeout, response capped. */
export function createFetchEmailClient(timeoutMs = 10_000, bodyLimit = 4_000): EmailHttpClient {
  return {
    async post(url, body, headers) {
      const res = await fetch(url, {
        method: "POST",
        body,
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
      let text = "";
      try {
        text = (await res.text()).slice(0, bodyLimit);
      } catch {
        text = "";
      }
      return { status: res.status, body: text };
    },
  };
}

/** A test double: a scripted responder plus the call log. */
export interface RecordedEmailCall {
  url: string;
  body: string;
  headers: Record<string, string>;
}

export function createStubEmailClient(
  respond: (call: RecordedEmailCall) => EmailHttpResponse,
): EmailHttpClient & { calls: RecordedEmailCall[] } {
  const calls: RecordedEmailCall[] = [];
  return {
    calls,
    async post(url, body, headers) {
      const call = { url, body, headers };
      calls.push(call);
      return respond(call);
    },
  };
}

interface ProviderAdapter {
  provider: Exclude<EmailProvider, "none" | "smtp">;
  defaultBaseUrl: string;
  path: string;
  headers(apiKey: string): Record<string, string>;
  body(message: EmailMessage, from: EmailAddress, replyTo: EmailAddress | null): string;
  /** pull the provider's message id out of a 2xx body; null if absent */
  messageId(body: string): string | null;
}

/**
 * Two adapters, one shape. Both providers accept a single JSON POST with an
 * API key in a header, which is why no npm dependency is needed for either;
 * the difference is field casing and the auth header, and that is all these
 * objects encode.
 */
const ADAPTERS: Record<"resend" | "postmark", ProviderAdapter> = {
  resend: {
    provider: "resend",
    defaultBaseUrl: "https://api.resend.com",
    path: "/emails",
    headers: (apiKey) => ({
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    }),
    body: (message, from, replyTo) =>
      JSON.stringify({
        from: formatAddress(from),
        to: [formatAddress(message.to)],
        subject: sanitizeHeaderValue(message.subject),
        text: message.text,
        html: message.html,
        ...(replyTo ? { reply_to: formatAddress(replyTo) } : {}),
        ...(message.tags
          ? { tags: Object.entries(message.tags).map(([name, value]) => ({ name, value })) }
          : {}),
      }),
    messageId: (body) => readJsonString(body, "id"),
  },
  postmark: {
    provider: "postmark",
    defaultBaseUrl: "https://api.postmarkapp.com",
    path: "/email",
    headers: (apiKey) => ({
      "x-postmark-server-token": apiKey,
      "content-type": "application/json",
      accept: "application/json",
    }),
    body: (message, from, replyTo) =>
      JSON.stringify({
        From: formatAddress(from),
        To: formatAddress(message.to),
        Subject: sanitizeHeaderValue(message.subject),
        TextBody: message.text,
        HtmlBody: message.html,
        ...(replyTo ? { ReplyTo: formatAddress(replyTo) } : {}),
        ...(message.template ? { Tag: message.template } : {}),
      }),
    messageId: (body) => readJsonString(body, "MessageID"),
  },
};

/** Read one top-level string field out of a provider response, tolerantly. */
function readJsonString(body: string, key: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object") {
      const value = (parsed as Record<string, unknown>)[key];
      if (typeof value === "string" && value !== "") return value;
    }
  } catch {
    /* a provider that answered 200 with a non-JSON body still delivered */
  }
  return null;
}

export interface HttpTransportOptions {
  provider: "resend" | "postmark";
  apiKey: string;
  from: EmailAddress;
  replyTo?: EmailAddress | null;
  /** override the provider host — self-hosted gateways and tests */
  baseUrl?: string;
  /** injected so the adapter is testable without a network */
  client?: EmailHttpClient;
}

export function createHttpTransport(options: HttpTransportOptions): EmailTransport {
  const adapter = ADAPTERS[options.provider];
  const client = options.client ?? createFetchEmailClient();
  const baseUrl = (options.baseUrl ?? adapter.defaultBaseUrl).replace(/\/+$/, "");
  const url = `${baseUrl}${adapter.path}`;
  const replyTo = options.replyTo ?? null;

  return {
    kind: "http",
    provider: adapter.provider,
    dispatches: true,
    describe: () =>
      `Email is dispatched through the ${adapter.provider} HTTP API as ` +
      `${formatAddress(options.from)}.`,
    async send(message, secrets = []) {
      const at = new Date().toISOString();
      const redactedBody = redactForStorage(message.text, secrets);
      const base = {
        transport: "http" as const,
        provider: adapter.provider,
        at,
        redactedBody,
        subject: message.subject,
        toEmail: message.to.email,
      };
      let res: EmailHttpResponse;
      try {
        res = await client.post(
          url,
          adapter.body(message, options.from, replyTo),
          adapter.headers(options.apiKey),
        );
      } catch (err) {
        // A transport-level failure is reported, never thrown: the record the
        // caller just created is valid, and the message can be re-sent.
        const error = err instanceof Error ? err.message : String(err);
        return {
          ...base,
          status: "failed",
          dispatched: false,
          providerMessageId: null,
          reasons: [`${adapter.provider} could not be reached: ${error}`],
          error,
        };
      }
      if (res.status < 200 || res.status >= 300) {
        // The provider body can echo the recipient address; it never contains
        // our tokens, but it is truncated and stored as an error, not a body.
        const detail = res.body.slice(0, 500);
        return {
          ...base,
          status: "failed",
          dispatched: false,
          providerMessageId: null,
          reasons: [`${adapter.provider} rejected the message with HTTP ${res.status}.`],
          error: detail === "" ? `HTTP ${res.status}` : detail,
        };
      }
      return {
        ...base,
        status: "sent",
        dispatched: true,
        providerMessageId: adapter.messageId(res.body),
        reasons: [],
        error: null,
      };
    },
  };
}

/* ------------------------------------------------------------------ */
/* SMTP — a documented adapter slot, not a pretend sender              */
/* ------------------------------------------------------------------ */

const SMTP_UNAVAILABLE =
  "EMAIL_PROVIDER=smtp is a configured but unimplemented adapter slot: this repo " +
  "ships no SMTP client (that needs an npm dependency), so the message was recorded " +
  "and not dispatched. Use EMAIL_PROVIDER=resend or postmark, which need no " +
  "dependency, or add an SMTP adapter behind createSmtpTransport().";

/**
 * The slot. It exists so the deployment surface (SMTP_HOST, SMTP_PORT,
 * SMTP_USERNAME, SMTP_PASSWORD, SMTP_SECURE) is stable and documented, and so
 * that adding a real adapter later is a change inside this function rather
 * than a change to config, .env.example and every caller.
 *
 * It records like the no-op and says exactly why. What it must never do is
 * return `dispatched: true` — an operator who configured SMTP and saw success
 * would stop looking for the mail that never arrived.
 */
export function createSmtpTransport(options: {
  host: string;
  port: number;
  username?: string | null;
  password?: string | null;
  secure: boolean;
  from: EmailAddress;
}): EmailTransport {
  void options;
  return {
    kind: "smtp",
    provider: "smtp",
    dispatches: false,
    describe: () => SMTP_UNAVAILABLE,
    async send(message, secrets = []) {
      return {
        status: "recorded",
        transport: "smtp",
        provider: "smtp",
        dispatched: false,
        providerMessageId: null,
        reasons: [SMTP_UNAVAILABLE],
        error: null,
        at: new Date().toISOString(),
        redactedBody: redactForStorage(message.text, secrets),
        subject: message.subject,
        toEmail: message.to.email,
      };
    },
  };
}

/* ------------------------------------------------------------------ */
/* Selection and reporting                                             */
/* ------------------------------------------------------------------ */

export interface TransportDeps {
  /** injected HTTP client for the provider adapters */
  client?: EmailHttpClient;
}

/**
 * Pick the transport the configuration describes. Unset — the state this
 * platform is in today — yields the recording transport, which is why nothing
 * silently disappears and every affected API response can say so.
 *
 * `loadConfig` has already refused a half-configured provider (a key with no
 * from-address, say), so anything reaching here is either complete or `none`.
 */
export function resolveEmailTransport(config: Config, deps: TransportDeps = {}): EmailTransport {
  const from: EmailAddress = {
    email: config.EMAIL_FROM_ADDRESS ?? "",
    name: config.EMAIL_FROM_NAME,
  };
  const replyTo: EmailAddress | null = config.EMAIL_REPLY_TO
    ? { email: config.EMAIL_REPLY_TO }
    : null;

  if (config.EMAIL_PROVIDER === "resend" || config.EMAIL_PROVIDER === "postmark") {
    if (!config.EMAIL_API_KEY || from.email === "") return createRecordingTransport();
    return createHttpTransport({
      provider: config.EMAIL_PROVIDER,
      apiKey: config.EMAIL_API_KEY,
      from,
      replyTo,
      baseUrl: config.EMAIL_API_BASE_URL,
      client: deps.client,
    });
  }
  if (config.EMAIL_PROVIDER === "smtp") {
    if (!config.SMTP_HOST) return createRecordingTransport();
    return createSmtpTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      username: config.SMTP_USERNAME ?? null,
      password: config.SMTP_PASSWORD ?? null,
      secure: config.SMTP_SECURE,
      from,
    });
  }
  return createRecordingTransport();
}

/**
 * What an API response says about a message.
 *
 * Routes that send (invite, reset, verify) MUST include this. A 201 with no
 * mention of delivery is the bug this whole file exists to fix: the caller
 * cannot tell an invitation that is on its way from one that will never
 * arrive. `dispatched:false` plus `reasons` is the honest answer, and it names
 * the environment variable that changes it.
 */
export interface EmailDeliveryReport {
  dispatched: boolean;
  status: EmailDispatchStatus;
  transport: EmailTransportKind;
  /** one sentence, safe to show a user */
  message: string;
  reasons: string[];
}

export function deliveryReport(result: EmailSendResult): EmailDeliveryReport {
  return {
    dispatched: result.dispatched,
    status: result.status,
    transport: result.transport,
    message: result.dispatched
      ? `Message sent to ${result.toEmail}.`
      : `Message for ${result.toEmail} was recorded but NOT dispatched.`,
    reasons: result.reasons,
  };
}

/**
 * The row to write into `email_dispatches`. Bodies are redacted here, once, so
 * no caller has to remember to do it.
 */
export interface EmailDispatchRow {
  template: EmailTemplateKey | null;
  toEmail: string;
  toName: string | null;
  subject: string;
  bodyPreview: string;
  status: EmailDispatchStatus;
  transport: EmailTransportKind;
  provider: string | null;
  providerMessageId: string | null;
  reasons: string[];
  error: string | null;
  dispatchedAt: string | null;
}

export function dispatchRow(
  message: EmailMessage,
  result: EmailSendResult,
): EmailDispatchRow {
  return {
    template: message.template ?? null,
    toEmail: result.toEmail,
    toName: message.to.name ?? null,
    subject: result.subject,
    bodyPreview: result.redactedBody,
    status: result.status,
    transport: result.transport,
    provider: result.provider === "none" ? null : result.provider,
    providerMessageId: result.providerMessageId,
    reasons: result.reasons,
    error: result.error,
    dispatchedAt: result.dispatched ? result.at : null,
  };
}
