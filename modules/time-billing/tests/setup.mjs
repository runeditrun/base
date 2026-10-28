export async function seedNative(db, installation, policies) {
  const statements = [];
  for (const id of ['worker', 'preparer', 'reviewer', 'finance', 'timeOnly', 'outsider']) statements.push(db.prepare('INSERT INTO native_people(installation,id) VALUES(?,?)').bind(installation, id));
  for (const id of ['project-1', 'project-2']) statements.push(db.prepare('INSERT INTO native_work(installation,id) VALUES(?,?)').bind(installation, id));
  const memberships = [
    ['worker', 'project-1', 1, 1, 0, 0, 'worker'],
    ['preparer', 'project-1', 1, 1, 0, 0, 'worker'],
    ['reviewer', 'project-1', 1, 0, 1, 1, null],
    ['finance', 'project-1', 1, 1, 1, 1, null],
    ['timeOnly', 'project-1', 1, 0, 0, 0, null],
    ['outsider', 'project-2', 1, 1, 1, 1, null],
  ];
  for (const row of memberships) statements.push(db.prepare('INSERT INTO native_memberships(installation,person_id,work_id,can_read,can_capture,can_review,can_finance,timekeeper_id) VALUES(?,?,?,?,?,?,?,?)').bind(installation, ...row));
  statements.push(db.prepare('INSERT INTO native_access_policy(installation,revision) VALUES(?,?)').bind(installation, 'access-1'));
  statements.push(db.prepare('INSERT INTO native_review_policy(installation,work_id,revision,enabled) VALUES(?,?,?,1)').bind(installation, 'project-1', 'review-1'));
  statements.push(db.prepare('INSERT INTO native_control(installation,current_time) VALUES(?,?)').bind(installation, '2026-10-28T10:00:00.000Z'));
  statements.push(db.prepare('INSERT INTO native_rates(installation,work_id,id,revision,minor_numerator,duration_denominator,currency,effective_at) VALUES(?,?,?,?,?,?,?,?)').bind(installation, 'project-1', 'service-rate', 'rate-1', '12500', '3600000', 'USD', '2026-10-01T00:00:00.000Z'));
  statements.push(db.prepare('INSERT INTO native_adjustments(installation,id,revision,amount_minor,currency,engine,calculation_revision) VALUES(?,?,?,?,?,?,?)').bind(installation, 'adjustment-1', '1', '-125', 'USD', 'native-cost-plus', 'cost-4'));
  for (const policy of policies) statements.push(db.prepare('INSERT INTO native_capture_policy(installation,id,revision,active) VALUES(?,?,?,1)').bind(installation, policy.id, policy.revision));
  await db.batch(statements);
  if (installation === 'source') {
    for (const actor of ['worker', 'preparer', 'reviewer', 'finance', 'timeOnly', 'outsider']) await db.prepare('INSERT INTO native_sessions(token,person_id) VALUES(?,?)').bind(`test-${actor}`, actor).run();
    await db.prepare('INSERT INTO native_sessions(token,person_id,agent_id,sponsor_id) VALUES(?,?,?,?)').bind('test-agent', 'preparer', 'agent-1', 'preparer').run();
  }
}

export async function state(db, installation) {
  const count = async (table, where = '') => Number((await db.prepare(`SELECT count(*) AS n FROM ${table} WHERE installation=? ${where}`).bind(installation).first()).n);
  const [commands, events, claims, outcomes, activeBills] = await Promise.all([
    count('tb_commands'), count('tb_events'), count('tb_claims'), count('native_outcomes'), count('native_bills', "AND state='approved'"),
  ]);
  return { commands, events, claims, outcomes, activeBills };
}
