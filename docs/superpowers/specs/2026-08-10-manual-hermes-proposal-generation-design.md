# Manual Hermes Proposal Generation Design

## Goal

Let an operator submit an idea for the currently selected workspace to Hermes, review the resulting proposal card, and queue it through the existing approval flow.

## Scope

Add a small proposal composer to the Motoko panel. It accepts a required non-empty idea prompt and requires a selected workspace. Submitting calls the existing `gits.hermes.proposals.inspectGits` RPC with the selected workspace as `projectDir`, the operator text as `prompt`, and `actionKind: "worktree-spawn"` so an approved proposal remains eligible for the normal Delamain-backed queue path.

The generated `HermesProposalCard` appears in the existing proposal list. Review, approve, draft, and queueing remain unchanged: `GitsCockpit` continues to use its existing decision mutation, which calls `decideProposal` then `draftFromProposal`; server-side automode owns enqueueing under the existing policy rails.

## UI Behaviour

- Place the composer in the existing Motoko proposal area, rather than the Autopilot controls or a new screen.
- Disable Generate until a workspace is selected, the prompt is non-empty after trimming, and no cockpit action is in flight.
- On success, clear the prompt and refetch Hermes status, proposal cards, and the Hermes log.
- Surface existing mutation errors via the panel's `actionError` mechanism.
- The existing selected workspace route is authoritative; root/GITS scope is not accepted for manual generation.

## Boundaries

- Reuse the existing contract and RPC; `HermesInspectGitsProposalInput` already supports `projectDir`, optional `prompt`, and `actionKind`.
- Do not add scheduling, automatic approval, a new queue, or a new server endpoint.
- Do not allow direct execution: proposals remain governed by the existing approval and drafting rails.

## Testing

- Add focused component-logic coverage for the generator's enabled state and submit payload, including prompt trimming and the required selected workspace.
- Keep existing server/RPC coverage unchanged because the new UI uses the established `inspectGits` route and its existing contract validation.
