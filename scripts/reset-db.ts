import { getDb, resetDb } from "../src/db.js";

const db = await getDb();
await resetDb(db);
const [{ runs }] = await db.query<{ runs: number }>("SELECT count(*) AS runs FROM trace_runs");
console.log(`Reset ${db.kind} database: schema recreated, ${runs} trace runs seeded.`);
await db.close();
