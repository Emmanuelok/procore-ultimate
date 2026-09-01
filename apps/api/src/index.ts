import { buildApp } from "./app.js";
import { config } from "./config.js";

const { app, close } = await buildApp({ config });

/*
 * Graceful shutdown. Node is PID 1 in the container, so without handlers a
 * redeploy's SIGTERM is ignored until the platform escalates to SIGKILL
 * mid-request: in-flight uploads are lost, a ledger append can be cut
 * between the operational write and the chain entry, and the scheduler may
 * be half-way through a sweep. Closing the server first stops new
 * connections and lets in-flight requests finish; closing the database
 * handle second releases the pool. A hard deadline guarantees the process
 * still exits if something hangs.
 */
let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "shutdown requested");
  const deadline = setTimeout(() => {
    app.log.error("shutdown deadline reached, exiting");
    process.exit(1);
  }, 25_000);
  deadline.unref();
  try {
    await close();
    app.log.info("shutdown complete");
    process.exit(0);
  } catch (err) {
    app.log.error(err, "shutdown failed");
    process.exit(1);
  }
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

try {
  await app.listen({ port: config.PORT, host: config.HOST });
  app.log.info(`ConstructOS API listening on ${config.HOST}:${config.PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
