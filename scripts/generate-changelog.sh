#!/usr/bin/env bash
# Generate changelog.json from recent commits across all repos.
# Uses the GitHub CLI (gh) to fetch commits.
#
# This output is the FALLBACK for the "What's New" panel — the site fetches
# commits live from the public GitHub API at runtime and only reads this file
# when that fails (offline, rate-limited). Repo list is single-sourced from
# site/public/changelog-sources.json (shared with the runtime fetcher).
#
# Usage: generate-changelog.sh [output-file] [branch] [sources-file]
#   output-file   defaults to site/public/changelog.json
#   branch        git branch to read commits from (defaults to main). The deploy
#                 workflow passes 'main' for prod and 'test' for the test env.
#   sources-file  defaults to site/public/changelog-sources.json
set -euo pipefail

OUTPUT_FILE="${1:-site/public/changelog.json}"
BRANCH="${2:-main}"
SOURCES_FILE="${3:-site/public/changelog-sources.json}"
MAX_COMMITS=30 # per repo (fetched, then merged + sorted across repos)
MAX_ENTRIES=20 # kept in the fallback file (panel shows 4 + "Show more")

echo "Generating changelog from GitHub commits (branch: ${BRANCH})..."

ALL_ENTRIES="[]"

while IFS=$'\t' read -r repo label; do
  echo "  Fetching from $repo ($label)..."

  # Fetch commits using gh api (works with GITHUB_TOKEN)
  COMMITS=$(gh api \
    "repos/${repo}/commits?sha=${BRANCH}&per_page=${MAX_COMMITS}" \
    --jq '.[] | {
      sha: .sha[0:7],
      date: (.commit.committer.date[0:10]),
      iso: .commit.committer.date,
      title: (.commit.message | split("\n") | .[0]),
      description: (.commit.message | split("\n") | .[1:] | join("\n") | ltrimstr("\n")),
      author: .commit.author.name
    }' 2>/dev/null || echo "")

  if [ -z "$COMMITS" ]; then
    echo "    Warning: Could not fetch commits from $repo (may be private or gh not authenticated)"
    continue
  fi

  # Convert newline-delimited JSON objects into an array, adding tool label
  REPO_ENTRIES=$(echo "$COMMITS" | jq -s --arg tool "$label" '[.[] | . + {tool: $tool}]')
  ALL_ENTRIES=$(echo "$ALL_ENTRIES" "$REPO_ENTRIES" | jq -s '.[0] + .[1]')
done < <(jq -r '.[] | [.repo, .tool] | @tsv' "$SOURCES_FILE")

# Keep only the most recent entries across all repos. Sort on the full ISO
# timestamp (`iso`), not the day-granular `date`, so same-day commits order
# correctly; then drop the sort-only helper field from the output.
SORTED=$(echo "$ALL_ENTRIES" | jq --argjson n "$MAX_ENTRIES" \
  'sort_by(.iso) | reverse | .[0:$n] | map(del(.iso))')

# Ensure output directory exists
mkdir -p "$(dirname "$OUTPUT_FILE")"

echo "$SORTED" > "$OUTPUT_FILE"

COUNT=$(echo "$SORTED" | jq 'length')
echo "Changelog generated: ${COUNT} entries → ${OUTPUT_FILE}"
