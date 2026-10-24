# RE Program Bot

Telegram bot, Mini App, subscription logic, support bot and a separate Stars demonstration.
This source snapshot includes the audit corrections for subscription expiry, abandoned invoices,
authorization query limits and demo webhook handling. Historical private operational evidence
is kept outside this public source tree.

## Local development

Use Node.js 24, npm and Python 3.11 or newer. The test database is synthetic SQLite;
external network calls are blocked. On Windows, set `PUBLIC_TEST_PYTHON` to the
full Python executable path if Python is not available as `python` on PATH
(`python3` is used on Linux and macOS).

```sh
npm ci --ignore-scripts --no-audit --no-fund
node node_modules/playwright/cli.js install chromium
npm run setup:tests
npm run check:assets
npm test
npm run build
```

The UI checks require a real browser. Set `P11_BROWSER_PATH` to an existing
Chrome/Chromium executable to reuse it instead of downloading the test browser.
The tests use an isolated temporary profile and synthetic responses. Linux CI
installs Chromium's operating-system dependencies with `--with-deps`.
Windows runs suites sequentially to reduce peak memory use on laptops; Linux CI
runs two suites at a time. Test workers limit their JavaScript heap to 768 MiB.

`tests/public-tests.json` lists the maintained offline runtime suites. Tests for old deployments,
private acceptance screenshots and archived release controllers are not public CI requirements.
The build creates `dist/bot.mjs`, `dist/support.mjs` and `dist/demo.mjs`. These are source bundles;
building them does not activate a release, migrate a database or upload anything.

## Editing and contributions

Create a branch and submit a pull request. Only the owner may approve and merge production-related
changes. CI has read-only repository permission and receives no production or backup credentials.
The Mini App's existing appearance is preserved; keep functional fixes separate from restyling.
See `CONTRIBUTING.md` and `SECURITY.md`.

## Running a service

Production deployment is a separate reviewed operation. This repository has no automatic deploy
workflow and no populated provider credentials. Use your own Telegram bots and isolated databases.
Release gates remain fail-closed without the required server configuration; do not remove them to
make a preview appear to work. Never run historical scripts against a real account to set up a fork.

The existing D1 architecture requires the Workers Paid per-invocation query allowance for full
subscription features; it is not certified for Workers Free's 50-query limit. Source CI is independent
of hosting. Current limits: https://developers.cloudflare.com/d1/platform/limits/

Before updating an existing demo Worker, apply the additive `src/v1.4.3-demo/schema.sql` to the
**demo database only**. It adds durable webhook receipts. Main and support databases are separate.

The authority model still has a protective bound of 128 genuine financial evidence rows.
Exceeding it requires review; abandoned never-paid invoices no longer consume that bound.
This is not a claim that arbitrary account history is supported without pagination work.
Referral rechecks also have a finite scan/retry budget and explicitly request manual
review if it is exhausted; a partial scan never authorizes an unproved reward.

## Secrets and backups

Keep production tokens and backup credentials in private operational storage. Public CI does not
need them. Never commit `.env`, `.dev.vars`, archives, SQL exports, logs, original payment screenshots
or personal chat transcripts. A passing source test is not proof of a complete disaster-recovery copy.

## Rights

No additional open-source license is granted in this preparation. Public visibility and GitHub's
fork/pull-request features do not by themselves grant unrestricted redistribution or commercial-use
rights. The owner can choose a license separately. Third-party development tools retain their licenses.
