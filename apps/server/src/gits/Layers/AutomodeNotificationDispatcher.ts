import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { writeFileStringAtomically } from "../../atomicWrite.ts";
import { ServerConfig } from "../../config.ts";
import { PushNotificationService } from "../../push/Services/PushNotificationService.ts";
import {
  AutomodeNotificationDispatcher,
  type AutomodeNotificationChannel,
  type AutomodeNotificationInput,
} from "../Services/AutomodeNotificationDispatcher.ts";
import { HermesTelegramNotifier } from "../Services/HermesTelegramNotifier.ts";

const STATE_FILE_NAME = "automode-notifications-state.json";

/**
 * Delivered-key cap. Keys are per-transition and never revisited once their goal/proposal
 * is terminal, so the tail is pure ballast; the newest window is what protects against
 * re-notifying live transitions across a restart.
 * ponytail: fixed FIFO cap, swap for time-based expiry if keys ever outlive this window.
 */
const MAX_DELIVERED_KEYS = 500;

const PersistedState = Schema.Struct({
  version: Schema.Literal(1),
  deliveredKeys: Schema.Array(Schema.String),
});
type PersistedState = typeof PersistedState.Type;
const decodePersistedState = Schema.decodeUnknownEffect(Schema.fromJsonString(PersistedState));

const emptyState: PersistedState = { version: 1, deliveredKeys: [] };

function persistState(statePath: string, state: PersistedState) {
  return writeFileStringAtomically({
    filePath: statePath,
    contents: `${JSON.stringify(state, null, 2)}\n`,
  });
}

/** Deep link a proposal notification opens: the exact card in the Autopilot review sheet. */
export function proposalNotificationUrl(proposalId: string): string {
  return `/gits?panel=autopilot&proposal=${encodeURIComponent(proposalId)}`;
}

/** Deep link for Automode transitions that have no proposal to focus. */
export function automodeSectionUrl(section: string): string {
  return `/gits?panel=autopilot&section=${encodeURIComponent(section)}`;
}

/** Per-channel delivery key: enabling Telegram later must not swallow a PWA-delivered key. */
function channelKey(key: string, channel: AutomodeNotificationChannel): string {
  return `${channel}:${key}`;
}

/**
 * Unlike the sweep's state file, an unreadable/corrupt notification state is NOT fatal:
 * the worst case of starting from empty is one duplicate notification, which is much
 * better than failing the layer and taking the server down over a notification log.
 */
function loadState(statePath: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs.exists(statePath);
    if (!exists) return emptyState;
    const raw = yield* fs.readFileString(statePath);
    if (raw.trim() === "") return emptyState;
    return yield* decodePersistedState(raw);
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("gits.notify.state-unreadable", { cause: Cause.pretty(cause) }).pipe(
        Effect.as(emptyState),
      ),
    ),
  );
}

export const AutomodeNotificationDispatcherLive = Layer.effect(
  AutomodeNotificationDispatcher,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const push = yield* PushNotificationService;
    const telegram = yield* HermesTelegramNotifier;
    const statePath = path.join(config.stateDir, "gits", STATE_FILE_NAME);
    const stateRef = yield* Ref.make(yield* loadState(statePath));
    // One permit: notify does read-modify-write on the delivered set, and driver ticks,
    // the sweep, and RPC handlers all call it concurrently.
    const semaphore = yield* Semaphore.make(1);

    const markDelivered = (keys: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        if (keys.length === 0) return;
        const state = yield* Ref.get(stateRef);
        const next: PersistedState = {
          version: 1,
          deliveredKeys: [...state.deliveredKeys, ...keys].slice(-MAX_DELIVERED_KEYS),
        };
        yield* Ref.set(stateRef, next);
        yield* persistState(statePath, next).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.catchCause((cause) =>
            // In-memory state already advanced, so this process still dedups correctly;
            // only cross-restart dedup is lost. Not worth failing the caller over.
            Effect.logWarning("gits.notify.persist-failed", { cause: Cause.pretty(cause) }),
          ),
        );
      });

    const notify = (input: AutomodeNotificationInput) =>
      semaphore.withPermits(1)(
        Effect.gen(function* () {
          const delivered = new Set((yield* Ref.get(stateRef)).deliveredKeys);
          const wantsGits =
            input.policy.gitsNotificationsEnabled && !delivered.has(channelKey(input.key, "gits"));
          const wantsTelegram =
            input.policy.telegramNotificationsEnabled &&
            !delivered.has(channelKey(input.key, "telegram"));
          if (!wantsGits && !wantsTelegram) return;

          const sentKeys: string[] = [];
          if (wantsGits) {
            // sendToAll never fails, but it can still die on an unexpected defect; a dead
            // push channel must not take the Telegram one (or the caller) down with it.
            const ok = yield* push
              .sendToAll({
                title: input.subject,
                body: input.text,
                tag: input.key,
                url: input.url,
              })
              .pipe(
                Effect.as(true),
                Effect.catchCause((cause) =>
                  Effect.logWarning("gits.notify.push-failed", {
                    key: input.key,
                    cause: Cause.pretty(cause),
                  }).pipe(Effect.as(false)),
                ),
              );
            if (ok) sentKeys.push(channelKey(input.key, "gits"));
          }
          if (wantsTelegram) {
            const ok = yield* telegram
              .notify({ subject: input.subject, text: `${input.text}\n${input.url}` })
              .pipe(
                Effect.as(true),
                Effect.catchCause((cause) =>
                  Effect.logWarning("gits.notify.telegram-failed", {
                    key: input.key,
                    cause: Cause.pretty(cause),
                  }).pipe(Effect.as(false)),
                ),
              );
            if (ok) sentKeys.push(channelKey(input.key, "telegram"));
          }
          // Only successful sends are recorded, so a transient outage retries next tick.
          yield* markDelivered(sentKeys);
        }),
      );

    return { notify };
  }),
);
