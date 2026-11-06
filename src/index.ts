export interface RpcContext {
  readonly signal?: AbortSignal;
}

export type Parser<T> = (value: unknown) => T;

export interface Procedure<I, O> {
  readonly __types?: { readonly input: I; readonly output: O };
  readonly execute: (input: unknown, context: RpcContext) => Promise<unknown>;
}

export interface ProcedureSpec<I, O> {
  readonly parseInput: Parser<I>;
  readonly parseOutput: Parser<O>;
  readonly handler: (input: I, context: RpcContext) => O | PromiseLike<O>;
}

export interface RpcOptions {
  readonly maxProcedures?: number;
  readonly maxBatch?: number;
}

export interface BatchCall {
  readonly name: string;
  readonly input: unknown;
}

export type BatchResult =
  { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: RpcError };

export type RpcErrorCode =
  'invalid' | 'not-found' | 'input' | 'output' | 'handler' | 'cancelled' | 'batch-limit';

export class RpcError extends Error {
  constructor(
    readonly code: RpcErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

export type InputOf<T> = T extends Procedure<infer I, unknown> ? I : never;
export type OutputOf<T> = T extends Procedure<unknown, infer O> ? O : never;

function assertSignal(signal: AbortSignal | undefined): void {
  if (
    signal !== undefined &&
    (!signal ||
      typeof signal.throwIfAborted !== 'function' ||
      typeof signal.addEventListener !== 'function' ||
      typeof signal.removeEventListener !== 'function')
  ) {
    throw new RpcError('invalid', 'Expected a platform AbortSignal.');
  }
}

function getSignal(context: RpcContext): AbortSignal | undefined {
  if (
    !context ||
    typeof context !== 'object' ||
    Array.isArray(context) ||
    (Object.getPrototypeOf(context) !== Object.prototype && Object.getPrototypeOf(context) !== null)
  )
    throw new RpcError('invalid', 'Call options must be a plain record.');
  const keys = Reflect.ownKeys(context);
  if (keys.some((key) => key !== 'signal'))
    throw new RpcError('invalid', 'Call options support only a signal field.');
  const descriptor = Object.getOwnPropertyDescriptor(context, 'signal');
  if (descriptor && (!descriptor.enumerable || !('value' in descriptor)))
    throw new RpcError('invalid', 'The signal option must be a data property.');
  const signal = descriptor?.value as AbortSignal | undefined;
  assertSignal(signal);
  return signal;
}

export function defineProcedure<I, O>(spec: ProcedureSpec<I, O>): Procedure<I, O> {
  if (
    !spec ||
    typeof spec !== 'object' ||
    Array.isArray(spec) ||
    (Object.getPrototypeOf(spec) !== Object.prototype && Object.getPrototypeOf(spec) !== null)
  ) {
    throw new TypeError('A procedure requires input/output parsers and a handler.');
  }
  const fields: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(spec)) {
    if (typeof key !== 'string' || !['parseInput', 'parseOutput', 'handler'].includes(key))
      throw new TypeError('Procedure specifications contain only parser and handler fields.');
    const descriptor = Object.getOwnPropertyDescriptor(spec, key);
    if (!descriptor?.enumerable || !('value' in descriptor))
      throw new TypeError('Procedure specification fields must be data properties.');
    fields[key] = descriptor.value;
  }
  if (
    typeof fields.parseInput !== 'function' ||
    typeof fields.parseOutput !== 'function' ||
    typeof fields.handler !== 'function'
  )
    throw new TypeError('A procedure requires input/output parsers and a handler.');
  const parseInput = fields.parseInput as Parser<I>;
  const parseOutput = fields.parseOutput as Parser<O>;
  const handler = fields.handler as ProcedureSpec<I, O>['handler'];
  const execute = async (value: unknown, context: RpcContext): Promise<unknown> => {
    let input: I;
    try {
      input = parseInput(value);
    } catch (error) {
      throw new RpcError('input', 'Procedure input validation failed.', error);
    }
    let output: O | PromiseLike<O>;
    try {
      output = await handler(input, context);
    } catch (error) {
      if (error instanceof RpcError) throw error;
      throw new RpcError('handler', 'Procedure handler failed.', error);
    }
    try {
      return parseOutput(output);
    } catch (error) {
      throw new RpcError('output', 'Procedure output validation failed.', error);
    }
  };
  return Object.freeze({ execute }) as Procedure<I, O>;
}

export function createRpc<const P extends Readonly<Record<string, Procedure<any, any>>>>(
  procedures: P,
  options: RpcOptions = {},
) {
  if (
    !procedures ||
    typeof procedures !== 'object' ||
    Array.isArray(procedures) ||
    (Object.getPrototypeOf(procedures) !== Object.prototype &&
      Object.getPrototypeOf(procedures) !== null)
  )
    throw new TypeError('Procedures must be a plain record.');
  const names = Reflect.ownKeys(procedures);
  const maxProcedures = options.maxProcedures ?? 256;
  const maxBatch = options.maxBatch ?? 100;
  if (!Number.isSafeInteger(maxProcedures) || maxProcedures < 1 || maxProcedures > 10_000)
    throw new RangeError('maxProcedures must be an integer from 1 through 10000.');
  if (!Number.isSafeInteger(maxBatch) || maxBatch < 1 || maxBatch > 10_000)
    throw new RangeError('maxBatch must be an integer from 1 through 10000.');
  if (names.length > maxProcedures)
    throw new RpcError('batch-limit', `At most ${maxProcedures} procedures are allowed.`);
  const table = new Map<string, Procedure<unknown, unknown>>();
  for (const name of names) {
    if (typeof name !== 'string' || name.length < 1 || name.length > 128)
      throw new RpcError('invalid', 'Procedure names must contain 1..128 characters.');
    const descriptor = Object.getOwnPropertyDescriptor(procedures, name);
    if (!descriptor?.enumerable || !('value' in descriptor))
      throw new RpcError('invalid', `Procedure "${name}" must be an enumerable data property.`);
    const procedure = descriptor.value;
    if (!procedure || typeof procedure.execute !== 'function')
      throw new RpcError('invalid', `Procedure "${name}" is invalid.`);
    table.set(name, procedure as Procedure<unknown, unknown>);
  }
  const dispatch = async (name: string, input: unknown, signal?: AbortSignal): Promise<unknown> => {
    if (typeof name !== 'string' || name.length < 1 || name.length > 128)
      throw new RpcError('invalid', 'Procedure name must contain 1..128 characters.');
    assertSignal(signal);
    if (signal?.aborted)
      throw new RpcError('cancelled', 'Procedure call was cancelled.', signal.reason);
    const procedure = table.get(name);
    if (!procedure) throw new RpcError('not-found', `Unknown procedure "${name}".`);
    try {
      const output = await procedure.execute(input, signal ? { signal } : {});
      if (signal?.aborted)
        throw new RpcError('cancelled', 'Procedure call was cancelled.', signal.reason);
      return output;
    } catch (error) {
      if (error instanceof RpcError) throw error;
      throw new RpcError('handler', 'Procedure call failed.', error);
    }
  };
  return Object.freeze({
    call<K extends keyof P & string>(
      name: K,
      input: InputOf<P[K]>,
      options: RpcContext = {},
    ): Promise<OutputOf<P[K]>> {
      try {
        return dispatch(name, input, getSignal(options)) as Promise<OutputOf<P[K]>>;
      } catch (error) {
        return Promise.reject(error);
      }
    },
    async batch(
      calls: readonly BatchCall[],
      options: RpcContext = {},
    ): Promise<readonly BatchResult[]> {
      const signal = getSignal(options);
      if (!Array.isArray(calls) || calls.length > maxBatch)
        throw new RpcError('batch-limit', `A batch may contain at most ${maxBatch} calls.`);
      const results: BatchResult[] = [];
      for (const call of calls) {
        if (
          !call ||
          typeof call !== 'object' ||
          Array.isArray(call) ||
          (Object.getPrototypeOf(call) !== Object.prototype && Object.getPrototypeOf(call) !== null)
        ) {
          results.push({
            ok: false,
            error: new RpcError('invalid', 'Batch items require a name and input.'),
          });
          continue;
        }
        const keys = Reflect.ownKeys(call);
        const nameDescriptor = Object.getOwnPropertyDescriptor(call, 'name');
        const inputDescriptor = Object.getOwnPropertyDescriptor(call, 'input');
        if (
          keys.some((key) => key !== 'name' && key !== 'input') ||
          !nameDescriptor?.enumerable ||
          !('value' in nameDescriptor) ||
          !inputDescriptor?.enumerable ||
          !('value' in inputDescriptor) ||
          typeof nameDescriptor.value !== 'string'
        ) {
          results.push({
            ok: false,
            error: new RpcError('invalid', 'Batch items require a name and input.'),
          });
          continue;
        }
        if (signal?.aborted) {
          results.push({
            ok: false,
            error: new RpcError('cancelled', 'Batch was cancelled.', signal.reason),
          });
          continue;
        }
        try {
          results.push({
            ok: true,
            value: await dispatch(nameDescriptor.value, inputDescriptor.value, signal),
          });
        } catch (error) {
          results.push({
            ok: false,
            error:
              error instanceof RpcError
                ? error
                : new RpcError('handler', 'Procedure call failed.', error),
          });
        }
      }
      return Object.freeze(results);
    },
    names(): readonly string[] {
      return Object.freeze([...table.keys()]);
    },
  });
}
