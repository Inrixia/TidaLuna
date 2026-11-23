import assert from "node:assert";
import { describe, it } from "node:test";

import { compareVersions, coreNativeQuestion, coreNativeRule } from "./policy";

describe("core native rules", () => {
	it("denies or confirms the dangerous core natives", () => {
		assert.equal(coreNativeRule("sendToRender"), "deny");
		assert.equal(coreNativeRule("update"), "confirm");
		// Installs only what a confirmed update downloaded
		assert.equal(coreNativeRule("runElevatedInstall"), "allow");
		assert.equal(coreNativeRule("startNativeDebugging"), "confirm");
		assert.equal(coreNativeRule("pkg"), "allow");
	});

	it("names the version an update installs", () => {
		const [title, lines, confirmText] = coreNativeQuestion("update", ["1.2.3"]);
		assert.equal(title, "Update Luna?");
		assert.match(lines.join(" "), /1\.2\.3/);
		assert.equal(confirmText, "Update");
	});

	it("shows the installed version and warns about a downgrade", () => {
		const [, newer] = coreNativeQuestion("update", ["1.26.0"], "1.25.0-beta");
		assert.match(newer.join(" "), /1\.25\.0-beta -> 1\.26\.0/);
		assert.doesNotMatch(newer.join(" "), /older/);
		const [, older] = coreNativeQuestion("update", ["1.24.3"], "1.25.0-beta");
		assert.match(older.join(" "), /older than the installed version/);
	});

	it("orders release versions", () => {
		assert.ok(compareVersions("1.25.0", "1.25.0-beta") > 0);
		assert.ok(compareVersions("1.9.0", "1.10.0") < 0);
		assert.ok(compareVersions("1.25.0-beta.2", "1.25.0-beta.10") < 0);
		assert.equal(compareVersions("v1.2.3", "1.2.3"), 0);
	});
});
