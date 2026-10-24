import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  createReferralRewardCandidate,
} from "../src/v1.3.7/referral-reward-candidate-runtime.mjs";
import {
  completeReferralProtectionJob,
  ensureReferralProtectionWorkflow,
  getReferralProtectionSchedule,
  reconcileReferralRewardSourcePayment,
  repairReferralProtectionWorkflows,
  settleReferralRewardProtection,
} from "../src/v1.3.7/referral-reward-protection-runtime.mjs";
import {
  REFERRAL_PROTECTION_RETRY_POLICY,
  ReferralRewardProtectionWorkflow,
} from "../src/v1.3.7/referral-reward-protection-workflow.mjs";
import {
  attachReferralCandidateAfterAppliedAccess,
} from "../src/v1.3.7/stars-commerce-runtime.mjs";

const foundationMigration = readFileSync(
  new URL(
    "../migrations/0028-v1.3.7-referral-reward-foundation.sql",
    import.meta.url,
  ),
  "utf8",
);
const cycleGuardMigration = readFileSync(
  new URL(
    "../migrations/0029-v1.3.7-referral-candidate-cycle-guard.sql",
    import.meta.url,
  ),
  "utf8",
);
const protectionMigration = readFileSync(
  new URL(
    "../migrations/0030-v1.3.7-referral-protection-workflow.sql",
    import.meta.url,
  ),
  "utf8",
);
const workflowSource = readFileSync(
  new URL(
    "../src/v1.3.7/referral-reward-protection-workflow.mjs",
    import.meta.url,
  ),
  "utf8",
);
const wrangler = JSON.parse(readFileSync(
  new URL("../wrangler.jsonc", import.meta.url),
  "utf8",
));

const DAY = 86_400;
const BASE_TIME = 1_780_000_000;
let idSequence = 1;

function uuid() {
  return `40000000-0000-4000-8000-${String(idSequence++)
    .padStart(12, "0")}`;
}

function sqlTime(epochSeconds) {
  return new Date(epochSeconds * 1_000)
    .toISOString()
    .replace("T", " ")
    .slice(0, 19);
}

class D1Statement {
  constructor(database, sql, bindings = []) {
    this.database = database;
    this.sql = sql;
    this.bindings = bindings;
  }

  bind(...bindings) {
    return new D1Statement(this.database, this.sql, bindings);
  }

  async first() {
    return this.database.prepare(this.sql).get(...this.bindings) || null;
  }

  async all() {
    return { success: true, results: this.database.prepare(this.sql).all(...this.bindings) };
  }

  runSync() {
    const result = this.database.prepare(this.sql).run(...this.bindings);
    return { success: true, meta: { changes: Number(result.changes || 0) } };
  }

  async run() {
    return this.runSync();
  }
}

class D1Database {
  constructor(database) {
    this.database = database;
    this.beforeBatch = null;
  }

  prepare(sql) {
    return new D1Statement(this.database, sql);
  }

  async batch(statements) {
    const hook = this.beforeBatch;
    this.beforeBatch = null;
    if (hook) hook(this.database);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => statement.runSync());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

class FakeWorkflowBinding {
  constructor({ ambiguousCreate = false, failCreate = false } = {}) {
    this.states = new Map();
    this.createCalls = 0;
    this.ambiguousCreate = ambiguousCreate;
    this.failCreate = failCreate;
  }

  async get(instanceId) {
    return {
      status: async () => ({
        status: this.states.get(instanceId) || "unknown",
      }),
    };
  }

  async create({ id }) {
    this.createCalls += 1;
    if (this.failCreate) {
      const error = new Error("private workflow transport detail");
      error.code = "workflow_transport_failure";
      throw error;
    }
    this.states.set(id, "waiting");
    if (this.ambiguousCreate) {
      const error = new Error("ambiguous response after commit");
      error.code = "workflow_create_ambiguous";
      throw error;
    }
    return { id };
  }
}

class FakeWorkflowStep {
  constructor() {
    this.steps = [];
    this.sleeps = [];
  }

  async do(name, ...args) {
    this.steps.push(name);
    const callback = args.at(-1);
    return callback();
  }

  async sleepUntil(name, timestamp) {
    this.sleeps.push({ name, timestamp });
  }
}

function createFixture(envOverrides = {}) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  sqlite.exec(`
    CREATE TABLE re_schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE users (
      telegram_id INTEGER PRIMARY KEY,
      inviter_id INTEGER,
      inviter_bound_at TEXT,
      referral_code TEXT NOT NULL UNIQUE,
      joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE bot_start_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id INTEGER NOT NULL,
      source_code TEXT NOT NULL DEFAULT 'direct',
      is_new_user INTEGER NOT NULL DEFAULT 0 CHECK (is_new_user IN (0, 1)),
      started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE subscription_orders (
      order_id TEXT PRIMARY KEY,
      telegram_id INTEGER NOT NULL,
      plan_code TEXT NOT NULL,
      currency TEXT NOT NULL DEFAULT 'XTR',
      amount_stars INTEGER NOT NULL,
      order_state TEXT NOT NULL,
      applied_at INTEGER
    );
    CREATE TABLE payment_ledger (
      ledger_entry_id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL REFERENCES subscription_orders(order_id),
      telegram_id INTEGER NOT NULL,
      entry_type TEXT NOT NULL,
      direction TEXT NOT NULL,
      currency TEXT NOT NULL,
      amount_stars INTEGER NOT NULL,
      related_ledger_entry_id TEXT REFERENCES payment_ledger(ledger_entry_id),
      occurred_at INTEGER NOT NULL,
      recorded_at INTEGER NOT NULL
    );
    CREATE TABLE subscriptions (
      subscription_id TEXT PRIMARY KEY,
      telegram_id INTEGER NOT NULL,
      plan_code TEXT NOT NULL,
      status TEXT NOT NULL,
      current_period_end INTEGER NOT NULL
    );
    CREATE TABLE subscription_access_grants (
      grant_id TEXT PRIMARY KEY,
      subscription_id TEXT NOT NULL REFERENCES subscriptions(subscription_id),
      order_id TEXT NOT NULL UNIQUE REFERENCES subscription_orders(order_id),
      payment_ledger_entry_id TEXT NOT NULL UNIQUE
        REFERENCES payment_ledger(ledger_entry_id),
      telegram_id INTEGER NOT NULL,
      plan_code TEXT NOT NULL,
      status TEXT NOT NULL,
      starts_at INTEGER NOT NULL,
      ends_at INTEGER NOT NULL
    );
    CREATE TABLE payment_reconciliation_runs (
      run_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER
    );
    CREATE TABLE payment_reconciliation_items (
      item_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES payment_reconciliation_runs(run_id),
      observation_side TEXT NOT NULL,
      transaction_direction TEXT NOT NULL,
      telegram_id INTEGER,
      amount_stars INTEGER NOT NULL,
      transaction_date INTEGER NOT NULL,
      local_state TEXT NOT NULL,
      ledger_entry_id TEXT REFERENCES payment_ledger(ledger_entry_id),
      observed_at INTEGER NOT NULL
    );
  `);
  sqlite.exec(foundationMigration);
  sqlite.exec(cycleGuardMigration);
  sqlite.exec(protectionMigration);
  sqlite.exec(protectionMigration);
  const database = new D1Database(sqlite);
  return {
    sqlite,
    database,
    env: {
      DB: database,
      ADMIN_ID: "99001",
      REFERRAL_REWARDS_ENABLED: "true",
      REFERRAL_REWARD_ROLLOUT_MODE: "public",
      REFERRAL_REWARD_CANDIDATES_ENABLED: "true",
      REFERRAL_REWARD_CONFIRMATIONS_ENABLED: "true",
      REFERRAL_BONUS_GRANTS_ENABLED: "false",
      REFERRAL_REWARD_PROGRAM_STARTED_AT: String(BASE_TIME - DAY),
      STARS_RECONCILIATION_ENABLED: "true",
      ...envOverrides,
    },
  };
}

function ensureUser(sqlite, telegramId, {
  inviterId = null,
  inviterBoundAt = null,
} = {}) {
  sqlite.prepare(
    `INSERT OR IGNORE INTO users (
       telegram_id, inviter_id, inviter_bound_at, referral_code, joined_at
     ) VALUES (?, ?, ?, ?, ?)`,
  ).run(
    telegramId,
    inviterId,
    inviterBoundAt === null ? null : sqlTime(inviterBoundAt),
    `ref-${telegramId}`,
    sqlTime(BASE_TIME),
  );
}

async function seedPendingReward(fixture, {
  buyerId = 20_001,
  inviterId = 10_001,
  firstStartedAt = BASE_TIME,
  paidAt = firstStartedAt + DAY,
  selectedAt = paidAt + 2,
  planCode = "professional",
} = {}) {
  const orderId = uuid();
  const paymentLedgerId = `payment-${uuid()}`;
  const subscriptionId = uuid();
  const accessGrantId = uuid();
  const amountStars = planCode === "dragon" ? 499 : 249;
  ensureUser(fixture.sqlite, inviterId);
  ensureUser(fixture.sqlite, buyerId, {
    inviterId,
    inviterBoundAt: firstStartedAt,
  });
  fixture.sqlite.prepare(
    `INSERT INTO bot_start_events
       (telegram_id, source_code, is_new_user, started_at)
     VALUES (?, 'referral', 1, ?)`,
  ).run(buyerId, sqlTime(firstStartedAt));
  fixture.sqlite.prepare(
    `INSERT INTO subscription_orders
       (order_id, telegram_id, plan_code, currency, amount_stars,
        order_state, applied_at)
     VALUES (?, ?, ?, 'XTR', ?, 'applied', ?)`,
  ).run(orderId, buyerId, planCode, amountStars, paidAt + 1);
  fixture.sqlite.prepare(
    `INSERT INTO payment_ledger
       (ledger_entry_id, order_id, telegram_id, entry_type, direction,
        currency, amount_stars, related_ledger_entry_id,
        occurred_at, recorded_at)
     VALUES (?, ?, ?, 'payment', 'credit', 'XTR', ?, NULL, ?, ?)`,
  ).run(
    paymentLedgerId,
    orderId,
    buyerId,
    amountStars,
    paidAt,
    paidAt,
  );
  fixture.sqlite.prepare(
    `INSERT INTO subscriptions
       (subscription_id, telegram_id, plan_code, status, current_period_end)
     VALUES (?, ?, ?, 'active', ?)`,
  ).run(subscriptionId, buyerId, planCode, paidAt + 30 * DAY);
  fixture.sqlite.prepare(
    `INSERT INTO subscription_access_grants
       (grant_id, subscription_id, order_id, payment_ledger_entry_id,
        telegram_id, plan_code, status, starts_at, ends_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
  ).run(
    accessGrantId,
    subscriptionId,
    orderId,
    paymentLedgerId,
    buyerId,
    planCode,
    paidAt,
    paidAt + 30 * DAY,
  );
  const candidate = await createReferralRewardCandidate(fixture.env, {
    orderId,
    selectedAt,
  });
  assert.equal(candidate.status, "created");
  return {
    ...candidate,
    orderId,
    paymentLedgerId,
    accessGrantId,
    buyerId,
    inviterId,
    amountStars,
    paidAt,
    selectedAt,
  };
}

function insertReconciliation(fixture, reward, {
  checkedAt = reward.confirmAfter,
  runStatus = "completed",
  localState = "matched",
  observationSide = "telegram",
  direction = "incoming",
  telegramId = reward.buyerId,
  amountStars = reward.amountStars,
  transactionDate = reward.paidAt,
  ledgerEntryId = reward.paymentLedgerId,
} = {}) {
  const runId = uuid();
  const itemId = uuid();
  fixture.sqlite.prepare(
    `INSERT INTO payment_reconciliation_runs
       (run_id, status, started_at, finished_at)
     VALUES (?, ?, ?, ?)`,
  ).run(runId, runStatus, checkedAt, checkedAt);
  fixture.sqlite.prepare(
    `INSERT INTO payment_reconciliation_items
       (item_id, run_id, observation_side, transaction_direction,
        telegram_id, amount_stars, transaction_date, local_state,
        ledger_entry_id, observed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    itemId,
    runId,
    observationSide,
    direction,
    telegramId,
    amountStars,
    transactionDate,
    localState,
    ledgerEntryId,
    checkedAt,
  );
  return { runId, itemId, checkedAt };
}

function insertCompensation(fixture, reward, {
  type = "refund",
  occurredAt = reward.paidAt + 2 * DAY,
  recordedAt = occurredAt,
} = {}) {
  const ledgerId = `${type}-${uuid()}`;
  fixture.sqlite.prepare(
    `INSERT INTO payment_ledger
       (ledger_entry_id, order_id, telegram_id, entry_type, direction,
        currency, amount_stars, related_ledger_entry_id,
        occurred_at, recorded_at)
     VALUES (?, ?, ?, ?, 'debit', 'XTR', ?, ?, ?, ?)`,
  ).run(
    ledgerId,
    reward.orderId,
    reward.buyerId,
    type,
    reward.amountStars,
    reward.paymentLedgerId,
    occurredAt,
    recordedAt,
  );
  fixture.sqlite.prepare(
    `UPDATE subscription_access_grants
     SET status = ? WHERE grant_id = ?`,
  ).run(type, reward.accessGrantId);
  return ledgerId;
}

function count(sqlite, tableName) {
  return Number(
    sqlite.prepare(`SELECT COUNT(*) AS total FROM "${tableName}"`).get().total,
  );
}

function getReward(sqlite, rewardId) {
  return sqlite.prepare(
    `SELECT reward_status, revision, last_transition_id,
            confirmed_at, cancelled_at
     FROM referral_rewards WHERE reward_id = ?`,
  ).get(rewardId);
}

function getJob(sqlite, rewardId) {
  return sqlite.prepare(
    `SELECT * FROM referral_reward_protection_jobs WHERE reward_id = ?`,
  ).get(rewardId);
}

test("Part 3 migration is additive, idempotent and remains disconnected", () => {
  const fixture = createFixture();
  assert.equal(count(fixture.sqlite, "referral_reward_protection_jobs"), 0);
  assert.equal(count(fixture.sqlite, "referral_reward_protection_checks"), 0);
  assert.doesNotMatch(
    protectionMigration.replace(/--.*$/gm, ""),
    /^\s*(?:DROP\b|ALTER\b|DELETE\s+FROM\b|REPLACE\s+INTO\b)/im,
  );
  assert.equal(wrangler.main, "src/v1.3.6/worker-entrypoint.mjs");
  assert.equal(
    Object.keys(wrangler.vars).some((key) => key.startsWith("REFERRAL_")),
    false,
  );
  assert.equal(
    wrangler.workflows.some((entry) =>
      entry.binding === "REFERRAL_REWARD_PROTECTION_WORKFLOW"),
    false,
  );
  assert.match(workflowSource, /step\.sleepUntil/);
  assert.deepEqual(REFERRAL_PROTECTION_RETRY_POLICY.settlement.retries, {
    limit: 10,
    delay: "10 seconds",
    backoff: "exponential",
  });
});

test("scheduler creates one deterministic Workflow and replay is harmless", async () => {
  const fixture = createFixture();
  const reward = await seedPendingReward(fixture);
  const binding = new FakeWorkflowBinding();
  fixture.env.REFERRAL_REWARD_PROTECTION_WORKFLOW = binding;
  const first = await ensureReferralProtectionWorkflow(fixture.env, {
    rewardId: reward.rewardId,
    requestedAt: reward.selectedAt + 1,
  });
  const replay = await ensureReferralProtectionWorkflow(fixture.env, {
    rewardId: reward.rewardId,
    requestedAt: reward.selectedAt + 2,
  });
  assert.equal(first.status, "started");
  assert.equal(replay.status, "started");
  assert.equal(replay.reason, "workflow_already_started");
  assert.equal(first.workflowInstanceId, `referral-protection-${reward.rewardId}`);
  assert.equal(binding.createCalls, 1);
  assert.equal(count(fixture.sqlite, "referral_reward_protection_jobs"), 1);
  assert.equal(getJob(fixture.sqlite, reward.rewardId).start_attempt_count, 1);
});

test("paid-access adapter schedules protection without changing paid result", async () => {
  const fixture = createFixture();
  const reward = await seedPendingReward(fixture, {
    buyerId: 20_010,
    inviterId: 10_010,
  });
  const binding = new FakeWorkflowBinding();
  fixture.env.REFERRAL_REWARD_PROTECTION_WORKFLOW = binding;
  const paidAccess = Object.freeze({
    handled: true,
    status: "applied",
    accessApplied: true,
    orderId: reward.orderId,
    planCode: "professional",
  });
  const result = await attachReferralCandidateAfterAppliedAccess(
    fixture.env,
    { message: { successful_payment: { currency: "XTR" } } },
    paidAccess,
    { selectedAt: reward.selectedAt + 1 },
  );
  assert.equal(result.accessApplied, true);
  assert.equal(result.referralReward.status, "duplicate");
  assert.equal(result.referralReward.rewardId, reward.rewardId);
  assert.equal(result.referralReward.protection.status, "started");
  assert.equal(binding.createCalls, 1);
});

test("ambiguous Workflow create is recovered and failed starts are repairable", async () => {
  {
    const fixture = createFixture();
    const reward = await seedPendingReward(fixture, {
      buyerId: 20_002,
      inviterId: 10_002,
    });
    const binding = new FakeWorkflowBinding({ ambiguousCreate: true });
    fixture.env.REFERRAL_REWARD_PROTECTION_WORKFLOW = binding;
    const result = await ensureReferralProtectionWorkflow(fixture.env, {
      rewardId: reward.rewardId,
      requestedAt: reward.selectedAt + 1,
    });
    assert.equal(result.status, "started");
    assert.equal(result.reason, "ambiguous_create_recovered");
    assert.equal(getJob(fixture.sqlite, reward.rewardId).workflow_state, "started");
  }
  {
    const fixture = createFixture();
    const reward = await seedPendingReward(fixture, {
      buyerId: 20_003,
      inviterId: 10_003,
    });
    fixture.env.REFERRAL_REWARD_PROTECTION_WORKFLOW =
      new FakeWorkflowBinding({ failCreate: true });
    const failed = await ensureReferralProtectionWorkflow(fixture.env, {
      rewardId: reward.rewardId,
      requestedAt: reward.selectedAt + 1,
    });
    assert.equal(failed.status, "start_failed");
    assert.equal(failed.reason, "workflow_transport_failure");
    const repairedBinding = new FakeWorkflowBinding();
    fixture.env.REFERRAL_REWARD_PROTECTION_WORKFLOW = repairedBinding;
    const repaired = await repairReferralProtectionWorkflows(fixture.env, {
      requestedAt: reward.selectedAt + 2,
    });
    assert.equal(repaired.status, "completed");
    assert.equal(repaired.attempted, 1);
    assert.equal(repaired.results[0].status, "started");
    assert.equal(getJob(fixture.sqlite, reward.rewardId).start_attempt_count, 2);
  }
});

test("exact 21-day boundary plus fresh exact reconciliation confirms once", async () => {
  const fixture = createFixture();
  const reward = await seedPendingReward(fixture, {
    buyerId: 21_001,
    inviterId: 11_001,
  });
  const early = await settleReferralRewardProtection(fixture.env, {
    rewardId: reward.rewardId,
    checkedAt: reward.confirmAfter - 1,
  });
  assert.equal(early.status, "waiting");
  assert.equal(early.remainingSeconds, 1);
  assert.equal(getReward(fixture.sqlite, reward.rewardId).reward_status, "pending");

  const fresh = insertReconciliation(fixture, reward);
  const settled = await settleReferralRewardProtection(fixture.env, {
    rewardId: reward.rewardId,
    reconciliationRunId: fresh.runId,
    checkedAt: reward.confirmAfter,
  });
  const replay = await settleReferralRewardProtection(fixture.env, {
    rewardId: reward.rewardId,
    reconciliationRunId: fresh.runId,
    checkedAt: reward.confirmAfter,
  });
  assert.equal(settled.status, "settled");
  assert.equal(settled.outcome, "confirmed");
  assert.equal(replay.status, "already_settled");
  assert.equal(replay.transitionId, settled.transitionId);
  assert.deepEqual(
    Object.fromEntries(Object.entries(getReward(fixture.sqlite, reward.rewardId))),
    {
      reward_status: "confirmed",
      revision: 2,
      last_transition_id: settled.transitionId,
      confirmed_at: reward.confirmAfter,
      cancelled_at: null,
    },
  );
  assert.equal(count(fixture.sqlite, "referral_reward_protection_checks"), 1);
  assert.equal(count(fixture.sqlite, "bonus_access_grants"), 0);
});

test("reconciliation wrapper accepts exact evidence and rejects mismatches", async () => {
  {
    const fixture = createFixture();
    const reward = await seedPendingReward(fixture, {
      buyerId: 21_002,
      inviterId: 11_002,
    });
    let calls = 0;
    const result = await reconcileReferralRewardSourcePayment(
      fixture.env,
      { rewardId: reward.rewardId, checkedAt: reward.confirmAfter },
      {
        reconcileTransactions: async (_env, request) => {
          calls += 1;
          assert.equal(request.runSource, "scheduled");
          const evidence = insertReconciliation(fixture, reward, {
            checkedAt: request.startedAt,
            transactionDate: reward.paidAt + 60,
          });
          return { runId: evidence.runId, status: "completed" };
        },
      },
    );
    assert.equal(calls, 1);
    assert.equal(result.status, "verified");
  }
  {
    const fixture = createFixture();
    const reward = await seedPendingReward(fixture, {
      buyerId: 21_004,
      inviterId: 11_004,
    });
    const existing = insertReconciliation(fixture, reward);
    const result = await reconcileReferralRewardSourcePayment(
      fixture.env,
      { rewardId: reward.rewardId, checkedAt: reward.confirmAfter },
      {
        reconcileTransactions: async () => {
          throw new Error("fresh exact recheck should have been reused");
        },
      },
    );
    assert.equal(result.status, "verified");
    assert.equal(result.reused, true);
    assert.equal(result.reconciliationRunId, existing.runId);
  }
  {
    const fixture = createFixture();
    const reward = await seedPendingReward(fixture, {
      buyerId: 21_003,
      inviterId: 11_003,
    });
    const bad = insertReconciliation(fixture, reward, {
      localState: "missing_telegram",
      observationSide: "local",
    });
    const result = await settleReferralRewardProtection(fixture.env, {
      rewardId: reward.rewardId,
      reconciliationRunId: bad.runId,
      checkedAt: reward.confirmAfter,
    });
    assert.equal(result.status, "manual_review");
    assert.equal(result.reason, "referral_payment_recheck_not_verified");
    assert.equal(getReward(fixture.sqlite, reward.rewardId).reward_status, "pending");
    assert.equal(count(fixture.sqlite, "referral_reward_protection_checks"), 0);
  }
});

test('legacy referral recheck returns a continuation, then verifies only the exact source on the later window',async t=>{
  const fixture=createFixture();t.after(()=>fixture.sqlite.close());
  const reward=await seedPendingReward(fixture),requests=[];
  const reconcileTransactions=async(_env,request)=>{
    requests.push(request.offsetStart);
    if(request.offsetStart===0){
      const runId=uuid();
      fixture.sqlite.prepare('INSERT INTO payment_reconciliation_runs(run_id,status,started_at,finished_at) VALUES(?,?,?,?)')
        .run(runId,'manual_review',request.startedAt,request.startedAt);
      return {runId,status:'manual_review',complete:false,scanComplete:false,nextOffset:2000,transactionsSeen:2000};
    }
    const proof=insertReconciliation(fixture,reward,{checkedAt:request.startedAt,runStatus:'manual_review'});
    return {runId:proof.runId,status:'manual_review',complete:false,scanComplete:true,nextOffset:2001,transactionsSeen:1};
  };
  const first=await reconcileReferralRewardSourcePayment(fixture.env,{rewardId:reward.rewardId,checkedAt:reward.confirmAfter},{reconcileTransactions});
  assert.equal(first.status,'pending');assert.equal(first.nextOffset,2000);
  assert.equal(getReward(fixture.sqlite,reward.rewardId).reward_status,'pending');
  assert.equal(count(fixture.sqlite,'referral_reward_protection_checks'),0);
  const next=await reconcileReferralRewardSourcePayment(fixture.env,
    {rewardId:reward.rewardId,checkedAt:reward.confirmAfter,offsetStart:first.nextOffset},{reconcileTransactions});
  assert.equal(next.status,'verified');assert.deepEqual(requests,[0,2000]);
  const settled=await settleReferralRewardProtection(fixture.env,{rewardId:reward.rewardId,
    checkedAt:next.checkedAt,reconciliationRunId:next.reconciliationRunId});
  assert.equal(settled.outcome,'confirmed');assert.equal(count(fixture.sqlite,'referral_reward_protection_checks'),1);
});

test("refund and chargeback cancel a pending reward without a bonus", async () => {
  for (const [offset, type] of ["refund", "chargeback"].entries()) {
    const fixture = createFixture();
    const reward = await seedPendingReward(fixture, {
      buyerId: 22_001 + offset,
      inviterId: 12_001 + offset,
    });
    const compensationId = insertCompensation(fixture, reward, {
      type,
      occurredAt: reward.confirmAfter - DAY,
      recordedAt: reward.confirmAfter - DAY,
    });
    const settled = await settleReferralRewardProtection(fixture.env, {
      rewardId: reward.rewardId,
      checkedAt: reward.confirmAfter,
    });
    assert.equal(settled.status, "settled");
    assert.equal(settled.outcome, "cancelled");
    const transition = fixture.sqlite.prepare(
      `SELECT reason_code, related_payment_ledger_entry_id
       FROM referral_reward_transitions WHERE transition_id = ?`,
    ).get(settled.transitionId);
    assert.equal(transition.reason_code, type);
    assert.equal(transition.related_payment_ledger_entry_id, compensationId);
    assert.equal(count(fixture.sqlite, "bonus_access_grants"), 0);
  }
});

test("compensation arriving inside the confirmation transaction wins the race", async () => {
  const fixture = createFixture();
  const reward = await seedPendingReward(fixture, {
    buyerId: 23_001,
    inviterId: 13_001,
  });
  const fresh = insertReconciliation(fixture, reward);
  let compensationId;
  fixture.database.beforeBatch = () => {
    compensationId = insertCompensation(fixture, reward, {
      type: "chargeback",
      occurredAt: reward.confirmAfter,
      recordedAt: reward.confirmAfter,
    });
  };
  const settled = await settleReferralRewardProtection(fixture.env, {
    rewardId: reward.rewardId,
    reconciliationRunId: fresh.runId,
    checkedAt: reward.confirmAfter,
  });
  assert.equal(settled.outcome, "cancelled");
  const checks = fixture.sqlite.prepare(
    `SELECT decision, reason_code, compensation_ledger_entry_id
     FROM referral_reward_protection_checks`,
  ).all();
  assert.equal(checks.length, 1);
  assert.deepEqual(Object.fromEntries(Object.entries(checks[0])), {
    decision: "cancel",
    reason_code: "chargeback",
    compensation_ledger_entry_id: compensationId,
  });
});

test("eight concurrent settlements create one final transition and one check", async () => {
  const fixture = createFixture();
  const reward = await seedPendingReward(fixture, {
    buyerId: 24_001,
    inviterId: 14_001,
  });
  const fresh = insertReconciliation(fixture, reward);
  const results = await Promise.all(Array.from({ length: 8 }, () =>
    settleReferralRewardProtection(fixture.env, {
      rewardId: reward.rewardId,
      reconciliationRunId: fresh.runId,
      checkedAt: reward.confirmAfter,
    })));
  assert.equal(results.filter((entry) => entry.status === "settled").length, 1);
  assert.equal(
    results.filter((entry) => entry.status === "already_settled").length,
    7,
  );
  assert.equal(count(fixture.sqlite, "referral_reward_protection_checks"), 1);
  assert.equal(
    fixture.sqlite.prepare(
      `SELECT COUNT(*) AS total FROM referral_reward_transitions
       WHERE reward_id = ? AND from_status = 'pending'`,
    ).get(reward.rewardId).total,
    1,
  );
});

test("database refuses an automated transition without its protection check", async () => {
  const fixture = createFixture();
  const reward = await seedPendingReward(fixture, {
    buyerId: 25_001,
    inviterId: 15_001,
  });
  assert.throws(() => fixture.sqlite.prepare(
    `INSERT INTO referral_reward_transitions (
       transition_id, transition_key, transition_scope, reward_id,
       bonus_grant_id, from_status, to_status, from_revision, to_revision,
       reason_code, actor_type, actor_id, related_payment_ledger_entry_id,
       effect_starts_at, effect_ends_at, compensated_seconds,
       occurred_at, recorded_at
     ) VALUES (?, ?, 'reward', ?, NULL, 'pending', 'confirmed', 1, 2,
               'hold_elapsed', 'workflow', NULL, ?, NULL, NULL, 0, ?, ?)`,
  ).run(
    uuid(),
    `unprotected:${reward.rewardId}`,
    reward.rewardId,
    reward.paymentLedgerId,
    reward.confirmAfter,
    reward.confirmAfter,
  ), /protection check/);
  assert.equal(getReward(fixture.sqlite, reward.rewardId).reward_status, "pending");
});

test("Workflow sleeps to canonical time and completes compensated reward", async () => {
  const fixture = createFixture({
    REFERRAL_REWARD_PROGRAM_STARTED_AT: String(BASE_TIME - 60 * DAY),
  });
  const reward = await seedPendingReward(fixture, {
    buyerId: 26_001,
    inviterId: 16_001,
    firstStartedAt: BASE_TIME - 40 * DAY,
    paidAt: BASE_TIME - 39 * DAY,
  });
  const binding = new FakeWorkflowBinding();
  fixture.env.REFERRAL_REWARD_PROTECTION_WORKFLOW = binding;
  await ensureReferralProtectionWorkflow(fixture.env, {
    rewardId: reward.rewardId,
    requestedAt: reward.selectedAt + 1,
  });
  insertCompensation(fixture, reward, {
    type: "refund",
    occurredAt: reward.confirmAfter - DAY,
    recordedAt: reward.confirmAfter - DAY,
  });
  const step = new FakeWorkflowStep();
  const workflow = new ReferralRewardProtectionWorkflow(null, fixture.env);
  const result = await workflow.run({ payload: { rewardId: reward.rewardId } }, step);
  assert.equal(result.outcome, "cancelled");
  assert.deepEqual(step.sleeps, [{
    name: "wait until referral protection hold ends",
    timestamp: reward.confirmAfter * 1_000,
  }]);
  const job = getJob(fixture.sqlite, reward.rewardId);
  assert.equal(job.workflow_state, "completed");
  assert.equal(job.settlement_outcome, "cancelled");
  assert.equal(job.settled_transition_id, result.transitionId);
});

test("disabled confirmation gate writes neither job nor transition", async () => {
  const fixture = createFixture({
    REFERRAL_REWARD_CONFIRMATIONS_ENABLED: "false",
  });
  const reward = await seedPendingReward(fixture, {
    buyerId: 27_001,
    inviterId: 17_001,
  });
  const scheduled = await ensureReferralProtectionWorkflow(fixture.env, {
    rewardId: reward.rewardId,
    requestedAt: reward.selectedAt + 1,
  });
  const settled = await settleReferralRewardProtection(fixture.env, {
    rewardId: reward.rewardId,
    checkedAt: reward.confirmAfter,
  });
  assert.equal(scheduled.status, "disabled");
  assert.equal(settled.status, "disabled");
  assert.equal(count(fixture.sqlite, "referral_reward_protection_jobs"), 0);
  assert.equal(count(fixture.sqlite, "referral_reward_protection_checks"), 0);
  assert.equal(getReward(fixture.sqlite, reward.rewardId).reward_status, "pending");
});

test("completed jobs are immutable and schedule reads canonical D1 state", async () => {
  const fixture = createFixture();
  const reward = await seedPendingReward(fixture, {
    buyerId: 28_001,
    inviterId: 18_001,
  });
  fixture.env.REFERRAL_REWARD_PROTECTION_WORKFLOW = new FakeWorkflowBinding();
  const started = await ensureReferralProtectionWorkflow(fixture.env, {
    rewardId: reward.rewardId,
    requestedAt: reward.selectedAt + 1,
  });
  const schedule = await getReferralProtectionSchedule(fixture.env, {
    rewardId: reward.rewardId,
  });
  assert.equal(schedule.confirmAfter, reward.confirmAfter);
  assert.equal(schedule.workflowInstanceId, started.workflowInstanceId);
  const fresh = insertReconciliation(fixture, reward);
  const settlement = await settleReferralRewardProtection(fixture.env, {
    rewardId: reward.rewardId,
    reconciliationRunId: fresh.runId,
    checkedAt: reward.confirmAfter,
  });
  const completed = await completeReferralProtectionJob(fixture.env, {
    rewardId: reward.rewardId,
    transitionId: settlement.transitionId,
    outcome: settlement.outcome,
    reconciliationRunId: fresh.runId,
    completedAt: reward.confirmAfter,
  });
  assert.equal(completed.status, "completed");
  assert.throws(() => fixture.sqlite.prepare(
    `UPDATE referral_reward_protection_jobs
     SET last_error_code = 'rewrite' WHERE reward_id = ?`,
  ).run(reward.rewardId), /completed protection job is immutable/);
  assert.throws(() => fixture.sqlite.prepare(
    `DELETE FROM referral_reward_protection_checks WHERE reward_id = ?`,
  ).run(reward.rewardId), /append-only/);
});
