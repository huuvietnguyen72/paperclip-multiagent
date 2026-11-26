#!/usr/bin/env node
// Paperclip cost watcher.
//
// Paperclip keeps a finished run "waiting_for_receipt" until the provider's final usage receipt arrives. When the
// provider process died (cancelled while hung, "process lost"), that receipt never comes and the run's tokens never
// reach the cost ledger, so Costs and Analytics under-count them. This watcher polls each company's accounting health
// and, once such a run has been finished for GRACE_MS, records the usage Paperclip observed on the run as an
// "estimated" cost event through Paperclip's own POST /cost-events API.
//
// Idempotent: each event uses the key backfill:run:<runId>[:<n>]; the server returns the existing event on a repeat.
// Usage: node cost-watcher.mjs [--once] [--dry-run]

const BASE = process.env.PAPERCLIP_API ?? "http://localhost:3100/api";
const ORIGIN = process.env.PAPERCLIP_ORIGIN ?? "http://localhost:3100";
const POLL_MS = Number(process.env.COST_WATCH_POLL_MS ?? 30_000);
const GRACE_MS = Number(process.env.COST_WATCH_GRACE_MS ?? 180_000);
const once = process.argv.includes("--once");
const dryRun = process.argv.includes("--dry-run");

/** Runs already settled by this process (recorded, or nothing to record) — skipped on later polls. */
const handled = new Set();

const log = (...parts) => console.log(new Date().toISOString(), ...parts);

async function get(path) {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return res.json();
}

/** Cost events for one run's observed usage (one per model when the run carries a per-model split). */
export function eventsForRun(run) {
  const u = run.usageJson ?? {};
  const scope = u.ledgerScope ?? {};
  const parts = Array.isArray(u.usageByModel) && u.usageByModel.length > 0
    ? u.usageByModel.map((m) => ({ model: m.model ?? u.model, input: m.inputTokens ?? 0, cached: m.cachedInputTokens ?? 0, output: m.outputTokens ?? 0, costUsd: m.costUsd ?? 0 }))
    : [{ model: u.model, input: u.inputTokens ?? 0, cached: u.cachedInputTokens ?? 0, output: u.outputTokens ?? 0, costUsd: u.costUsd ?? 0 }];
  const subscription = u.billingType === "subscription_included";
  return parts
    .map((part, i) => ({ part, i }))
    .filter(({ part }) => part.model && part.input + part.cached + part.output > 0)
    .map(({ part, i }) => ({
      idempotencyKey: `backfill:run:${run.id}${parts.length > 1 ? `:${i}` : ""}`,
      agentId: run.agentId,
      heartbeatRunId: run.id,
      issueId: scope.issueId ?? null,
      projectId: scope.projectId ?? null,
      provider: u.provider ?? "unknown",
      biller: u.biller ?? u.provider ?? "unknown",
      billingType: u.billingType ?? "unknown",
      costStatus: "estimated",
      model: part.model,
      inputTokens: part.input,
      cachedInputTokens: part.cached,
      outputTokens: part.output,
      costCents: subscription ? "0" : String(Math.round(Number(part.costUsd || 0) * 1e9) / 1e7),
      occurredAt: new Date(run.finishedAt ?? run.startedAt ?? run.createdAt).toISOString(),
    }));
}

async function sweepCompany(company) {
  const health = await get(`/companies/${company.id}/accounting/health`);
  const now = Date.now();
  for (const item of health.items ?? []) {
    if (item.state !== "waiting_for_receipt" || !item.runId || handled.has(item.runId)) continue;
    // Give a genuine late receipt time to arrive before falling back to the observed usage.
    if (now - Date.parse(item.since) < GRACE_MS) continue;
    const run = await get(`/heartbeat-runs/${item.runId}`);
    const events = eventsForRun(run);
    if (events.length === 0) {
      handled.add(item.runId);
      continue;
    }
    let ok = true;
    for (const body of events) {
      if (dryRun) {
        log("[dry-run]", company.issuePrefix ?? company.id, run.id.slice(0, 8), body.model, body.inputTokens + body.cachedInputTokens + body.outputTokens, "tokens");
        continue;
      }
      const res = await fetch(`${BASE}/companies/${company.id}/cost-events`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: ORIGIN },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        log("recorded", company.issuePrefix ?? company.id, run.id.slice(0, 8), run.status, body.model, body.inputTokens + body.cachedInputTokens + body.outputTokens, "tokens");
      } else {
        ok = false;
        log("FAILED", run.id.slice(0, 8), res.status, (await res.text()).slice(0, 200));
      }
    }
    if (ok && !dryRun) handled.add(item.runId);
  }
}

async function sweep() {
  try {
    const companies = await get("/companies");
    for (const company of companies) {
      if (company.status && company.status !== "active") continue;
      try {
        await sweepCompany(company);
      } catch (error) {
        log("company sweep failed", company.id, error.message);
      }
    }
  } catch (error) {
    // Paperclip is not running (or restarting): try again next poll.
    log("paperclip unreachable:", error.message);
  }
}

log(`cost watcher started (poll ${POLL_MS / 1000}s, grace ${GRACE_MS / 1000}s${dryRun ? ", dry run" : ""})`);
await sweep();
if (!once) setInterval(sweep, POLL_MS);
