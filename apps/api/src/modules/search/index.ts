/**
 * Company-wide search (cross-package contract §3.3, Vol I §0.3 #74).
 *
 * ONE endpoint that answers "where is the thing I am thinking of" across
 * every record type on the platform, with the caller's permissions applied
 * BEFORE any row is returned:
 *
 *   • project-scoped sources are restricted to the projects the caller is a
 *     member of (or holds an assurance grant over) — owners/admins excepted;
 *   • each source names the tool it belongs to, and a caller without `read`
 *     on that tool in a project never sees that project's rows;
 *   • company-level sources (vendors, contacts, people) need only membership.
 *
 * What it deliberately does not do: it is not a full-text index. See
 * engine.ts for why, and what would replace it.
 */
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { PermissionLevel, ToolKey } from "@constructos/shared";
import { rankHits, scoreCandidate, tokenize } from "./engine.js";
import { listSearchSources, type SearchSource } from "./registry.js";
import { loadProjectAccess, canUseTool, visibleProjectIds } from "../projects/access.js";

export { registerSearchSource, tableSource, listSearchSources } from "./registry.js";
export type { SearchSource, SearchCandidate, TableSourceSpec } from "./registry.js";

const searchQuerySchema = z.object({
  q: z.string().min(1).max(200),
  /** comma-separated list of source types; absent = every source */
  types: z.string().max(600).optional(),
  projectId: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export interface SearchHit {
  type: string;
  id: string;
  projectId: string | null;
  title: string;
  subtitle: string | null;
  status: string | null;
  href: string;
  score: number;
  updatedAt: string | null;
}

export const searchModule: FastifyPluginAsync = async (app) => {
  const gate = [app.authenticate, app.requireCompany];

  /** The sources this caller may search, with the project ids each may see. */
  async function permittedSources(
    req: Parameters<typeof loadProjectAccess>[1],
    wanted: Set<string> | null,
  ): Promise<Array<{ source: SearchSource; projectIds: string[] | null }>> {
    const access = await loadProjectAccess(app, req);
    const visible = await visibleProjectIds(app, req, access);
    const out: Array<{ source: SearchSource; projectIds: string[] | null }> = [];
    for (const source of listSearchSources()) {
      if (wanted && !wanted.has(source.type)) continue;
      if (source.scope === "company") {
        if (source.tool === null) {
          out.push({ source, projectIds: null });
          continue;
        }
        // A company-level tool (the directory) is gated by the tenant role:
        // guests hold no project membership at all and must not read it.
        if (access.isCompanyAdmin || req.companyRole === "member") {
          out.push({ source, projectIds: null });
        }
        continue;
      }
      if (visible === null) {
        out.push({ source, projectIds: null });
        continue;
      }
      const tool = source.tool;
      const allowed = tool
        ? visible.filter((id) => canUseTool(access, id, tool as ToolKey, "read" as PermissionLevel))
        : visible;
      if (allowed.length > 0) out.push({ source, projectIds: allowed });
    }
    return out;
  }

  /**
   * GET /search — the ⌘K palette and every "find a record" affordance.
   *
   * `coverage` names the sources actually searched, so a caller can tell the
   * difference between "no results" and "you cannot see that tool".
   */
  app.get("/search", { preHandler: gate }, async (req) => {
    const q = searchQuerySchema.parse(req.query);
    const started = Date.now();
    const terms = tokenize(q.q);
    if (terms.length === 0) {
      return { items: [], total: 0, tookMs: 0, coverage: [] };
    }
    const wanted = q.types
      ? new Set(q.types.split(",").map((t) => t.trim()).filter(Boolean))
      : null;

    const permitted = await permittedSources(req, wanted);
    // Over-fetch per source so ranking has something to choose between, then
    // cut once globally. Bounded so a broad query cannot pull the platform
    // into memory.
    const perSource = Math.min(50, Math.max(q.limit, 10));

    const hits: SearchHit[] = [];
    const coverage: string[] = [];
    for (const { source, projectIds } of permitted) {
      coverage.push(source.type);
      let candidates;
      try {
        candidates = await source.query(app.db, {
          companyId: req.companyId!,
          terms,
          projectIds,
          projectId: q.projectId ?? null,
          limit: perSource,
        });
      } catch (err) {
        // One source failing (a module mid-migration) must not take the whole
        // palette down; it drops out of coverage instead.
        req.log?.warn({ err, source: source.type }, "search source failed");
        coverage.pop();
        continue;
      }
      for (const row of candidates) {
        const score = scoreCandidate(
          {
            title: row.title,
            subtitle: row.subtitle,
            reference: row.reference,
            status: row.status,
            updatedAt: row.updatedAt,
            sourceWeight: source.weight,
          },
          terms,
        );
        if (score <= 0) continue;
        hits.push({
          type: source.type,
          id: row.id,
          projectId: row.projectId,
          title: row.title,
          subtitle: row.subtitle,
          status: row.status,
          href: source.href(row),
          score,
          updatedAt: row.updatedAt,
        });
      }
    }

    const items = rankHits(hits, q.limit);
    return {
      items,
      total: hits.length,
      tookMs: Date.now() - started,
      coverage: coverage.sort(),
    };
  });

  /** What the palette can offer as a type filter, for this caller. */
  app.get("/search/sources", { preHandler: gate }, async (req) => {
    const permitted = await permittedSources(req, null);
    return {
      items: permitted.map(({ source }) => ({
        type: source.type,
        label: source.label,
        tool: source.tool,
        scope: source.scope,
      })),
      total: permitted.length,
    };
  });
};
