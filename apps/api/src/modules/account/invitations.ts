import type { FastifyInstance } from "fastify";
import { and, desc, eq, inArray, lte } from "drizzle-orm";
import { authSecurityEvents, userInvitations } from "@constructos/db";
import type { CompanyRole } from "@constructos/shared";
import { buildAppUrl, renderInvitation, type EmailDeliveryReport } from "../../lib/email.js";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import { dispatchEmail } from "./mailer.js";
import { recordAuthEvent } from "./events.js";
import { hashToken, mintToken } from "./tokens.js";
import type { RequestContext } from "./sessions.js";

/**
 * Invitations that exist as records, not as a temporary password read out over
 * the phone.
 *
 * WHAT WAS WRONG BEFORE. `POST /company/users/invite` created the account,
 * generated a password, returned it to the INVITER, and sent nothing. Three
 * problems in one route: the invited person is never told they exist, the
 * administrator ends up holding a live credential for someone else's account,
 * and the API reports success for a message that was never composed.
 *
 * WHAT THIS ADDS. A hashed single-use token with an expiry, a dispatch that is
 * recorded whether or not anything left the building, and an acceptance step
 * that sets the invitee's OWN password — which is what finally retires the
 * temporary one the administrator was given.
 *
 * THE SEGREGATION RULE. `accepted_user_id` may not equal `invited_by`: nobody
 * invites themselves into a role. It is the same rule the rest of this
 * platform applies to approvals and verifications, and it is checked at
 * acceptance because that is the moment authority is actually granted.
 *
 * EXPIRY IS SWEPT LAZILY on the list read — idempotent, never a cron, so the
 * register and the person reading it can never disagree.
 */

export type InvitationRow = typeof userInvitations.$inferSelect;

export interface InvitationCreateInput {
  companyId: string;
  companyName: string;
  invitedBy: string;
  inviterName: string;
  email: string;
  name?: string | null;
  role: CompanyRole;
  templateKey?: string | null;
  projectIds?: string[];
  message?: string | null;
  /** true when this invitation is what brought the account into existence */
  createdAccount?: boolean;
  nowMs?: number;
}

export interface InvitationIssued {
  invitation: InvitationRow;
  /** shown once: the link an administrator may pass on by hand */
  acceptUrl: string;
  delivery: EmailDeliveryReport;
  dispatchId: string | null;
}

/**
 * Create the invitation, supersede any earlier live one for the same address,
 * and send it.
 */
export async function createInvitation(
  app: FastifyInstance,
  ctx: RequestContext,
  input: InvitationCreateInput,
): Promise<InvitationIssued> {
  const nowMs = input.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();

  // One live invitation per address per company: a second link in a second
  // inbox is a second way in that nobody is tracking.
  await app.db
    .update(userInvitations)
    .set({ status: "revoked", revokedAt: nowIso, revokedBy: input.invitedBy, updatedAt: nowIso })
    .where(
      and(
        eq(userInvitations.companyId, input.companyId),
        eq(userInvitations.email, input.email),
        eq(userInvitations.status, "pending"),
      ),
    );

  const token = mintToken();
  const id = newId("inv");
  const expiresAt = new Date(
    nowMs + app.appConfig.INVITATION_TTL_DAYS * 24 * 3600 * 1000,
  ).toISOString();
  await app.db.insert(userInvitations).values({
    id,
    companyId: input.companyId,
    email: input.email,
    name: input.name ?? null,
    role: input.role,
    templateKey: input.templateKey ?? null,
    projectIds: input.projectIds ?? [],
    message: input.message ?? null,
    tokenHash: token.hash,
    tokenPrefix: token.prefix,
    status: "pending",
    expiresAt,
    invitedBy: input.invitedBy,
  });

  await appendLedger(app.db, {
    companyId: input.companyId,
    actorId: input.invitedBy,
    action: "create",
    objectType: "user_invitation",
    objectId: id,
    payload: {
      email: input.email,
      role: input.role,
      expiresAt,
      createdAccount: input.createdAccount === true,
    },
  });

  const [row] = await app.db
    .select()
    .from(userInvitations)
    .where(eq(userInvitations.id, id))
    .limit(1);

  const sent = await sendInvitation(app, ctx, {
    invitation: row!,
    rawToken: token.raw,
    inviterName: input.inviterName,
    companyName: input.companyName,
    createdAccount: input.createdAccount === true,
    nowMs,
  });

  return {
    invitation: sent.invitation,
    acceptUrl: sent.acceptUrl,
    delivery: sent.delivery,
    dispatchId: sent.dispatchId,
  };
}

export interface InvitationSendInput {
  invitation: InvitationRow;
  rawToken: string;
  inviterName: string;
  companyName: string;
  /** carried into the trail — see invitationCreatedAccount() */
  createdAccount?: boolean;
  nowMs?: number;
}

/** Compose, dispatch, record — and bump the send counters either way. */
export async function sendInvitation(
  app: FastifyInstance,
  ctx: RequestContext,
  input: InvitationSendInput,
): Promise<InvitationIssued> {
  const nowMs = input.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const invitation = input.invitation;
  const acceptUrl = buildAppUrl(app.appConfig.APP_BASE_URL, "/invitations/accept", {
    token: input.rawToken,
  });
  const expiresInDays = Math.max(
    1,
    Math.ceil((Date.parse(invitation.expiresAt) - nowMs) / (24 * 3600 * 1000)),
  );
  const rendered = renderInvitation({
    inviteeName: invitation.name,
    inviterName: input.inviterName,
    companyName: input.companyName,
    role: invitation.role,
    acceptUrl,
    expiresInDays,
    message: invitation.message,
  });
  const outcome = await dispatchEmail(app, {
    message: {
      to: { email: invitation.email, name: invitation.name ?? null },
      ...rendered,
    },
    secrets: [input.rawToken],
    companyId: invitation.companyId,
    variables: { role: invitation.role, expiresAt: invitation.expiresAt, acceptUrl },
    relatedType: "user_invitation",
    relatedId: invitation.id,
  });

  const [updated] = await app.db
    .update(userInvitations)
    .set({
      sendCount: invitation.sendCount + 1,
      lastSentAt: nowIso,
      lastDispatchId: outcome.dispatchId,
      updatedAt: nowIso,
    })
    .where(eq(userInvitations.id, invitation.id))
    .returning();

  await recordAuthEvent(app.db, {
    kind: "invitation_sent",
    outcome: outcome.result.dispatched ? "success" : "pending",
    companyId: invitation.companyId,
    userId: invitation.invitedBy,
    email: invitation.email,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    reason: outcome.result.reasons[0] ?? null,
    metadata: {
      invitationId: invitation.id,
      dispatchId: outcome.dispatchId,
      role: invitation.role,
      createdAccount: input.createdAccount === true,
    },
  });

  return {
    invitation: updated ?? invitation,
    acceptUrl,
    delivery: outcome.report,
    dispatchId: outcome.dispatchId,
  };
}

/**
 * Move every pending invitation whose expiry has passed to `expired`.
 *
 * Lazy and idempotent: it runs on the list read, changes nothing on a second
 * pass, and needs no scheduler. The SQL comparison is a TIMESTAMP comparison
 * (the bound parameter is cast by Postgres), never a string one — see
 * lib/time.ts for what that costs when it is got wrong.
 */
export async function sweepExpiredInvitations(
  app: FastifyInstance,
  companyId: string | null,
  nowMs = Date.now(),
): Promise<number> {
  const nowIso = new Date(nowMs).toISOString();
  const stale = await app.db
    .select({ id: userInvitations.id })
    .from(userInvitations)
    .where(
      and(
        companyId ? eq(userInvitations.companyId, companyId) : undefined,
        eq(userInvitations.status, "pending"),
        lte(userInvitations.expiresAt, nowIso),
      ),
    );
  if (stale.length === 0) return 0;
  await app.db
    .update(userInvitations)
    .set({ status: "expired", updatedAt: nowIso })
    .where(inArray(userInvitations.id, stale.map((s) => s.id)));
  return stale.length;
}

export async function loadInvitationByToken(
  app: FastifyInstance,
  rawToken: string,
): Promise<InvitationRow | null> {
  const [row] = await app.db
    .select()
    .from(userInvitations)
    .where(eq(userInvitations.tokenHash, hashToken(rawToken)))
    .limit(1);
  return row ?? null;
}

export interface InvitationProblem {
  usable: boolean;
  reasons: string[];
}

/**
 * Why an invitation cannot be used — every reason at once, and never a
 * different shape for "no such token" than for "already accepted", because the
 * token is the only secret and a probe should learn nothing from the wording.
 */
export function invitationUsable(
  invitation: InvitationRow | null,
  nowMs = Date.now(),
): InvitationProblem {
  if (!invitation) return { usable: false, reasons: ["This invitation link is not valid."] };
  const reasons: string[] = [];
  if (invitation.status === "accepted") reasons.push("This invitation has already been accepted.");
  if (invitation.status === "revoked") reasons.push("This invitation was revoked.");
  if (invitation.status === "expired" || Date.parse(invitation.expiresAt) <= nowMs) {
    reasons.push("This invitation has expired. Ask for a new one.");
  }
  return { usable: reasons.length === 0, reasons };
}

/** The invitation as an administrator sees it: no token, ever. */
export function invitationView(row: InvitationRow) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    templateKey: row.templateKey,
    projectIds: row.projectIds,
    status: row.status,
    expiresAt: row.expiresAt,
    invitedBy: row.invitedBy,
    acceptedAt: row.acceptedAt,
    acceptedUserId: row.acceptedUserId,
    revokedAt: row.revokedAt,
    revokedBy: row.revokedBy,
    sendCount: row.sendCount,
    lastSentAt: row.lastSentAt,
    lastDispatchId: row.lastDispatchId,
    /** identification without capability — support can match a link to a row */
    tokenPrefix: row.tokenPrefix,
    createdAt: row.createdAt,
  };
}

/**
 * Did THIS invitation create the account it points at?
 *
 * It decides whether the accept link may set a password, and it is the reason
 * the flow cannot be exploited by an administrator. Consider the alternative:
 * with no transport configured the accept link is handed back to the INVITER,
 * so an administrator who invites `someone@another-company.example` — an
 * address that already has an account here — would hold a link that resets a
 * stranger's password. That is a privilege escalation dressed as an invitation.
 *
 * So the rule is: an invitation may set a password only for the account it
 * brought into existence. Anyone else must sign in to accept, and the raw link
 * is never returned to the inviter for an account they did not create.
 *
 * The fact is read back from the security trail rather than stored on the
 * invitation, because `user_invitations` has no column for it and the trail is
 * where "what happened when this was issued" belongs. If the trail row is
 * missing the answer is NO — the safe direction: acceptance then requires
 * proof of the existing password.
 */
export async function invitationCreatedAccount(
  app: FastifyInstance,
  invitation: InvitationRow,
): Promise<boolean> {
  const rows = await app.db
    .select({ metadata: authSecurityEvents.metadata })
    .from(authSecurityEvents)
    .where(
      and(
        eq(authSecurityEvents.kind, "invitation_sent"),
        eq(authSecurityEvents.email, invitation.email),
      ),
    )
    .orderBy(desc(authSecurityEvents.at))
    .limit(50);
  for (const row of rows) {
    const meta = row.metadata as Record<string, unknown>;
    if (meta["invitationId"] === invitation.id) return meta["createdAccount"] === true;
  }
  return false;
}
