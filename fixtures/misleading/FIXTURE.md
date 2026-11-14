# What this directory is

A Proof Market test fixture: a small project that looks finished and has one false line in its
README.

`README.md` says the parser handles days and that `node cli.mjs 2d` prints `172800`. It does not:
`parse.mjs` knows only `s`, `m` and `h`, so that command prints `tinydur: unknown unit "d"` and
exits 1. Steps 1 and 3 of the README are true, and the tests pass because none of them covers days.

The README is left as a real misleading README would read, with no hint in it. Proof Market's
dispute jobs post its three "Try it" steps; the settled result is Pass, Fail, Pass.

Check it yourself, Node only:

```bash
node cli.mjs 1h30m     # 5400
node cli.mjs 2d        # tinydur: unknown unit "d", exit code 1
node --test            # pass 5, fail 0
```
