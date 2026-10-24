"""Public accepted DDL plus four fictional users, before 0062–0065."""
import json, runpy
from types import SimpleNamespace
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
schema = SimpleNamespace(**runpy.run_path(str(ROOT/'scripts/public-probe-schema.py')))
objects = schema.public_schema()
statements = []
for kind in ('table', 'index', 'view', 'trigger'):
    statements.extend(row['sql'].rstrip(';')+';' for row in objects.values() if row['type'] == kind)
for name in (*schema.MIGRATIONS, '0060-v1.4.0-rebuild-effect-privacy.sql', '0061-v1.4.0-rebuild-release-lease.sql'):
    statements.extend(schema.statements((ROOT/'migrations'/name).read_text(encoding='utf-8')))
for actor in (101, 202, 303, 900):
    statements.extend((f"INSERT INTO users(telegram_id,referral_code,accepted_terms) VALUES({actor},'p06_fixture_{actor}',1);",
                       f"INSERT INTO user_roles(telegram_id,role,status) VALUES({actor},'user','active');",
                       f"INSERT INTO user_access(telegram_id,access_tier) VALUES({actor},'free');"))
statements.extend(("INSERT INTO user_roles(telegram_id,role,status) VALUES(900,'admin','active');",
                   "INSERT INTO mini_app_release_control(id,candidate_sha,revision,state,beta_enabled,updated_at) VALUES(1,'54fe39772c290c49a35ae4d259c8bb5c0883dbb9',26,'closed',0,unixepoch());"))
print(json.dumps([statements[i:i+32] for i in range(0, len(statements), 32)]))
