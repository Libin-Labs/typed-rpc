import test from 'node:test';
import assert from 'node:assert/strict';
import { createRpc, defineProcedure, RpcError } from '../dist/esm/index.js';

const numberParser = (value) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError('number required');
  return value;
};
const addProcedure = defineProcedure({
  parseInput(value) {
    if (
      !value ||
      typeof value !== 'object' ||
      typeof value.a !== 'number' ||
      typeof value.b !== 'number'
    )
      throw new TypeError('pair required');
    return { a: value.a, b: value.b };
  },
  parseOutput: numberParser,
  handler: ({ a, b }) => a + b,
});

test('dispatches validated input and output through an inferred procedure', async () => {
  const rpc = createRpc({ add: addProcedure });
  assert.equal(await rpc.call('add', { a: 2, b: 3 }), 5);
});

test('classifies input parse failures and does not invoke handler', async () => {
  let called = false;
  const procedure = defineProcedure({
    parseInput() {
      throw new Error('bad input');
    },
    parseOutput: numberParser,
    handler() {
      called = true;
      return 0;
    },
  });
  await assert.rejects(createRpc({ procedure }).call('procedure', null), (error) => {
    assert.equal(error.code, 'input');
    assert.equal(error.cause.message, 'bad input');
    return true;
  });
  assert.equal(called, false);
});

test('classifies output parse failures', async () => {
  const procedure = defineProcedure({
    parseInput: numberParser,
    parseOutput: numberParser,
    handler: () => 'not a number',
  });
  await assert.rejects(createRpc({ procedure }).call('procedure', 1), { code: 'output' });
});

test('wraps handler errors and retains the original cause', async () => {
  const original = new Error('boom');
  const procedure = defineProcedure({
    parseInput: numberParser,
    parseOutput: numberParser,
    handler() {
      throw original;
    },
  });
  await assert.rejects(createRpc({ procedure }).call('procedure', 1), (error) => {
    assert.equal(error.code, 'handler');
    assert.strictEqual(error.cause, original);
    return true;
  });
});

test('reports unknown names and invalid names explicitly', async () => {
  const rpc = createRpc({ add: addProcedure });
  await assert.rejects(rpc.call('missing', null), { code: 'not-found' });
  await assert.rejects(rpc.call('', null), { code: 'invalid' });
});

test('rejects already-aborted signals before executing a handler', async () => {
  let called = false;
  const procedure = defineProcedure({
    parseInput: numberParser,
    parseOutput: numberParser,
    handler(value) {
      called = true;
      return value;
    },
  });
  const controller = new AbortController();
  controller.abort('stop');
  await assert.rejects(
    createRpc({ procedure }).call('procedure', 1, { signal: controller.signal }),
    {
      code: 'cancelled',
    },
  );
  assert.equal(called, false);
});

test('passes cancellation context to handlers and discards late results', async () => {
  let observedSignal;
  const procedure = defineProcedure({
    parseInput: numberParser,
    parseOutput: numberParser,
    async handler(value, context) {
      observedSignal = context.signal;
      await Promise.resolve();
      return value;
    },
  });
  const controller = new AbortController();
  const promise = createRpc({ procedure }).call('procedure', 3, { signal: controller.signal });
  controller.abort('cancelled');
  await assert.rejects(promise, { code: 'cancelled' });
  assert.strictEqual(observedSignal, controller.signal);
});

test('batch isolates per-call failures and continues sequentially', async () => {
  const order = [];
  const procedure = defineProcedure({
    parseInput: numberParser,
    parseOutput: numberParser,
    handler(value) {
      order.push(value);
      return value * 2;
    },
  });
  const rpc = createRpc({ double: procedure });
  const results = await rpc.batch([
    { name: 'double', input: 2 },
    { name: 'missing', input: 3 },
    { name: 'double', input: 4 },
  ]);
  assert.deepEqual(order, [2, 4]);
  assert.deepEqual(
    results.map((result) => result.ok),
    [true, false, true],
  );
  assert.equal(results[1].error.code, 'not-found');
  assert.equal(results[2].value, 8);
});

test('rejects oversized batches before running any procedure', async () => {
  let calls = 0;
  const procedure = defineProcedure({
    parseInput: numberParser,
    parseOutput: numberParser,
    handler(value) {
      calls++;
      return value;
    },
  });
  const rpc = createRpc({ procedure }, { maxBatch: 1 });
  await assert.rejects(
    rpc.batch([
      { name: 'procedure', input: 1 },
      { name: 'procedure', input: 2 },
    ]),
    { code: 'batch-limit' },
  );
  assert.equal(calls, 0);
});

test('returns frozen procedure names and rejects invalid procedure capacities', () => {
  const rpc = createRpc({ add: addProcedure });
  assert.deepEqual(rpc.names(), ['add']);
  assert.equal(Object.isFrozen(rpc.names()), true);
  assert.throws(() => createRpc({}, { maxProcedures: 0 }), RangeError);
  assert.throws(() => createRpc({ a: addProcedure, b: addProcedure }, { maxProcedures: 1 }), {
    code: 'batch-limit',
  });
});

test('returns structured errors for malformed batch entries and signals', async () => {
  const rpc = createRpc({ add: addProcedure });
  const results = await rpc.batch([null, { name: 'add' }]);
  assert.deepEqual(
    results.map((result) => result.error.code),
    ['invalid', 'invalid'],
  );
  await assert.rejects(rpc.call('add', { a: 1, b: 1 }, { signal: {} }), RpcError);
  await assert.rejects(rpc.call('add', { a: 1, b: 1 }, { unexpected: true }), { code: 'invalid' });
});

test('batch cancellation produces a result for each unstarted call', async () => {
  const rpc = createRpc({ add: addProcedure });
  const controller = new AbortController();
  controller.abort();
  const result = await rpc.batch(
    [
      { name: 'add', input: { a: 1, b: 2 } },
      { name: 'add', input: { a: 3, b: 4 } },
    ],
    { signal: controller.signal },
  );
  assert.deepEqual(
    result.map((entry) => entry.error.code),
    ['cancelled', 'cancelled'],
  );
});
