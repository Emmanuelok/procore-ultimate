import { loadConfig } from "../config.js";
import { createDb } from "../lib/db.js";

const cfg = loadConfig();
const handle = await createDb(cfg); // createDb runs migrations on connect
console.log(`Migrations applied (${cfg.DATABASE_URL ? "postgres" : "pglite"})`);
await handle.close();
