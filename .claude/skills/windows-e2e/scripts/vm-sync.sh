#!/bin/sh
# Put the Windows VM's ForgeMind checkout on an exact local commit and build it.
# Usage: vm-sync.sh <local worktree> <base commit already on the VM> <branch>
set -eu
[ $# -eq 3 ] || { echo "usage: vm-sync.sh <worktree> <base-on-vm> <branch>" >&2; exit 2; }
worktree=$1 base=$2 branch=$3
case $branch in ''|-*|*..*|*[!A-Za-z0-9._/-]*) echo "unsafe branch name" >&2; exit 2;; esac
case $base in ''|*[!0-9a-f]*) echo "base must be a commit id" >&2; exit 2;; esac
dir=$(mktemp -d -t forgemind-vm)
trap 'rm -rf "$dir"' EXIT
git -C "$worktree" bundle create -q "$dir/sync.bundle" "$base..$branch"
want=$(git -C "$worktree" rev-parse "$branch")
scp -q "$dir/sync.bundle" forgevm:C:/Users/forgemind/sync.bundle
# The VM checkout is disposable: discard edits, check out the fetched commit detached, and refuse a tree that isn't clean.
out=$(ssh forgevm "cd /d C:\\Users\\forgemind\\forgemind && git checkout -q -- . && git fetch -q C:\\Users\\forgemind\\sync.bundle +$branch:refs/heads/vm-sync && git checkout -q --detach vm-sync && git status --short && npm.cmd run build > C:\\Users\\forgemind\\build-sync.log 2>&1 && git rev-parse HEAD" | tr -d '\r')
printf '%s\n' "$out" >&2
[ "$out" = "$want" ] || { printf '%s\n' "VM is not at $want with a clean tree (or the build failed: see C:\\Users\\forgemind\\build-sync.log)" >&2; exit 1; }
echo "VM at $want, clean, built"
