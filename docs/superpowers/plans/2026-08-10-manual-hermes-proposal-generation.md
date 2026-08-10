# Manual Hermes Proposal Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator generate a Hermes proposal from an idea and the selected workspace, then use the existing review and queue path.

**Architecture:** Reuse `gits.hermes.proposals.inspectGits`; the cockpit mutation supplies the selected workspace, trimmed prompt, and `worktree-spawn`. `MotokoPanel` owns the small prompt UI and invokes the mutation. Existing proposal cards, approval, drafting, and server-side queue rails remain untouched.

**Tech Stack:** React, TanStack Query, Vitest, TypeScript, Effect Schema contracts.

## Global Constraints

- Reuse the existing Hermes inspect RPC; do not create an endpoint, queue, schedule, or direct-execution path.
- Require a selected workspace and a non-empty trimmed prompt.
- Preserve the existing approval → draft → automode queue flow.
- Do not add dependencies.

---

## File Structure

- Modify: `apps/web/src/components/gits/cockpit/motoko/motoko.logic.ts` — pure payload guard shared by the UI shell and test.
- Modify: `apps/web/src/components/gits/cockpit/motoko/motoko.logic.test.ts` — regression coverage for the manual proposal request.
- Modify: `apps/web/src/components/gits/GitsCockpit.tsx` — mutation that calls the established RPC and refreshes existing data.
- Modify: `apps/web/src/components/gits/cockpit/MotokoPanel.tsx` — prompt field and Generate proposal button in the existing proposal area.

### Task 1: Guard the manual proposal request

**Files:**

- Modify: `apps/web/src/components/gits/cockpit/motoko/motoko.logic.ts`
- Test: `apps/web/src/components/gits/cockpit/motoko/motoko.logic.test.ts`

**Interfaces:**

- Produces: `manualProposalInput(projectDir: string, prompt: string): { projectDir: string; prompt: string; actionKind: "worktree-spawn" } | null`.
- Consumed by: `GitsCockpit` generation mutation.

- [ ] **Step 1: Write the failing test**

```ts
import { manualProposalInput } from "./motoko.logic";

it("builds a worktree proposal request from a selected workspace and trimmed idea", () => {
  expect(manualProposalInput(" /repo ", "  Fix failing login tests  ")).toEqual({
    projectDir: "/repo",
    prompt: "Fix failing login tests",
    actionKind: "worktree-spawn",
  });
});

it("rejects a root route or blank idea", () => {
  expect(manualProposalInput("", "idea")).toBeNull();
  expect(manualProposalInput("/repo", "   ")).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test apps/web/src/components/gits/cockpit/motoko/motoko.logic.test.ts`

Expected: FAIL because `manualProposalInput` is not exported.

- [ ] **Step 3: Write the minimal implementation**

```ts
export function manualProposalInput(projectDir: string, prompt: string) {
  const trimmedProjectDir = projectDir.trim();
  const trimmedPrompt = prompt.trim();
  return trimmedProjectDir.length === 0 || trimmedPrompt.length === 0
    ? null
    : {
        projectDir: trimmedProjectDir,
        prompt: trimmedPrompt,
        actionKind: "worktree-spawn" as const,
      };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test apps/web/src/components/gits/cockpit/motoko/motoko.logic.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/gits/cockpit/motoko/motoko.logic.ts apps/web/src/components/gits/cockpit/motoko/motoko.logic.test.ts
git commit -m "feat: build manual Hermes proposal requests"
```

### Task 2: Generate and display a proposal from the Motoko panel

**Files:**

- Modify: `apps/web/src/components/gits/GitsCockpit.tsx`
- Modify: `apps/web/src/components/gits/cockpit/MotokoPanel.tsx`

**Interfaces:**

- Consumes: `manualProposalInput`; `readGitsClient().hermes.inspectGits(input)`.
- Produces: `onGenerateProposal(): void` prop on `MotokoPanel`.

- [ ] **Step 1: Write the failing test**

Add this exact case to the Task 1 test:

```ts
expect(manualProposalInput("/repo", "Add the workspace picker")).toEqual({
  projectDir: "/repo",
  prompt: "Add the workspace picker",
  actionKind: "worktree-spawn",
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test apps/web/src/components/gits/cockpit/motoko/motoko.logic.test.ts`

Expected: FAIL until the exact payload behaviour is implemented.

- [ ] **Step 3: Write the minimal implementation**

In `GitsCockpit.tsx`, create a `useMutation` that obtains `manualProposalInput(selectedProjectRoot, manualProposalPrompt)`, throws if it returns `null`, calls `client.hermes.inspectGits(input)`, clears the prompt after success, and refetches `hermesProposalsQuery`, `hermesLogQuery`, and `hermesQuery`. Include this mutation in the existing Hermes action pending/error aggregation and pass its prompt and submit callback to `MotokoPanel`.

In `MotokoPanel.tsx`, render a compact controlled textarea labelled `Proposal idea` and a `Generate proposal` button near the existing proposal cards. Disable it when `actionPending`, the selected root is blank, or the trimmed prompt is empty. Its button invokes the supplied callback. Do not modify card decisions, draft controls, or scheduling controls.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test apps/web/src/components/gits/cockpit/motoko/motoko.logic.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/gits/GitsCockpit.tsx apps/web/src/components/gits/cockpit/MotokoPanel.tsx
git commit -m "feat: generate Hermes proposals from Motoko"
```

### Task 3: Verify the complete change

**Files:**

- Verify only.

- [ ] **Step 1: Run targeted regression coverage**

Run: `bun run test apps/web/src/components/gits/cockpit/motoko/motoko.logic.test.ts`

Expected: PASS.

- [ ] **Step 2: Run required repository checks**

Run: `bun fmt && bun lint && bun typecheck`

Expected: each command exits 0.

- [ ] **Step 3: Inspect the final diff**

Run: `git diff --check && git status --short`

Expected: no whitespace errors; only the plan and feature files are changed.
