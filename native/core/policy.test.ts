import assert from "node:assert";
import { describe, it } from "node:test";

import { coreNativeQuestion, coreNativeRule } from "./policy";

describe("core native rules", () => {
	it("denies or confirms the dangerous core natives", () => {
		assert.equal(coreNativeRule("sendToRender"), "deny");
		assert.equal(coreNativeRule("update"), "confirm");
		assert.equal(coreNativeRule("runElevatedInstall"), "confirm");
		assert.equal(coreNativeRule("startNativeDebugging"), "confirm");
		assert.equal(coreNativeRule("pkg"), "allow");
	});

	it("names the version an update installs", () => {
		const [title, lines, confirmText] = coreNativeQuestion("update", ["1.2.3"]);
		assert.equal(title, "Update Luna?");
		assert.match(lines.join(" "), /1\.2\.3/);
		assert.equal(confirmText, "Update");
	});
});
