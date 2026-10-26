import { describe, expect, test } from "bun:test";
import { modelAssetUrl } from "../src/model-url";

describe("modelAssetUrl", () => {
	test("builds a web2dmodel URL from a POSIX dir", () => {
		expect(modelAssetUrl("/Users/me/models/zero", "zero.model3.json")).toBe(
			"web2dmodel://model/Users/me/models/zero/zero.model3.json",
		);
	});

	test("ignores trailing slashes on the dir", () => {
		expect(modelAssetUrl("/m/zero//", "a.json")).toBe("web2dmodel://model/m/zero/a.json");
	});

	test("keeps nested file paths as path segments", () => {
		expect(modelAssetUrl("/m", "textures/tex_00.png")).toBe("web2dmodel://model/m/textures/tex_00.png");
	});

	test("encodes spaces and non-ASCII per segment", () => {
		expect(modelAssetUrl("/m/my model", "表情 1.exp3.json")).toBe(
			`web2dmodel://model/m/my%20model/${encodeURIComponent("表情 1.exp3.json")}`,
		);
	});

	test("normalizes Windows backslashes and drive letters", () => {
		expect(modelAssetUrl("C:\\Models\\zero\\", "zero.model3.json")).toBe(
			"web2dmodel://model/C%3A/Models/zero/zero.model3.json",
		);
	});
});
