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
import "./types.js";
import { loadConfig, type Config } from "./config.js";
import { createDb, type DbHandle } from "./lib/db.js";
import { createLocalStorage } from "./lib/storage.js";
import { createS3Storage } from "./lib/storage-s3.js";
import { AppError } from "./lib/errors.js";
import authPlugin from "./plugins/auth.js";

// Module plugins — each owns its routes under /api/v1.
import { identityModule } from "./modules/identity/index.js";
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
    trustProxy: config.TRUST_PROXY,
  });

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
        connectSrc: ["'self'", "blob:"],
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

  await app.register(cors, { origin: true, credentials: true });
  await app.register(multipart, {
    limits: { fileSize: 1024 * 1024 * 1024, files: 25 },
  });

  const dbHandle: DbHandle = await createDb(config);
  app.decorate("db", dbHandle.db);
  app.decorate(
    "storage",
    config.STORAGE_DRIVER === "s3" ? createS3Storage(config) : createLocalStorage(config.STORAGE_DIR),
  );
  app.decorate("appConfig", config);

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

  const prefix = "/api/v1";
  await app.register(identityModule, { prefix });
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
