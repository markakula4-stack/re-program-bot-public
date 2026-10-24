# Audit corrections

- Make legacy prepaid expiry conditional across the entire transaction so a renewed subscription
  cannot be downgraded by a stale expiry attempt.
- Exclude abandoned never-paid invoices from the bounded financial evidence set while preserving
  every linked payment, grant, subscription, contract and referral source.
- Group authorization proofs within D1 limits and verify all groups in one transactional batch.
  Restore subscription views, referral preparation and authorized broadcasts without removing guards.
- Bound demo JSON reads by bytes/time and persist webhook delivery receipts across Worker restarts.
- Continue referral payment reconciliation across bounded durable steps, retaining exact payment
  and refund evidence checks rather than treating the first page window as the whole history.
- Connect the read-only Packages menu callback to the existing authorization handler.
- Update stale test fixtures and race injection hooks while preserving authorization expectations.
- Replace the default legacy deployment workflow with secret-free source validation.

No live deployment or publication is performed by these source changes.
