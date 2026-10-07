# Give Mira a real host connection

Mira can now use a genuine local Model Context Protocol (MCP) server to keep an event brief, work graph, draft artifacts, decisions, reported outcomes and proposed memory in a persistent workspace. Your existing host supplies the reasoning model. The server performs bounded local operations and makes no model calls, including when provider credentials are present in the environment. Your host's normal model usage and billing still apply.

This is an independent open-source teammate. Connecting a server does not by itself load a full personality into every host, establish employment or endorsement, connect an account, or prove executive-level performance. Load the role guidance explicitly and evaluate the quality of the resulting work.

## Connect a project

From the source checkout:

```sh
node bin/open-teammates.mjs connect --project /absolute/path/to/project --dir /absolute/path/to/project/.teammates
```

Or, from the directory containing the local package:

```sh
npx --yes --package ./open-teammates open-teammates connect --project /absolute/path/to/project --dir /absolute/path/to/project/.teammates
```

The local package command works before a public npm release. A registry-only one-liner requires the corresponding package to be published first.

`connect` prepares a project-local `.mcp.json` entry named `open-teammates-events` and `.teammates-chief-of-events.md` with instructions for loading the role. It preserves other server entries and refuses to replace an existing entry with that name. It does not change the project's root `AGENTS.md` or global host settings. Review the generated files; let your host discover or import the server entry using that host's documented configuration workflow.

`.mcp.json` is a host configuration convention, not part of the MCP protocol. Some hosts require their own configuration file, an add-server command, or a UI import. In those hosts, use the exact generated command and arguments. Paths must remain accessible to the process that launches the server. A local `npx` cache path or source checkout must stay available for later launches; reconnect after moving it. Windows hosts need paths suitable for their own environment.

The underlying invocation is:

```sh
node /absolute/path/to/open-teammates/bin/open-teammates.mjs mcp --dir /absolute/path/to/project/.teammates
```

The host starts this subprocess and exchanges JSON-RPC over stdin/stdout. Standard output contains only protocol messages. The server closes when stdin ends and rejects inbound frames larger than 1 MiB. The tool quota is 120 calls per connection per 60-second window.

## Load the role explicitly

Use the host's resource interface to read both:

- `teammate://chief-of-events/soul`: Mira's personality and shared DNA.
- `teammate://chief-of-events/work-contract`: event workflows, the skill, evidence standards and connected-tool limits.

The server also offers the `teammate_chief_of_events` prompt, with a required `request` string and optional `missionId`. Selecting that prompt loads the same guidance plus the current mission. MCP hosts control how resources, prompts and server instructions reach their model; a configured connection alone cannot guarantee that the host adopted the role.

A useful first request is:

> Read Mira's soul and work-contract resources. Work with me as Chief of Events within your existing policies. Read the local status and next actions, recommend the highest-value next step, and make the reversible local draft work concrete. Label assumptions and show what evidence and owner decisions remain.

## Local tool contract

Every tool name begins with `teammate_`. All object schemas reject unknown properties. Text, collection and payload limits are part of the advertised schemas. Mission and task IDs must be UUIDs.

| Tool | Input | Result and meaning |
| --- | --- | --- |
| `status` | Optional `missionId`, `limit` (1–50, default 20) | Read the ledger. A mission result includes its work, decisions, observations and advisory readiness. |
| `create_mission` | `{ brief }` | Return `{ mission, tasks }`. Seed event-relative proposed work with unassigned owners and prerequisites. Omitted brief fields are explicit demo assumptions. |
| `revise_mission` | `missionId`, brief `patch`, `expectedRevision`, `reason` | Revise the brief, retain its history, and make existing drafts stale. Review task deadlines after changing date/timezone. |
| `draft_mission` | `missionId` | Save the offline starter artifact pack. Its review checks structure and calculations; it does not establish real-world readiness. |
| `save_draft` | `missionId`, `name`, `title`, `content`, `expectedRevision`, `expectedDraftVersion` | Save host-authored Markdown in a new versioned pack. Use a lowercase `.md` basename and 100–60000 characters. Deterministic CSV artifacts remain in the pack. |
| `add_task` | `{ missionId, task }` | Add local work with owner, priority, deadline, prerequisites and completion evidence. |
| `update_task` | `taskId`, `patch`, `expectedRevision` | Update against the current task revision. Done requires a named owner, substantive reported evidence and completed prerequisites. |
| `record_decision` | `missionId`, `question`, `recommendation`, `rationale`; optional `owner`, `evidence`, `revisitWhen` | Record a proposed planning recommendation. Owner acceptance cannot be asserted through this tool. |
| `record_outcome` | `missionId`, `metric`, finite numeric `value`, `unit`, `source`, `observedAt`; optional `notes` | Record a caller-reported actual observation. A source is required; the server does not independently verify it. |
| `remember` | `{ text }` | Record proposed teammate memory. Owner review is required before it becomes confirmed context. |
| `next_actions` | Optional `missionId`, `limit` (1–50, default 20) | Compute an advisory queue from current records. This runs on request, without background monitoring. |
| `request_handoff` | `kind`, `summary`, concrete `payload`; optional `missionId` | Record an exact external-action request for separate owner review. Nothing executes. |

Brief fields are `name`, `organization`, `objective`, `audience`, `format`, `city`, `date`, `timezone`, `budget`, `currency`, `capacity`, `constraints`, and optional extra `assumptions` on creation. Formats are `flagship`, `executive`, `regional`, `internal`, and `webinar`. Budget is an integer in major currency units. Handoff spend payloads instead use integer `amountMinor` plus uppercase `currency`.

Task fields are `title`, `description`, nullable `owner`, `status`, `priority`, nullable `dueAt`, prerequisite UUID `dependencies`, nullable `evidence`, `acceptanceCriteria`, `suggestedOwner`, and optional calendar `date`. Status values are `open`, `in_progress`, `blocked`, and `done`. Priority values are `critical`, `high`, `normal`, and `low`. `dueAt` and outcome `observedAt` require an ISO timestamp with an explicit timezone offset or `Z`.

Use the revision from the latest returned record. A conflict means another operation changed it: refresh, review the change, and then form the revised request. Mission revisions track brief changes; task revisions track task changes. `mission.draftVersion` starts at zero and increases whenever a new artifact pack is saved. `save_draft` requires both `expectedRevision` and `expectedDraftVersion`, protecting the brief context and the pack the host inspected. A competing host's newer prose cannot be silently replaced with an edit based on an older pack. Draft runs retain their versioned artifacts. Updating a date does not silently rewrite task assignments or claim that old deadlines still fit.

## A concrete first work cycle

Call `teammate_create_mission` with a brief such as:

```json
{
  "brief": {
    "name": "Builders Together",
    "organization": "Example organization",
    "objective": "Every participant leaves with a tested prototype and a useful next step.",
    "audience": "Developers learning our product",
    "format": "regional",
    "city": "New York",
    "date": "2027-05-18",
    "timezone": "America/New_York",
    "budget": 45000,
    "currency": "USD",
    "capacity": 120,
    "constraints": ["Step-free access, live captions and an offline demo fallback."]
  }
}
```

Read the returned proposed tasks, choose actual human owners, and call `teammate_draft_mission`. The host can then recommend a sharper audience promise, smaller viable format, or creative direction and save that prose with `teammate_save_draft`. Capture the recommendation with `teammate_record_decision` and a reopening trigger. Read `teammate_next_actions` to identify what unlocks the next stage.

An owner-reviewed quote, rehearsal report, supplier acceptance, published asset or delivery receipt can support a later task update. Source references supplied by a host remain asserted evidence; a record alone is not independent verification. Targets, capacity and draft copy cannot establish attendance, adoption or business results. Keep actual outcomes in `teammate_record_outcome` after the relevant observation exists.

## Authority and portability

The server reads bundled role resources and the selected local ledger, and writes versioned drafts inside that ledger's workspace. It exposes no arbitrary path reader, shell, browser, network call, approval tool or external-action executor. Handoff kinds are `send_message`, `publish`, `spend`, `sign_contract`, `book_venue`, and `share_attendee_data`; all remain review requests. Owner-only CLI controls handle approval and memory confirmation, and approval still does not execute the action in this release.

Host tools are separate. If Hermes, OpenClaw or another host has messaging, calendar, procurement, browser or payment access, its policies still govern those capabilities. Mira's role files and proposed local memory do not grant them. The existing runtime exports remain useful for loading personality and skills; an MCP connection adds the local work ledger, without automatically enabling any host connection or channel.

Protocol behavior is tested with the official SDK client against the actual stdio transport and a real CLI subprocess: initialization, discovery, resources, prompt loading, local work, competing draft edits, revision conflicts, proposed memory, denied approval attempts, input/path bounds, corrupted state, oversized frames and stdin closure. Those integration checks establish the interface behavior. Role judgment and event outcomes require the separate evaluation and owner review described in [QUALITY.md](QUALITY.md).

## Implementation references

The package pins `@modelcontextprotocol/sdk` 1.32.1 and Zod 4.6.5. The official [v1 SDK documentation](https://ts.sdk.modelcontextprotocol.io/) describes this maintained line and its support for the 2025-11-25 protocol; the newer stable SDK uses separate v2 packages. This release uses the combined SDK deliberately and does not claim support for the 2026-07-28 protocol. The [SDK server guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.x/docs/server.md) defines the high-level server, stdio transport, resources and prompts. The [MCP stdio specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) defines newline-framed JSON-RPC and protocol-only stdout. Tool schemas and error handling follow the [MCP tools specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools). Registry versions were checked on October 7, 2026.
