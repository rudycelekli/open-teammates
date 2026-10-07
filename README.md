# Open Teammates

**An open-source employee series. First hire: Mira, Chief of Events.**

Mira brings a point of view, professional workflows, a persistent work ledger, and artifacts you can inspect. She protects the attendee experience, challenges weak premises, reconciles budgets, names the next useful action, and follows work beyond event day. Her personality DNA is readable and editable. Her judgment is an ambition to evaluate, not an invented resume or a claim of perfection.

Version **0.2.0** adds a real MCP work connection, event-relative task graphs, brief revisions, decision and outcome records, multi-turn consultations, owner-reviewed memory and executable baseline comparisons. MIT licensed and published on [GitHub](https://github.com/rudycelekli/open-teammates). npm registry publication remains pending.

## Hire the first teammate

With Node.js 22+ and Git installed, hire from the versioned GitHub source:

```sh
npx --yes --package github:rudycelekli/open-teammates#v0.2.0 open-teammates hire chief-of-events --demo --dir ./.teammates/mira
```

Or, from the directory containing a local copy of this package:

```sh
npx --yes --package ./open-teammates open-teammates hire chief-of-events --demo --dir ./open-teammates/.teammates/mira
```

This installs a local role bundle and creates a fictional 600-person developer gathering with a USD 180,000 budget, eight planning artifacts, and twelve suggested tasks. Owners remain unassigned until someone accepts the work. The demo makes no model request. Omit `--demo` to start with an empty work ledger, or supply `--brief ./my-event.json`. Rehiring preserves edits and refuses incomplete bundles rather than claiming they are installed.

Read Mira's next work:

```sh
npx --yes --package ./open-teammates open-teammates briefing --dir ./open-teammates/.teammates/mira
```

The GitHub command installs without an npm registry release. The shorter `npx open-teammates hire chief-of-events` remains a registry release target.

## Give Mira a working host connection

```sh
npx --yes --package ./open-teammates open-teammates connect --project ./your-project --dir ./open-teammates/.teammates/mira
```

This prepares a project-local `.mcp.json` entry and role instructions while preserving other servers. Enable that entry in an MCP-compatible host, or import the printed configuration into the host's settings. Keep the package path available; reconnect if you move it or clear the npm cache. Connecting does not automatically load a personality or start background work.

Tell your host:

> Read Mira's soul and work-contract resources. Work with me as Chief of Events within your existing policies. Inspect teammate_status and teammate_next_actions, recommend the highest-value next step, and make the authorized local draft work concrete. Show what evidence and owner decisions remain.

The MCP server uses your host's reasoning model and provides twelve bounded local tools: mission creation/revision, offline drafting, host-authored draft saves, tasks, decisions, reported outcomes, proposed memory, next actions, and concrete handoff requests. These tools make no provider calls. Host model usage follows your host's billing and access. [Connection guide and exact tool contract](docs/HOST-INTEGRATION.md).

## Work with a real event brief

Node.js 22+ is required. From this package directory, run `npm ci --ignore-scripts` once for the pinned MCP dependencies, then use the CLI directly:

```sh
node bin/open-teammates.mjs run --brief examples/developer-flagship.json --dir ./my-events
node bin/open-teammates.mjs briefing --dir ./my-events
node bin/open-teammates.mjs task list --dir ./my-events
```

Edit the example's audience, useful outcome, format, date, timezone, budget, capacity and constraints. Formats are `flagship`, `executive`, `regional`, `internal`, and `webinar`. Budget is an integer in major currency units. Dates must be real `YYYY-MM-DD` dates; timezones must be valid IANA names. Missing fields become visible assumptions. Offline documents are useful templates; original reasoning comes from a configured model or the host.

Mira produces an executive brief, portfolio strategy, budget allocation, production run of show, risk register, stakeholder plan, measurement plan and follow-through plan. Allocations reconcile with contingency inside the cap. They are proposals, not supplier quotes or confirmed commitments.

## Change the plan without losing its history

```sh
node bin/open-teammates.mjs revise MISSION_UUID --patch revised-brief.json --reason "Budget reduced; resize the experience" --expected-revision 1 --dir ./my-events
node bin/open-teammates.mjs redraft MISSION_UUID --dir ./my-events
```

A revision retains the previous brief, makes its draft stale, supersedes mission handoffs, and marks recorded work for review. Completed task evidence remains in history. Deadlines and owners are not silently reassigned; review them against the new brief. Competing brief edits and competing draft saves are rejected when based on an older version. Historical artifact directories remain available.

Tasks have owners, priorities, deadlines, prerequisites and completion evidence. A task cannot become done merely because a draft exists or a dependency was completed. The readiness view is advisory, with post-event follow-through separate from pre-event preparation. [Work loop and input examples](docs/WORK-LOOP.md).

## Connect a drafting model

```sh
export OPEN_TEAMMATES_MODEL='your-provider-model-id'
export OPEN_TEAMMATES_API_KEY='your-provider-key'
# Optional: export OPEN_TEAMMATES_BASE_URL='https://your-provider.example/v1'
node bin/open-teammates.mjs doctor
node bin/open-teammates.mjs run --brief ./my-event.json --live --dir ./my-events
node bin/open-teammates.mjs ask "What should we protect if the budget falls 30%?" --mission MISSION_UUID --dir ./my-events
```

The default endpoint is `https://api.openai.com/v1`. Providers must implement Chat Completions `messages`, `max_completion_tokens`, and JSON-object `response_format` for pack generation. [Official API contract](https://developers.openai.com/api/reference/resources/chat). Local HTTP providers on localhost are accepted and may omit a key. Actual provider compatibility remains unverified in this release.

Live mode sends the mission, confirmed preferences and relevant conversation context to the chosen provider and may incur charges. Pack generation uses one request to rewrite Markdown, retaining deterministic CSVs. Consultation preserves six prior exchanges from the same mission revision. A superseded response cannot commit as current work. Prompts and replies are now stored locally; keep credentials outside the repository.

## Memory and owner decisions

```sh
node bin/open-teammates.mjs memory add "Protect rehearsal and accessible participation when reducing scope." --dir ./my-events
node bin/open-teammates.mjs memory list --dir ./my-events
node bin/open-teammates.mjs memory confirm PROPOSED_MEMORY_UUID --dir ./my-events
node bin/open-teammates.mjs memory delete MEMORY_UUID --dir ./my-events
```

Host suggestions are proposed memory until owner confirmation. Only confirmed memory enters live drafting context. No silent personal profiling, automatic model training, or cross-user sharing occurs. Deletion removes active context; historic artifacts and conversations remain in local history.

Owner CLI controls accept or reject planning decisions and concrete handoff requests. Approval is bound to the exact payload and mission revision. The MCP server exposes no approval tool. This release records approved handoffs with `executed:false`; it has no email, booking, procurement, payment or publication executor. Real account access and external execution must use a permissioned host integration with receipts.

## Measure whether the role helps

```sh
node bin/open-teammates.mjs eval list
node bin/open-teammates.mjs eval plan --out .teammates/evaluation-plan
node bin/open-teammates.mjs eval run --out .teammates/budget-eval --case budget-cut --live
```

Planning is offline. A live evaluation explicitly selects one case and attempts exactly two matched provider requests, baseline and Mira. Outputs, usage, timings and failures are retained; grader notes never enter the model prompt. Machine checks cover JSON structure and specified budget arithmetic. Human reviewers score judgment, honesty, feasibility, attendee experience and outcome reasoning. Missing reviews stay incomplete; critical failures override averages. [Evaluation protocol](docs/EVALUATION.md).

No real-provider scores or professional event-delivery claims are made. Eight fixed fictional cases cover portfolio investment, launch changes, budget cuts, VIP privacy, accessibility, production incidents, executive pushback and causal outcome reasoning.

## Take the role into Hermes or OpenClaw

```sh
node bin/open-teammates.mjs export --runtime hermes --out ./mira-hermes
node bin/open-teammates.mjs export --runtime openclaw --out ./mira-openclaw
```

Hermes is the recommended ongoing host; OpenClaw is an alternative. Pi and generic exports are available, with manual Open Dots and Maria Open Instinct adaptations. Merit Systems' unrelated OpenInstinct needs a separate code adapter. Exports contain persona and skills; they do not install the host or enforce its tool permissions. Pair a host with the MCP work ledger where supported. [Verified source comparison](docs/RUNTIME-DECISION.md).

## Verify and contribute

```sh
npm ci --ignore-scripts
npm run check
npm test
npm pack
npm run smoke:package -- ./open-teammates-0.2.0.tgz
```

Tests include a real SDK client/CLI subprocess, concurrent process writes, crash recovery, revision conflicts, role/memory boundaries and mocked provider failure paths. The package smoke installs the actual tarball into an empty npm cache and checks its offline work and MCP connection. Test runs make no paid provider calls. The loopback API remains available with `open-teammates start`; the current product is CLI-first. [Recorded verification](docs/VERIFICATION.md) · [Architecture](docs/ARCHITECTURE.md) · [Series](docs/SERIES.md) · [Quality](docs/QUALITY.md) · [Contributing](CONTRIBUTING.md) · [Release](docs/RELEASE.md).

Independent project. The supplied job description informed Mira's remit; no OpenAI affiliation, endorsement or operation of real OpenAI events is claimed.
