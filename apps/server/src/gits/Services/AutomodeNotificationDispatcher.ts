import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { AutomodePolicy } from "@t3tools/contracts";

/** The two independently-configurable delivery channels. */
export type AutomodeNotificationChannel = "gits" | "telegram";

/** Only the policy fields that gate delivery — callers pass the whole policy. */
export type AutomodeNotificationPolicy = Pick<
  AutomodePolicy,
  "gitsNotificationsEnabled" | "telegramNotificationsEnabled"
>;

export interface AutomodeNotificationInput {
  /**
   * Stable transition key (e.g. `proposal-created:<id>`, `goal-blocked:<goalId>`). The
   * dispatcher persists delivered keys per channel, so re-ticking the same transition
   * across a restart never re-notifies.
   */
  readonly key: string;
  readonly subject: string;
  /** Body text. Must not contain full prompts or sensitive repository evidence. */
  readonly text: string;
  /** Deep link the PWA notification opens, e.g. `/gits?panel=autopilot&proposal=<id>`. */
  readonly url: string;
  readonly policy: AutomodeNotificationPolicy;
}

export interface AutomodeNotificationDispatcherShape {
  /**
   * Routes one transition to whichever channels the policy enables. Never fails: delivery
   * problems are logged, because a dropped notification must not roll back the proposal or
   * Automode state change that triggered it.
   */
  readonly notify: (input: AutomodeNotificationInput) => Effect.Effect<void>;
}

export class AutomodeNotificationDispatcher extends Context.Service<
  AutomodeNotificationDispatcher,
  AutomodeNotificationDispatcherShape
>()("t3/gits/Services/AutomodeNotificationDispatcher") {}
