# Independent session messaging and optional swarms

Status: accepted. The user approved the written record and authorized implementation.
Date: 2026-09-29

## Context

Pi sessions need to collaborate without being parent and child agents. Long-running sessions must be able to discover peers, exchange findings and requests during work, and form optional groups.

The reference is https://code.claude.com/docs/en/cross-session-messaging. The sibling `../pi-flow` package provides inspiration for package layout and agent policy injection, not a messaging implementation.

## Decision

Implement a local-first Pi extension in `pi-talk`. Independent sessions communicate through local sockets. There is no central service and no session controller.

### Identity and discovery

Each running instance publishes its own socket and JSON registry file in a configurable, user-private directory. The proposed default is `~/.pi/agent/pi-talk/peers/`. The implementation must account for operating-system socket-path limits.

Registry metadata includes a stable Pi session ID, a unique running-instance ID, display name, agent-editable description, current model, working directory, swarm memberships, socket address, and busy or idle state. It does not contain conversation history. Model metadata comes from Pi rather than agent claims.

Registry updates use atomic replacement. Discovery verifies reachability and excludes stale registrations. A stable session ID can have multiple live instances; messages must resolve to an unambiguous running instance.

### Peer messaging and swarms

Peer messaging works without swarm membership. Agents can discover peers and send direct messages whenever needed. Agents can join or leave named swarms without user approval for each operation. A session can belong to multiple swarms.

When joining a swarm, an agent introduces itself with its description and current model. Swarms support member discovery and broadcasts. User commands expose the same operations. Membership does not create an ownership hierarchy or grant authority over another session.

Description and swarm memberships persist in session state across resume. Each launch recreates its live socket and registration.

### Delivery

The extension checks incoming work periodically while the session is running. Accepted messages enter model context at an available between-tool boundary, without interrupting a running tool. An accepted message starts a turn when the recipient is idle. Agents also have an explicit inbox-check operation.

Each message includes sender identity, model, an optional swarm, a message ID, and a reply target. Broadcasts report results separately for each recipient.

Sending distinguishes queued, held, refused, and unavailable results. Queued means accepted by the recipient, not read or completed. A timeout is an uncertain outcome and must not trigger a silent retry.

Users control inbound delivery with `accept`, `hold`, or `refuse`; the default is `accept`. Held messages do not reach the model until released. Size and queue limits reject excess traffic explicitly.

Accepted queues are in memory. Messages are not guaranteed to survive a recipient restart.

### Trust and controls

Messages are identified as peer requests, not user instructions or approval. Peer requests cannot grant permission, change permission policy, or authorize bypassing a blocked action. Agent instructions discourage replies that only acknowledge receipt and provide no new information.

The operating-system user is the local trust boundary. Swarm membership is not a security boundary against processes running under that account. Registry and socket access must be restricted to that user. Sandbox restrictions remain in force.

### Cleanup

Shutdown, extension reload, and session replacement release sockets, registry files, timers, and open connections. Cleanup is idempotent and applies only to resources owned by that running instance.

Discovery detects crash leftovers. It removes only entries confirmed stale and must not remove a live peer's resources. Uncertain reachability must not be treated as sufficient evidence for destructive cleanup.

## Alternatives

- Peer messaging alone would meet direct communication needs but omit the requested swarm discovery and broadcasts.
- A central broker would simplify some coordination but add a service lifecycle and failure point. It is excluded from version one.
- Cross-machine messaging requires transport authentication and routing beyond the agreed local scope.

## Consequences

Sessions remain independently controlled, with their own models, conversations, tools, and permissions. Automatic idle wake-up can incur model usage and can create reply loops. Visible inbound controls, explicit limits, and agent policy reduce these risks but do not establish a global token budget.

A shared private directory makes discovery inspectable without a daemon. Crashes can leave files behind, so stale detection and conservative cleanup are correctness requirements.

An in-memory inbox simplifies version one but loses undelivered messages on restart. The implementation and documentation must not claim durable or exactly-once delivery.

## Invariants

1. Swarm membership is optional for direct messages.
2. Peer messages never count as user approval.
3. Running tools are not interrupted for message delivery.
4. Queued, read, and completed are distinct states; version one must not claim the latter two from a queue acknowledgement.
5. Ambiguous peers are never selected silently.
6. Discovery never exposes conversation history.
7. Cleanup never removes resources known to belong to a live peer.
8. Session replacement cannot deliver an old session's queued messages into a new session.
9. Sandbox denial must be surfaced, not bypassed.

## Acceptance scenarios

- Two independent Pi processes discover each other and exchange direct messages without joining a swarm.
- Agents join a swarm, introduce themselves, discover members, broadcast, and leave.
- Description and memberships return on resume; model metadata reflects the current model.
- A busy agent receives an accepted message at a safe boundary during its work. A running tool is not interrupted.
- An idle agent starts a turn for an accepted message.
- Held messages do not reach the model until released; refused messages never reach it.
- Oversized messages and full queues return explicit failures. Broadcast results distinguish recipients.
- An ambiguous name requires disambiguation. Multiple instances of one session remain separately addressable.
- Graceful shutdown and reload leave no owned live resources behind.
- A crashed peer is excluded from discovery; conservative cleanup removes confirmed leftovers without harming a live process.
- Session replacement isolates identity, memberships, and pending deliveries.
- Tests exercise actual local transport between separate processes as well as extension lifecycle behavior.

## Excluded work

Cross-machine transport, a central broker, shared task scheduling, parent-child agent orchestration, conversation-history transfer, durable offline mailboxes, and claims of exactly-once delivery.

## Decision provenance

The user approved independent peer messaging, optional agent-managed swarms, agent descriptions and model advertisement, active-work inbox checks, autonomous sending, local sockets, shared metadata files, cleanup, and persisted membership and description on resume.

Exact command and tool names, wire format, timer intervals, numerical limits, and module structure remain implementation details to specify in the plan. Pi lifecycle behavior must be verified against the installed extension API before implementation.
