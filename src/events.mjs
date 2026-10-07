/** Pure, dependency-free planning primitives. These create proposals, not commitments. */
export const DEMO_BRIEF = Object.freeze({
  name: 'Builders Together',
  organization: 'Your organization',
  objective: 'Help developers understand the product, build one useful prototype, and form relationships that continue after the event.',
  audience: 'Developers, technical customer teams, partners, and community organizers',
  format: 'flagship',
  city: 'San Francisco',
  date: '2027-03-18',
  timezone: 'America/Los_Angeles',
  budget: 180000,
  currency: 'USD',
  capacity: 600,
  constraints: Object.freeze([
    'This is a fictional planning example; no venue, speaker, supplier, pricing, or attendance is confirmed.',
    'Provide step-free access, live captions, dietary choices, a quiet room, and a remote way to participate.',
    'Keep product demonstrations reproducible and prepare an offline fallback.',
  ]),
});

const FORMATS = new Set(['flagship', 'executive', 'regional', 'internal', 'webinar']);
const FIELDS = ['name', 'organization', 'objective', 'audience', 'format', 'city', 'date', 'timezone', 'budget', 'currency', 'capacity', 'constraints'];
const STRING_FIELDS = ['name', 'organization', 'objective', 'audience', 'city'];
const FORMAT_PROGRAMS = {
  flagship: { promise: 'Leave with a working prototype, a useful new relationship, and a clear next step.', opening: 'Product story and reproducible live demonstration', morning: 'Guided build labs and product office hours', afternoon: 'Community showcases and practical problem solving', followUp: 'A reusable lab kit, opt-in community introductions, and product office hours' },
  executive: { promise: 'Leave with a decision framework and an owner for a realistic next experiment.', opening: 'Executive context and evidence-led product briefing', morning: 'Moderated peer discussion and customer use-case review', afternoon: 'Small-group decision workshops and executive office hours', followUp: 'A concise decision memo and an opt-in working session for each participating account' },
  regional: { promise: 'Leave with a locally useful use case and a connection to the regional community.', opening: 'Localized product story and regional use-case demonstration', morning: 'Local-language build workshops and partner office hours', afternoon: 'Regional community showcases and feedback circles', followUp: 'Localized learning material and an opt-in regional community session' },
  internal: { promise: 'Leave understanding the company priorities, open questions, and next actions.', opening: 'Leadership context and company priorities', morning: 'Team updates, moderated employee questions, and demonstrations', afternoon: 'Cross-team working sessions and production review', followUp: 'An access-controlled recording, unanswered question log, and owner action list' },
  webinar: { promise: 'Leave understanding one useful workflow and how to try it independently.', opening: 'Host welcome, workflow demonstration, and accessibility orientation', morning: 'Live workflow walkthrough and moderated questions', afternoon: 'Recorded recap and optional product office hours', followUp: 'A captioned replay, reproducible workflow guide, and opt-in office hours' },
};

/** Normalize a brief, recording every omitted field as an assumption. Never assign an id. */
export function createMission(input = {}, now = new Date()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Mission input must be an object.');
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError('now must be a valid Date.');
  const values = {};
  const assumptions = [];
  for (const field of FIELDS) {
    const supplied = Object.hasOwn(input, field) && input[field] !== undefined;
    values[field] = supplied ? input[field] : DEMO_BRIEF[field];
    if (!supplied) assumptions.push(`${field}: defaulted to ${Array.isArray(values[field]) ? values[field].join(' | ') : String(values[field])}. Verify before using this plan.`);
  }
  for (const field of STRING_FIELDS) {
    if (typeof values[field] !== 'string' || !values[field].trim()) throw new TypeError(`${field} must be a non-empty string.`);
    values[field] = values[field].trim();
  }
  if (!FORMATS.has(values.format)) throw new TypeError('format must be flagship, executive, regional, internal, or webinar.');
  if (typeof values.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(values.date)) throw new TypeError('date must be a real calendar date in YYYY-MM-DD format.');
  const parsedDate = new Date(`${values.date}T12:00:00Z`);
  if (Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== values.date) throw new TypeError('date must be a real calendar date in YYYY-MM-DD format.');
  if (typeof values.timezone !== 'string' || !values.timezone.trim() || /^[+-]/.test(values.timezone.trim())) throw new TypeError('timezone must be a valid IANA timezone.');
  values.timezone = values.timezone.trim();
  try { new Intl.DateTimeFormat('en-US', { timeZone: values.timezone }).format(parsedDate); }
  catch { throw new TypeError('timezone must be a valid IANA timezone.'); }
  for (const field of ['budget', 'capacity']) {
    if (!Number.isSafeInteger(values[field]) || values[field] <= 0) throw new TypeError(`${field} must be a positive safe integer.`);
  }
  if (typeof values.currency !== 'string' || !/^[A-Za-z]{3}$/.test(values.currency)) throw new TypeError('currency must contain three letters, for example USD.');
  values.currency = values.currency.toUpperCase();
  if (!Array.isArray(values.constraints) || values.constraints.some(value => typeof value !== 'string' || !value.trim())) throw new TypeError('constraints must be an array of non-empty strings.');
  values.constraints = values.constraints.map(value => value.trim());
  if (input.assumptions !== undefined) {
    if (!Array.isArray(input.assumptions) || input.assumptions.some(value => typeof value !== 'string' || !value.trim())) throw new TypeError('assumptions must be an array of non-empty strings.');
    assumptions.push(...input.assumptions.map(value => value.trim()));
  }
  const todayParts = new Intl.DateTimeFormat('en', { timeZone: values.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const today = ['year', 'month', 'day'].map(type => todayParts.find(part => part.type === type).value).join('-');
  if (values.date < today) {
    assumptions.push('The event date is in the past: treat this as a retrospective or confirm a new date before execution.');
  }
  assumptions.push('Budget lines, staffing, timings, success thresholds, and program choices are planning proposals; current supplier quotes, stakeholder approval, and local requirements have not been verified.');
  return { ...values, assumptions: [...new Set(assumptions)], status: 'draft', createdAt: now.toISOString() };
}

// Use integer weights and largest remainders so the spending ceiling is exact even for small budgets.
function allocateBudget(total, format) {
  const weights = format === 'webinar'
    ? [2, 29, 2, 19, 7, 9, 2, 10, 6, 6, 8]
    : format === 'internal'
      ? [13, 24, 14, 10, 6, 5, 5, 7, 2, 6, 8]
      : [20, 19, 14, 10, 5, 4, 6, 8, 3, 3, 8];
  const rows = [
    ['Venue and infrastructure', 'Events operations lead', 'Space, utilities, network, permits; verify quote and suitability'],
    ['Production and technical crew', 'Executive producer', 'Stage or studio, AV, streaming, rehearsal, backup playback'],
    ['Hospitality and catering', 'Attendee experience lead', 'Dietary choices, hydration, transport information, welcome'],
    ['Program and content', 'Program lead', 'Speaker preparation, build labs, editorial development, rights'],
    ['Accessibility and inclusion', 'Attendee experience lead', 'Captions, accessible pathways, quiet space, interpretation needs'],
    ['Registration and event technology', 'Operations lead', 'Registration, consent, check-in, support, attendee data controls'],
    ['Team travel and regional support', 'Regional lead', 'Staff travel and local adaptation; avoid uncosted assumptions'],
    ['Agency and operational staffing', 'Agency account lead', 'Named staffing plan, scope of work, milestones, escalation'],
    ['Audience communications', 'Audience lead', 'Audience-specific invitations and useful pre-event preparation'],
    ['Follow-through and measurement', 'Revenue / developer programs lead', 'Opt-in next steps, useful learning assets, analysis'],
    ['Contingency reserve', 'Budget owner + Finance', 'Held centrally; release requires documented decision'],
  ].map(([category, owner, scope], index) => {
    // Division first avoids multiplying a near-MAX_SAFE_INTEGER total by a percentage.
    const whole = Math.floor(total / 100) * weights[index];
    const numerator = (total % 100) * weights[index];
    return { category, owner, scope, amount: whole + Math.floor(numerator / 100), remainder: numerator % 100, index };
  });
  let remaining = total - rows.reduce((sum, row) => sum + row.amount, 0);
  const order = [...rows].sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (let index = 0; index < remaining; index++) order[index].amount++;
  return rows;
}

// Quote every CSV cell and neutralize spreadsheet formulas, including whitespace-prefixed formulas.
function csvCell(value) {
  let string = String(value ?? '');
  if (/^[\s\uFEFF]*[=+@-]/u.test(string)) string = `'${string}`;
  return `"${string.replaceAll('"', '""')}"`;
}
function csv(headers, rows) { return `${[headers, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n')}\r\n`; }
function md(value) { return String(value).replace(/[\\`*_{}\[\]<>#|]/g, '\\$&').replace(/\r?\n/g, ' '); }
function money(mission, amount) { return `${mission.currency} ${amount.toLocaleString('en-US')}`; }
function document(mission, title, body) {
  return `# ${title}\n\n**${md(mission.name)} · ${md(mission.organization)}**\n\nStatus: draft planning proposal. Event date: ${mission.date}. All local times use ${mission.timezone}. Generated: ${mission.createdAt}.\n\n${body.trim()}\n`;
}
function artifact(name, title, content) { return { name, title, content }; }

/** Return eight actionable artifacts. No tool calls, file writes, bookings, or fabricated confirmations. */
export function buildDeliverables(mission) {
  if (!mission || typeof mission !== 'object' || typeof mission.createdAt !== 'string' || Number.isNaN(Date.parse(mission.createdAt))) throw new TypeError('Pass a normalized mission with a valid createdAt.');
  const checked = createMission(mission, new Date(mission.createdAt));
  const m = { ...checked, assumptions: [...new Set([...(mission.assumptions ?? []), ...checked.assumptions])] };
  const program = FORMAT_PROGRAMS[m.format];
  const budgetRows = allocateBudget(m.budget, m.format);
  const reserve = budgetRows.at(-1).amount;
  const coreBudget = m.budget - reserve;
  const perAttendee = Math.floor(m.budget / m.capacity);
  const assumptions = m.assumptions.map(value => `- ${md(value)}`).join('\n');
  const constraints = m.constraints.length ? m.constraints.map(value => `- ${md(value)}`).join('\n') : '- No additional constraints supplied; collect accessibility, security, production, and audience needs.';
  const isWebinar = m.format === 'webinar';
  const liveLocation = isWebinar ? `Remote participation; studio location proposed in ${md(m.city)}` : `${md(m.city)}; venue shortlist and accessibility inspection required`;

  const brief = document(m, 'Executive event brief', `
## The decision and the attendee promise

Approve a discovery phase for a ${m.format} experience with a maximum envelope of ${money(m, m.budget)} and a planning capacity of ${m.capacity} participants. ${md(m.objective)}

Attendee promise: ${program.promise} This is a proposed direction, not evidence of audience demand. Audience: ${md(m.audience)}. Delivery: ${liveLocation}.

## Creative direction and program

Use a clear story: understand → try → exchange → continue. Put a useful task before spectacle. Each session must have an audience purpose, a named editorial owner, a rehearsable output, and an accessible participation method.

- Opening: ${program.opening}.
- Core experience: ${program.morning}.
- Second act: ${program.afternoon}.
- Beyond the room: ${program.followUp}.

Treat the run of show as a starting template. For a webinar, the public broadcast is 10:00–11:00 local; later activities are optional staff and participant sessions. For other formats, use a one-day template and resize after agenda and travel needs are validated.

## Investment and tradeoffs

The envelope provides about ${money(m, perAttendee)} per planned participant, rounded down. This is an allocation, not a cost estimate. Core planned spend is ${money(m, coreBudget)} with ${money(m, reserve)} held as contingency. Get current quotes and reconcile tax, fees, currencies, and cancellation exposure before commitments. A zero-valued line or a quote exceeding its allocation is a feasibility warning, not permission to omit necessary work.

Protect accessibility, attendee support, rehearsal, and follow-through. If costs exceed the envelope, reduce stage complexity, paid scenic elements, session count, or scale before cutting those foundations. Do not treat a low allocated unit cost as proof that the event is viable.

## Leadership and decision rights

An executive sponsor owns the business decision. Mira proposes portfolio and experience direction. A human events lead owns delivery; an executive producer owns technical production and show-stop authority. Finance validates the envelope; Procurement validates scopes and supplier onboarding; Legal and Security determine applicable review. Agencies receive written scope, named crew, rehearsal dates, acceptance criteria, and escalation paths. Owners below are role placeholders until actual people accept them.

## Milestones and gates

| Gate | Planned timing | Evidence required | Decision owner |
| --- | --- | --- | --- |
| Discovery | T−90 days | Audience interviews, objective, options, feasibility | Executive sponsor |
| Direction | T−75 days | Experience concept, portfolio fit, budget alternatives | Events lead + sponsor |
| Commit | T−60 days | Approved budget, quotes, accessible venue or studio, supplier terms | Budget owner + Procurement |
| Content lock | T−21 days | Session owners, rights, speaker consent, demo fallback | Program lead + Communications |
| Readiness | T−7 days | Crew, risk review, rehearsals, support routes, production acceptance | Executive producer |
| Go / no-go | T−1 day | Resolved critical risks, tested playback and access, emergency owner | Human events lead |
| Learn | T+30 days | Costs, audience outcomes, limitations, next decision | Events lead + measurement owner |

These are lead-time proposals. If time is compressed, reduce scope and agree revised gates; never label a skipped gate complete.

## Constraints

${constraints}

## Assumptions and open questions

${assumptions}

Resolve the three decisions that change the plan most: what participants should be able to do afterward; which audience is primary; and who can commit the budget. Then confirm date suitability, supplier availability, executive participation, staffing, accessibility requests, data handling, and local requirements.
`);

  const portfolio = document(m, 'Portfolio strategy', `
## Invest in a portfolio with a reason to exist

The current mission is the ${m.format} entry in a proposed portfolio. No annual portfolio size or budget has been supplied. This document proposes a decision system; it does not invent spend history, past attendance, attribution, or regional demand.

| Program | Audience value | Business / community value | Production and adaptation |
| --- | --- | --- | --- |
| Flagship conference | Learn, build, find collaborators | Product understanding, adoption, community growth | Signature story, reproducible labs, captions, tested demos |
| Product launch experience | Understand the new capability and its limits | Informed product trial and credible communication | Product + Research fact checks; offline fallback; release dependencies |
| Developer gatherings | Solve a real problem with peers | Useful prototypes and durable developer relationships | Local organizers; relevant examples; low-friction follow-up |
| Executive programs | Compare practical decisions with trusted peers | Customer relationships and agreed next experiments | Small rooms; clear consent; confidential discussion rules |
| Regional experiences | Participate in culturally and linguistically useful ways | Regional community and partner participation | Local lead has adaptation authority within brand and safety constraints |
| Industry / cultural presence | Discover a relevant idea in a relevant setting | Qualified relationships and product relevance | Participate only when audience fit exceeds standalone opportunity cost |
| Internal town halls | Understand priorities and ask useful questions | Alignment and accountable leadership follow-up | In-house producer; remote parity; access-controlled archive |
| Webinar studio | Learn one workflow and ask questions | Repeatable education, adoption, and useful next steps | In-house host, streaming engineer, captions, replay quality |
| Film and recorded projects | Revisit a clear, credible product or community story | Durable educational and brand assets | In-house editorial owner; contributor consent; rights; accessible delivery |

## Choose, scale, or stop

Score proposals from 1–5 for audience need (30%), product / community / business outcome fit (25%), distinctive experience (15%), deliverability (15%), and learning or reusable content (15%). Record evidence and uncertainty next to each score. Unknown is unknown; do not supply a convenient midpoint as evidence. Compare the opportunity cost against a smaller gathering, useful digital content, or another audience investment.

Fund discovery when a relevant audience problem is plausible but evidence is weak. Fund delivery when an owner, budget, viable format, and measurement plan exist. Stop or resize when expected usefulness, capacity to deliver, or feasibility no longer justifies the investment. Executive participation should serve the audience and have a prepared purpose, not fill an empty slot.

## Regional authority and shared foundations

Keep the attendee promise, product truth, accessible participation, quality gates, and measurement definitions consistent. Let the regional lead adapt language, calendar, cultural norms, hospitality, local speaker mix, travel assumptions, venue rules, and relevant use cases. Verify local requirements with the relevant people; this template is not a legal or security review.

Give each regional lead a budget envelope, approval route, escalation contact, and reusable production kit. Hold a listening review before applying the flagship format elsewhere. Translation alone is not adaptation.

## Team and agency operating rhythm

Weekly portfolio decisions: outcomes, tradeoffs, blockers, and capacity. Weekly delivery review per active event: scope, spend forecast, owner commitments, readiness, and changes. A single executive producer controls production cues. Develop regional and production leaders with delegated decisions and feedback. Agencies own contracted execution; the organization retains the attendee experience, decision record, and reusable files.

## Learning loop

At T+7, review experience, accessibility, and production issues. At T+30, compare outcomes and full costs with the approved brief, including non-attendees and digital participation where measurable. Record what to repeat, change, and stop with evidence and a responsible owner. Revisit the portfolio quarterly; no metric by itself earns an event a permanent place.
`);

  const budget = csv(['Category', 'Allocated amount (major units)', 'Currency', 'Accountable owner (unassigned role)', 'Basis', 'Status'], [
    ...budgetRows.map(row => [row.category, row.amount, m.currency, row.owner, row.scope, 'Proposed allocation; quote / approval required']),
    ['TOTAL', m.budget, m.currency, 'Budget owner', 'Includes contingency; integer allocations reconcile to the ceiling', 'Draft'],
  ]);

  const runRows = [
    ['07:30', '08:00', 'Crew call / studio setup', 'Executive producer', 'Operations and technical leads', 'Crew attendance, access, comms, emergency routes', 'Hold public doors or broadcast if critical systems fail'],
    ['08:00', '08:45', 'Technical and accessibility rehearsal', 'Technical director', 'Audio, video, streaming, captioning, accessibility leads', 'Playback, demos, captions, remote audio, comms and backup tested', 'Switch to verified backup or remove unsupported segment'],
    ['08:45', '09:00', 'Show readiness decision', 'Human events lead', 'Executive producer and Security lead', 'Unresolved risks and show-stop authority reviewed', 'Human owner calls hold / no-go'],
    ['09:00', '09:45', isWebinar ? 'Host / speaker sound check and audience support setup' : 'Doors and welcome', 'Attendee experience lead', 'Registration, hospitality, accessibility support', 'Step-free access or remote access verified; support visible', 'Staffed help route and alternative participation'],
    ['09:45', '10:00', 'Host and producer briefing', 'Executive producer', 'Host, stage manager, session owners', 'Pronunciation, timing, cues, questions and consent checked', 'Use approved briefing and prerecorded fallback'],
    ['10:00', '10:15', 'Welcome and orientation', 'Host', 'Stage manager or broadcast producer', 'Purpose, captions, participation, support and recording notice', 'Simple host-led opening if media fails'],
    ['10:15', isWebinar ? '10:45' : '11:00', program.opening, 'Program lead', 'Speaker, demo operator, technical director', 'Product claims checked; reproducible demo and backup', 'Preverified recording or guided explanation'],
    [isWebinar ? '10:45' : '11:00', isWebinar ? '11:00' : '11:15', isWebinar ? 'Moderated questions and public broadcast close' : 'Break and transition', isWebinar ? 'Host' : 'Attendee experience lead', 'Moderator and support crew', 'Time, captions, accessible transition and unresolved questions', 'Publish owned unanswered question list'],
    ['11:15', '12:30', isWebinar ? 'Optional office hours; public broadcast has ended' : program.morning, 'Developer / audience lead', 'Facilitators, moderators, technical support', 'Audience-specific useful task; remote participation method', 'Offline lab kit or guided small-group discussion'],
    ['12:30', '13:30', isWebinar ? 'Staff break and replay quality review' : 'Lunch and hosted connections', 'Attendee experience lead', 'Hospitality and community hosts', 'Dietary provision, seating choices, quiet space, consent', 'Provide accessible alternatives; do not force networking'],
    ['13:30', '15:00', isWebinar ? 'Recording edit and content handoff (staff work)' : program.afternoon, 'Program lead', 'Session owners and producer', 'Actionable output and owner for unanswered questions', 'Resize session if staffing or quality cannot support it'],
    ['15:00', '15:20', isWebinar ? 'Internal production retrospective' : 'Closing and useful next steps', 'Events lead', 'Host and follow-through owner', 'Clear opt-in next step; no unsupported outcome claims', 'Plain-language recap and staffed help route'],
    ['15:20', '16:00', 'Crew debrief / controlled strike', 'Executive producer', 'Technical crew and operations', 'Equipment return, incident log, participant support, access controls', 'Preserve safety staffing until public areas clear'],
  ];
  const runOfShow = csv(['Event', 'Date', 'Start local', 'End local', 'IANA timezone', 'Segment', 'Accountable owner (unassigned role)', 'Crew / support', 'Acceptance check', 'Fallback / hold'], runRows.map(row => [m.name, m.date, row[0], row[1], m.timezone, ...row.slice(2)]));

  const risks = [
    ['R01', 'Audience need or demand unvalidated', 'High', 'Medium', 'Audience lead', 'Interviews and audience-specific invitation response at T−75', 'Validate useful task and compare smaller formats', 'Resize scope before commitments', 'Open; evidence required'],
    ['R02', 'Quotes, fees, or cancellation exposure exceed envelope', 'High', 'Medium', 'Budget owner + Finance', 'Reforecast at every scope change; signed exposure reconciles', 'Get itemized quotes and reserve centrally', 'Cut scenic complexity or scale; request explicit budget decision', 'Open; quote required'],
    ['R03', 'Accessibility barriers prevent participation', 'High', 'Medium', 'Attendee experience lead', 'Access review plus confidential needs route by T−21', 'Verify routes, captions, assistive needs, quiet space and remote parity', 'Accessible alternative; hold inaccessible activity', 'Open; accessibility review required'],
    ['R04', 'Demo, connectivity, playback, or broadcast failure', 'High', 'Medium', 'Technical director', 'Full rehearsal and backup test at T−7 / T−1', 'Reproducible demo, local recording, redundant connection where viable', 'Verified playback or host-led fallback; producer may hold', 'Open; rehearsal required'],
    ['R05', 'Safety, crowd, weather, or medical incident', 'High', 'Unassessed', 'Security lead + events lead', 'Site / remote incident review before readiness gate', 'Qualified local assessment, clear exits and named response lead', 'Human lead invokes response plan or stops show', 'Open; local assessment required'],
    ['R06', 'Speaker, content, or release dependency changes', 'Medium', 'Medium', 'Program lead + Communications', 'Content lock and release decision by T−21', 'Backup moderator, approved claims, rights and contributor consent', 'Swap approved segment; explain changes honestly', 'Open; content approval required'],
    ['R07', 'Agency scope gaps or crew overload', 'High', 'Medium', 'Executive producer + agency lead', 'Staffing and scope reviewed at T−60 and each change', 'Named crew, breaks, shared cues, acceptance criteria', 'Reduce concurrent sessions; assign explicit human coverage', 'Open; crew assignment required'],
    ['R08', 'Attendee data misuse or recording consent confusion', 'High', 'Unassessed', 'Data owner + Legal', 'Registration and recording review before launch', 'Minimum collection, clear notices, opt-in routing, retention decision', 'Suspend unsupported collection / publication and escalate', 'Open; data review required'],
    ['R09', 'Regional mismatch or insufficient local support', 'Medium', 'Unassessed', 'Regional lead', 'Local listening and calendar / language review', 'Local authority for cultural and logistical adaptation', 'Localize, reduce scope, or select a better date', 'Open; local review required'],
    ['R10', 'No useful follow-through or inflated attribution', 'High', 'Medium', 'Measurement owner + Revenue / developer lead', 'Follow-through owner and baseline defined before invitations', 'Opt-in learning assets, denominators, cohort tracking and limitations', 'Publish honest outcome gaps and revise next investment', 'Open; measurement setup required'],
  ];
  const riskRegister = csv(['ID', 'Risk', 'Impact (planning judgment)', 'Likelihood (unverified)', 'Accountable owner (unassigned role)', 'Trigger / review gate', 'Mitigation', 'Contingency / decision', 'Status'], risks);

  const stakeholders = document(m, 'Stakeholder and production accountability plan', `
## Assign real people before execution

Role names below are accountability placeholders. They do not mean a person has accepted a task or an agency has been hired. One accountable human owns each decision; contributors provide input without creating ambiguous shared responsibility.

| Work / decision | Accountable role | Required partners | Acceptance evidence |
| --- | --- | --- | --- |
| Portfolio priority and executive participation | Executive sponsor | Mira, leadership, audience lead | Objective, opportunity cost, prepared executive purpose |
| Event direction and delivery scope | Human events lead | Brand, Creative, Product, Research, Communications | Approved brief, tradeoffs, named owners |
| Product story and demonstrations | Program lead | Product + Research + Communications | Accurate claims, working task, rehearsed fallback |
| Spend envelope and contingency release | Budget owner | Finance | Forecast, committed exposure, reserve decision |
| Agencies, vendors, and contracting | Procurement owner | Events, Finance, Legal | Scope, rates, cancellation terms, approval evidence |
| Attendee experience and accessibility | Attendee experience lead | Local accessibility expertise, community, operations | Accessible journeys, support route, remote parity |
| Show and studio production | Executive producer | Technical director, stage manager, crew, agency | Crew roster, cues, breaks, rehearsal, show-stop authority |
| Site and incident readiness | Security lead | Events, venue, qualified local partners | Applicable assessment and response owner |
| Regional adaptation | Regional lead | Local community and partner teams | Relevant format, language, calendar, hospitality |
| Developer and customer participation | Audience lead | Developer relations, Revenue Marketing, Field Marketing | Segmented audience goals and useful next steps |
| Outcome measurement and learning | Measurement owner | Data owner, Revenue / developer programs | Baseline, consent, metric definitions, limitations |
| Town halls, webinars, and film assets | In-house production lead | Editorial, IT, accessibility, Legal | Access controls, contributor consent, captions, archive owner |

## Working rhythm and escalation

Hold a weekly decision review with a short decision log: issue, options, recommendation, owner, date, evidence, and reopening trigger. Review forecast and change requests against the approved scope. Give agencies one production contact and written acceptance criteria; request editable source files and agreed handover rights.

At T−7, move to a readiness review. At show time, only the executive producer calls cues; the human events lead and relevant safety lead can stop the show. Do not promise availability, credentials, authority, or completed review without evidence. An unresolved critical dependency becomes a visible hold, with a smaller viable option when one exists.
`);

  const measurement = document(m, 'Outcome measurement plan', `
## Establish evidence before declaring success

No baseline, historic event data, audience research, or business attribution has been supplied. The targets below are suggested decision thresholds and require the sponsor and measurement owner to accept or replace them before invitations. Do not report them as achieved.

| Outcome | Proposed threshold / decision rule | Measurement and denominator | Owner |
| --- | --- | --- | --- |
| Product understanding | 70% of responding attendees can identify one useful workflow and one limit | Same short pre / post questions; disclose respondent counts and selection bias | Product education lead |
| Developer usefulness | 60% of lab participants complete the guided task | Opt-in task completion divided by lab participants with measured status | Developer programs lead |
| Product adoption | Establish baseline first; compare opt-in participating cohort at T+30 | Activation definition agreed with Product; no invented uplift or causal attribution | Product analytics owner |
| Executive / customer value | Every opted-in participating account has a relevant next action and owner | Documented useful next step, not automatic sales qualification | Revenue / Field Marketing lead |
| Community continuation | 30% of opted-in participants use a useful follow-up asset by T+30 | Defined action divided by opt-in cohort; distinguish people from clicks | Community lead |
| Attendee experience | Review every reported access barrier and high-severity issue within 2 working days | Anonymous feedback plus confidential support route; disclose sample and unresolved items | Attendee experience lead |
| Production reliability | Every critical cue rehearsed; every incident logged with impact | Rehearsal checklist and actual incident record | Executive producer |
| Investment | Actual all-in cost within approved envelope; explain variance by category | Ledger + committed exposure + forecast + reserve, reconciled with Finance | Budget owner |

## Audience-specific goals

Developers need a useful working task and support beyond the room. Executive attendees need clear options and an owned next experiment. Customer and partner teams need relevant introductions and consent-based working sessions. Internal audiences need clarity and answered questions. Digital participants need useful material and a chance to participate, not only a view count.

Segment measurement only where consent, sample size, and context support it. Track live, digital, and hybrid participation separately with clear denominators. Never imply that an invitation, registration, view, conversation, or satisfaction score equals adoption or revenue.

## Collection and review

Before invitations: establish baseline, data owner, minimal fields, consent, retention, access, and agreed targets. During: record participation and incidents with the least data needed. T+2: review access and experience issues. T+7: deliver production and experience review. T+30: review adoption, relationships, community continuation, cost, and limitations. Use a comparison group only where feasible and appropriate; otherwise describe associations and alternative explanations.

## AI use with an owner

Use AI to cluster feedback, draft accessible summaries, compare scope options, and identify unanswered questions. Remove unnecessary personal or confidential data first. A responsible human verifies conclusions, checks language and sampling bias, and records what evidence changed the next event. AI-generated themes are leads to investigate, not source evidence.
`);

  const followThrough = document(m, 'Follow-through and learning plan', `
## Make the experience continue usefully

At registration, offer clear choices for learning material, community contact, and account follow-up. Collect only what the declared purpose needs. Participation does not imply permission for marketing, introductions, recording publication, or sharing attendee lists.

| Timing | Useful output | Accountable owner | Completion evidence |
| --- | --- | --- | --- |
| Before invitations | Opt-in routes, audience segments, support contact, and baseline | Audience + data owner | Approved wording and responsible owners |
| T−7 | ${program.followUp} prepared in draft | Program + developer / revenue lead | Tested files, captions, rights, correct access |
| T+1 working day | Thank-you draft, useful resources, help route, next-step choices | Audience lead | Reviewed draft; send only within permission and owner policy |
| T+2 working days | Answer log, access issue follow-up, incident actions | Attendee experience + program lead | Owned response or honest unresolved status |
| T+7 | Captioned replay or access-controlled archive; reusable lab / decision kit | In-house production + editorial lead | Quality, contributor consent, product accuracy, access verified |
| T+14 | Optional office hours, regional continuation, customer working sessions | Developer programs + regional + revenue lead | Actual opt-in participation and relevant owned next actions |
| T+30 | Outcome review, cost reconciliation, and portfolio recommendation | Measurement owner + events lead | Counts, denominators, limitations, and decision log |

## Preserve useful memory

Store verified preferences, accepted decisions, reusable production notes, actual costs, incidents, and learning with source, date, owner, confidence, and next-review trigger. Separate observation from hypothesis. Avoid sensitive attendee details unless explicitly needed and authorized. Offer correction and deletion; stale memory loses authority.

Mira can propose drafts, prioritize questions, prepare reviewable plans, and track explicit dependencies. Messaging people, publishing recordings, committing budget, hiring vendors, and executing production require the appropriate human or runtime authorization. A saved plan is not proof of execution.

## Decide what happens next

Write a one-page review: attendee promise; observed usefulness; who was missing; what failed; all-in cost; what evidence supports the conclusion; what remains unknown; and what to repeat, change, or stop. Assign each change an owner and date. Regional teams and in-house production receive the reusable kit and a chance to challenge the conclusions. No unverified success story enters memory as fact.
`);

  return [
    artifact('event-brief.md', 'Executive event brief', brief),
    artifact('portfolio-strategy.md', 'Portfolio strategy', portfolio),
    artifact('budget.csv', 'Budget and contingency allocation', budget),
    artifact('production-run-of-show.csv', 'Production run of show', runOfShow),
    artifact('risk-register.csv', 'Risk register', riskRegister),
    artifact('stakeholder-plan.md', 'Stakeholder and production accountability', stakeholders),
    artifact('measurement-plan.md', 'Outcome measurement plan', measurement),
    artifact('follow-through.md', 'Follow-through and learning plan', followThrough),
  ];
}
