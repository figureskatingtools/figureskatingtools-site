#!/usr/bin/env bash
# Generate changelog.json from recent commits across all repos.
# Uses the GitHub CLI (gh) to fetch commits.
# Usage: generate-changelog.sh [output-file] [branch]
#   output-file  defaults to site/public/changelog.json
#   branch       git branch to read commits from (defaults to main). The deploy
#                workflow passes 'main' for prod and 'test' for the test env.
set -euo pipefail

# Repos and their display labels
declare -A REPOS=(
  ["figureskatingtools/figureskatingtools-site"]="Site"
  ["figureskatingtools/fs-judgepapers"]="Judge Papers"
)

OUTPUT_FILE="${1:-site/public/changelog.json}"
BRANCH="${2:-main}"
MAX_COMMITS=30 # per repo (fetched, then merged + sorted across repos)
MAX_ENTRIES=4  # shown in the "What's New" panel

echo "Generating changelog from GitHub commits (branch: ${BRANCH})..."

ALL_ENTRIES="[]"

for repo in "${!REPOS[@]}"; do
  label="${REPOS[$repo]}"
  echo "  Fetching from $repo ($label)..."

  # Fetch commits using gh api (works with GITHUB_TOKEN)
  COMMITS=$(gh api \
    "repos/${repo}/commits?sha=${BRANCH}&per_page=${MAX_COMMITS}" \
    --jq '.[] | {
      sha: .sha[0:7],
      date: (.commit.committer.date[0:10]),
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
done

# Sort by date descending, keep only the most recent entries across all repos
SORTED=$(echo "$ALL_ENTRIES" | jq --argjson n "$MAX_ENTRIES" 'sort_by(.date) | reverse | .[0:$n]')

# Ensure output directory exists
mkdir -p "$(dirname "$OUTPUT_FILE")"

echo "$SORTED" > "$OUTPUT_FILE"

COUNT=$(echo "$SORTED" | jq 'length')
echo "Changelog generated: ${COUNT} entries → ${OUTPUT_FILE}"
