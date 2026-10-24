-- Isolated demo only. These tables MUST NOT be installed in production D1.
-- Additive and idempotent: apply this demo schema before upgrading the Worker.
-- A claimed/unknown receipt is deliberately not retried automatically: the
-- provider may have delivered the button before its response was lost.
CREATE TABLE IF NOT EXISTS re_demo_webhook_receipts (
 bot_id INTEGER NOT NULL CHECK(bot_id>0),
 update_id INTEGER NOT NULL CHECK(update_id>=0),
 state TEXT NOT NULL CHECK(state IN ('claimed','delivered','unknown')),
 received_at INTEGER NOT NULL CHECK(received_at>0),
 finished_at INTEGER CHECK(finished_at IS NULL OR finished_at>=received_at),
 PRIMARY KEY(bot_id,update_id)
);
CREATE INDEX IF NOT EXISTS idx_re_demo_webhook_received_at ON re_demo_webhook_receipts(received_at);
CREATE TABLE IF NOT EXISTS re_demo_accounts (
 owner_id INTEGER PRIMARY KEY CHECK(owner_id>0),
 generation INTEGER NOT NULL DEFAULT 1 CHECK(generation BETWEEN 1 AND 9999)
);
CREATE TABLE IF NOT EXISTS re_demo_generations (
 owner_id INTEGER NOT NULL,
 generation INTEGER NOT NULL,
 subject_id INTEGER NOT NULL UNIQUE,
 balance INTEGER NOT NULL DEFAULT 1000 CHECK(balance>=0),
 now_sec INTEGER NOT NULL CHECK(now_sec>0),
 plan_code TEXT CHECK(plan_code IS NULL OR plan_code IN ('professional','dragon')),
 auto_renew INTEGER NOT NULL DEFAULT 0 CHECK(auto_renew IN (0,1)),
 origin_order_id TEXT,
 contract_id TEXT,
 paid_until INTEGER,
 last_payment_json TEXT,
 locked_operation_id TEXT,
 revision INTEGER NOT NULL DEFAULT 1,
 PRIMARY KEY(owner_id,generation)
);
CREATE TABLE IF NOT EXISTS re_demo_operations (
 owner_id INTEGER NOT NULL,
 operation_id TEXT NOT NULL,
 generation INTEGER NOT NULL,
 action TEXT NOT NULL,
 request_hash TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('pending','completed')),
 work_json TEXT NOT NULL CHECK(json_valid(work_json)),
 result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
 created_at INTEGER NOT NULL,
 PRIMARY KEY(owner_id,operation_id)
);
