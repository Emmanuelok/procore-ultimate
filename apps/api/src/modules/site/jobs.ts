/**
 * Scheduler jobs for site operations. Each job is the same service a button
 * calls, run for every tenant with the system actor and idempotent: a
 * condition already signalled is never raised twice, and every status change
 * is guarded by the status it moves from.
 *
 *   site.lone-worker          5 min    missed check-ins → overdue → escalated
 *   site.confined-space       5 min    people overdue out of a permitted space
 *   site.permit-expiry       15 min    permits that lapsed while still open
 *   site.exclusion-zones     15 min    zones past their active window
 *   site.access-credentials  6 hourly  induction/pass expiry, pass without induction
 *   site.overstay            hourly    still on the register after a full shift+
 *
 * The two life-safety sweeps run at five minutes because a lone worker who is
 * an hour late is not a notification, they are an incident.
 */
import type { FastifyInstance } from "fastify";
import { forEachCompany } from "../../lib/scheduler.js";
import {
  sweepAccessCredentials,
  sweepExclusionZones,
  sweepLoneWorkers,
  sweepOverstays,
  sweepPermitEntries,
  sweepPermitExpiry,
} from "./service.js";

export function registerSiteJobs(app: FastifyInstance): void {
  app.scheduler.register({
    name: "site.lone-worker",
    description:
      "Detect missed lone-worker check-ins: overdue on the first miss, escalated with a critical signal and a notification once a whole check-in interval has passed",
    everyMs: 5 * 60_000,
    runOnBoot: true,
    run: async ({ db, now }) => forEachCompany(db, (companyId) => sweepLoneWorkers(db, companyId, now)),
  });

  app.scheduler.register({
    name: "site.confined-space",
    description:
      "Find people still recorded inside a permitted space past their expected exit time and raise a signal naming them",
    everyMs: 5 * 60_000,
    runOnBoot: true,
    run: async ({ db, now }) => forEachCompany(db, (companyId) => sweepPermitEntries(db, companyId, now)),
  });

  app.scheduler.register({
    name: "site.permit-expiry",
    description:
      "Expire permits to work whose validity window closed while they were still requested, approved, active or suspended",
    everyMs: 15 * 60_000,
    runOnBoot: true,
    run: async ({ db, now }) => forEachCompany(db, (companyId) => sweepPermitExpiry(db, companyId, now)),
  });

  app.scheduler.register({
    name: "site.exclusion-zones",
    description: "Lift exclusion zones whose active window has closed so the plan of the site stays true",
    everyMs: 15 * 60_000,
    runOnBoot: true,
    run: async ({ db, now }) => forEachCompany(db, (companyId) => sweepExclusionZones(db, companyId, now)),
  });

  app.scheduler.register({
    name: "site.access-credentials",
    description:
      "Expire inductions and site passes that have run out, and flag every active pass standing on an induction that is not valid",
    everyMs: 6 * 60 * 60_000,
    runOnBoot: true,
    run: async ({ db, now }) => forEachCompany(db, (companyId) => sweepAccessCredentials(db, companyId, now)),
  });

  app.scheduler.register({
    name: "site.overstay",
    description:
      "Flag anyone the gate register still holds on site more than sixteen hours after their entry — the platform never invents the missing exit",
    everyMs: 60 * 60_000,
    runOnBoot: true,
    run: async ({ db, now }) => forEachCompany(db, (companyId) => sweepOverstays(db, companyId, now)),
  });
}
