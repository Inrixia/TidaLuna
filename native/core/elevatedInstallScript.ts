// The shell script an elevated Linux update runs, kept apart so a test can run it with `sh`.
// Positional parameters: $1 app folder, $2 downloaded zip, $3 sha256 (hex) of the confirmed download.
//
// The zip in tmpdir belongs to the user, so any program of theirs could swap it before the elevated shell reads it. The
// script copies it to a root-owned directory first, checks the copy against the digest of the confirmed download and
// unzips only that copy. A mismatch exits with DIGEST_MISMATCH_EXIT before anything is touched. The digest says which
// file this is, not who built it: it is not a check of the release itself.
// `unzip` recreates symlinks, which a name check on the entries never sees, so the result must hold none: exit
// SYMLINK_EXIT and remove it otherwise.
// Unzip goes next to the app folder first, so a failed unzip leaves the current install untouched.
export const DIGEST_MISMATCH_EXIT = 3;
export const SYMLINK_EXIT = 4;

export const elevatedInstallScript =
	'd=$(mktemp -d) && trap \'rm -rf -- "$d"\' EXIT && cp -- "$2" "$d/u.zip" && ' +
	`{ echo "$3  $d/u.zip" | sha256sum -c - >/dev/null 2>&1 || { echo "Update zip does not match the confirmed download" >&2; exit ${DIGEST_MISMATCH_EXIT}; }; } && ` +
	'rm -rf -- "$1.new" && mkdir -p -- "$1.new" && unzip -o "$d/u.zip" -d "$1.new" && ' +
	// A find that fails counts as a link found: an empty answer from a broken find must not pass
	`{ { l=$(find "$1.new" -type l) && [ -z "$l" ]; } || { rm -rf -- "$1.new"; echo "Update zip contains a symlink" >&2; exit ${SYMLINK_EXIT}; }; } && ` +
	'rm -rf -- "$1" && mv -- "$1.new" "$1"';
