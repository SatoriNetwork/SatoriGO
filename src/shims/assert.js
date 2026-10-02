// Browser stand-in for Node's `assert`, aliased in vite.config.ts for the
// monero-ts page bundle only (the Monero engine design notes §6.1). monero-ts
// calls `assert(cond, msg)`, `assert.equal` and `assert.deepEqual` as internal
// sanity checks; the real module is Node-only. Loose equality on purpose:
// Node's `assert.equal` is `==`, and monero-ts relies on that (numbers against
// numeric strings). `deepEqual` compares through JSON with bigint support,
// which covers the plain data monero-ts passes it.
function fail(message, fallback) {
  const err = new Error(message || fallback);
  err.name = 'AssertionError';
  return err;
}

function assert(condition, message) {
  if (!condition) throw fail(message, 'Assertion failed');
}

const json = (v) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x));

assert.ok = assert;
assert.equal = (actual, expected, message) => {
  if (actual != expected) throw fail(message, `Assertion failed: ${String(actual)} == ${String(expected)}`);
};
assert.notEqual = (actual, expected, message) => {
  if (actual == expected) throw fail(message, `Assertion failed: ${String(actual)} != ${String(expected)}`);
};
assert.strictEqual = (actual, expected, message) => {
  if (actual !== expected) throw fail(message, `Assertion failed: ${String(actual)} === ${String(expected)}`);
};
assert.notStrictEqual = (actual, expected, message) => {
  if (actual === expected) throw fail(message, `Assertion failed: ${String(actual)} !== ${String(expected)}`);
};
assert.deepEqual = (actual, expected, message) => {
  if (json(actual) !== json(expected)) throw fail(message, 'Assertion failed: values are not deeply equal');
};
assert.deepStrictEqual = assert.deepEqual;
assert.fail = (message) => {
  throw fail(message, 'Assertion failed');
};

export default assert;
