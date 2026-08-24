import { existsSync } from "node:fs";
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
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'wasm-unsafe-eval'"],
        workerSrc: ["'self'", "blob:"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "blob:"],
        connectSrc: ["'self'", "blob:"],
        fontSrc: ["'self'", "data:"],
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
