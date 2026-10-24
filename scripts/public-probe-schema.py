"""Public schema-only input and SQLite-aware splitting for offline probe builds."""
import json
import re
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIGRATIONS = (
    '0057-v1.4.0-rebuild-mini-app-storage.sql',
    '0058-v1.4.0-rebuild-legal-history.sql',
    '0059-v1.4.0-rebuild-lead-history.sql',
)


def public_schema():
    rows = json.loads((ROOT / 'tests/fixtures/base-schema.json').read_text(encoding='utf-8'))['objects']
    objects = {row['name']: row for row in rows
               if not row['name'].startswith(('sqlite_', '_cf_'))}
    if not objects or not all(row.get('sql') and row['type'] in ('table', 'index', 'view', 'trigger')
                              for row in objects.values()):
        raise ValueError('public_probe_schema_invalid')
    return objects


def sql_head(statement):
    return re.sub(r'^(?:\s|--[^\n]*(?:\n|$)|/\*.*?\*/)+', '', statement, flags=re.S).strip()


def statements(source):
    # complete_statement preserves semicolons in triggers and quoted strings.
    pending = ''
    for char in source:
        pending += char
        if char == ';' and sqlite3.complete_statement(pending):
            yield pending
            pending = ''
    if sql_head(pending):
        raise ValueError('public_probe_statement_incomplete')
