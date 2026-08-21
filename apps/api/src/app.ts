import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { ZodError } from "zod";
import "./types.js";
import { loadConfig, type Config } from "./config.js";
import { createDb, type DbHandle } from "./lib/db.js";
import { createLocalStorage } from "./lib/storage.js";
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
  });

  await app.register(cors, { origin: true, credentials: true });
  await app.register(multipart, {
    limits: { fileSize: 1024 * 1024 * 1024, files: 25 },
  });

  const dbHandle: DbHandle = await createDb(config);
  app.decorate("db", dbHandle.db);
  app.decorate("storage", createLocalStorage(config.STORAGE_DIR));
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

  return {
    app,
    close: async () => {
      await app.close();
      await dbHandle.close();
    },
  };
}
