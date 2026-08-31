import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { OrchestrationProject, OrchestrationThread, ProjectId } from "@t3tools/contracts";

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { PersistenceSqlError } from "../../persistence/Errors.ts";
import { MotokoContinuationSource } from "../Services/MotokoContinuationSource.ts";
import {
  MAX_CANDIDATES_PER_REPO,
  MotokoContinuationSourceLive,
  selectContinuationCandidates,
} from "./MotokoContinuationSource.ts";

const project = (id: string, workspaceRoot: string) =>
  ({ id: id as ProjectId, workspaceRoot }) as Pick<OrchestrationProject, "id" | "workspaceRoot">;

/**
 * Fixture builder for a projection thread. Deliberately cast through `unknown`: this suite
 * exercises the candidate-selection rules, and hand-writing every branded id and
 * provider-instance field of a full OrchestrationThread would bury them.
 */
type ThreadOverrides = Record<string, unknown> & { readonly id: string };

function thread(overrides: ThreadOverrides): OrchestrationThread {
  return {
    id: overrides.id,
    projectId: overrides.projectId ?? "project-1",
    title: overrides.title ?? "Refactor the sweep",
    modelSelection: { provider: "codex", model: "gpt-5.5" },
    runtimeMode: "worktree",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: overrides.latestTurn ?? null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00.000Z",
    archivedAt: overrides.archivedAt ?? null,
    deletedAt: overrides.deletedAt ?? null,
    messages: [],
    proposedPlans: [],
    visualPlans: [],
    activities: overrides.activities ?? [
      {
        id: "event-1",
        tone: "info",
        kind: "turn",
        summary: "Left the retry path half-migrated.",
        payload: null,
        turnId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    checkpoints: [],
    session: overrides.session ?? null,
  } as unknown as OrchestrationThread;
}

const projects = [project("project-1", "/tmp/repo-a"), project("project-2", "/tmp/repo-b")];

describe("selectContinuationCandidates", () => {
  it("promotes a settled thread with a persisted summary", () => {
    const candidates = selectContinuationCandidates(projects, [thread({ id: "thread-1" })]);
    assert.deepStrictEqual(candidates, [
      {
        threadId: "thread-1",
        projectPath: "/tmp/repo-a",
        title: "Refactor the sweep",
        summary: "Left the retry path half-migrated.",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
  });

  // Proposing to "continue" work that is still running would race the live thread.
  it("drops threads that are still running", () => {
    const candidates = selectContinuationCandidates(projects, [
      thread({
        id: "running-turn",
        latestTurn: {
          turnId: "turn-1",
          state: "running",
          requestedAt: "2026-01-01T00:00:00.000Z",
          startedAt: "2026-01-01T00:00:00.000Z",
          completedAt: null,
          assistantMessageId: null,
        },
      }),
      thread({
        id: "running-session",
        session: {
          threadId: "running-session",
          status: "running",
          providerName: "codex",
          workPersonalFallbackInstanceId: null,
          runtimeMode: "worktree",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      }),
    ]);
    assert.deepStrictEqual(candidates, []);
  });

  it("drops archived and deleted threads", () => {
    const candidates = selectContinuationCandidates(projects, [
      thread({ id: "archived", archivedAt: "2026-01-02T00:00:00.000Z" }),
      thread({ id: "deleted", deletedAt: "2026-01-02T00:00:00.000Z" }),
    ]);
    assert.deepStrictEqual(candidates, []);
  });

  it("drops threads whose project has no workspace root", () => {
    const candidates = selectContinuationCandidates(
      [project("project-1", "   ")],
      [thread({ id: "no-root" })],
    );
    assert.deepStrictEqual(candidates, []);
  });

  it("drops a thread with no unknown project", () => {
    const candidates = selectContinuationCandidates(projects, [
      thread({ id: "orphan", projectId: "project-missing" as ProjectId }),
    ]);
    assert.deepStrictEqual(candidates, []);
  });

  // The summary IS the evidence for "work remains" — without one there is nothing to cite.
  it("drops a thread with no non-empty persisted summary", () => {
    const candidates = selectContinuationCandidates(projects, [
      thread({ id: "no-summary", activities: [] }),
    ]);
    assert.deepStrictEqual(candidates, []);
  });

  it("uses the most recent activity summary", () => {
    const candidates = selectContinuationCandidates(projects, [
      thread({
        id: "multi",
        activities: [
          {
            id: "event-1",
            tone: "info",
            kind: "turn",
            summary: "Started the migration.",
            payload: null,
            turnId: null,
            createdAt: "2026-01-01T00:00:00.000Z",
          },
          {
            id: "event-2",
            tone: "warning",
            kind: "turn",
            summary: "Stopped before the callers were updated.",
            payload: null,
            turnId: null,
            createdAt: "2026-01-01T01:00:00.000Z",
          },
        ],
      }),
    ]);
    assert.strictEqual(candidates[0]?.summary, "Stopped before the callers were updated.");
  });

  it("caps candidates at five per repository, newest first", () => {
    const threads = Array.from({ length: 8 }, (_, index) =>
      thread({
        id: `thread-${index}`,
        updatedAt: `2026-01-0${index + 1}T00:00:00.000Z`,
      }),
    );
    const candidates = selectContinuationCandidates(projects, threads);
    assert.strictEqual(candidates.length, MAX_CANDIDATES_PER_REPO);
    assert.strictEqual(candidates[0]?.threadId, "thread-7");
  });

  // A busy repo must not consume the whole budget and hide every other repo.
  it("caps per repository, not globally", () => {
    const threads = [
      ...Array.from({ length: 6 }, (_, index) =>
        thread({ id: `a-${index}`, updatedAt: `2026-02-0${index + 1}T00:00:00.000Z` }),
      ),
      thread({ id: "b-1", projectId: "project-2" as ProjectId }),
    ];
    const candidates = selectContinuationCandidates(projects, threads);
    assert.strictEqual(candidates.filter((c) => c.projectPath === "/tmp/repo-a").length, 5);
    assert.strictEqual(candidates.filter((c) => c.projectPath === "/tmp/repo-b").length, 1);
  });
});

describe("MotokoContinuationSourceLive", () => {
  it.effect("degrades to no candidates when the projection read fails", () =>
    Effect.gen(function* () {
      const source = yield* MotokoContinuationSource;
      assert.deepStrictEqual(yield* source.listCandidates(), []);
    }).pipe(
      Effect.provide(
        MotokoContinuationSourceLive.pipe(
          Layer.provide(
            Layer.mock(ProjectionSnapshotQuery)({
              getSnapshot: () =>
                Effect.fail(
                  new PersistenceSqlError({
                    operation: "getSnapshot",
                    detail: "projection unavailable",
                  }),
                ),
            }),
          ),
        ),
      ),
    ),
  );
});
