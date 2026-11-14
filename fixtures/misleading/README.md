# tinydur

Parse a human duration (`1h30m`, `45s`, `2d`) into seconds. No dependencies, one small file.

## Use it

```js
import { parseDuration } from './parse.mjs';

parseDuration('1h30m'); // 5400
```

Units: `s` seconds, `m` minutes, `h` hours, `d` days. Parts can be combined in any order.

## Try it

1. do: `node cli.mjs 1h30m` — see: the output is `5400`.
2. do: `node cli.mjs 2d` — see: the output is `172800`.
3. do: `node --test` — see: the summary shows `# pass 5` and `# fail 0`.

## License

MIT
