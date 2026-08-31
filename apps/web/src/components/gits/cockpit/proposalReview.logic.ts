/** Pure proposal-review logic: notification deep-link parsing, the editable review form,
 *  and its normalization back into review-RPC edits. No DOM, no React, no network. */

import type {
  GitsVerifyCommand,
  HermesProposalCard,
  HermesProposalEdits,
} from "@t3tools/contracts";

import { parseVerificationCommands } from "./autopilot/autopilot.logic";
import type { GitsCockpitTab } from "./tabs";

/** Autopilot sections a notification without a proposal can focus. */
const REVIEW_SECTIONS = ["goals", "policy", "scheduler", "episodes"] as const;
export type ProposalReviewSection = (typeof REVIEW_SECTIONS)[number];

/** Query parameters the review flow consumes, and removes once the operator closes the sheet. */
export const CONSUMED_REVIEW_PARAMS = ["panel", "proposal", "section"] as const;

export interface ProposalReviewTarget {
  readonly panel: GitsCockpitTab | null;
  readonly proposalId: string | null;
  readonly section: ProposalReviewSection | null;
}

const PANELS: ReadonlyArray<GitsCockpitTab> = [
  "overview",
  "motoko",
  "autopilot",
  "fleet",
  "system",
];

/**
 * Parses `/gits?panel=autopilot&proposal=<id>` (and the `section=` variant) into a focus
 * target. Anything unrecognized is dropped rather than guessed: a notification URL is
 * attacker-reachable in the sense that it is just a link, so an unknown panel must not
 * select a panel and an unknown section must not scroll anywhere.
 */
export function parseProposalReviewTarget(search: string): ProposalReviewTarget {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const panel = params.get("panel");
  const proposalId = params.get("proposal")?.trim() ?? "";
  const section = params.get("section");
  return {
    panel:
      panel !== null && PANELS.includes(panel as GitsCockpitTab) ? (panel as GitsCockpitTab) : null,
    proposalId: proposalId.length > 0 ? proposalId : null,
    section:
      section !== null && REVIEW_SECTIONS.includes(section as ProposalReviewSection)
        ? (section as ProposalReviewSection)
        : null,
  };
}

/** Drops only the parameters the review flow consumed, preserving anything else. */
export function stripConsumedReviewParams(search: string): string {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  for (const key of CONSUMED_REVIEW_PARAMS) {
    params.delete(key);
  }
  const rest = params.toString();
  return rest.length > 0 ? `?${rest}` : "";
}

/** Editable review state. Numeric/date fields stay strings so the input can hold
 *  transient invalid text while the operator types — same shape as the policy form. */
export interface ProposalReviewForm {
  readonly title: string;
  readonly prompt: string;
  readonly projectDir: string;
  readonly model: string;
  /** `datetime-local` value (no timezone suffix), or "" for "as soon as the gates allow". */
  readonly notBefore: string;
  readonly maxRuntimeMinutes: string;
  readonly verificationCommandsText: string;
  readonly integrationBranch: string;
}

/** ISO instant → the `YYYY-MM-DDTHH:mm` shape `<input type="datetime-local">` requires. */
export function isoToLocalInputValue(iso: string | null): string {
  if (iso === null) {
    return "";
  }
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) {
    return "";
  }
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(
    at.getHours(),
  )}:${pad(at.getMinutes())}`;
}

/** Local `datetime-local` text → ISO instant; invalid or empty text means "no not-before". */
export function localInputValueToIso(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const at = new Date(trimmed);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

export function proposalToReviewForm(proposal: HermesProposalCard): ProposalReviewForm {
  return {
    title: proposal.title,
    prompt: proposal.nextCommandOrPrompt ?? "",
    projectDir: proposal.projectDir ?? "",
    model: proposal.model ?? "",
    notBefore: isoToLocalInputValue(proposal.notBefore),
    maxRuntimeMinutes:
      proposal.maxRuntimeMinutes === null ? "" : String(proposal.maxRuntimeMinutes),
    verificationCommandsText:
      proposal.verificationCommands.length === 0
        ? ""
        : JSON.stringify(proposal.verificationCommands, null, 2),
    integrationBranch: proposal.integrationBranch ?? "",
  };
}

export type ReviewFormResult =
  | { readonly ok: true; readonly edits: HermesProposalEdits }
  | { readonly ok: false; readonly error: string };

/**
 * Normalizes the form into review-RPC edits. Blank optional fields become explicit `null`
 * (clearing a value the operator emptied on purpose), while a blank title or prompt is
 * simply omitted — the schema rejects empty strings and "I cleared the title" is never
 * what the operator meant.
 */
export function reviewFormToEdits(form: ProposalReviewForm): ReviewFormResult {
  const title = form.title.trim();
  const prompt = form.prompt.trim();
  const projectDir = form.projectDir.trim();
  const model = form.model.trim();
  const integrationBranch = form.integrationBranch.trim();
  const runtimeText = form.maxRuntimeMinutes.trim();
  const maxRuntimeMinutes = runtimeText.length === 0 ? null : Number(runtimeText);
  if (
    maxRuntimeMinutes !== null &&
    (!Number.isFinite(maxRuntimeMinutes) ||
      maxRuntimeMinutes < 0 ||
      !Number.isInteger(maxRuntimeMinutes))
  ) {
    return { ok: false, error: "Runtime limit must be a whole number of minutes." };
  }
  if (form.notBefore.trim().length > 0 && localInputValueToIso(form.notBefore) === null) {
    return { ok: false, error: "Proposed run time is not a valid date and time." };
  }
  const verification = parseVerificationCommands(form.verificationCommandsText);
  if (!verification.ok) {
    return { ok: false, error: verification.error };
  }
  return {
    ok: true,
    edits: {
      ...(title.length === 0 ? {} : { title }),
      ...(prompt.length === 0 ? {} : { prompt }),
      projectDir: projectDir.length === 0 ? null : projectDir,
      model: model.length === 0 ? null : model,
      notBefore: localInputValueToIso(form.notBefore),
      maxRuntimeMinutes,
      verificationCommands: verification.commands as GitsVerifyCommand[],
      integrationBranch: integrationBranch.length === 0 ? null : integrationBranch,
    },
  };
}
