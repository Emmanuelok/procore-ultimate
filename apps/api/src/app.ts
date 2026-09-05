import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { ZodError } from "zod";
import { sql } from "drizzle-orm";
import "./types.js";
import { loadConfig, productionWarnings, type Config } from "./config.js";
import { createDb, type DbHandle } from "./lib/db.js";
import { createLocalStorage } from "./lib/storage.js";
import { createS3Storage } from "./lib/storage-s3.js";
import { PlatformScheduler } from "./lib/scheduler.js";
import { AppError } from "./lib/errors.js";
import authPlugin from "./plugins/auth.js";

// Module plugins — each owns its routes under /api/v1.
import { identityModule } from "./modules/identity/index.js";
import { platformModule } from "./modules/platform/index.js";
import { directoryModule } from "./modules/directory/index.js";
import { adminModule } from "./modules/admin/index.js";
import { projectsModule } from "./modules/projects/index.js";
import { documentsModule } from "./modules/documents/index.js";
import { drawingsModule } from "./modules/drawings/index.js";
import { bimModule } from "./modules/bim/index.js";
import { twinModule } from "./modules/twin/index.js";
import { workflowModule } from "./modules/workflow/index.js";
import { fieldModule } from "./modules/field/index.js";
import { notificationsModule } from "./modules/notifications/index.js";
import { assuranceModule } from "./modules/assurance/index.js";
import { aiModule } from "./modules/ai/index.js";
import { commercialModule } from "./modules/commercial/index.js";
import { contractsModule } from "./modules/contracts/index.js";
import { scheduleModule } from "./modules/schedule/index.js";
import { forensicsModule } from "./modules/forensics/index.js";
import { paymentsModule } from "./modules/payments/index.js";
import { landModule } from "./modules/land/index.js";
import { workforceModule } from "./modules/workforce/index.js";
import { esgModule } from "./modules/esg/index.js";
import { jurisdictionModule } from "./modules/jurisdiction/index.js";
import { analyticsModule } from "./modules/analytics/index.js";
import { riskModule } from "./modules/risk/index.js";
import { governanceModule } from "./modules/governance/index.js";
import { financeModule } from "./modules/finance/index.js";
import { disputesModule } from "./modules/disputes/index.js";
import { ingestionModule } from "./modules/ingestion/index.js";
import { benchmarksModule } from "./modules/benchmarks/index.js";
import { anchoringModule } from "./modules/anchoring/index.js";
import { insuranceModule } from "./modules/insurance/index.js";
import { learningModule } from "./modules/learning/index.js";
import { integrationsModule } from "./modules/integrations/index.js";
// Financial suite — budget, prime contracts, commitments, change management,
// invoicing (M2-M6). The money spine: see packages/db/src/schema/financials.ts.
import { budgetModule } from "./modules/budget/index.js";
import { primeContractsModule } from "./modules/primecontracts/index.js";
import { commitmentsModule } from "./modules/commitments/index.js";
import { changesModule } from "./modules/changes/index.js";
import { invoicingModule } from "./modules/invoicing/index.js";
// Procore-parity domains (M19-M25) — specifications, meetings, safety,
// quality, equipment & materials, timecards, bidding. Schema lives in
// packages/db/src/schema/{specifications,meetings,safety,quality,equipment,
// timecards,bidding}.ts; routes land per module.
import { specificationsModule } from "./modules/specifications/index.js";
import { meetingsModule } from "./modules/meetings/index.js";
import { safetyModule } from "./modules/safety/index.js";
import { qualityModule } from "./modules/quality/index.js";
import { equipmentModule } from "./modules/equipment/index.js";
import { timecardsModule } from "./modules/timecards/index.js";
import { biddingModule } from "./modules/bidding/index.js";
// Authentication foundation (Phase 8) — user SSO, MFA and account
// self-service. Schema in packages/db/src/schema/auth.ts, email transport in
// lib/email.ts. These carry REAL ROUTES: OIDC sign-in and provider CRUD, TOTP
// enrolment and the MFA challenge, and email verification / password reset /
// device sessions / invitations. See each module's index.ts.
import { ssoModule } from "./modules/sso/index.js";
import { mfaModule } from "./modules/mfa/index.js";
import { accountModule } from "./modules/account/index.js";
import { intelligenceModule } from "./modules/intelligence/index.js";
import { automationModule } from "./modules/automation/index.js";
import { searchModule } from "./modules/search/index.js";
import { correspondenceModule } from "./modules/correspondence/index.js";
import { designModule } from "./modules/design/index.js";
import { estimatingModule } from "./modules/estimating/index.js";
import { portfolioModule } from "./modules/portfolio/index.js";
import { resourcesModule } from "./modules/resources/index.js";
import { siteModule } from "./modules/site/index.js";
import { supplychainModule } from "./modules/supplychain/index.js";
import { taxModule } from "./modules/tax/index.js";
import { mcpModule } from "./modules/mcp/index.js";

/**
 * sha256 CSP hashes for every inline <script> in the index.html this process
 * serves, or [] when it serves no SPA. Read once at boot: the file cannot
 * change under a running container, and re-reading it per request would put a
 * disk hit on the hot path.
 */
function webRootIndexScriptHashes(config: Config): string[] {
  if (!config.WEB_DIST_DIR) return [];
  const indexPath = path.join(path.resolve(config.WEB_DIST_DIR), "index.html");
  if (!existsSync(indexPath)) return [];
  let html = "";
  try {
    html = readFileSync(indexPath, "utf8");
  } catch {
    return [];
  }
  const hashes = new Set<string>();
  for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
    const body = m[1];
    if (body === undefined || body.trim() === "") continue;
    hashes.add(`'sha256-${createHash("sha256").update(body, "utf8").digest("base64")}'`);
  }
  return [...hashes];
}

export interface BuildAppOptions {
  config?: Config;
  logger?: boolean;
}

export interface BuiltApp {
  app: FastifyInstance;
  close: () => Promise<void>;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<BuiltApp> {
  const config = options.config ?? loadConfig();
  const app = Fastify({
    logger:
      options.logger === false || config.NODE_ENV === "test"
        ? false
        : { level: config.LOG_LEVEL },
    bodyLimit: 32 * 1024 * 1024,
    // A hop COUNT rather than `true`: with `true`, Fastify takes the LEFTMOST
    // X-Forwarded-For entry as the client address, and a client can prepend
    // any value it likes — which is exactly how the per-IP auth rate limit
    // was bypassable. Trusting only the platform edge uses the address the
    // edge itself appended.
    trustProxy: config.TRUST_PROXY
      ? (_address: string, hop: number) => hop < config.TRUST_PROXY_HOPS
      : false,
  });

  // Configuration smells, said out loud exactly once at boot. These never stop
  // the process (see config.ts) but they must never be silent either: an
  // operator reading the deploy log has to be able to see that this instance is
  // on the embedded database, or that its email links point at localhost.
  const configWarnings = productionWarnings(config);
  for (const warning of configWarnings) app.log.warn({ config: true }, warning);

  // Security headers. CSP is tuned for the SPA the API serves same-origin:
  // pdf.js needs blob: workers and blob: fetches, web-ifc needs WebAssembly
  // compilation ('wasm-unsafe-eval'), and viewers render into blob: images.
  //
  // The two additions below were found by driving the built SPA through this
  // server in a real browser, which is the only place they show up — `vite
  // preview` and the dev server send no CSP at all:
  //
  //   * index.html carries ONE inline script, the anti-flash theme bootstrap
  //     that sets data-theme before first paint. `script-src 'self'` blocked
  //     it, so the production build painted the wrong canvas colour on every
  //     load and ignored a stored dark-mode preference until React mounted.
  //     Rather than pasting a hash that silently rots the next time that
  //     script is edited, the hashes are COMPUTED from the index.html this
  //     process is actually serving. A CSP that can drift from the file it
  //     protects is a CSP nobody will keep correct.
  //   * the Inter webfont is loaded from fonts.googleapis.com/gstatic.com, so
  //     `style-src 'self'` blocked the stylesheet and the whole app rendered
  //     in the fallback system font.
  const inlineScriptHashes = webRootIndexScriptHashes(config);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'wasm-unsafe-eval'", ...inlineScriptHashes],
        workerSrc: ["'self'", "blob:"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        imgSrc: ["'self'", "data:", "blob:"],
        // The landing page streams its poster media from CloudFront, so that
        // origin is allowed for media and fetch. `blob:` stays on connectSrc
        // for the PDF and IFC viewers, which build object URLs client-side.
        mediaSrc: ["'self'", "https://d2ol7oe51mr4n9.cloudfront.net"],
        connectSrc: ["'self'", "blob:", "https://d2ol7oe51mr4n9.cloudfront.net"],
        fontSrc: ["'self'", "data:", "https://fonts.gstatic.com"],
        objectSrc: ["'none'"],
        frameAncestors: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  });

  if (config.RATE_LIMIT_ENABLED && config.NODE_ENV !== "test") {
    await app.register(rateLimit, {
      max: config.RATE_LIMIT_MAX_PER_MINUTE,
      timeWindow: "1 minute",
    });
  }

  // CORS. In production the SPA is served same-origin, so the only
  // cross-origin callers are the ones an operator lists in CORS_ORIGINS (plus
  // APP_BASE_URL's origin). Reflecting every origin WITH credentials — the
  // previous behaviour — is the textbook misconfiguration: any site could
  // make credentialed calls with a victim's cookies. Bearer tokens make the
  // exposure smaller than it looks, but the header is wrong regardless.
  // Development and test keep the permissive origin for the Vite proxy.
  const corsOrigins = new Set<string>(
    config.CORS_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean),
  );
  try {
    corsOrigins.add(new URL(config.APP_BASE_URL).origin);
  } catch {
    /* an unparseable APP_BASE_URL is already refused by loadConfig in production */
  }
  await app.register(cors, {
    origin:
      config.NODE_ENV === "production"
        ? (origin, cb) => cb(null, !origin || corsOrigins.has(origin))
        : true,
    credentials: true,
  });
  await app.register(multipart, {
    limits: { fileSize: config.UPLOAD_MAX_BYTES, files: config.UPLOAD_MAX_FILES },
  });

  const dbHandle: DbHandle = await createDb(config);
  app.decorate("db", dbHandle.db);
  app.decorate(
    "storage",
    config.STORAGE_DRIVER === "s3" ? createS3Storage(config) : createLocalStorage(config.STORAGE_DIR),
  );
  app.decorate("appConfig", config);

  // The platform job scheduler. Modules register their sweeps during their
  // own registration; the ticker starts once every module is in place (below)
  // and is stopped on close. Off under test — suites call runNow() instead.
  const scheduler = new PlatformScheduler(dbHandle.db, app.log, {
    enabled: config.SCHEDULER_ENABLED && config.NODE_ENV !== "test",
    tickMs: config.SCHEDULER_TICK_MS,
    postgres: Boolean(config.DATABASE_URL),
  });
  app.decorate("scheduler", scheduler);
  app.addHook("onClose", async () => {
    scheduler.stop();
  });

  await app.register(authPlugin);

  app.setErrorHandler((error, req, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({
        statusCode: error.statusCode,
        error: error.name,
        message: error.message,
        details: error.details,
      });
    }
    if (error instanceof ZodError) {
      return reply.status(400).send({
        statusCode: 400,
        error: "ValidationError",
        message: "Request validation failed",
        details: error.issues,
      });
    }
    const err = error as Error & { statusCode?: unknown };
    const status = typeof err.statusCode === "number" ? err.statusCode : 500;
    if (status >= 500) req.log.error(err);
    return reply.status(status).send({
      statusCode: status,
      error: err.name || "InternalServerError",
      message:
        status >= 500 && config.NODE_ENV === "production"
          ? "Internal server error"
          : err.message,
    });
  });

  app.get("/api/v1/health", async () => ({
    ok: true,
    db: config.DATABASE_URL ? "postgres" : "pglite",
    time: new Date().toISOString(),
  }));

  // Readiness is a different question from liveness: "is the process up"
  // versus "can it serve a request that touches the database". Orchestrators
  // route traffic on this one.
  app.get("/api/v1/health/ready", async (_req, reply) => {
    const checks: Record<string, { ok: boolean; detail?: string }> = {};
    try {
      await dbHandle.db.execute(sql`select 1`);
      checks["database"] = { ok: true };
    } catch (err) {
      checks["database"] = { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
    checks["storage"] = { ok: true, detail: config.STORAGE_DRIVER };
    checks["scheduler"] = {
      ok: true,
      detail: scheduler.enabled ? `enabled, ${scheduler.list().length} jobs` : "disabled",
    };
    const ok = Object.values(checks).every((c) => c.ok);
    return reply.status(ok ? 200 : 503).send({
      ok,
      db: config.DATABASE_URL ? "postgres" : "pglite",
      checks,
      // Reduced-shape configuration, reported rather than hidden. Ready is
      // still 200 with warnings present — they describe a smaller deployment,
      // not a broken one.
      warnings: configWarnings,
      time: new Date().toISOString(),
    });
  });

  const prefix = "/api/v1";
  await app.register(identityModule, { prefix });
  await app.register(platformModule, { prefix });
  // Registered next to identity because they extend the same surface: SSO and
  // MFA sit in front of the login it already owns, and account self-service
  // (verification, reset, device list) sits behind it.
  await app.register(ssoModule, { prefix });
  await app.register(mfaModule, { prefix });
  await app.register(accountModule, { prefix });
  await app.register(directoryModule, { prefix });
  await app.register(adminModule, { prefix });
  await app.register(projectsModule, { prefix });
  await app.register(documentsModule, { prefix });
  await app.register(drawingsModule, { prefix });
  await app.register(bimModule, { prefix });
  await app.register(twinModule, { prefix });
  await app.register(workflowModule, { prefix });
  await app.register(fieldModule, { prefix });
  await app.register(notificationsModule, { prefix });
  await app.register(assuranceModule, { prefix });
  await app.register(aiModule, { prefix });
  await app.register(commercialModule, { prefix });
  await app.register(contractsModule, { prefix });
  await app.register(scheduleModule, { prefix });
  await app.register(forensicsModule, { prefix });
  await app.register(paymentsModule, { prefix });
  await app.register(landModule, { prefix });
  await app.register(workforceModule, { prefix });
  await app.register(esgModule, { prefix });
  await app.register(jurisdictionModule, { prefix });
  await app.register(analyticsModule, { prefix });
  await app.register(riskModule, { prefix });
  await app.register(governanceModule, { prefix });
  await app.register(financeModule, { prefix });
  await app.register(disputesModule, { prefix });
  await app.register(ingestionModule, { prefix });
  await app.register(benchmarksModule, { prefix });
  await app.register(anchoringModule, { prefix });
  await app.register(insuranceModule, { prefix });
  await app.register(learningModule, { prefix });
  await app.register(integrationsModule, { prefix });
  await app.register(budgetModule, { prefix });
  await app.register(primeContractsModule, { prefix });
  await app.register(commitmentsModule, { prefix });
  await app.register(changesModule, { prefix });
  await app.register(invoicingModule, { prefix });
  await app.register(specificationsModule, { prefix });
  await app.register(meetingsModule, { prefix });
  await app.register(safetyModule, { prefix });
  await app.register(qualityModule, { prefix });
  await app.register(equipmentModule, { prefix });
  await app.register(timecardsModule, { prefix });
  await app.register(biddingModule, { prefix });
  // Cross-cutting reach: search reads projects/access.ts for the same
  // permission scoping the project routes use, so it registers alongside them.
  await app.register(searchModule, { prefix });
  // The intelligence layer and the rules engine both observe every other
  // module's ledger writes, so they mount after the modules they read.
  await app.register(intelligenceModule, { prefix });
  await app.register(automationModule, { prefix });
  await app.register(correspondenceModule, { prefix });
  await app.register(designModule, { prefix });
  await app.register(estimatingModule, { prefix });
  await app.register(portfolioModule, { prefix });
  await app.register(resourcesModule, { prefix });
  await app.register(siteModule, { prefix });
  await app.register(supplychainModule, { prefix });
  await app.register(taxModule, { prefix });
  await app.register(mcpModule, { prefix });

  // Every module has registered its jobs; start the ticker.
  scheduler.start();

  // Same-origin SPA serving (production): the built web app is copied into
  // the container and served by the API, so the client's absolute
  // /api/v1/... paths need no proxy and no CORS. Hashed /assets/* are
  // immutable; index.html is never cached; any non-API GET falls back to
  // index.html for client-side routing.
  const webRoot = config.WEB_DIST_DIR ? path.resolve(config.WEB_DIST_DIR) : null;
  if (webRoot && existsSync(path.join(webRoot, "index.html"))) {
    await app.register(fastifyStatic, {
      root: webRoot,
      wildcard: true,
      index: "index.html",
      setHeaders: (reply, filePath) => {
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          void reply.header("cache-control", "public, max-age=31536000, immutable");
        } else {
          void reply.header("cache-control", "no-cache");
        }
      },
    });
    app.setNotFoundHandler((req, reply) => {
      const wantsApi = req.raw.url?.startsWith("/api/");
      if (!wantsApi && (req.method === "GET" || req.method === "HEAD")) {
        const pathname = req.url.split("?", 1)[0];
        if (pathname !== "/") reply.header("x-robots-tag", "noindex, nofollow");
        return reply.header("cache-control", "no-cache").sendFile("index.html");
      }
      return reply.status(404).send({
        statusCode: 404,
        error: "NotFound",
        message: `Route ${req.method} ${req.url} not found`,
      });
    });
  }

  return {
    app,
    close: async () => {
      await app.close();
      await dbHandle.close();
    },
  };
}
