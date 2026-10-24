import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { compileProofReadQueries, proofReadResultsValid } from '../src/v1.4.1/proof-queries.mjs';

const execute = (db, queries) => queries.map(query => ({ success: true,
  results: db.prepare(query.sql).all(...query.params) }));

test('all authority assertions remain required across D1 parameter-bounded groups', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const assertions = Array.from({ length: 49 }, (_, id) => ({ sql: '? = ? AND ? = 1', params: [id, id, 1] }));
  const grouped = compileProofReadQueries(assertions);
  assert.ok(grouped.length < assertions.length && grouped.length > 1);
  assert.equal(grouped.reduce((n, query) => n + query.params.length, 0), 147);
  assert.ok(grouped.every(query => query.params.length <= 100 && new TextEncoder().encode(query.sql).length <= 100_000));
  assert.equal(proofReadResultsValid(execute(db, grouped), grouped.length), true);
  // Failure in an early, middle or final group cannot be hidden by another
  // successful group; a NULL predicate is also not an authorization.
  for (const index of [0, 24, 48]) for (const value of [0, null]) {
    const stale = assertions.map(piece => ({ sql: piece.sql, params: [...piece.params] }));
    stale[index].params[2] = value;
    const queries = compileProofReadQueries(stale);
    assert.equal(proofReadResultsValid(execute(db, queries), queries.length), false);
  }
});

test('SQL byte and bound-parameter limits split queries without dropping predicates', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const hundred = { sql: Array.from({ length: 50 }, () => '? = ?').join(' AND '), params: Array(100).fill(1) };
  const queries = compileProofReadQueries([hundred, { sql: '? = 1', params: [1] }]);
  assert.equal(queries.length, 2);
  assert.equal(proofReadResultsValid(execute(db, queries), 2), true);
  const large = { sql: '1 /*' + 'é'.repeat(30_000) + '*/', params: [] };
  const byteSplit = compileProofReadQueries([large, large]);
  assert.equal(byteSplit.length, 2);
  assert.ok(byteSplit.every(query => new TextEncoder().encode(query.sql).length <= 100_000));
  assert.equal(proofReadResultsValid(execute(db, byteSplit), 2), true);
  for (const bad of [[], [{ sql: '1', params: Array(101).fill(1) }],
    [{ sql: '1 /*' + 'é'.repeat(50_000) + '*/', params: [] }],
    Array.from({ length: 97 }, () => ({ sql: '1', params: [] })), [{ sql: ' ', params: [] }]]) {
    assert.throws(() => compileProofReadQueries(bad), /invalid_authority_proof/);
  }
});

test('missing, malformed and partial batch results fail closed', () => {
  assert.equal(proofReadResultsValid([],0),false);
  const valid = { success: true, results: [{ valid: 1 }] };
  for (const results of [null, [], [valid], [valid, { success: false, results: [{ valid: 1 }] }],
    [valid, { success: true, results: [] }], [valid, { success: true, results: [null] }], [valid, { success: true, results: [{ valid: '1' }] }],
    [valid, { success: true, results: [{ valid: 1 }, { valid: 1 }] }]]) {
    assert.equal(proofReadResultsValid(results, 2), false);
  }
});
