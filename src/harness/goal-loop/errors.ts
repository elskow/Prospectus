import { Data, Duration, Effect, Schedule } from "effect";
import { FatalSourceError, TransientSourceError } from "@src/harness/errors";

export class SourceTransientError extends Data.TaggedError("SourceTransientError")<{
  readonly retryAfterMs: number | null;
  readonly cause: unknown;
}> {}

export class SourceFatalError extends Data.TaggedError("SourceFatalError")<{
  readonly cause: unknown;
}> {}

export const sourceRetrySchedule = Schedule.exponential(Duration.millis(1_000), 2).pipe(
  Schedule.setInputType<SourceTransientError | SourceFatalError>(),
  Schedule.modifyDelay(({ duration, input }) =>
    Effect.succeed(
      input._tag === "SourceTransientError" && input.retryAfterMs !== null
        ? Duration.millis(Math.max(Duration.toMillis(duration), input.retryAfterMs))
        : Duration.millis(Math.min(Duration.toMillis(duration), 8_000)),
    ),
  ),
  Schedule.upTo({ times: 2 }),
);

export const fromSourceOperation = <A>(operation: () => Promise<A>): Effect.Effect<A, SourceTransientError | SourceFatalError> =>
  Effect.tryPromise({
    try: operation,
    catch: (cause) => {
      if (cause instanceof TransientSourceError) return new SourceTransientError({ retryAfterMs: cause.retryAfterMs, cause });
      if (cause instanceof FatalSourceError) return new SourceFatalError({ cause });
      return new SourceFatalError({ cause });
    },
  });
