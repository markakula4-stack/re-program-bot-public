import { PACKAGE_SCHEMA, PACKAGE_PAYMENT_REVIEW_SCHEMA, PACKAGE_PROVIDER_INACTIVE_EXIT_SCHEMA,
  inspectPackageSchema, inspectPackagePaymentReviewSchema,
  packageSchemaSerializationObjects } from './package-schema.mjs';
import { inspectPackageReferralSchema, packageReferralSchemaAssertion } from './package-referral-contract.mjs';

const fail = () => { throw Object.assign(new Error('native_recovery_frame_unverified'), {
  code: 'native_recovery_frame_unverified', status: 403 }); };

// The original native frame stays immutable. Accept only exact reviewed
// additive package objects, then verify the unchanged historical frame hash.
// Callers still assert the FULL actual schema and migration inventory in the
// same operation batch; this never hides an unknown object or old DDL change.
export async function readPackageNativeFrameExtension({ db, schema, ledger } = {}) {
  if (!Array.isArray(schema) || !Array.isArray(ledger)) fail();
  const base = await inspectPackageSchema(db), review = await inspectPackagePaymentReviewSchema(db);
  if (review.present && !base.present) fail();
  let referral, referralAssertion;
  try { referral = await inspectPackageReferralSchema(db); referralAssertion = packageReferralSchemaAssertion(referral); } catch { fail(); }
  if (referral.present && !base.present) fail();
  const manifests = [...(base.present ? [{ marker: PACKAGE_SCHEMA.marker,
    objects: packageSchemaSerializationObjects(base) }] : []),
    ...(base.providerInactiveExitReady ? [{marker:PACKAGE_PROVIDER_INACTIVE_EXIT_SCHEMA.marker,objects:[]}] : []),
    ...(review.present ? [PACKAGE_PAYMENT_REVIEW_SCHEMA] : []),
    ...(referral.present ? [{ marker: referral.marker, objects: JSON.parse(referralAssertion.params.at(-2)) }] : [])];
  const names = new Set(manifests.flatMap(manifest => manifest.objects
    .filter(row => row.sql !== null).map(row => row.name)));
  const markers = new Set(manifests.map(manifest => manifest.marker));
  for (const manifest of manifests) {
    for (const expected of manifest.objects.filter(row => row.sql !== null)) {
      const actual = schema.filter(row => row.name === expected.name);
      if (actual.length !== 1 || actual[0].type !== expected.type ||
          actual[0].tbl_name !== expected.table_name || actual[0].sql !== expected.sql) fail();
    }
    if (ledger.filter(row => row.version === manifest.marker).length !== 1) fail();
  }
  return Object.freeze({ baselineSchema: schema.filter(row => !names.has(row.name)),
    baselineLedger: ledger.filter(row => !markers.has(row.version)),
    extensionAssertions: Object.freeze([referralAssertion]),
    extensionObjectCount: names.size, extensionMarkers: Object.freeze([...markers].sort()) });
}
