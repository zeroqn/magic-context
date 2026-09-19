/**
 * pi-native config location — keep Magic Context's real user config in pi's tree.
 *
 * Magic Context reads and writes its user config at the shared CortexKit path
 * (`<XDG_CONFIG_HOME or ~/.config>/cortexkit/magic-context.jsonc`), which is
 * correct for the OpenCode harness and for the standalone CLI. This module makes
 * the pi-native file the real storage instead, by placing a symlink at the
 * CortexKit path — the same shape `rpiv-advisor-pi-native` uses.
 *
 * The runtime only READS this file (config loads when the extension factory
 * runs), so reads follow the link. The writers are not so accommodating:
 * `cortexkit setup` / `doctor` write a temp sibling and rename it onto the
 * target, which replaces a symlink with a regular file. ensureLink() therefore
 * reconciles on every run: a regular file at the CortexKit path is folded back
 * into pi-native, and when both differ the newer mtime wins while the loser is
 * preserved as `<path>.pre-symlink`.
 *
 * Idempotent. Runs at extension load (before session_start handlers) and again
 * on every session_start. Handles first-run migration, dangling/stale links, and
 * clobbered links.
 */

import {
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readlinkSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

const PI_NATIVE_PATH = join(homedir(), ".pi", "agent", "extension-configs", "magic-context", "magic-context.jsonc");

/** Mirrors magic-context's homeDir(): HOME first, then os.homedir(). */
function homeDir(): string {
	if (process.platform === "win32") {
		return process.env.USERPROFILE || process.env.HOME || homedir();
	}
	return process.env.HOME || homedir();
}

/** Mirrors magic-context's configHome(): XDG_CONFIG_HOME only when absolute. */
function configHome(): string {
	const xdg = process.env.XDG_CONFIG_HOME;
	return xdg && isAbsolute(xdg) ? xdg : join(homeDir(), ".config");
}

function cortexKitPath(): string {
	return join(configHome(), "cortexkit", "magic-context.jsonc");
}

function isSymlink(path: string): boolean {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false;
	}
}

function pointsAt(path: string, target: string): boolean {
	try {
		return readlinkSync(path) === target;
	} catch {
		return false;
	}
}

function sameContent(a: string, b: string): boolean {
	try {
		return readFileSync(a).equals(readFileSync(b));
	} catch {
		return false;
	}
}

function mtimeMs(path: string): number {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return 0;
	}
}

/** rename that works across filesystems (EXDEV -> copy + delete). */
function moveFile(from: string, to: string): void {
	try {
		renameSync(from, to);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
		copyFileSync(from, to);
		rmSync(from);
	}
}

/** First free `.pre-symlink` (optionally timestamped) path beside the loser. */
function backupPathFor(path: string): string {
	const base = `${path}.pre-symlink`;
	return existsSync(base) ? `${base}.${Date.now()}` : base;
}

function ensureLink(): void {
	const target = cortexKitPath();

	// Target directory must exist: writes through a dangling symlink create the
	// target file, but not its parent directory.
	mkdirSync(dirname(PI_NATIVE_PATH), { recursive: true });

	if (isSymlink(target)) {
		if (pointsAt(target, PI_NATIVE_PATH)) return; // already correct
		rmSync(target); // dangling or stale target — relink below
	} else if (existsSync(target)) {
		// A regular file here means an atomic writer (cortexkit setup/doctor)
		// renamed over the link. Fold its content back into pi-native.
		if (!existsSync(PI_NATIVE_PATH)) {
			moveFile(target, PI_NATIVE_PATH);
		} else if (sameContent(target, PI_NATIVE_PATH)) {
			rmSync(target);
		} else if (mtimeMs(target) >= mtimeMs(PI_NATIVE_PATH)) {
			// The external write is the freshest content: adopt it.
			copyFileSync(PI_NATIVE_PATH, backupPathFor(PI_NATIVE_PATH));
			moveFile(target, PI_NATIVE_PATH);
		} else {
			// pi-native was edited more recently: keep it, preserve the writer's copy.
			copyFileSync(target, backupPathFor(target));
			rmSync(target);
		}
	}

	// No seeding: a missing config is schema defaults, and inventing a file the
	// user never had is worse than leaving both paths absent.
	if (!existsSync(PI_NATIVE_PATH)) return;

	mkdirSync(dirname(target), { recursive: true });
	symlinkSync(PI_NATIVE_PATH, target);
}

/**
 * Bring the CortexKit symlink back in line with the pi-native file. Safe to call
 * at any time and as often as you like.
 */
export function ensurePiNativeConfigLink(): void {
	ensureLink();
}
