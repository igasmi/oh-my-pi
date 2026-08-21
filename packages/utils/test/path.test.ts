import * as path from "node:path";
import { describe, expect, it } from "bun:test";
import { pathIsWithin } from "../src/dirs";
import { stripWindowsExtendedLengthPathPrefix } from "../src/path";
describe("stripWindowsExtendedLengthPathPrefix", () => {
	it("removes drive and UNC extended-length prefixes on Windows", () => {
		expect(stripWindowsExtendedLengthPathPrefix("\\\\?\\C:\\Users\\Shi Xin\\omp.exe", "win32")).toBe(
			"C:\\Users\\Shi Xin\\omp.exe",
		);
		expect(stripWindowsExtendedLengthPathPrefix("\\\\?\\UNC\\server\\share\\omp.exe", "win32")).toBe(
			"\\\\server\\share\\omp.exe",
		);
	});

	it("leaves non-Windows paths unchanged", () => {
		const path = "\\\\?\\C:\\Users\\Shi Xin\\omp.exe";
		expect(stripWindowsExtendedLengthPathPrefix(path, "linux")).toBe(path);
	});
});

describe("pathIsWithin", () => {
	it("allows dot-prefixed child directories and files", () => {
		const base = path.resolve("workspace");
		expect(pathIsWithin(base, path.join(base, "..cache"))).toBe(true);
		expect(pathIsWithin(base, path.join(base, "..cache", "token"))).toBe(true);
		expect(pathIsWithin(base, path.join(base, "...triple-dot"))).toBe(true);
		expect(pathIsWithin(base, path.join(base, "normal-child"))).toBe(true);
		expect(pathIsWithin(base, base)).toBe(true);
	});

	it("rejects true parent and sibling escapes", () => {
		const base = path.resolve("workspace");
		expect(pathIsWithin(base, path.resolve(base, ".."))).toBe(false);
		expect(pathIsWithin(base, path.resolve(base, "..", "sibling"))).toBe(false);
		expect(pathIsWithin(base, path.resolve(base, "../..", "other"))).toBe(false);
	});
});
