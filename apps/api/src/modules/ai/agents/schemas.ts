/**
 * Output schemas shared by the fleet.
 *
 * Two rules the whole fleet obeys:
 *  · `confidence` is REQUIRED (Vol II X #1018). The previous generation used
 *    `.optional().catch(undefined)`, which silently accepted an answer with
 *    no stated certainty and then rendered it next to grounded numbers. A run
 *    without confidence now fails and is recorded as failed.
 *  · `citations` carry the type/id of a record that was actually supplied.
 *    `validateCitations` in ../service.ts drops anything else, so a schema
 *    only has to describe the shape, never police the content.
 */
import { z } from "zod";

/** Required, 0..1. A missing or unparseable value fails the run. */
export const requiredConfidence = z
  .number({ message: "confidence is required (0-1)" })
  .min(0)
  .max(1);

export const citationList = z
  .array(
    z.object({
      ref: z.number().int().optional(),
      type: z.string().min(1).max(64),
      id: z.string().min(1).max(128),
      excerpt: z.string().max(2000).optional(),
    }),
  )
  .default([])
  .catch([]);

export const severityEnum = z.enum(["info", "low", "medium", "high", "critical"]).catch("medium");

/** A finding every monitor-style agent returns, with its own citations. */
export const findingSchema = z.object({
  recordType: z.string().max(64).optional(),
  recordId: z.string().max(128).optional(),
  title: z.string().min(1).max(300),
  severity: severityEnum,
  rationale: z.string().min(1).max(4000),
  recommendedAction: z.string().max(2000).optional(),
  citations: citationList,
});
export type Finding = z.infer<typeof findingSchema>;

export const findingsOutput = z.object({
  findings: z.array(findingSchema).max(40).default([]).catch([]),
  summary: z.string().max(2000).optional(),
  citations: citationList,
  confidence: requiredConfidence,
});
export type FindingsOutput = z.infer<typeof findingsOutput>;

/** Instruction block appended to every fleet system prompt. */
export function outputContract(jsonShape: string): string {
  return [
    "Ground every statement in the numbered EVIDENCE block. Never use outside knowledge about this project.",
    "Cite with the exact type and id printed in an evidence header; a citation naming anything else is dropped and lowers the recorded confidence.",
    "If the evidence does not support a conclusion, say so in the rationale and return an empty findings list rather than guessing.",
    `Return ONLY a JSON object of this shape: ${jsonShape}`,
    '"confidence" is REQUIRED: a number 0-1 stating how certain you are given ONLY the supplied evidence.',
  ].join("\n");
}
