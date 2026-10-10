// Rebuild the ClickHouse transcript search index from the bucket.
//   npm run search:reindex                          everything
//   npm run search:reindex -- --month 2026-10       one monthly partition
//   npm run search:reindex -- --account 1 [--month 2026-10]
import { parseArgs } from "node:util";
import { getDb } from "../src/db.js";
import { reindexTranscripts } from "../src/search.js";

const { values } = parseArgs({ options: { account: { type: "string" }, month: { type: "string" } } });
const db = await getDb();
const r = await reindexTranscripts(db, {
  accountId: values.account === undefined ? undefined : Number(values.account),
  month: values.month,
});
console.log(`Indexed ${r.events} events from ${r.files} transcripts under ${r.prefix} in ${r.ms}ms`);
await db.close();
process.exit(0);
