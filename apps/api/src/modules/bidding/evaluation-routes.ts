/**
 * THE AI EVALUATION ASSISTANT'S ONE ROUTE.
 *
 *   POST /projects/:projectId/bid-packages/:packageId/evaluation/propose
 *
 * It reads the buyer's scope rows and every live bid's own words, asks the
 * model to propose an inclusion status per unanswered cell WITH THE SENTENCE
 * IT CAME FROM, throws away everything it cannot verify, and returns drafts.
 * It writes nothing to the levelling grid: each proposal carries the exact
 * body an evaluator posts to /levelling/entries if they accept it, and the
 * citation is carried into `adjustmentNote` so the accepted cell says where
 * it came from.
 *
 * Sealed packages are refused (reading bid text before an opening is the
 * thing the seal exists to prevent), and with no API key the route answers
 * 503 AiDisabled while every other bidding route carries on working.
 */

import type { FastifyPluginAsync } from "fastify";
import { and, asc, eq } from "drizzle-orm";
import {
  bidLevellingEntries,
  bidLevellingItems,
  bidSubmissionLines,
  bidSubmissions,
  vendors,
} from "@constructos/db";
import { conflict } from "../../lib/errors.js";
import { aiDisabledError, aiEnabled, runAgent, type InputRef } from "../ai/service.js";
import { fetchPackage, isInContention, ledger, requireBiddingLevel } from "./shared.js";
import { assertUnsealedForAnalysis } from "./sealing.js";
import {
  buildEvaluationPrompt,
  evaluationOutputSchema,
  reconcileProposals,
  type PromptBid,
  type PromptScopeRow,
} from "./evaluation-ai.js";

const MAX_BIDS = 12;

export const evaluationAiRoutes: FastifyPluginAsync = async (app) => {
  const standardGate = [
    app.authenticate,
    app.requireCompany,
    app.requireTool("bidding", "standard"),
  ];

  app.post(
    "/projects/:projectId/bid-packages/:packageId/evaluation/propose",
    { preHandler: standardGate },
    async (req, reply) => {
      const { packageId } = req.params as { packageId: string };
      const companyId = req.companyId!;
      const projectId = req.projectId!;
      await requireBiddingLevel(app, req, reply, projectId, "standard");
      const pkg = await fetchPackage(app.db, packageId, companyId, projectId);
      assertUnsealedForAnalysis(pkg, "Reading bidders' text for an AI levelling proposal");

      /*
       * The structural refusals come BEFORE the AI check, because they are
       * true whether or not a key is configured: a package with no scope
       * rows and no live bids cannot be levelled by anybody. Answering 503
       * there would tell an operator to go and buy an API key to fix a
       * problem the API key does not fix.
       */
      const items = await app.db
        .select()
        .from(bidLevellingItems)
        .where(eq(bidLevellingItems.packageId, packageId))
        .orderBy(asc(bidLevellingItems.position));
      if (items.length === 0) {
        throw conflict(
          "This package has no levelling scope rows, so there is nothing neutral to level bids " +
            "against. Build the scope first: the rows are the buyer's description of the work, " +
            "and letting a model invent them would put the bidders' words in charge of the " +
            "comparison.",
        );
      }

      const submissions = await app.db
        .select()
        .from(bidSubmissions)
        .where(eq(bidSubmissions.packageId, packageId))
        .orderBy(asc(bidSubmissions.createdAt));
      const live = submissions
        .filter((s) => isInContention(s.status) && !s.supersededById)
        .slice(0, MAX_BIDS);
      if (live.length === 0) {
        throw conflict(
          "No bid on this package is in contention, so there is nothing to level. A proposal " +
            "against a withdrawn or superseded bid would be work nobody can use.",
        );
      }

      if (!aiEnabled(app)) throw aiDisabledError();

      const vendorRows = await app.db
        .select({ id: vendors.id, name: vendors.name })
        .from(vendors)
        .where(eq(vendors.companyId, companyId));
      const vendorName = new Map(vendorRows.map((v) => [v.id, v.name] as const));

      const lines = await app.db
        .select()
        .from(bidSubmissionLines)
        .where(eq(bidSubmissionLines.packageId, packageId));
      const entries = await app.db
        .select()
        .from(bidLevellingEntries)
        .where(
          and(
            eq(bidLevellingEntries.packageId, packageId),
            eq(bidLevellingEntries.companyId, companyId),
          ),
        );

      const rows: PromptScopeRow[] = items.map((i) => ({
        id: i.id,
        itemCode: i.itemCode,
        description: i.description,
        category: i.category,
        isMandatory: i.isMandatory === 1,
        unit: i.unit,
        estimatedQuantity: i.estimatedQuantity,
      }));

      const bids: PromptBid[] = live.map((s) => ({
        submissionId: s.id,
        reference: s.reference,
        vendorName: vendorName.get(s.vendorId) ?? s.vendorId,
        currency: s.currency,
        exclusions: s.exclusions,
        qualifications: s.qualifications,
        assumptions: s.assumptions,
        lines: lines
          .filter((l) => l.submissionId === s.id)
          .map((l) => ({
            id: l.id,
            itemCode: l.itemCode,
            description: l.description,
            amount: l.amount,
            unitRate: l.unitRate,
            quantity: l.quantity,
            levellingItemId: l.levellingItemId,
          })),
        answeredItemIds: entries
          .filter((e) => e.submissionId === s.id)
          .map((e) => e.levellingItemId),
      }));

      const prompt = buildEvaluationPrompt({
        packageReference: pkg.reference,
        packageTitle: pkg.title,
        currency: pkg.currency,
        scopeDescription: pkg.scopeDescription,
        rows,
        bids,
      });

      if (prompt.openCells === 0) {
        return {
          runId: null,
          proposals: [],
          complianceNotes: [],
          dropped: [],
          openCells: 0,
          note:
            "Every scope row already carries an entry for every bid in contention. There is " +
            "nothing left to propose — which is what a finished levelling looks like.",
        };
      }

      const inputRefs: InputRef[] = [
        { type: "bid_package", id: pkg.id },
        ...bids.map((b) => ({ type: "bid_submission", id: b.submissionId })),
        ...rows.map((r) => ({ type: "bid_levelling_item", id: r.id })),
      ];

      const result = await runAgent({
        app,
        req,
        agentKind: "bid_levelling_assistant",
        projectId,
        system: prompt.system,
        user: prompt.user,
        inputRefs,
        schema: evaluationOutputSchema,
        dataCategories: ["commercial_terms"],
        contextChars: prompt.contextChars,
        maxTokens: 8_000,
      });

      const reconciled = reconcileProposals(
        result.json ?? { proposals: [], complianceNotes: [] },
        rows,
        bids,
      );

      /*
       * The RUN is ledgered, not the proposals: nothing has changed yet.
       * What is worth recording is that a model was shown every bidder's
       * commercial text on this package, and how much of what it said back
       * survived verification.
       */
      await ledger(
        app.db,
        req,
        "access",
        "bid_package",
        pkg.id,
        {
          projectId,
          event: "ai_levelling_proposals",
          runId: result.runId,
          bids: bids.length,
          scopeRows: rows.length,
          openCells: prompt.openCells,
          proposed: reconciled.proposals.length,
          dropped: reconciled.dropped.length,
        },
        projectId,
        true,
      );

      return {
        runId: result.runId,
        openCells: prompt.openCells,
        proposals: reconciled.proposals,
        complianceNotes: reconciled.complianceNotes,
        dropped: reconciled.dropped,
        citations: result.grounding.citations,
        droppedCitations: result.grounding.dropped,
        evidenceScore: result.grounding.evidenceScore,
        note:
          `${reconciled.proposals.length} proposal(s) survived verification out of ` +
          `${prompt.openCells} unanswered cell(s); ${reconciled.dropped.length} were discarded ` +
          "and each says why. NOTHING HAS BEEN WRITTEN. Each proposal carries the body to POST " +
          "to /levelling/entries if you accept it, and the sentence it came from travels with " +
          "it into the adjustment note. An adjustment still needs a human to mean it.",
      };
    },
  );
};
