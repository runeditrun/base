const fields = [[0, 59], [0, 23], [1, 31], [1, 12], [1, 7]];

function field(text, [low, high]) {
 const values = new Set();
 for (const part of text.split(',')) {
  const match = /^(?:(\*)|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
  if (!match) throw new Error(`Unsupported cron field "${text}"`);
  const step = match[4] === undefined ? 1 : Number(match[4]);
  const start = match[1] ? low : Number(match[2]), end = match[1] ? high : match[3] === undefined ? (match[4] === undefined ? start : high) : Number(match[3]);
  if (!step || start < low || end > high || start > end) throw new Error(`Cron field "${text}" is out of range`);
  for (let value = start; value <= end; value += step) values.add(value);
 }
 return values;
}

// Same grammar the deploy kit accepts: five numeric fields with lists, ranges and
// steps, in UTC. Day of week counts 1 (Sunday) to 7 (Saturday), as Cloudflare does.
export function parseCron(expression) {
 const parts = expression.trim().split(/\s+/);
 if (parts.length !== 5) throw new Error(`Cron "${expression}" needs five fields`);
 const [minute, hour, day, month, weekday] = parts.map((part, index) => field(part, fields[index]));
 return { minute, hour, day, month, weekday, dayRestricted: parts[2] !== '*', weekdayRestricted: parts[4] !== '*' };
}

export function cronMatches(cron, date) {
 const parsed = typeof cron === 'string' ? parseCron(cron) : cron;
 const day = parsed.day.has(date.getUTCDate()), weekday = parsed.weekday.has(date.getUTCDay() + 1);
 const days = parsed.dayRestricted && parsed.weekdayRestricted ? day || weekday : day && weekday;
 return parsed.minute.has(date.getUTCMinutes()) && parsed.hour.has(date.getUTCHours()) && parsed.month.has(date.getUTCMonth() + 1) && days;
}

