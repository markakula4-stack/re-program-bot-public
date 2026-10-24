#!/usr/bin/env python3
"""Compile the seven new v1.4.1 foundations from checked-in additive SQL.

The database is synthetic and contains no live schema export, credentials,
identity rows, or private data. Only new-table DDL enters the generated module.
--check compares source hashes and exact SQLite schema bytes without writing.
"""
import argparse
import hashlib
import json
from pathlib import Path
import sqlite3


ROOT = Path(__file__).resolve().parent.parent
MIGRATIONS = (
    "0062-v1.4.1-capability-policy.sql",
    "0063-v1.4.1-grants-overrides.sql",
    "0064-v1.4.1-audit-rollout.sql",
)
TABLES = (
    "capability_catalog", "plan_capabilities", "entitlement_grants",
    "entitlement_overrides", "entitlement_decision_audit", "feature_flags",
    "feature_flag_assignments",
)
OLD_TABLES = (
    "re_schema_migrations", "mini_app_privacy_guard", "privacy_deletion_requests",
)
OUTPUT = ROOT / "src/v1.4.1/foundation-schema.mjs"


def compact(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def schema_rows(db, tables):
    placeholders = ",".join("?" for _ in tables)
    return [dict(name=name, type=kind, table_name=table, sql=sql)
            for kind, name, table, sql in db.execute(
                "SELECT type,name,tbl_name,sql FROM sqlite_schema "
                f"WHERE tbl_name IN ({placeholders}) ORDER BY type,name", tables)]


def build():
    db = sqlite3.connect(":memory:")
    try:
        db.execute("PRAGMA foreign_keys=ON")
        # The synthetic old fixture exists only to resolve the existing cleanup
        # and migration-ledger names. Its DDL is excluded from the new manifest.
        db.executescript("""
          CREATE TABLE re_schema_migrations(version TEXT PRIMARY KEY);
          CREATE TABLE mini_app_privacy_guard(
            request_id TEXT, subject_id INTEGER, reason TEXT,
            precondition_ok INTEGER, expires_at INTEGER);
          CREATE TABLE privacy_deletion_requests(
            request_id TEXT PRIMARY KEY, telegram_id INTEGER,
            status TEXT, expires_at TEXT);
        """)
        old = schema_rows(db, OLD_TABLES)
        hashes = {}
        for name in MIGRATIONS:
            source = (ROOT / "migrations" / name).read_bytes()
            hashes[name] = hashlib.sha256(source).hexdigest()
            db.executescript(source.decode("utf-8"))
        if schema_rows(db, OLD_TABLES) != old:
            raise RuntimeError("foundation_changed_old_schema")
        actual_tables = {row[0] for row in db.execute(
            "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'")}
        if actual_tables != set(OLD_TABLES) | set(TABLES):
            raise RuntimeError("foundation_table_set_invalid")
        objects = schema_rows(db, TABLES)
        columns = {table: [row[1] for row in db.execute(f'PRAGMA table_info("{table}")')]
                   for table in TABLES}
        if not all(columns.values()):
            raise RuntimeError("foundation_columns_missing")
        if db.execute("PRAGMA integrity_check").fetchone()[0] != "ok" or list(
                db.execute("PRAGMA foreign_key_check")):
            raise RuntimeError("foundation_schema_invalid")
        manifest = dict(version=1, sourceKind="synthetic_additive_ddl_only",
                        migrationSha256=hashes, tables=list(TABLES), columns=columns,
                        objects=objects, schemaSha256=hashlib.sha256(
                            compact(objects).encode("utf-8")).hexdigest())
        output = (
            "// Generated from seven new foundations only; no live/identity rows.\n"
            "// Run scripts/v1.4.1-build-foundation-schema.py; --check rejects drift.\n"
            "const freeze = value => {\n"
            "  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;\n"
            "  for (const child of Object.values(value)) freeze(child);\n"
            "  return Object.freeze(value);\n"
            "};\n"
            "export const FOUNDATION_SCHEMA = freeze(" + compact(manifest) + ");\n"
        )
        return output, manifest
    finally:
        db.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    output, manifest = build()
    if args.check:
        if not OUTPUT.is_file() or OUTPUT.read_text(encoding="utf-8") != output:
            raise SystemExit("foundation_schema_stale")
    else:
        OUTPUT.parent.mkdir(parents=True, exist_ok=True)
        OUTPUT.write_text(output, encoding="utf-8")
    print(compact(dict(tables=len(manifest["tables"]), schemaObjects=len(manifest["objects"]),
                       implicitIndexes=sum(row["type"] == "index" and row["sql"] is None
                                           for row in manifest["objects"]),
                       migrationFiles=len(manifest["migrationSha256"]),
                       schemaSha256=manifest["schemaSha256"], check=args.check)))


if __name__ == "__main__":
    main()
