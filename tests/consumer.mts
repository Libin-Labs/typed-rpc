import { createRpc, defineProcedure } from '@lp-labs/typed-rpc';
const double = defineProcedure({
  parseInput(value) {
    if (typeof value !== 'number') throw new TypeError();
    return value;
  },
  parseOutput(value) {
    if (typeof value !== 'number') throw new TypeError();
    return value;
  },
  handler: (value) => value * 2,
});
const rpc = createRpc({ double });
const value: Promise<number> = rpc.call('double', 4);
// @ts-expect-error input is validated and inferred as a number
rpc.call('double', '4');
void value;
