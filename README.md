# @lp-labs/typed-rpc

Define typed local procedures with runtime input/output parsers, explicit errors, cancellation
signals, and bounded sequential batches. This package is dispatch plumbing, not a network protocol:
**it does not add transport or security**.

- Zero runtime and peer dependencies; ESM, CommonJS, and TypeScript declarations.
- Runtime validation hooks; structured validation, handler, cancellation, and lookup errors.
- No HTTP/WebSocket/worker transport, authentication, authorization, encryption, or rate limiting.
- [MIT](./LICENSE). Node.js 18+.

## Installation

```sh
npm install @lp-labs/typed-rpc
```

## Quickstart

```js
import { createRpc, defineProcedure } from '@lp-labs/typed-rpc';

const add = defineProcedure({
  parseInput(value) {
    if (!value || typeof value !== 'object' || !('a' in value) || !('b' in value))
      throw new TypeError('Expected { a, b }.');
    const { a, b } = value;
    if (typeof a !== 'number' || typeof b !== 'number') throw new TypeError('Expected numbers.');
    return { a, b };
  },
  parseOutput(value) {
    if (typeof value !== 'number' || !Number.isFinite(value))
      throw new TypeError('Expected finite result.');
    return value;
  },
  handler: ({ a, b }) => a + b,
});
const rpc = createRpc({ add });
console.log(await rpc.call('add', { a: 2, b: 3 })); // 5
```

CommonJS: `const { createRpc, defineProcedure } = require('@lp-labs/typed-rpc')`.

## API and errors

`defineProcedure({ parseInput, parseOutput, handler })` supplies runtime validation hooks; parsers
return trusted values or throw. The handler receives `(input, { signal? })` and may be async.
`createRpc(procedures, { maxProcedures?, maxBatch? })` defaults to 256 procedures and 100 calls per
batch. Limits are each 10,000.

`call(name, input, { signal? })` is type-inferred from the procedure map. It rejects with `RpcError`
codes `not-found`, `input`, `output`, `handler`, `cancelled`, or `invalid`. Cancellation is
cooperative: the signal is passed to the handler; a handler that ignores it continues running, but
its result is discarded if cancellation is observed before completion.

`batch([{ name, input }, ...], { signal? })` processes calls sequentially and returns one `{ ok,
value }` or `{ ok: false, error }` result per call. A batch larger than the configured maximum
rejects before any call starts. `names()` returns the registered names.

## Customization and limitations

Implement parsers with a schema library of your choice or hand-written checks; no validation library
is bundled. Keep procedure names and inputs stable when adapting the local API to a transport. This
package does not serialize messages or provide a client/server boundary, protocol compatibility,
authentication, authorization, access controls, input-size protection for a remote transport, or
replay protection. Add those controls in the actual transport and deployment.

## Support

If this library is useful to you, consider supporting its maintenance with a [donation via PayPal](https://www.paypal.me/LibinPrasanth).

## Author

Created by [Libin Prasanth](https://www.linkedin.com/in/libinprasanth/). Connect on LinkedIn for updates and discussion.
