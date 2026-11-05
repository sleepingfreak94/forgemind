#!/bin/sh
# Put the Windows VM's ForgeMind checkout on an exact local commit and build it.
# Usage: vm-sync.sh <local worktree> <base commit already on the VM> <branch>
set -eu
[ $# -eq 3 ] || { echo "usage: vm-sync.sh <worktree> <base-on-vm> <branch>" >&2; exit 2; }
worktree=$1 base=$2 branch=$3
case $branch in *[!A-Za-z0-9._/-]*) echo "unsafe branch name" >&2; exit 2;; esac
case $base in *[!0-9a-f]*) echo "base must be a commit id" >&2; exit 2;; esac
bundle=$(mktemp -t forgemind-vm).bundle
git -C "$worktree" bundle create -q "$bundle" "$base..$branch"
want=$(git -C "$worktree" rev-parse "$branch")
scp -q "$bundle" forgevm:C:/Users/forgemind/sync.bundle
rm -f "$bundle"
# The VM checkout is disposable: discard edits, then hard-reset to the fetched ref.
ssh forgevm "cd /d C:\\Users\\forgemind\\forgemind && git checkout -q -- . && git fetch -q C:\\Users\\forgemind\\sync.bundle +$branch:refs/heads/vm-sync && git reset -q --hard vm-sync && git status --short && npm.cmd run build > C:\\Users\\forgemind\\build-sync.log 2>&1 && git rev-parse HEAD" | tr -d '\r' | tee /dev/stderr | tail -1 | grep -qx "$want" \
  || { echo "VM is not at $want (or the build failed: see C:\\Users\\forgemind\\build-sync.log)" >&2; exit 1; }
echo "VM at $want, built"
