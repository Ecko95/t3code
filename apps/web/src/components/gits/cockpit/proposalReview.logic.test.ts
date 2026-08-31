import { describe, expect, it } from "vitest";

import type { HermesProposalCard } from "@t3tools/contracts";

import {
  isoToLocalInputValue,
  localInputValueToIso,
  parseProposalReviewTarget,
  proposalToReviewForm,
  reviewFormToEdits,
  stripConsumedReviewParams,
  type ProposalReviewForm,
} from "./proposalReview.logic";

const card: HermesProposalCard = {
  id: "hermes-1",
  episodeId: "epi-1",
  title: "Improve the sweep",
  summary: "Summary.",
  detail: "Detail.",
  evidence: ["evidence"],
  scope: ["apps/server"],
  risk: "low",
  actionKind: "worktree-spawn",
  status: "proposed",
  requiresApproval: true,
  recommendedExecutor: "delamain",
  verificationPlan: ["bun run test"],
  nextCommandOrPrompt: "Do the thing.",
  blockedReason: null,
  source: "test",
  projectDir: "/tmp/repo",
  decisionReason: null,
  decidedAt: null,
  model: null,
  notBefore: null,
  maxRuntimeMinutes: null,
  verificationCommands: [],
  integrationBranch: null,
  sourceThreadId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const form: ProposalReviewForm = {
  title: "Improve the sweep",
  prompt: "Do the thing.",
  projectDir: "/tmp/repo",
  model: "",
  notBefore: "",
  maxRuntimeMinutes: "",
  verificationCommandsText: "",
  integrationBranch: "",
};

describe("parseProposalReviewTarget", () => {
  it("parses a proposal deep link", () => {
    expect(parseProposalReviewTarget("?panel=autopilot&proposal=hermes-1")).toEqual({
      panel: "autopilot",
      proposalId: "hermes-1",
      section: null,
    });
  });

  it("parses a section deep link", () => {
    expect(parseProposalReviewTarget("?panel=autopilot&section=goals")).toEqual({
      panel: "autopilot",
      proposalId: null,
      section: "goals",
    });
  });

  it("works without the leading question mark", () => {
    expect(parseProposalReviewTarget("panel=autopilot&proposal=hermes-1").proposalId).toBe(
      "hermes-1",
    );
  });

  // A link is untrusted input: an unknown panel/section must be dropped, not guessed at.
  it("ignores unknown panels and sections", () => {
    expect(parseProposalReviewTarget("?panel=nope&section=nope")).toEqual({
      panel: null,
      proposalId: null,
      section: null,
    });
  });

  it("ignores a blank proposal id", () => {
    expect(parseProposalReviewTarget("?panel=autopilot&proposal=%20%20").proposalId).toBeNull();
  });

  it("returns an empty target for an empty search string", () => {
    expect(parseProposalReviewTarget("")).toEqual({
      panel: null,
      proposalId: null,
      section: null,
    });
  });

  it("decodes an encoded proposal id", () => {
    expect(parseProposalReviewTarget("?proposal=a%20b%26c").proposalId).toBe("a b&c");
  });
});

describe("stripConsumedReviewParams", () => {
  it("removes only the consumed parameters", () => {
    expect(stripConsumedReviewParams("?panel=autopilot&proposal=hermes-1&keep=1")).toBe("?keep=1");
  });

  it("returns an empty string when nothing is left", () => {
    expect(stripConsumedReviewParams("?panel=autopilot&proposal=hermes-1")).toBe("");
  });
});

describe("proposalToReviewForm", () => {
  it("seeds the form from the card, mapping the prompt off nextCommandOrPrompt", () => {
    expect(proposalToReviewForm(card)).toEqual(form);
  });

  it("renders execution settings when present", () => {
    const seeded = proposalToReviewForm({
      ...card,
      model: "gpt-5.4",
      maxRuntimeMinutes: 45,
      verificationCommands: [{ label: "typecheck", cmd: ["bun", "typecheck"] }],
      integrationBranch: "auto/gits",
    });
    expect(seeded.model).toBe("gpt-5.4");
    expect(seeded.maxRuntimeMinutes).toBe("45");
    expect(seeded.verificationCommandsText).toContain("typecheck");
    expect(seeded.integrationBranch).toBe("auto/gits");
  });

  it("round-trips a not-before instant through the datetime-local field", () => {
    const iso = new Date(2026, 0, 8, 22, 30).toISOString();
    const seeded = proposalToReviewForm({ ...card, notBefore: iso });
    expect(localInputValueToIso(seeded.notBefore)).toBe(iso);
  });

  it("treats an unparseable stored not-before as empty", () => {
    expect(isoToLocalInputValue("not-a-date")).toBe("");
  });
});

describe("reviewFormToEdits", () => {
  it("normalizes an unedited form", () => {
    const result = reviewFormToEdits(form);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.edits).toEqual({
      title: "Improve the sweep",
      prompt: "Do the thing.",
      projectDir: "/tmp/repo",
      model: null,
      notBefore: null,
      maxRuntimeMinutes: null,
      verificationCommands: [],
      integrationBranch: null,
    });
  });

  // Blanking an optional field is a deliberate "clear this", so it must reach the server
  // as null rather than being silently dropped.
  it("clears blanked optional fields", () => {
    const result = reviewFormToEdits({ ...form, model: "  ", integrationBranch: "" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.edits.model).toBeNull();
    expect(result.edits.integrationBranch).toBeNull();
  });

  // The schema rejects an empty title/prompt, and an accidental clear must not blow up
  // the whole review — omit them instead so the stored value survives.
  it("omits a blanked title and prompt instead of sending empty strings", () => {
    const result = reviewFormToEdits({ ...form, title: "   ", prompt: "" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.edits.title).toBeUndefined();
    expect(result.edits.prompt).toBeUndefined();
  });

  it("rejects a non-integer runtime limit", () => {
    expect(reviewFormToEdits({ ...form, maxRuntimeMinutes: "12.5" })).toEqual({
      ok: false,
      error: "Runtime limit must be a whole number of minutes.",
    });
  });

  it("rejects a negative runtime limit", () => {
    expect(reviewFormToEdits({ ...form, maxRuntimeMinutes: "-5" }).ok).toBe(false);
  });

  it("rejects an invalid proposed run time", () => {
    expect(reviewFormToEdits({ ...form, notBefore: "tomorrow-ish" })).toEqual({
      ok: false,
      error: "Proposed run time is not a valid date and time.",
    });
  });

  it("rejects malformed verification commands", () => {
    expect(reviewFormToEdits({ ...form, verificationCommandsText: "{" }).ok).toBe(false);
  });

  it("carries valid verification commands through", () => {
    const result = reviewFormToEdits({
      ...form,
      verificationCommandsText: '[{"label":"test","cmd":["bun","run","test"]}]',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.edits.verificationCommands).toEqual([
      { label: "test", cmd: ["bun", "run", "test"] },
    ]);
  });
});
