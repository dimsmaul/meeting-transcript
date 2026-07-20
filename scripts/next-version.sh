#!/usr/bin/env bash
# Compute the next version from Conventional Commits since the last STABLE tag.
#
# Bump level  : feat -> minor, fix/perf -> patch, `!` or `BREAKING CHANGE:` -> major.
# Channel      : BETA when every releasing commit carries the `(beta)` scope
#                (e.g. feat(beta):). If ANY releasing commit is non-beta, the
#                whole batch promotes to a STABLE release.
# Beta version : <next-stable-base>-beta.<N>, N auto-increments across existing
#                beta tags for that base.
#
# Output (KEY=VALUE lines on stdout, ready for $GITHUB_OUTPUT):
#   release=true|false   version=  tag=  channel=stable|beta  prerelease=true|false
#
# Usage: scripts/next-version.sh
set -euo pipefail

emit() { echo "$1=$2"; }

# No commits at all → nothing to release.
if ! git rev-parse HEAD >/dev/null 2>&1; then
  emit release false
  exit 0
fi

# Last STABLE tag = highest semver vX.Y.Z WITHOUT a prerelease suffix.
last_stable="$(git tag -l 'v[0-9]*.[0-9]*.[0-9]*' | grep -vE -- '-' | sort -V | tail -1 || true)"

if [[ -n "$last_stable" ]]; then
  range="${last_stable}..HEAD"
  cur="${last_stable#v}"
else
  range=""        # no stable tag yet → scan full history
  cur="0.0.0"
fi

subjects="$(git log --format='%s' ${range:+$range})"
bodies="$(git log --format='%b' ${range:+$range})"

major=0 minor=0 patch=0 beta_only=1 has_release=0

while IFS= read -r s; do
  [[ -z "$s" ]] && continue
  # type(scope)!: subject   — scope and ! optional
  if [[ "$s" =~ ^(feat|fix|perf)(\(([a-zA-Z0-9_-]+)\))?(!)?: ]]; then
    type="${BASH_REMATCH[1]}"
    scope="${BASH_REMATCH[3]}"
    bang="${BASH_REMATCH[4]}"
    has_release=1
    [[ "$scope" != "beta" ]] && beta_only=0
    if [[ -n "$bang" ]]; then
      major=1
    elif [[ "$type" == "feat" ]]; then
      minor=1
    else
      patch=1
    fi
  fi
done <<< "$subjects"

# BREAKING CHANGE anywhere in a commit body → major.
if grep -q 'BREAKING CHANGE' <<< "$bodies"; then major=1; fi

if [[ "$has_release" -eq 0 ]]; then
  emit release false
  exit 0
fi

IFS=. read -r cmaj cmin cpat <<< "$cur"
if [[ "$major" -eq 1 ]]; then
  base="$((cmaj + 1)).0.0"
elif [[ "$minor" -eq 1 ]]; then
  base="${cmaj}.$((cmin + 1)).0"
else
  base="${cmaj}.${cmin}.$((cpat + 1))"
fi

if [[ "$beta_only" -eq 1 ]]; then
  # Next beta number for this base version.
  n="$(git tag -l "v${base}-beta.*" | sed -E 's/.*-beta\.//' | sort -n | tail -1 || true)"
  n="$(( ${n:-0} + 1 ))"
  version="${base}-beta.${n}"
  emit release true
  emit version "$version"
  emit tag "v${version}"
  emit channel beta
  emit prerelease true
else
  emit release true
  emit version "$base"
  emit tag "v${base}"
  emit channel stable
  emit prerelease false
fi
