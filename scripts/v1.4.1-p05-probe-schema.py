#!/usr/bin/env python3
"""Fixed public DDL and fictional P05 rows; no production access."""
import json
import re
import runpy
from types import SimpleNamespace
from pathlib import Path

ROOT=Path(__file__).resolve().parent.parent
schema=SimpleNamespace(**runpy.run_path(str(ROOT/'scripts/public-probe-schema.py')))
objects=schema.public_schema()
statements=[]
for kind in ('table','index','view','trigger'):
    statements.extend(row['sql'].rstrip(';')+';' for row in objects.values() if row['type']==kind)
for name in (*schema.MIGRATIONS,'0060-v1.4.0-rebuild-effect-privacy.sql','0061-v1.4.0-rebuild-release-lease.sql',
             '0062-v1.4.1-capability-policy.sql','0063-v1.4.1-grants-overrides.sql',
             '0064-v1.4.1-audit-rollout.sql','0065-v1.4.1-privacy-ai-journal.sql'):
    statements.extend(schema.statements((ROOT/'migrations'/name).read_text(encoding='utf-8')))
for sql in schema.statements((ROOT/'migrations/0021-v1.3.5-plan-foundation.sql').read_text(encoding='utf-8')):
    if re.match(r'INSERT OR IGNORE INTO (plan_catalog|plan_display_versions|plan_aliases)\b',schema.sql_head(sql),re.I):statements.append(sql)
for sql in schema.statements((ROOT/'migrations/0037-v1.3.9-canonical-analytics-foundation.sql').read_text(encoding='utf-8')):
    if schema.sql_head(sql).upper().startswith('INSERT'):statements.append(sql)
statements.append('INSERT INTO partner_beta_settings(id,enabled,private_offers_enabled,submissions_enabled,public_visibility_enabled,max_active_offers_per_partner) VALUES(1,1,1,1,1,25);')
for actor in (101,202,303,900):
    statements.extend((f"INSERT INTO users(telegram_id,referral_code,accepted_terms) VALUES({actor},'p05_synthetic_{actor}',1);",
                       f"INSERT INTO user_roles(telegram_id,role,status) VALUES({actor},'user','active');",
                       f"INSERT INTO user_access(telegram_id,access_tier) VALUES({actor},'free');"))
statements.append("INSERT INTO user_roles(telegram_id,role,status) VALUES(900,'admin','active');")
statements.extend(("WITH RECURSIVE n(id) AS (SELECT 10000 UNION ALL SELECT id+1 FROM n WHERE id<10999) INSERT INTO users(telegram_id,referral_code,accepted_terms) SELECT id,'p05_population_'||id,1 FROM n;",
                   "INSERT INTO user_roles(telegram_id,role,status) SELECT telegram_id,'user','active' FROM users WHERE telegram_id BETWEEN 10000 AND 10999;",
                   "INSERT INTO user_access(telegram_id,access_tier) SELECT telegram_id,'free' FROM users WHERE telegram_id BETWEEN 10000 AND 10999;"))
print(json.dumps([statements[i:i+32] for i in range(0,len(statements),32)]))
