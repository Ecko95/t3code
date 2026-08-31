import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { ServerConfig } from "../../config.ts";
import {
  PushNotificationService,
  type PushNotificationPayload,
} from "../../push/Services/PushNotificationService.ts";
import {
  AutomodeNotificationDispatcher,
  type AutomodeNotificationPolicy,
} from "../Services/AutomodeNotificationDispatcher.ts";
import {
  HermesTelegramNotifier,
  HermesTelegramNotifierError,
} from "../Services/HermesTelegramNotifier.ts";
import {
  AutomodeNotificationDispatcherLive,
  automodeSectionUrl,
  proposalNotificationUrl,
} from "./AutomodeNotificationDispatcher.ts";

const BOTH: AutomodeNotificationPolicy = {
  gitsNotificationsEnabled: true,
  telegramNotificationsEnabled: true,
};
const PWA_ONLY: AutomodeNotificationPolicy = {
  gitsNotificationsEnabled: true,
  telegramNotificationsEnabled: false,
};
const TELEGRAM_ONLY: AutomodeNotificationPolicy = {
  gitsNotificationsEnabled: false,
  telegramNotificationsEnabled: true,
};
const NEITHER: AutomodeNotificationPolicy = {
  gitsNotificationsEnabled: false,
  telegramNotificationsEnabled: false,
};

interface Recorder {
  readonly pushed: PushNotificationPayload[];
  readonly telegrams: { readonly subject: string; readonly text: string }[];
}

/**
 * Builds the dispatcher over a real temp stateDir (dedup persistence is the point of this
 * suite) with recording push/Telegram stubs. `failPush`/`failTelegram` drive the
 * non-fatal-delivery cases.
 */
function harness(
  baseDir: string,
  options?: { readonly failPush?: boolean; readonly failTelegram?: boolean },
) {
  const recorder: Recorder = { pushed: [], telegrams: [] };
  const layer = AutomodeNotificationDispatcherLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        // A real config over a real directory: cross-restart dedup is what this suite tests,
        // so the state file has to actually land on disk.
        ServerConfig.layerTest(process.cwd(), baseDir).pipe(Layer.provide(NodeServices.layer)),
        Layer.succeed(PushNotificationService, {
          getPublicConfig: () => ({ enabled: true, publicKey: "test-key" }),
          sendToAll: (payload) =>
            options?.failPush === true
              ? Effect.die(new Error("push exploded"))
              : Effect.sync(() => {
                  recorder.pushed.push(payload);
                }),
          sendForOrchestrationEvent: () => Effect.void,
        }),
        Layer.succeed(HermesTelegramNotifier, {
          notify: (input) =>
            options?.failTelegram === true
              ? Effect.fail(new HermesTelegramNotifierError({ message: "telegram down" }))
              : Effect.sync(() => {
                  recorder.telegrams.push(input);
                }),
        }),
        NodeServices.layer,
      ),
    ),
  );
  return { recorder, layer };
}

const tempStateDir = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix: "gits-notify-" });
}).pipe(Effect.provide(NodeServices.layer));

const input = (key: string, policy: AutomodeNotificationPolicy) => ({
  key,
  subject: "GITS proposal",
  text: "A new proposal is waiting for review.",
  url: proposalNotificationUrl("proposal-1"),
  policy,
});

describe("AutomodeNotificationDispatcher", () => {
  it.effect("routes to the PWA only when Telegram is disabled", () =>
    Effect.gen(function* () {
      const stateDir = yield* tempStateDir;
      const { recorder, layer } = harness(stateDir);
      yield* Effect.gen(function* () {
        const dispatcher = yield* AutomodeNotificationDispatcher;
        yield* dispatcher.notify(input("proposal-created:p1", PWA_ONLY));
      }).pipe(Effect.provide(layer));
      assert.strictEqual(recorder.pushed.length, 1);
      assert.strictEqual(recorder.pushed[0]?.url, "/gits?panel=autopilot&proposal=proposal-1");
      assert.strictEqual(recorder.telegrams.length, 0);
    }),
  );

  it.effect("routes to Telegram only when the PWA channel is disabled", () =>
    Effect.gen(function* () {
      const stateDir = yield* tempStateDir;
      const { recorder, layer } = harness(stateDir);
      yield* Effect.gen(function* () {
        const dispatcher = yield* AutomodeNotificationDispatcher;
        yield* dispatcher.notify(input("proposal-created:p1", TELEGRAM_ONLY));
      }).pipe(Effect.provide(layer));
      assert.strictEqual(recorder.pushed.length, 0);
      assert.strictEqual(recorder.telegrams.length, 1);
      // The deep link has to survive into the Telegram body — it is the only way to reach
      // the card from a phone.
      assert.include(recorder.telegrams[0]?.text ?? "", "/gits?panel=autopilot&proposal=");
    }),
  );

  it.effect("routes to both channels when both are enabled", () =>
    Effect.gen(function* () {
      const stateDir = yield* tempStateDir;
      const { recorder, layer } = harness(stateDir);
      yield* Effect.gen(function* () {
        const dispatcher = yield* AutomodeNotificationDispatcher;
        yield* dispatcher.notify(input("proposal-created:p1", BOTH));
      }).pipe(Effect.provide(layer));
      assert.strictEqual(recorder.pushed.length, 1);
      assert.strictEqual(recorder.telegrams.length, 1);
    }),
  );

  it.effect("sends nothing when both channels are disabled", () =>
    Effect.gen(function* () {
      const stateDir = yield* tempStateDir;
      const { recorder, layer } = harness(stateDir);
      yield* Effect.gen(function* () {
        const dispatcher = yield* AutomodeNotificationDispatcher;
        yield* dispatcher.notify(input("proposal-created:p1", NEITHER));
      }).pipe(Effect.provide(layer));
      assert.strictEqual(recorder.pushed.length, 0);
      assert.strictEqual(recorder.telegrams.length, 0);
    }),
  );

  it.effect("deduplicates a repeated key within one process", () =>
    Effect.gen(function* () {
      const stateDir = yield* tempStateDir;
      const { recorder, layer } = harness(stateDir);
      yield* Effect.gen(function* () {
        const dispatcher = yield* AutomodeNotificationDispatcher;
        yield* dispatcher.notify(input("goal-blocked:g1", BOTH));
        yield* dispatcher.notify(input("goal-blocked:g1", BOTH));
        yield* dispatcher.notify(input("goal-blocked:g2", BOTH));
      }).pipe(Effect.provide(layer));
      assert.strictEqual(recorder.pushed.length, 2);
      assert.strictEqual(recorder.telegrams.length, 2);
    }),
  );

  // The restart case is why delivery is persisted at all: a periodic driver tick re-observes
  // the same blocked goal forever, and an in-memory-only guard would re-notify on every boot.
  it.effect("deduplicates across a restart via the persisted state file", () =>
    Effect.gen(function* () {
      const stateDir = yield* tempStateDir;
      const first = harness(stateDir);
      yield* Effect.gen(function* () {
        const dispatcher = yield* AutomodeNotificationDispatcher;
        yield* dispatcher.notify(input("goal-blocked:g1", BOTH));
      }).pipe(Effect.provide(first.layer));
      assert.strictEqual(first.recorder.pushed.length, 1);

      const second = harness(stateDir);
      yield* Effect.gen(function* () {
        const dispatcher = yield* AutomodeNotificationDispatcher;
        yield* dispatcher.notify(input("goal-blocked:g1", BOTH));
      }).pipe(Effect.provide(second.layer));
      assert.strictEqual(second.recorder.pushed.length, 0);
      assert.strictEqual(second.recorder.telegrams.length, 0);
    }),
  );

  // Channels are tracked independently: turning Telegram on later must still deliver a
  // transition the PWA already saw.
  it.effect("tracks delivery per channel", () =>
    Effect.gen(function* () {
      const stateDir = yield* tempStateDir;
      const first = harness(stateDir);
      yield* Effect.gen(function* () {
        const dispatcher = yield* AutomodeNotificationDispatcher;
        yield* dispatcher.notify(input("proposal-created:p1", PWA_ONLY));
      }).pipe(Effect.provide(first.layer));

      const second = harness(stateDir);
      yield* Effect.gen(function* () {
        const dispatcher = yield* AutomodeNotificationDispatcher;
        yield* dispatcher.notify(input("proposal-created:p1", BOTH));
      }).pipe(Effect.provide(second.layer));
      assert.strictEqual(second.recorder.pushed.length, 0);
      assert.strictEqual(second.recorder.telegrams.length, 1);
    }),
  );

  it.effect("survives a failing Telegram channel and still delivers the PWA notification", () =>
    Effect.gen(function* () {
      const stateDir = yield* tempStateDir;
      const { recorder, layer } = harness(stateDir, { failTelegram: true });
      yield* Effect.gen(function* () {
        const dispatcher = yield* AutomodeNotificationDispatcher;
        yield* dispatcher.notify(input("proposal-created:p1", BOTH));
      }).pipe(Effect.provide(layer));
      assert.strictEqual(recorder.pushed.length, 1);
    }),
  );

  it.effect("survives a failing PWA channel and still delivers the Telegram notification", () =>
    Effect.gen(function* () {
      const stateDir = yield* tempStateDir;
      const { recorder, layer } = harness(stateDir, { failPush: true });
      yield* Effect.gen(function* () {
        const dispatcher = yield* AutomodeNotificationDispatcher;
        yield* dispatcher.notify(input("proposal-created:p1", BOTH));
      }).pipe(Effect.provide(layer));
      assert.strictEqual(recorder.telegrams.length, 1);
    }),
  );

  // A failed send must not be recorded as delivered, or a transient outage silently eats
  // the only notification the operator was ever going to get.
  it.effect("retries a channel whose previous delivery failed", () =>
    Effect.gen(function* () {
      const stateDir = yield* tempStateDir;
      const failing = harness(stateDir, { failTelegram: true });
      yield* Effect.gen(function* () {
        const dispatcher = yield* AutomodeNotificationDispatcher;
        yield* dispatcher.notify(input("proposal-created:p1", TELEGRAM_ONLY));
      }).pipe(Effect.provide(failing.layer));

      const healthy = harness(stateDir);
      yield* Effect.gen(function* () {
        const dispatcher = yield* AutomodeNotificationDispatcher;
        yield* dispatcher.notify(input("proposal-created:p1", TELEGRAM_ONLY));
      }).pipe(Effect.provide(healthy.layer));
      assert.strictEqual(healthy.recorder.telegrams.length, 1);
    }),
  );

  it("builds proposal and section deep links", () => {
    assert.strictEqual(
      proposalNotificationUrl("hermes-abc"),
      "/gits?panel=autopilot&proposal=hermes-abc",
    );
    assert.strictEqual(automodeSectionUrl("goals"), "/gits?panel=autopilot&section=goals");
    // Identifiers reach the URL from stored state, so they must be encoded, not interpolated.
    assert.strictEqual(
      proposalNotificationUrl("a b&c"),
      "/gits?panel=autopilot&proposal=a%20b%26c",
    );
  });
});
