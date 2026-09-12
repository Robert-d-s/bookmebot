/**
 * Local stand-in for the scheduler: calls /api/cron/tick with CRON_SECRET.
 *   pnpm tick            once
 *   pnpm tick --watch    every 30 seconds (override with --every=10)
 * Runs against APP_URL or http://localhost:3000.
 */
import "dotenv/config";

const base = process.env.APP_URL ?? "http://localhost:3000";
const watch = process.argv.includes("--watch");
const every = Number(process.argv.find((a) => a.startsWith("--every="))?.slice(8) ?? 30);

async function tick() {
  const res = await fetch(`${base}/api/cron/tick`, {
    headers: { authorization: `Bearer ${process.env.CRON_SECRET ?? ""}` },
  });
  const body = await res.text();
  console.log(new Date().toISOString(), res.status, body);
}

(async () => {
  await tick();
  if (!watch) return;
  setInterval(() => tick().catch((e) => console.error(e)), every * 1000);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
