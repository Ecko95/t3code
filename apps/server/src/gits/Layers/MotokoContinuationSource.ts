import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { OrchestrationProject, OrchestrationThread } from "@t3tools/contracts";

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  MotokoContinuationSource,
  type MotokoContinuationCandidate,
} from "../Services/MotokoContinuationSource.ts";

/** Per-repository cap: enough signal for one proposal prompt, bounded against a huge DB. */
export const MAX_CANDIDATES_PER_REPO = 5;

/** Statuses that mean the thread is still working — never propose to continue those. */
const LIVE_SESSION_STATUSES = new Set(["starting", "running"]);

/**
 * Pure candidate selection, extracted from the layer so the rules are testable without a
 * database. A thread qualifies only when it is settled (not running), belongs to a project
 * with a workspace root, and carries a non-empty persisted activity summary — the summary
 * IS the evidence, so a thread without one has nothing to say about why work remains.
 */
export function selectContinuationCandidates(
  projects: ReadonlyArray<Pick<OrchestrationProject, "id" | "workspaceRoot">>,
  threads: ReadonlyArray<OrchestrationThread>,
): ReadonlyArray<MotokoContinuationCandidate> {
  const workspaceRootById = new Map(projects.map((project) => [project.id, project.workspaceRoot]));
  const candidates: MotokoContinuationCandidate[] = [];
  for (const thread of threads) {
    if (thread.deletedAt !== null || thread.archivedAt !== null) {
      continue;
    }
    if (
      thread.latestTurn?.state === "running" ||
      (thread.session !== null && LIVE_SESSION_STATUSES.has(thread.session.status))
    ) {
      continue;
    }
    const projectPath = workspaceRootById.get(thread.projectId);
    if (projectPath === undefined || projectPath.trim().length === 0) {
      continue;
    }
    // Newest activity first: the last thing that happened is what "unfinished" means here.
    const summary = [...thread.activities]
      .reverse()
      .map((activity) => activity.summary.trim())
      .find((text) => text.length > 0);
    if (summary === undefined) {
      continue;
    }
    candidates.push({
      threadId: thread.id,
      projectPath,
      title: thread.title,
      summary,
      updatedAt: thread.updatedAt,
    });
  }
  // Most recent first, then cap per repo — a single busy repo must not crowd out the rest.
  const perRepo = new Map<string, number>();
  return candidates
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .filter((candidate) => {
      const seen = perRepo.get(candidate.projectPath) ?? 0;
      if (seen >= MAX_CANDIDATES_PER_REPO) {
        return false;
      }
      perRepo.set(candidate.projectPath, seen + 1);
      return true;
    });
}

export const MotokoContinuationSourceLive = Layer.effect(
  MotokoContinuationSource,
  Effect.gen(function* () {
    const projection = yield* ProjectionSnapshotQuery;
    return {
      // ponytail: reads the full projection snapshot once per nightly sweep. Swap for a
      // dedicated projection query if this ever runs more often than that.
      listCandidates: () =>
        projection.getSnapshot().pipe(
          Effect.map((snapshot) =>
            selectContinuationCandidates(snapshot.projects, snapshot.threads),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("gits.continuation.projection-failed", {
              cause: Cause.pretty(cause),
            }).pipe(Effect.as([] as ReadonlyArray<MotokoContinuationCandidate>)),
          ),
        ),
    };
  }),
);
