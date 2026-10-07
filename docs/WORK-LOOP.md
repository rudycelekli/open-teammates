# A useful work cycle

The workspace is Mira's shared operating record. Use it to turn a brief into accountable work, retain changes, and identify the next decision. The queue is computed on demand; it does not imply someone is working in the background.

## Start with the current state

```sh
open-teammates hire chief-of-events --demo --dir ./my-events
open-teammates briefing --dir ./my-events
open-teammates task list --mission MISSION_UUID --dir ./my-events
```

The fictional demo creates eight draft artifacts and twelve suggested tasks. Their actual owners remain unassigned. Deadlines derive from the event's local calendar and timezone, including daylight-saving changes. Follow-through offsets use weekdays; public holidays require local review. Tasks are editable suggestions, not a universal production schedule.

Choose the highest-value unblocked work. A host can read `teammate_status`, `teammate_next_actions` and the role resources, then author a concrete Markdown artifact with `teammate_save_draft`. That save requires the latest `expectedRevision` and `expectedDraftVersion`; it retains the deterministic CSV artifacts. Review the content's factual assumptions and budget implications.

## Assign and finish work with evidence

Save a task patch as JSON, using the real accepted owner and a reviewed deadline:

```json
{
  "owner": "Accepted owner's name",
  "status": "in_progress",
  "dueAt": "2027-02-05T17:00:00-08:00"
}
```

```sh
open-teammates task update TASK_UUID --patch task-patch.json --expected-revision 1 --dir ./my-events
```

Use the task's current revision from `task list`, not its mission's revision. A later completion patch must include `status: "done"` and substantive `evidence` describing the actual verification and source. All direct and transitive prerequisites need their own accountable completion evidence. A draft, a past deadline or a convincing sentence does not prove that work occurred.

For added tasks, use `task add --input task.json --mission MISSION_UUID`. The input supports `title`, `description`, `owner`, `status`, `priority`, `dueAt`, `dependencies` (task UUIDs), `acceptanceCriteria`, and `evidence`. Dependencies must belong to the same mission and cannot form a cycle.

## Preserve judgment and actual outcomes

A proposed decision input:

```json
{
  "question": "Which experience should receive the flagship investment?",
  "recommendation": "Prioritize the developer gathering and stage regional investment.",
  "rationale": "Hands-on product understanding is the agreed primary outcome; regional demand remains unverified.",
  "status": "proposed",
  "revisitWhen": "After the regional leads provide sourced demand evidence."
}
```

```sh
open-teammates decision add --input decision.json --mission MISSION_UUID --dir ./my-events
open-teammates decision review DECISION_UUID --input owner-review.json --dir ./my-events
```

An acceptance input requires `status: "accepted"`, `owner` and substantive `evidence`. The MCP tool only records proposals; the owner reviews separately. An accepted planning decision is distinct from permission to send, spend or book.

For an actual outcome, provide a finite numeric value, explicit unit, source and observation time:

```json
{
  "metric": "attendees",
  "value": 160,
  "unit": "people",
  "source": "Owner-reviewed check-in export, report events-2027-03-18",
  "observedAt": "2027-03-18T18:00:00-07:00",
  "notes": "Fictional input example; use an actual source in your workspace."
}
```

```sh
open-teammates outcome add --input outcome.json --mission MISSION_UUID --dir ./my-events
```

The store records what the caller asserts; it does not independently verify the source. Capacity and targets belong in the plan. Counts and activation windows do not establish causal return on investment. Add denominators, sampling limits, overlapping campaigns and a useful next experiment to the outcome memo.

## Revise without erasing the previous plan

```sh
open-teammates revise MISSION_UUID --patch revised-brief.json --reason "Finance changed the cap" --expected-revision 1 --dir ./my-events
open-teammates redraft MISSION_UUID --dir ./my-events
open-teammates briefing --mission MISSION_UUID --dir ./my-events
```

Revisions retain earlier briefs and files, invalidate the old draft, block tasks for review, reopen accepted decisions and supersede mission handoffs. Earlier task evidence remains in history. Review each affected task's deadline, owner, scope and prerequisites before resuming it. Redrafting alone does not complete this review.

## Learn and hand off accurately

A host uses `teammate_remember` to propose a scoped preference or lesson. The owner can confirm or delete it through `memory` commands; only confirmed records enter live context. Preserve evidence and uncertainty in the text. Current memory is explicit, not automatic model training.

Prepare consequential actions as exact handoff payloads. The owner can approve a specific current request through the CLI, but this package records permission only. A permissioned host executor must perform any real action and retain its receipt. Do not call a drafted invitation sent or a venue proposal booked.

Close each cycle by showing the saved artifact, what changed, what was checked, remaining decisions, and the next action with its accepted owner. Advisory readiness describes recorded pre-event evidence. The accountable owner still verifies the real event's conditions and go/no-go.
