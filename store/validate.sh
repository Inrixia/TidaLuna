#!/usr/bin/env bash
# Validates store/stores.json and store/blocklist.json.
# Run it locally with ./store/validate.sh before opening a pull request.
# Only needs jq and curl, both are preinstalled on ubuntu-latest.
set -uo pipefail

cd "$(dirname "$0")/.."

# Overridable so the checks can be run against a fixture
STORES="${STORES_FILE:-store/stores.json}"
BLOCKLIST="${BLOCKLIST_FILE:-store/blocklist.json}"
FAILED=0

# GitHub picks these up as inline annotations on the pull request diff
err() {
	local line="${2:-1}"
	echo "::error file=$STORES,line=$line::$1"
	FAILED=1
}

# Line number of the nth entry in the stores array, so annotations land near the right place
lineOf() {
	grep -n "^$(printf '\t\t'){" "$STORES" | sed -n "$(($1 + 1))p" | cut -d: -f1
}

for file in "$STORES" "$BLOCKLIST"; do
	if [[ ! -f $file ]]; then
		echo "::error::$file is missing"
		exit 1
	fi
	if ! jq empty "$file" 2>/dev/null; then
		echo "::error file=$file::Not valid JSON"
		exit 1
	fi
done

[[ $(jq -r '.version' "$STORES") == "1" ]] || err "version must be 1"
[[ $(jq -r '.stores | type' "$STORES") == "array" ]] || { err "stores must be an array"; exit 1; }

KNOWN_KEYS='["name","repo","url","added","status","removed","reason"]'
COUNT=$(jq '.stores | length' "$STORES")
echo "Checking $COUNT entries in $STORES"

for ((i = 0; i < COUNT; i++)); do
	LINE=$(lineOf "$i")
	entry=$(jq -c ".stores[$i]" "$STORES")
	name=$(jq -r '.name // ""' <<<"$entry")
	repo=$(jq -r '.repo // ""' <<<"$entry")
	url=$(jq -r '.url // ""' <<<"$entry")
	added=$(jq -r '.added // ""' <<<"$entry")
	status=$(jq -r '.status // "active"' <<<"$entry")
	label="[$i] ${name:-<no name>}"

	unknown=$(jq -r --argjson known "$KNOWN_KEYS" 'keys - $known | join(", ")' <<<"$entry")
	[[ -z $unknown ]] || err "$label unknown key: $unknown" "$LINE"

	[[ -n $name ]] || err "$label name is required and must not be empty" "$LINE"
	[[ $repo =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] || err "$label repo must be owner/repo, got '$repo'" "$LINE"
	[[ $url =~ ^https://github\.com/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+/releases/download/[^/]+/store\.json$ ]] ||
		err "$label url must be a store.json release asset link, got '$url'" "$LINE"
	[[ $added =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || err "$label added must be YYYY-MM-DD, got '$added'" "$LINE"
	[[ $status == "active" || $status == "removed" ]] || err "$label status must be active or removed, got '$status'" "$LINE"

	# The repo field drives the metrics generator, a mismatch means it would query the wrong repo
	urlRepo=$(sed -E 's#^https://github\.com/([^/]+/[^/]+)/releases/.*$#\1#' <<<"$url")
	[[ $urlRepo == "$repo" ]] || err "$label url points at $urlRepo but repo says $repo" "$LINE"

	if [[ $status == "removed" ]]; then
		[[ $(jq -r '.reason // ""' <<<"$entry") != "" ]] || err "$label removed entries need a reason" "$LINE"
		continue
	fi

	# Only active entries have to resolve, tombstones are expected to be dead
	body=$(curl -sL --max-time 30 -w '\n%{http_code}' "$url")
	code=$(tail -1 <<<"$body")
	if [[ $code != "200" ]]; then
		err "$label store.json returned HTTP $code" "$LINE"
		continue
	fi
	json=$(sed '$d' <<<"$body")
	if ! jq empty <<<"$json" 2>/dev/null; then
		err "$label store.json is not valid JSON" "$LINE"
		continue
	fi
	[[ $(jq -r '.name // ""' <<<"$json") != "" ]] || err "$label store.json has no name field" "$LINE"
	plugins=$(jq -r '(.plugins // []) | length' <<<"$json")
	[[ $plugins -gt 0 ]] || err "$label store.json lists no plugins" "$LINE"
	[[ $(jq -r '(.plugins // []) | map(select(type != "string")) | length' <<<"$json") == "0" ]] ||
		err "$label store.json plugins must be an array of file names" "$LINE"
done

# Duplicate urls are always wrong, duplicate repos are fine on tombstones (retagged releases)
dupUrls=$(jq -r '[.stores[].url] | group_by(.) | map(select(length > 1) | .[0]) | join(", ")' "$STORES")
[[ -z $dupUrls ]] || err "duplicate url: $dupUrls"
dupRepos=$(jq -r '[.stores[] | select((.status // "active") == "active") | .repo] | group_by(.) | map(select(length > 1) | .[0]) | join(", ")' "$STORES")
[[ -z $dupRepos ]] || err "duplicate active repo: $dupRepos"

[[ $(jq -r '.version' "$BLOCKLIST") == "1" ]] || { echo "::error file=$BLOCKLIST::version must be 1"; FAILED=1; }
[[ $(jq -r '.patterns | type' "$BLOCKLIST") == "array" ]] || { echo "::error file=$BLOCKLIST::patterns must be an array"; FAILED=1; }
badPattern=$(jq -r '[.patterns[] | select((.pattern // "") == "" or (.reason // "") == "")] | length' "$BLOCKLIST")
[[ $badPattern == "0" ]] || { echo "::error file=$BLOCKLIST::every pattern needs a pattern and a reason"; FAILED=1; }

if [[ $FAILED == 0 ]]; then
	echo "All $COUNT entries look good"
else
	echo "Validation failed"
fi
exit $FAILED
