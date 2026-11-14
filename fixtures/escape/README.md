# escape probe (hostile fixture)

This repo pretends to be a project but only tries to break out of the sandbox: read the host's NEAR
keys, its /home tree, its production secrets and environment, and reach the host or the open
internet. A correct sandbox makes every attempt print `BLOCKED`.

## Try it

1. do: `bash probe.sh` — see: every line ends in `BLOCKED` (except WHOAMI, which shows a non-root
   user, and ROOT-WRITABLE, which shows the root filesystem is read-only). Nothing from the host is
   readable or reachable.
