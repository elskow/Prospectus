import { Data, Effect } from "effect";
import { TransientSourceError } from "@src/harness/errors";

export class RetrievalTransientError extends Data.TaggedError("RetrievalTransientError")<{
  readonly message: string;
  readonly retryAfterMs: number | null;
  readonly cause: unknown;
}> {
  get plain(): TransientSourceError {
    return new TransientSourceError(this.message, this.retryAfterMs);
  }
}

export class RetrievalFatalError extends Data.TaggedError("RetrievalFatalError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export type RetrievalError = RetrievalTransientError | RetrievalFatalError;

export const retrievalError = (message: string, cause: unknown): RetrievalError => {
  const text = cause instanceof Error ? cause.message : String(cause);
  if (/rate limit|429|anomaly/i.test(`${message} ${text}`)) {
    return new RetrievalTransientError({ message, retryAfterMs: null, cause });
  }
  if (cause instanceof TransientSourceError) {
    return new RetrievalTransientError({ message, retryAfterMs: cause.retryAfterMs, cause });
  }
  return new RetrievalFatalError({ message, cause });
};

export const fromRetrievalOperation = <A>(operation: () => Promise<A>): Effect.Effect<A, RetrievalError> =>
  Effect.tryPromise({
    try: operation,
    catch: (cause): RetrievalError => retrievalError("retrieval failed", cause),
  });
