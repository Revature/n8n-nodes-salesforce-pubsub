# @revaturepak/n8n-nodes-salesforce-pubsub

An [n8n](https://n8n.io) trigger node that subscribes to a **Salesforce platform event** over the
[Pub/Sub API](https://developer.salesforce.com/docs/platform/pub-sub-api/overview) and starts the
workflow **once per event, in order**.

n8n's built-in Salesforce Trigger polls records with SOQL, and platform events cannot be queried, so it
cannot see them. This node holds a Pub/Sub subscription instead — the same way integration platforms
such as Workato do — with no Apex trigger or other change needed in Salesforce.

## Install

Self-hosted n8n only (it is not an n8n Cloud verified node).

- **UI:** *Settings → Community nodes → Install*, package `@revaturepak/n8n-nodes-salesforce-pubsub`.
- **Configuration (n8n ≥ 2.21), recommended:** pin the version and its checksum so only that exact build
  can be installed:

  ```bash
  N8N_COMMUNITY_PACKAGES_MANAGED_BY_ENV=true
  N8N_COMMUNITY_PACKAGES='[{"name":"@revaturepak/n8n-nodes-salesforce-pubsub","version":"0.1.0","checksum":"sha512-..."}]'
  ```

  The checksum is the `dist.integrity` value: `npm view @revaturepak/n8n-nodes-salesforce-pubsub@0.1.0 dist.integrity`.
  Read n8n's [environment-variable installation](https://docs.n8n.io/integrations/community-nodes/installation-and-management/environment-variable-installation)
  page first: the first start with this setting uninstalls community packages that are not listed.

Persist `/home/node/.n8n` (a volume) if you install from the UI, or installed nodes vanish when the
container is recreated.

## Credential: Salesforce Pub/Sub API

| Mode | Fields | Notes |
|---|---|---|
| **OAuth 2.0 Client Credentials** (recommended) | My Domain URL, client ID, client secret | A connected app / external client app with the client credentials flow enabled and a run-as user |
| **Username and Password** | Login URL, username, password, security token | SOAP login, no connected app. Salesforce is retiring SOAP `login()`; use only as a stop-gap |

The Salesforce user needs **Read** access to every platform event it subscribes to. The credential's
**Test** button logs in and opens the Pub/Sub channel.

## Node: Salesforce Pub/Sub Trigger

| Parameter | Default | |
|---|---|---|
| **Event** | — | `Order_Event__e`, or a full channel path such as `/event/Order_Event__e`. Names ending in `ChangeEvent` map to `/data/…` (Change Data Capture) |
| **Start From** | Latest | *Latest* · *Earliest Retained* (Salesforce keeps events 72 h) · *After a Replay ID*. Used only the first time; afterwards the trigger resumes where it left off. With *Latest*, events published while the subscription is still being set up (the first few seconds after activation) are not delivered |
| **Batch Size** | 100 | Events requested at a time (1–100). The next batch is requested only after this one is processed |

Each event produces one workflow run with a single item:

```json
{
  "topic": "/event/Order_Event__e",
  "eventName": "Order_Event__e",
  "replayId": "6327405",
  "eventUuid": "7c0b8d2e-…",
  "payload": { "OrderNumber__c": "ORD-1042", "Status__c": "Shipped", "CreatedDate": 1792595087085, "…": "…" },
  "receivedAt": "2026-10-21T14:05:09.123Z"
}
```

`payload` holds the event's fields exactly as the Avro schema delivers them: date-times are **epoch
milliseconds** (convert with `{{ DateTime.fromMillis($json.payload.CreatedDate) }}`), and integers too
large for JavaScript arrive as strings.

## Behaviour you should design for

- **In order, one at a time.** The next event waits until the previous run has finished.
- **At-least-once.** The trigger stores the replay ID of each processed event in the workflow's static
  data, which n8n saves when the next event starts a run. After a restart the most recent event can be
  delivered again, so **dedupe on `eventUuid`** — for example *Remove Duplicates → Remove items processed
  in previous executions*.
- **A failed run does not block the topic.** The position advances and the failure shows in n8n's
  executions (and your error workflow). Handle retries inside the workflow if an event must not be lost.
- **Reconnects automatically** with backoff (5 s up to 5 min), resuming after the stored replay ID. If the
  stored ID is older than Salesforce's 72-hour retention, it restarts from *Latest* and logs a warning.
- **Test mode** (*Listen for test event*) takes the next event published, then disconnects.
- **Each active workflow holds one gRPC connection.** Deliveries count against your org's daily
  platform-event delivery allocation (`DailyDeliveredPlatformEvents`).

## Development

```bash
npm ci
npm test        # flow-control logic, no Salesforce needed
npm run lint
npm run build   # → dist/, a single self-contained bundle
npm run dev     # local n8n at http://localhost:5678 with the node loaded
```

The build bundles [`salesforce-pubsub-api-client`](https://github.com/pozil/pub-sub-api-node-client) and
its dependencies into the node file, so the published package has no runtime dependencies. Their licences
are in `dist/THIRD_PARTY_LICENSES.txt`.

## Supply-chain security

A community node runs inside n8n with access to everything n8n can reach, so this repo guards both what
ships and how it is published:

- **No runtime dependencies.** Libraries are bundled at build time; installing the package fetches nothing else.
- **Vulnerability gate.** CI fails if any bundled package has a known vulnerability (`npm run check:supply-chain`,
  OSV database) or any dependency fails npm's registry-signature check.
- **Dependency review.** A pull request that adds or upgrades to a dependency with a high/critical
  vulnerability is blocked, development dependencies included (they are what gets bundled).
- **No install scripts.** CI installs with `npm ci --ignore-scripts`.
- **Build and publish are separate jobs.** The job that can publish to npm installs nothing and runs no
  package code; it uploads the tarball the build job produced, with provenance.
- Actions are pinned to commit SHAs, and Dependabot proposes updates weekly.

## Releasing

Merging a version bump is the release; there is nothing to tag by hand.

1. In a pull request, bump the version (`npm version patch --no-git-tag-version`, or `minor`/`major`).
2. Merge it. The *Publish* workflow sees that this version is not on npm yet and waits for approval on
   the `npm` environment (*Actions → Publish → Review deployments*).
3. Once approved, it tests, builds and publishes with [trusted publishing](https://docs.npmjs.com/trusted-publishers)
   and provenance (no npm token is stored anywhere), then creates the `v<version>` tag and GitHub release.
4. Update the pinned `version` and `checksum` wherever the node is installed.

Merges that don't change the version are left alone. If the publish or release step fails, fix the cause
and re-run it from *Actions → Publish → Run workflow*.

## License

[MIT](LICENSE)
