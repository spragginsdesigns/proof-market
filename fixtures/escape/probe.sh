#!/usr/bin/env bash
# Sandbox-escape probe. A hostile repo tries every way to read the host's secrets, filesystem,
# environment and services. In a correct sandbox EVERY line prints BLOCKED. The worker agent reads
# this output; the point of the fixture is that it finds nothing from the host.
#
# The host IP to refuse is passed in as HOST_GW (default: the common Docker bridge gateway), so the
# fixture names no specific machine.
set +e
say() { printf '%s: %s\n' "$1" "$2"; }
GW="${HOST_GW:-172.17.0.1}"

# 1. NEAR credentials (where a dev keychain lives), and root's
for p in "$HOME/.near-credentials" /root/.near-credentials; do
  if [ -r "$p" ] && [ -n "$(ls -A "$p" 2>/dev/null)" ]; then say "READ $p" "EXPOSED: $(ls -A "$p" | head -1)"; else say "READ $p" "BLOCKED"; fi
done

# 2. The host /home tree (the container's own base-image users runner and ubuntu are not the host)
hits=$(ls /home 2>/dev/null | grep -vE '^(runner|ubuntu)$' | head -3 | tr '\n' ' ')
if [ -n "$hits" ]; then say "LIST /home" "EXPOSED: $hits"; else say "LIST /home" "BLOCKED (only the container's own users)"; fi

# 3. Common host secrets: shadow, SSH keys, and any mounted dotenv
for p in /etc/shadow /root/.ssh/id_rsa /root/.ssh/id_ed25519 "$HOME/.ssh/id_rsa"; do
  if [ -r "$p" ]; then say "READ $p" "EXPOSED"; else say "READ $p" "BLOCKED"; fi
done

# 4. The process environment handed to the job (must carry no host secrets)
leak=$(env | grep -iE 'API|KEY|TOKEN|SECRET|PASS|CREDENTIAL|NEAR_' | grep -vE '^(HTTP_PROXY|HTTPS_PROXY|http_proxy|https_proxy|NO_PROXY|no_proxy)=' | head -5)
if [ -n "$leak" ]; then say "ENV secrets" "EXPOSED: $(echo "$leak" | cut -d= -f1 | tr '\n' ' ')"; else say "ENV secrets" "BLOCKED"; fi

# 5. Reach the host or its services directly (docker gateway, cloud metadata)
for target in "$GW:6379" "$GW:22" "169.254.169.254:80"; do
  host=${target%:*}; port=${target#*:}
  if timeout 3 bash -c "exec 3<>/dev/tcp/$host/$port" 2>/dev/null; then say "CONNECT $target" "EXPOSED"; exec 3>&- 2>/dev/null; else say "CONNECT $target" "BLOCKED"; fi
done

# 6. Reach the internet directly, bypassing the egress proxy (no proxy env used here)
if timeout 5 bash -c 'exec 3<>/dev/tcp/1.1.1.1/443' 2>/dev/null; then say "CONNECT 1.1.1.1:443 (direct)" "EXPOSED"; exec 3>&- 2>/dev/null; else say "CONNECT 1.1.1.1:443 (direct)" "BLOCKED"; fi

# 7. Reach a non-allowlisted host THROUGH the proxy (should be refused by the allowlist)
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 -x "$HTTPS_PROXY" https://example.com/ 2>/dev/null)
if [ "$code" = "200" ]; then say "PROXY example.com" "EXPOSED (allowed)"; else say "PROXY example.com" "BLOCKED (proxy refused, http $code)"; fi

# 8. Whoami / capabilities
say "WHOAMI" "$(id -u):$(id -g) ($(id -un 2>/dev/null || echo '?'))"
say "ROOT-WRITABLE" "$(touch /probe_root 2>/dev/null && echo 'EXPOSED: / is writable' || echo 'BLOCKED (read-only root)')"
