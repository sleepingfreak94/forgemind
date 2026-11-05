#!/bin/sh
# Run a .cmd on the Windows VM in a real terminal (ForgeMind needs a TTY) and capture the output on the Mac.
# Usage: vm-run.sh 'C:\Users\forgemind\<script>.cmd' <capture file> [max seconds, default 1700]
set -u
[ $# -ge 2 ] || { echo "usage: vm-run.sh <vm .cmd path> <capture file> [max seconds]" >&2; exit 2; }
script=$1 capture=$2 max=${3:-1700}
name=${script#C:\\Users\\forgemind\\}
# Only a plain file name directly under C:\Users\forgemind: cmd.exe runs this string.
case $name in "$script"|''|*[!A-Za-z0-9._-]*|*..*) printf '%s\n' "script must be C:\\Users\\forgemind\\<name>.cmd" >&2; exit 2;; esac
case $name in *.cmd) ;; *) echo "script must be a .cmd" >&2; exit 2;; esac
case $max in ''|*[!0-9]*) echo "max seconds must be a number" >&2; exit 2;; esac
rm -f "$capture" "$capture.sleep"
# Windows closes the pseudo-terminal at stdin EOF, so keep stdin open with a sleep that is stopped once the run exits.
( sleep "$max" & echo $! > "$capture.sleep"; wait 2>/dev/null ) | ssh -tt forgevm "$script & exit" > "$capture" 2>&1 &
ssh_pid=$!
waited=0
while [ "$waited" -lt "$max" ]; do
  if grep -q "EXIT=" "$capture" 2>/dev/null; then sleep 2; break; fi
  kill -0 "$ssh_pid" 2>/dev/null || break   # ssh ended without EXIT=: don't idle-wait
  sleep 10; waited=$((waited + 10))
done
[ -s "$capture.sleep" ] && kill "$(cat "$capture.sleep")" 2>/dev/null
rm -f "$capture.sleep"
wait 2>/dev/null
perl -pe 's/\e\[[0-9;?]*[A-Za-z]|\e\][^\a]*\a//g; s/\r//g' "$capture" | grep -v '^\s*at \|^\s*$'
grep -q "EXIT=" "$capture" || { echo "no EXIT= line (ssh ended or ${max}s passed)" >&2; exit 1; }
