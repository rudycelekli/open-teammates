import test from 'node:test';
import assert from 'node:assert/strict';
import { DEMO_BRIEF, createMission, buildDeliverables } from '../src/events.mjs';

const NOW = new Date('2026-10-07T14:00:00.000Z');

// A small RFC 4180 reader keeps these checks independent of the writer's implementation.
function parseCsv(source) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === '"') {
      if (quoted && source[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && char === ',') { row.push(cell); cell = ''; }
    else if (!quoted && char === '\r' && source[i + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; }
    else cell += char;
  }
  assert.equal(quoted, false, 'CSV has balanced quotation marks');
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

test('normalization records default assumptions and never assigns an id', () => {
  const mission = createMission({}, NOW);
  assert.equal(mission.date, '2027-03-18');
  assert.equal(mission.status, 'draft');
  assert.equal(mission.createdAt, NOW.toISOString());
  assert.equal(mission.budget, 180000);
  assert.ok(mission.assumptions.some(value => value.startsWith('budget: defaulted')));
  assert.equal(Object.hasOwn(mission, 'id'), false);
  mission.constraints.push('Test-only constraint');
  assert.equal(DEMO_BRIEF.constraints.includes('Test-only constraint'), false);
});

test('valid dates accept leap years while invalid dates reject rollover and ambiguous syntax', () => {
  assert.equal(createMission({ ...DEMO_BRIEF, date: '2028-02-29' }, NOW).date, '2028-02-29');
  for (const date of ['2027-02-29', '2027-02-30', '2027-04-31', '2027-13-01', '2027-00-10', '2027-01-00', '03/18/2027', '2027-3-18', 'invalid']) {
    assert.throws(() => createMission({ ...DEMO_BRIEF, date }, NOW), /real calendar date/);
  }
  assert.ok(createMission({ ...DEMO_BRIEF, date: '2025-01-01' }, NOW).assumptions.some(value => value.includes('past')));
});

test('timezone and budget validation reject ambiguous or impossible inputs', () => {
  for (const timezone of ['Not/A_Zone', '', '+01:00']) assert.throws(() => createMission({ ...DEMO_BRIEF, timezone }, NOW), /IANA/);
  for (const budget of [0, -1, 0.5, '180000', Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => createMission({ ...DEMO_BRIEF, budget }, NOW), /positive safe integer/);
  assert.throws(() => createMission({ ...DEMO_BRIEF, capacity: 0 }, NOW), /capacity/);
  assert.throws(() => createMission({ ...DEMO_BRIEF, constraints: 'none' }, NOW), /constraints/);
  assert.throws(() => createMission({ ...DEMO_BRIEF, format: 'festival' }, NOW), /format/);
  assert.throws(() => createMission({ ...DEMO_BRIEF, currency: '=1' }, NOW), /currency/);
  assert.equal(createMission({ ...DEMO_BRIEF, currency: 'usd' }, NOW).currency, 'USD');
});

test('budget reconciles exactly, includes contingency, and stays within the ceiling for every format', () => {
  for (const format of ['flagship', 'executive', 'regional', 'internal', 'webinar']) {
    for (const budget of [1, 7, 99, 101, 180003, Number.MAX_SAFE_INTEGER]) {
      const mission = createMission({ ...DEMO_BRIEF, format, budget }, NOW);
      const result = buildDeliverables(mission).find(value => value.name === 'budget.csv');
      const rows = parseCsv(result.content);
      const allocations = rows.slice(1, -1);
      assert.ok(allocations.some(row => row[0] === 'Contingency reserve'));
      assert.equal(allocations.reduce((sum, row) => sum + Number(row[1]), 0), budget);
      assert.equal(Number(rows.at(-1)[1]), budget);
      assert.ok(allocations.every(row => Number.isSafeInteger(Number(row[1])) && Number(row[1]) >= 0));
      assert.equal(buildDeliverables(mission).find(value => value.name === 'budget.csv').content, result.content);
    }
  }
});

test('run of show preserves CSV punctuation and neutralizes formula-bearing mission names', () => {
  for (const name of ['An event, with "quotes"\nand a second line', '=HYPERLINK("https://example.test","click")', ' \t+SUM(1,2)', '\uFEFF@command', '-1+1']) {
    const mission = createMission({ ...DEMO_BRIEF, name }, NOW);
    const rows = parseCsv(buildDeliverables(mission).find(value => value.name === 'production-run-of-show.csv').content);
    const expected = /^[\s\uFEFF]*[=+@-]/u.test(name.trim()) ? `'${name.trim()}` : name.trim();
    assert.equal(rows[1][0], expected);
    assert.equal(rows[1][4], mission.timezone);
    assert.ok(rows.every(row => row.length === rows[0].length));
  }
});

test('deliverables preserve proposal status and do not fabricate operational confirmations', () => {
  const mission = createMission(DEMO_BRIEF, NOW);
  const outputs = buildDeliverables(mission);
  assert.deepEqual(outputs.map(value => value.name), ['event-brief.md', 'portfolio-strategy.md', 'budget.csv', 'production-run-of-show.csv', 'risk-register.csv', 'stakeholder-plan.md', 'measurement-plan.md', 'follow-through.md']);
  const text = outputs.map(value => value.content).join('\n');
  assert.match(text, /no venue, speaker, supplier, pricing, or attendance is confirmed/i);
  assert.match(text, /No baseline, historic event data, audience research, or business attribution has been supplied/);
  assert.match(text, /They do not mean a person has accepted a task or an agency has been hired/);
  assert.match(text, /caption/i);
  assert.match(text, /town halls/i);
  assert.match(text, /film/i);
  assert.match(text, /T\+30/);
  assert.doesNotMatch(text, /(?:Venue|Supplier|Executive participation) confirmed\./i);
});

test('webinar program makes the one-hour public broadcast and later staff work explicit', () => {
  const mission = createMission({ ...DEMO_BRIEF, format: 'webinar' }, NOW);
  const outputs = buildDeliverables(mission);
  const rows = parseCsv(outputs.find(value => value.name === 'production-run-of-show.csv').content);
  const closing = rows.find(row => row[5].includes('public broadcast close'));
  assert.equal(closing[3], '11:00');
  assert.ok(rows.some(row => row[5].includes('staff work')));
});
