import { buildApp } from "./app.js";
import { config } from "./config.js";

const { app } = await buildApp({ config });

try {
  await app.listen({ port: config.PORT, host: config.HOST });
  app.log.info(`ConstructOS API listening on ${config.HOST}:${config.PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
