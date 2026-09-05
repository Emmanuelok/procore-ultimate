/**
 * RESOURCE PLANNING & PRODUCTIVITY (spec Vol I §5.1–5.2, #676–699) — tool key
 * `resources`.
 *
 * WHAT THIS MODULE IS. A project runs out of people and plant weeks before it
 * runs out of money, and the failure is visible in three places long before it
 * is visible in the cost report:
 *
 *   1. DEMAND vs SUPPLY, BY WEEK AND BY TRADE. A plan derived from the
 *      programme (#676–681), the supply the project has actually said it can
 *      field, and the histogram of the two (#682–685) with levelling
 *      suggestions that name the float-bearing activity to move (#686–687).
 *      Change the programme, re-derive, and the histogram moves — which is
 *      the only way a resourcing conversation stays honest as dates slip.
 *
 *   2. WHO IS BOOKED WHERE. A calendar of crews, workers and machines against
 *      activities (#688–689), with double bookings DETECTED rather than
 *      refused (#690): both bookings are usually real and the argument is
 *      about which gives way, so refusing the second would lose the
 *      requirement it represents.
 *
 *   3. HOURS BOUGHT vs HOURS EARNED. Productivity from coded timecard
 *      allocations by trade, crew and week (#691–693), achieved unit rates
 *      against planned (#694), utilisation (#695), hours at completion by four
 *      named methods (#696), and the measured-mile comparison the forensics
 *      module builds a disruption claim on (#697–699). Snapshots are kept
 *      because the live figure silently rewrites itself every time an old
 *      timecard is corrected.
 *
 * Plus the skills and certification matrix (#692–696): what each worker on the
 * register holds, who checked it, when it lapses, and who is booked onto work
 * that needs a ticket they do not have.
 *
 * WHAT IT DELIBERATELY DOES NOT DO.
 *   · It keeps NO second register of people, crews, machines or activities.
 *     Workers are `workers` (workforce.ts), crews and hours are
 *     `crews`/`timecards` (timecards.ts), plant is `equipment`
 *     (equipment.ts), activities are `schedule_tasks` (schedule.ts). This
 *     module holds the PLAN, the BOOKING and the MEASUREMENT on top of them.
 *   · It does not move the programme. Levelling SUGGESTS; the move is a
 *     schedule change made in the schedule module.
 *   · It does not convert between units, or between one trade's hours and
 *     another's. A crane hour does not cover a joiner hour.
 *   · It does not invent a standard working day. A resource type with no
 *     `standardHoursPerDay` reports headcount as unknown rather than dividing
 *     by an assumed eight.
 *
 * NULL IS A FIRST-CLASS ANSWER THROUGHOUT. A week with no recorded
 * availability has UNKNOWN supply, not zero supply. Hours with no installed
 * quantity are spent, not unproductive. A project with no plan has an unknown
 * coverage gap, not a perfect one. Every null carries the reason.
 *
 * Schema: packages/db/src/schema/resources.ts —
 *   resource_types, resource_plans, resource_demands, resource_availability,
 *   resource_assignments, resource_productivity_snapshots, resource_forecasts,
 *   resource_skills, worker_skills.
 *
 * Route surface, all under `/api/v1`:
 *   /resource-types                                  company library (+ /:id)
 *   /resource-skills                                 company library (+ /:id)
 *   /resources/signals                               open findings, member-scoped
 *   /projects/:projectId/resource-plans              (+ /:id, /activate, /archive,
 *                                                       /derive, /demand)
 *   /projects/:projectId/resource-availability       (+ /bulk, /:id)
 *   /projects/:projectId/resources/histogram         demand vs supply + levelling
 *   /projects/:projectId/resource-assignments        (+ /:id, /confirm, /start,
 *                                                       /complete, /cancel)
 *   /projects/:projectId/resources/calendar          lanes, days, conflicts
 *   /projects/:projectId/resources/conflicts         double bookings
 *   /projects/:projectId/resources/utilisation       booked days per resource
 *   /projects/:projectId/resources/productivity      (+ /snapshot, /snapshots)
 *   /projects/:projectId/resources/measured-mile     the forensics feed
 *   /projects/:projectId/resources/forecast          hours at completion (GET/POST)
 *   /projects/:projectId/worker-skills               (+ /:id, /:id/verify)
 *   /projects/:projectId/resources/skills-matrix     the matrix + coverage
 *   /projects/:projectId/resources/skill-gaps        booked without the ticket
 *   /projects/:projectId/resources/summary           the workspace header
 *   /projects/:projectId/resources/health-inputs     intelligence feed (§3.5)
 *   /projects/:projectId/resources/sweeps/run        force a sweep cycle
 *
 * GATES. `read` sees everything. `standard` plans, books, records and
 * measures. Exactly four operations are `admin` — activating a plan,
 * archiving one, verifying a certification, and forcing a sweep — because
 * each produces a record other people then rely on without re-checking. The
 * company library sits behind the company gate (mutation additionally
 * requires owner/admin), because a planner maintaining the vocabulary a
 * business resources against does not necessarily hold a permission on any
 * one project.
 */
import type { FastifyPluginAsync } from "fastify";
import { libraryRoutes } from "./routes/library.js";
import { planRoutes } from "./routes/plans.js";
import { assignmentRoutes } from "./routes/assignments.js";
import { productivityRoutes } from "./routes/productivity.js";
import { matrixRoutes } from "./routes/matrix.js";
import { summaryRoutes } from "./routes/summary.js";
import { registerResourceJobs } from "./sweeps.js";

export const resourcesModule: FastifyPluginAsync = async (app) => {
  registerResourceJobs(app);
  await app.register(libraryRoutes);
  await app.register(planRoutes);
  await app.register(assignmentRoutes);
  await app.register(productivityRoutes);
  await app.register(matrixRoutes);
  await app.register(summaryRoutes);
};
