/**
 * The isolation guard is only a guard while every path the code *writes* resolves inside it.
 *
 * `test-preload.ts` redirects MAGIC_CONTEXT_TEST_DATA_DIR, XDG_DATA_HOME, XDG_CONFIG_HOME — and
 * HOME, because the pi-native config path is HOME-derived. That last one needs the module to
 * cooperate: bun freezes `$HOME` at process start and `os.homedir()` keeps answering with that
 * snapshot afterwards (measured, bun 1.4.2), so a preload's assignment is invisible to it. With
 * `PI_NATIVE_PATH` built from `os.homedir()` the two paths straddled the isolation — the
 * CortexKit target moved into the throwaway tree and the file it overwrote stayed the
 * developer's own. On 2026-10-09 the latch test in `index-in-process-latch.test.ts` left its
 * fixture at `~/.pi/agent/extension-configs/magic-context/magic-context.jsonc` and moved the
 * real settings to `.pre-symlink.1791532417793`, which is why `todowrite.enabled` became false
 * in a config nobody had edited.
 *
 * These assertions are the tripwire: they name the file Magic Context is willing to *overwrite*,
 * so a regression here fails instead of silently editing someone's config. The XDG vars are
 * deliberately not asserted — tests replace them with fixture roots on purpose.
 */
import { describe, expect, it } from "bun:test";
import { userInfo } from "node:os";
import { join } from "node:path";

import { piNativeConfigPath } from "./pi-native-config";

describe("a test process cannot reach a real pi-native config", () => {
	it("writes the pi-native file inside the home the preload handed the process", () => {
		const home = process.env.HOME;
		expect(typeof home).toBe("string");
		// Without a preload the test process IS the developer's session, and the only honest
		// answer is to say so.
		expect(home).toBe(process.env.MAGIC_CONTEXT_TEST_DATA_DIR);
		expect(home).not.toBe("");
		// `pi-native-config.ts` resolves this through its own HOME-first helper, which reads
		// the live environment. `os.homedir()` here would answer with the real home, because
		// bun snapshots `$HOME` before any preload runs.
		expect(piNativeConfigPath().startsWith(`${home}/`)).toBe(true);
	});

	it("is not the developer's own pi-native file", () => {
		let real: string | undefined;
		try {
			real = userInfo().homedir;
		} catch {
			real = undefined;
		}
		// A container with no passwd entry cannot name a real home, so it proves nothing.
		if (real === undefined || real === "") return;
		expect(piNativeConfigPath()).not.toBe(
			join(
				real,
				".pi",
				"agent",
				"extension-configs",
				"magic-context",
				"magic-context.jsonc",
			),
		);
	});
});
