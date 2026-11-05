#!/bin/sh
# Run a .cmd on the Windows VM in a real terminal (ForgeMind needs a TTY) and capture the output on the Mac.
# Usage: vm-run.sh 'C:\Users\forgemind\<script>.cmd' <capture file> [max seconds, default 1700]
set -u
[ $# -ge 2 ] || { echo "usage: vm-run.sh <vm .cmd path> <capture file> [max seconds]" >&2; exit 2; }
script=$1 capture=$2 max=${3:-1700}
case $script in C:\\Users\\forgemind\\*.cmd) ;; *) echo "script must be a .cmd under C:\\Users\\forgemind" >&2; exit 2;; esac
rm -f "$capture"
# Windows closes the pseudo-terminal at stdin EOF, so keep stdin open with a sleep that is stopped once the run exits.
( sleep "$max" ) | ssh -tt forgevm "$script & exit" > "$capture" 2>&1 &
waited=0
while [ "$waited" -lt "$max" ]; do
  if grep -q "EXIT=" "$capture" 2>/dev/null; then sleep 2; break; fi
  sleep 10; waited=$((waited + 10))
done
pkill -f "^sleep $max\$" 2>/dev/null
wait
perl -pe 's/\e\[[0-9;?]*[A-Za-z]|\e\][^\a]*\a//g; s/\r//g' "$capture" | grep -v '^\s*at \|^\s*$'
grep -q "EXIT=" "$capture" || { echo "no EXIT= line within ${max}s" >&2; exit 1; }
