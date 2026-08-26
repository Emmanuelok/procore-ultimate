import type { FastifyPluginAsync } from "fastify";
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  changeEvents,
  changeOrderPackages,
  changeOrderRequests,
  commitmentChanges,
  commitments,
  potentialChangeOrders,
  primeContractChanges,
  primeContracts,
  projects,
} from "@constructos/db";
import { computed, round2, unavailable, type Component } from "./arithmetic.js";
import {
  reconcileChangeLog,
  type ChangeLogReconciliation,
  type ContractSumRow,
  type CorRow,
  type EventRow,
  type ExecutedChangeRow,
  type PackageRow,
  type PcoRow,
} from "./reconcile.js";
import { corTimeImpact } from "./requests.js";
import { changeGates, companyOf, projectOf } from "./shared.js";

const logQuery = z.object({
  currency: z.string().min(3).max(8).optional(),
});

export interface ChangeLogResponse {
  projectId: string;
  currencies: string[];
  mixedCurrency: boolean;
  /** the single-currency reconciliation; null when the project holds more than one */
  reconciliation: ChangeLogReconciliation | null;
  groups: ChangeLogReconciliation[];
  reasons: string[];
}

/**
 * THE CHANGE LOG.
 *
 * Every figure here comes from rows and is paired with the identity that says
 * which rows. The one thing it will not do is add up money in two currencies:
 * a project running a USD prime contract and a EUR supply commitment gets two
 * reconciliations and a reason, never one number that is true of neither.
 */
export const changeLogRoutes: FastifyPluginAsync = async (app) => {
  const gates = changeGates(app);

  app.get("/projects/:projectId/change-log", { preHandler: gates.read }, async (req) => {
    const q = logQuery.parse(req.query ?? {});
    const companyId = companyOf(req);
    const projectId = projectOf(req);

    const [projectRow] = await app.db
      .select({ currency: projects.currency })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    const projectCurrency = (projectRow?.currency ?? "USD").toUpperCase();

    const [eventRows, pcoRows, corRows, packageRows, contractRows, commitmentRows] =
      await Promise.all([
        app.db.select().from(changeEvents).where(and(eq(changeEvents.companyId, companyId), eq(changeEvents.projectId, projectId))).orderBy(asc(changeEvents.number)),
        app.db
          .select()
          .from(potentialChangeOrders)
          .where(and(eq(potentialChangeOrders.companyId, companyId), eq(potentialChangeOrders.projectId, projectId)))
          .orderBy(asc(potentialChangeOrders.number)),
        app.db
          .select()
          .from(changeOrderRequests)
          .where(and(eq(changeOrderRequests.companyId, companyId), eq(changeOrderRequests.projectId, projectId)))
          .orderBy(asc(changeOrderRequests.number)),
        app.db
          .select()
          .from(changeOrderPackages)
          .where(and(eq(changeOrderPackages.companyId, companyId), eq(changeOrderPackages.projectId, projectId)))
          .orderBy(asc(changeOrderPackages.number)),
        app.db.select().from(primeContracts).where(and(eq(primeContracts.companyId, companyId), eq(primeContracts.projectId, projectId))),
        app.db
          .select({
            id: commitments.id,
            reference: commitments.reference,
            currency: commitments.currency,
          })
          .from(commitments)
          .where(and(eq(commitments.companyId, companyId), eq(commitments.projectId, projectId))),
      ]);

    const contractIds = contractRows.map((c) => c.id);
    const commitmentIds = commitmentRows.map((c) => c.id);
    const [primeChangeRows, commitmentChangeRows] = await Promise.all([
      contractIds.length > 0
        ? app.db
            .select({
              id: primeContractChanges.id,
              parentId: primeContractChanges.primeContractId,
              changeOrderPackageId: primeContractChanges.changeOrderPackageId,
              status: primeContractChanges.status,
              amount: primeContractChanges.amount,
            })
            .from(primeContractChanges)
            .where(inArray(primeContractChanges.primeContractId, contractIds))
        : Promise.resolve([] as ExecutedChangeRow[]),
      commitmentIds.length > 0
        ? app.db
            .select({
              id: commitmentChanges.id,
              parentId: commitmentChanges.commitmentId,
              changeOrderPackageId: commitmentChanges.changeOrderPackageId,
              status: commitmentChanges.status,
              amount: commitmentChanges.amount,
            })
            .from(commitmentChanges)
            .where(inArray(commitmentChanges.commitmentId, commitmentIds))
        : Promise.resolve([] as ExecutedChangeRow[]),
    ]);

    const contractCurrency = new Map(
      contractRows.map((c) => [c.id, c.currency.toUpperCase()]),
    );
    const commitmentCurrency = new Map(
      commitmentRows.map((c) => [c.id, c.currency.toUpperCase()]),
    );
    const currencyOfContract = (id: string | null): string =>
      (id && contractCurrency.get(id)) || projectCurrency;
    const currencyOfCommitment = (id: string | null): string =>
      (id && commitmentCurrency.get(id)) || projectCurrency;

    const currencies = [
      ...new Set([
        projectCurrency,
        ...contractRows.map((c) => c.currency.toUpperCase()),
        ...commitmentRows.map((c) => c.currency.toUpperCase()),
      ]),
    ].sort();

    const build = (currency: string): ChangeLogReconciliation => {
      const events: EventRow[] = eventRows
        .filter((e) => currencyOfContract(e.primeContractId) === currency)
        .map((e) => ({
          id: e.id,
          status: e.status,
          eventType: e.eventType,
          scope: e.scope,
          roughOrderOfMagnitude: e.roughOrderOfMagnitude,
          estimatedCost: e.estimatedCost,
          latestCost: e.latestCost,
          estimatedRevenue: e.estimatedRevenue,
          approvedRevenue: e.approvedRevenue,
          scheduleImpactDays: e.scheduleImpactDays,
        }));
      const pcos: PcoRow[] = pcoRows
        .filter((p) =>
          p.commitmentId
            ? currencyOfCommitment(p.commitmentId) === currency
            : currencyOfContract(p.primeContractId) === currency,
        )
        .map((p) => ({
          id: p.id,
          changeEventId: p.changeEventId,
          commitmentId: p.commitmentId,
          changeOrderPackageId: p.changeOrderPackageId,
          status: p.status,
          estimatedAmount: p.estimatedAmount,
          quotedAmount: p.quotedAmount,
          amount: p.amount,
          noCharge: p.noCharge,
        }));
      const cors: CorRow[] = corRows
        .filter((c) => currencyOfContract(c.primeContractId) === currency)
        .map((c) => ({
          id: c.id,
          changeEventId: c.changeEventId,
          primeContractId: c.primeContractId,
          changeOrderPackageId: c.changeOrderPackageId,
          status: c.status,
          amount: c.amount,
          approvedAmount: c.approvedAmount,
          scheduleImpactDays: c.scheduleImpactDays,
          scheduleImpactApprovedDays: c.scheduleImpactApprovedDays,
          pcoIds: c.pcoIds,
        }));
      const packages: PackageRow[] = packageRows
        .filter((p) =>
          p.kind === "prime_contract"
            ? currencyOfContract(p.primeContractId) === currency
            : currencyOfCommitment(p.commitmentId) === currency,
        )
        .map((p) => ({
          id: p.id,
          kind: p.kind,
          status: p.status,
          changeEventId: p.changeEventId,
          primeContractId: p.primeContractId,
          commitmentId: p.commitmentId,
          memberIds: p.memberIds,
          amount: p.amount,
          scheduleImpactDays: p.scheduleImpactDays,
          primeContractChangeId: p.primeContractChangeId,
          commitmentChangeId: p.commitmentChangeId,
          budgetChangeId: p.budgetChangeId,
        }));
      const contracts: ContractSumRow[] = contractRows
        .filter((c) => c.currency.toUpperCase() === currency)
        .map((c) => ({
          id: c.id,
          reference: c.reference,
          currency: c.currency.toUpperCase(),
          originalContractSum: c.originalContractSum,
          approvedChangeSum: c.approvedChangeSum,
          pendingChangeSum: c.pendingChangeSum,
          revisedContractSum: c.revisedContractSum,
        }));
      const primeChanges = (primeChangeRows as ExecutedChangeRow[]).filter(
        (c) => currencyOfContract(c.parentId) === currency,
      );
      const commitChanges = (commitmentChangeRows as ExecutedChangeRow[]).filter(
        (c) => currencyOfCommitment(c.parentId) === currency,
      );
      return reconcileChangeLog({
        currency,
        events,
        pcos,
        cors,
        packages,
        contracts,
        primeChanges,
        commitmentChanges: commitChanges,
      });
    };

    const wanted = q.currency ? [q.currency.toUpperCase()] : currencies;
    const groups = wanted.map(build);
    const mixed = currencies.length > 1 && !q.currency;

    const response: ChangeLogResponse = {
      projectId,
      currencies,
      mixedCurrency: mixed,
      reconciliation: mixed ? null : (groups[0] ?? null),
      groups,
      reasons: mixed
        ? [
            `This project holds money in ${currencies.join(", ")}. A single change log across them ` +
              "would be a sum of unlike things, so one reconciliation per currency is returned in " +
              "`groups`; pass ?currency= to read just one.",
          ]
        : [],
    };
    return response;
  });

  /**
   * Time claimed against time modelled, across the project. The delay events
   * and their analysis belong to the forensics module — this view links to
   * them and reports what is NOT linked, which is the finding that matters.
   */
  app.get(
    "/projects/:projectId/change-log/time-impact",
    { preHandler: gates.read },
    async (req) => {
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const cors = await app.db
        .select()
        .from(changeOrderRequests)
        .where(
          and(
            eq(changeOrderRequests.companyId, companyId),
            eq(changeOrderRequests.projectId, projectId),
          ),
        )
        .orderBy(asc(changeOrderRequests.number));

      const assessed = [];
      for (const cor of cors) {
        assessed.push(await corTimeImpact(app.db, cor));
      }
      const live = assessed.filter((a) => a.status !== "void" && a.status !== "withdrawn");
      const daysClaimed = live.reduce((s, a) => s + a.daysClaimed, 0);
      const daysApproved = live.reduce((s, a) => s + a.daysApproved, 0);
      const modelledRows = live.filter((a) => a.modelledDays.value !== null);
      const modelled: Component =
        modelledRows.length === 0
          ? unavailable(
              [
                "No change order request on this project links to an analysed delay event, so the " +
                  "modelled time impact is unknown rather than zero.",
              ],
              { corsWithModelledDays: 0 },
            )
          : computed(
              modelledRows.reduce((s, a) => s + (a.modelledDays.value ?? 0), 0),
              { corsWithModelledDays: modelledRows.length },
            );
      const unsupported: Component =
        modelled.value === null
          ? unavailable(modelled.reasons, modelled.inputs)
          : computed(
              modelledRows.reduce((s, a) => s + a.daysClaimed, 0) - modelled.value,
              { basis: "claimed days on the modelled requests only" },
            );

      return {
        projectId,
        changeOrderRequests: assessed,
        totals: {
          daysClaimed,
          daysApproved,
          daysModelled: modelled,
          unsupportedDays: unsupported,
          requestsClaimingTime: live.filter((a) => a.daysClaimed > 0).length,
          requestsClaimingTimeWithNoDelayEvent: live.filter(
            (a) => a.daysClaimed > 0 && a.delayEventIds.length === 0,
          ).length,
        },
        unlinked: live
          .filter((a) => a.daysClaimed > 0 && a.delayEventIds.length === 0)
          .map((a) => ({
            changeOrderRequestId: a.changeOrderRequestId,
            reference: a.reference,
            daysClaimed: a.daysClaimed,
            verdict: a.verdict,
          })),
      };
    },
  );

  /** Contract-sum movement alone — the figure a monthly report opens with. */
  app.get(
    "/projects/:projectId/change-log/contract-movement",
    { preHandler: gates.read },
    async (req) => {
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const contracts = await app.db
        .select()
        .from(primeContracts)
        .where(and(eq(primeContracts.companyId, companyId), eq(primeContracts.projectId, projectId)))
        .orderBy(asc(primeContracts.number));
      const out = [];
      for (const contract of contracts) {
        const changes = await app.db
          .select()
          .from(primeContractChanges)
          .where(eq(primeContractChanges.primeContractId, contract.id))
          .orderBy(asc(primeContractChanges.number));
        let running = round2(contract.originalContractSum);
        const log = changes
          .filter((c) => c.status === "executed")
          .map((c) => {
            running = round2(running + c.amount);
            return {
              reference: c.reference,
              title: c.title,
              amount: round2(c.amount),
              executedDate: c.executedDate,
              scheduleImpactDays: c.scheduleImpactDays,
              runningContractSum: running,
              storedRevisedContractSum: round2(c.revisedContractSum),
              agrees: Math.abs(running - c.revisedContractSum) <= 0.005,
            };
          });
        out.push({
          primeContractId: contract.id,
          reference: contract.reference,
          currency: contract.currency,
          originalContractSum: round2(contract.originalContractSum),
          approvedChangeSum: round2(contract.approvedChangeSum),
          pendingChangeSum: round2(contract.pendingChangeSum),
          revisedContractSum: round2(contract.revisedContractSum),
          executedChanges: log,
          reconciles:
            Math.abs(running - contract.revisedContractSum) <= 0.005 && log.every((l) => l.agrees),
        });
      }
      return { projectId, contracts: out };
    },
  );
};
