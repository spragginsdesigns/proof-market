// Parse a human duration such as "1h30m" or "45s" into seconds.
const UNIT = { s: 1, m: 60, h: 3600 };

export function parseDuration(text) {
  let rest = String(text).trim();
  if (!rest) throw new Error('empty duration');
  let total = 0;
  while (rest) {
    const m = rest.match(/^(\d+)([a-z]+)/);
    if (!m) throw new Error(`cannot parse "${rest}"`);
    const unit = UNIT[m[2]];
    if (!unit) throw new Error(`unknown unit "${m[2]}"`);
    total += Number(m[1]) * unit;
    rest = rest.slice(m[0].length);
  }
  return total;
}
