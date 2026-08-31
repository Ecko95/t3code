# Web Push PWA Setup

GITS can send Web Push notifications for the same attention events used by the
in-app notification hook:

- turn diff completed
- approval requested
- user input requested

This is designed for self-hosting on a Tailscale tailnet. The phone must reach
the GITS web app to install the PWA and register a push subscription, but the
server does not need public inbound access for delivery. Delivery is an outbound
POST from the GITS server to the browser vendor's public push service.

## Generate VAPID Keys

Generate keys on the host that runs GITS:

```sh
npx web-push generate-vapid-keys
```

Configure the server with all three values:

```sh
export T3CODE_VAPID_PUBLIC_KEY="..."
export T3CODE_VAPID_PRIVATE_KEY="..."
export T3CODE_VAPID_SUBJECT="mailto:operator@example.com"
```

`T3CODE_VAPID_SUBJECT` may be a `mailto:` address or an HTTPS URL identifying
the operator. Restart the server after changing these variables. Web Push is
inert until all three values are present.

## Phone Setup

1. Connect the phone to the tailnet.
2. Open GITS from the same stable HTTPS origin you will keep using.
3. Install the app to the home screen.
4. Open the installed PWA and enable Settings -> Notifications -> Push to phone.

iOS requires iOS 16.4 or newer and a home-screen installed PWA. A normal Safari
tab cannot receive Web Push after it is closed.

## What Is Cached

The service worker only precaches the app shell and uses network-first handling
for page navigations. It does not cache `/api/*`, attachment URLs, or WebSocket
state. Live session state still comes from the server after reconnect.

## Server Event Seam

The server sends push notifications from
`OrchestrationEngineService.streamDomainEvents` via the push notification
reactor. The current mapped events are:

- `thread.turn-diff-completed`
- `thread.activity-appended` with `activity.kind === "approval.requested"`
- `thread.activity-appended` with `activity.kind === "user-input.requested"`

ponytail: notification text uses `Thread <threadId>` instead of loading the
projection title in the hot reactor path. Notification clicks still deep-link to
the exact thread route.

## Automode and Proposal Notifications

Automode attention events use the same Web Push delivery, routed through
`AutomodeNotificationDispatcher` instead of the orchestration reactor. The
dispatched events are:

- a newly persisted Motoko proposal (repository-pattern or thread continuation)
- an approved proposal queued for scheduled execution
- a goal entering `waiting-approval`, `blocked`, or `failed`
- the Automode driver halting
- a held PR becoming available

Delivery is deduplicated by a stable per-transition key, persisted per channel in
`<stateDir>/gits/automode-notifications-state.json`, so a restart or a repeated
driver tick never re-sends a transition the operator already saw. A failed send is
not recorded, so a transient outage retries on the next tick. Delivery failures
are logged and never alter proposal or Automode state.

Notification bodies carry titles, goal ids, and reasons only — never full
execution prompts or repository evidence.

### Channel Toggles

Two independent switches live in the cockpit's **Autopilot → Automation
switchboard**:

| Toggle                 | Policy field                   | Default |
| ---------------------- | ------------------------------ | ------- |
| GITS notifications     | `gitsNotificationsEnabled`     | on      |
| Telegram notifications | `telegramNotificationsEnabled` | off     |

Both may be enabled at once. The GITS toggle only controls _server-side_
delivery: the phone still needs browser notification permission, an installed
PWA, and the VAPID keys above. `telegramDigestEnabled` is unchanged and still
governs the separate daily digest.

### Proposal Deep Links

Proposal notifications open:

```text
/gits?panel=autopilot&proposal=<proposal-id>
```

Automode events with no proposal to focus link to a section instead:

```text
/gits?panel=autopilot&section=goals
```

Opening a proposal link selects the Autopilot panel and opens the review sheet on
that card. Title and execution prompt are the primary fields; repository, model,
proposed run time, runtime limit, verification commands, and integration branch
sit under **Advanced**. Approve, Defer, and Reject all go through one atomic
review RPC, so edits and the decision can never land separately.

Approving queues exactly one Automode goal carrying the proposal's episode id and
the edited execution settings. The proposed run time is a _not-before_ value, not
a second scheduler: the goal stays queued until that time passes and still has to
clear the slot scheduler, arming state, capacity limits, policy gates, and the
kill switch. Re-approving a proposal whose episode already has a live goal is a
no-op. The consumed query parameters are stripped from the URL once the sheet is
closed.
