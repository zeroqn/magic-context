// Test-isolation guard — runs ONCE before any test file is imported (wired via
// bunfig.toml `[test] preload`). Forces XDG data and config homes to one
// throwaway temp tree so NO test can read or migrate the user's real shared
// cortexkit DB (~/.local/share/cortexkit/magic-context/context.db), which
// pi-plugin shares with OpenCode via @magic-context/core's `getDataDir()` =
// `XDG_DATA_HOME ?? ~/.local/share`. See the OpenCode plugin's test-preload.ts
// for the full rationale: a 2026-06-01 unisolated test migrated the real DB,
// and #388 found a fixture-scoped test resolving the user's real embedding
// endpoint and model through the user config tier. Per-test XDG_DATA_HOME or XDG_CONFIG_HOME
// fixtures may replace this root, while MAGIC_CONTEXT_STORAGE_DIR can never
// escape test isolation. Do not remove.
import { afterAll, afterEach } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { __setLocalEmbeddingPoolingTestFallback } from "@magic-context/core/features/magic-context/memory/local-embedding-pooling";
import { getHarness, setHarness } from "@magic-context/core/shared/harness";
import { resetReusableWorkersForTests } from "@magic-context/core/shared/reusable-worker";
import {
	createTestTempDir,
	installTestTempDirCleanup,
	sweepStaleTestTempDirs,
} from "@magic-context/core/shared/test-temp-dir";
import { __setPiHarnessKindForTesting } from "./src/pi-harness-kind";

// Pooled threads and idle timers must not outlive the test that created them.
afterEach(resetReusableWorkersForTests);

sweepStaleTestTempDirs();
installTestTempDirCleanup((cleanup) =>
	afterAll(async () => {
		await resetReusableWorkersForTests();
		cleanup();
	}),
);
const { dir: isolatedDataHome } = createTestTempDir("mc-pi-test-xdg-");

// Bulletproof DB guard (see @magic-context/core resolveDatabasePath): never
// mutated by any test, so a bare openDatabase() can never reach the real DB.
process.env.MAGIC_CONTEXT_TEST_DATA_DIR = isolatedDataHome;
process.env.XDG_DATA_HOME = isolatedDataHome;
process.env.XDG_CONFIG_HOME = isolatedDataHome;

// Oh My Pi (OMP) compatibility dependencies can expose pi-utils beside the test
// runner. Select Pi before index.ts captures host detection at module load.
// Tests simulating OMP can override detection; the cleanup guard still rejects
// any file that leaves a non-Pi harness lock or detection memo.
__setPiHarnessKindForTesting("pi");

// Provider fixtures in this package use fake model IDs and retain the legacy mean path.
__setLocalEmbeddingPoolingTestFallback({
	status: "ready",
	pooling: "mean",
	normalize: true,
	declared: false,
	reason: "test fixture has no sentence-transformers pooling metadata",
});

afterAll(() => {
	const packageDir = process.cwd();
	const violations: string[] = [];
	const scan = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === "node_modules" || entry.name === ".git") continue;
				if (entry.name === "undefined") violations.push(path);
				scan(path);
			} else if (entry.isFile() && entry.name === "context.db") {
				violations.push(path);
			}
		}
	};
	scan(packageDir);
	if (violations.length > 0) {
		throw new Error(
			`Test storage leaked into the package directory:\n${violations.join("\n")}`,
		);
	}
});

// Preload afterAll hooks run after each file's own cleanup. Do not reset leaked
// state here: the file that selected another host must restore Pi itself.
afterAll(() => {
	const violations: string[] = [];
	try {
		// An unused harness is unlocked and may still have the OpenCode default.
		// Selecting Pi accepts that case but rejects any conflicting locked host.
		setHarness("pi");
	} catch {
		violations.push(`harness locked to "${getHarness()}"`);
	}
	const detection = (
		globalThis as typeof globalThis & {
			[key: symbol]: { kind: string } | undefined;
		}
	)[Symbol.for("magic-context.pi.harness-detection")];
	if (detection !== undefined && detection.kind !== "pi") {
		violations.push(`detection memo is "${detection.kind}"`);
	}
	if (violations.length > 0) {
		throw new Error(
			`Pi test harness isolation leak after file cleanup: ${violations.join("; ")}. ` +
				'Restore the harness with _resetHarnessForTesting() and setHarness("pi"), ' +
				"and clear detection with __setPiHarnessKindForTesting(undefined).",
		);
	}
});
// HOME as well, because a path *derived from it* is a write target — and the
// XDG redirect above does not cover one. This fork's `pi-native-config.ts`
// computes `PI_NATIVE_PATH` from `os.homedir()`
// (`~/.pi/agent/extension-configs/magic-context/magic-context.jsonc`), and
// `ensurePiNativeConfigLink()`, which the plugin factory calls on load, ADOPTS a
// newer external write found at the CortexKit path over it, moving the loser to
// `.pre-symlink[.<Date.now()>]`. With HOME left real the two paths straddle this
// isolation: the target is inside the throwaway tree and the file it overwrites
// is the developer's own. A test that writes a regular file at the isolated
// CortexKit path therefore rewrote a live config — on 2026-10-09 the latch test
// in `index-in-process-latch.test.ts` replaced
// `~/.pi/agent/extension-configs/magic-context/magic-context.jsonc` with its own
// fixture and moved the real settings to `.pre-symlink.1791532417793`, so
// `todowrite.enabled` became false in a config nobody had edited.
//
// Redirecting HOME puts the HOME-derived path inside this same throwaway tree,
// so no test can reach the real pi-native file however it writes the CortexKit
// one. The root and e2e bunfigs preload `packages/plugin/test-preload.ts`, which
// carries the same redirect for runs that discover this package's tests from
// outside it.
process.env.HOME = isolatedDataHome;
