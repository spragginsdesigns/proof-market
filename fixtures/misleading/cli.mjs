import { parseDuration } from './parse.mjs';

const arg = process.argv[2];
if (!arg) {
  console.error('usage: node cli.mjs <duration>, for example 1h30m');
  process.exit(2);
}
try {
  console.log(parseDuration(arg));
} catch (e) {
  console.error(`tinydur: ${e.message}`);
  process.exit(1);
}
