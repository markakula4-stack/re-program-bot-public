// Only server-created assertion producers call this helper. Keep all guards;
// combine reads without caching a result or widening the request's budget.
// D1's per-statement limits are 100 bound parameters and 100,000 SQL bytes.
const MAX_PARAMETERS = 100, MAX_SQL_BYTES = 100_000, MAX_ASSERTIONS = 96, MAX_GROUP_ASSERTIONS = 24;
const encoder = new TextEncoder();
const prefix = 'SELECT CASE WHEN (', suffix = ') THEN 1 ELSE 0 END AS valid';
const overhead = encoder.encode(prefix + suffix).length;
const fail = () => { throw Object.assign(new Error('invalid_authority_proof'), { code: 'invalid_authority_proof' }); };

export function compileProofReadQueries(assertions) {
  if (!Array.isArray(assertions) || !assertions.length || assertions.length > MAX_ASSERTIONS) fail();
  const queries = [];
  let parts = [], params = [], bytes = overhead;
  const flush = () => {
    if (!parts.length) return;
    queries.push(Object.freeze({ sql: prefix + parts.join(' AND ') + suffix, params: Object.freeze(params) }));
    parts = []; params = []; bytes = overhead;
  };
  for (const piece of assertions) {
    if (typeof piece?.sql !== 'string' || !piece.sql.trim() || !Array.isArray(piece.params) ||
        piece.params.length > MAX_PARAMETERS) fail();
    const sql = '(' + piece.sql + ')', size = encoder.encode(sql).length;
    if (overhead + size > MAX_SQL_BYTES) fail();
    if (parts.length && (parts.length >= MAX_GROUP_ASSERTIONS || params.length + piece.params.length > MAX_PARAMETERS ||
        bytes + 5 + size > MAX_SQL_BYTES)) flush();
    bytes += (parts.length ? 5 : 0) + size;
    parts.push(sql); params.push(...piece.params);
  }
  flush();
  return Object.freeze(queries);
}

export function proofReadResultsValid(results, expectedCount) {
  return Number.isSafeInteger(expectedCount) && expectedCount > 0 && expectedCount <= MAX_ASSERTIONS &&
    Array.isArray(results) && results.length === expectedCount && results.every(result =>
    result?.success === true && Array.isArray(result.results) && result.results.length === 1 && result.results[0]?.valid === 1);
}
