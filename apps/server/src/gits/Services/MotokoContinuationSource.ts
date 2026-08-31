import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

/**
 * A past GITS thread that looks like it still has work in it. Deliberately narrow: the
 * sweep folds these into a proposal prompt, and raw transcripts must never leave the
 * projection — only the thread's own persisted activity summary does.
 */
export interface MotokoContinuationCandidate {
  readonly threadId: string;
  /** The project's workspace root; candidates without one are dropped. */
  readonly projectPath: string;
  readonly title: string;
  /** The thread's most recent persisted activity summary. Never a raw transcript. */
  readonly summary: string;
  readonly updatedAt: string;
}

export interface MotokoContinuationSourceShape {
  /**
   * Bounded, read-only projection over persisted threads. Never fails: a projection
   * hiccup degrades the sweep to repository-pattern proposals only, which is strictly
   * better than losing the night.
   */
  readonly listCandidates: () => Effect.Effect<ReadonlyArray<MotokoContinuationCandidate>>;
}

export class MotokoContinuationSource extends Context.Service<
  MotokoContinuationSource,
  MotokoContinuationSourceShape
>()("t3/gits/Services/MotokoContinuationSource") {}
