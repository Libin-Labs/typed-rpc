import { createRpc, defineProcedure, RpcError } from '@lp-labs/typed-rpc';
const echo = defineProcedure({
  parseInput(value) {
    if (typeof value !== 'string') throw new TypeError();
    return value;
  },
  parseOutput(value) {
    if (typeof value !== 'string') throw new TypeError();
    return value;
  },
  handler: (value) => value,
});
const rpc = createRpc({ echo });
const response: Promise<string> = rpc.call('echo', 'hello');
const error = new RpcError('input', 'invalid');
void [response, error];
