import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * Which filesystems can be trusted with SQLite's WAL mode.
 *
 * WAL assumes two things of the filesystem that userspace cannot verify:
 *
 *   1. a shared-memory region (the `-shm` sidecar) that every connection to the
 *      database sees coherently and can lock, and
 *   2. fsync ordering that survives to the physical medium, so the write-ahead
 *      log is durable before the database file is modified.
 *
 * virtiofs serves the file from a host-side daemon across a VM boundary, so
 * neither assumption holds: the guest's `fsync` is a request to another
 * process, and the "shared memory" is a file the daemon also has mapped. When
 * they diverge, SQLite's page writes are not atomic and not ordered, and the
 * result is not a lost commit — it is a damaged database file.
 *
 * That is not hypothetical here. On 2026-09-20 a host reboot destroyed this
 * plugin's `context.db` on a virtiofs mount, leaving a clobbered page-1 b-tree
 * header, a `sqlite_master` cell truncated mid-`CREATE TABLE`, and six
 * duplicate pages — damage a lost WAL tail cannot produce, and damage that
 * `sqlite3 .recover` could not repair.
 *
 * So on these filesystems the connection uses the rollback journal instead,
 * which needs neither shared memory nor cross-page atomicity: each transaction
 * is bracketed by a journal file and a single fsync before the database file is
 * touched at all. It is slower and single-writer, and that is the point.
 *
 * Added to this set only with the same evidence that virtiofs has: a
 * demonstrated corruption, not a suspicion. Other network-ish filesystems
 * (nfs, smb, 9p, other FUSE mounts) are plausibly as unsafe, but each needs its
 * own determination.
 */
const WAL_UNSAFE_FILESYSTEMS = new Set(["virtiofs"]);

/** One line of the mount table, reduced to what the lookup needs. */
export interface MountEntry {
    mountPoint: string;
    filesystemType: string;
}

const PROC_SELF_MOUNTS = "/proc/self/mounts";

/**
 * Mount-table fields escape space, tab, newline and backslash as octal, so a
 * mount point containing a space would otherwise never prefix-match.
 */
function unescapeMountField(field: string): string {
    return field.replace(/\\([0-7]{3})/g, (_match, octal: string) =>
        String.fromCharCode(Number.parseInt(octal, 8)),
    );
}

/**
 * Parse `/proc/mounts` content into mount point + filesystem type pairs.
 * Unparsable lines are skipped rather than thrown: a surprising entry must not
 * be able to take storage down.
 */
export function parseMountTable(text: string): MountEntry[] {
    const entries: MountEntry[] = [];
    for (const line of text.split("\n")) {
        // Fields are space-separated, but the kernel's escaping means no field
        // can contain an unescaped space, so splitting on runs of whitespace is
        // safe and tolerates a line that arrives padded.
        const fields = line.trim().split(/\s+/);
        if (fields.length < 3) continue;
        entries.push({
            mountPoint: unescapeMountField(fields[1]),
            filesystemType: unescapeMountField(fields[2]),
        });
    }
    return entries;
}

/** True when `path` is `mountPoint` itself or sits underneath it. */
function isWithinMount(mountPoint: string, path: string): boolean {
    if (mountPoint === path) return true;
    const prefix = mountPoint.endsWith("/") ? mountPoint : `${mountPoint}/`;
    return path.startsWith(prefix);
}

/**
 * The filesystem type backing `path`: the *longest* mount point that contains
 * it, because a nested mount (this machine mounts `~/.local/share/cortexkit`
 * separately from `/`) is the one that actually holds the bytes.
 */
export function filesystemTypeFor(path: string, mounts: MountEntry[]): string | null {
    let best: MountEntry | null = null;
    for (const entry of mounts) {
        if (!isWithinMount(entry.mountPoint, path)) continue;
        if (best === null || entry.mountPoint.length > best.mountPoint.length) best = entry;
    }
    return best === null ? null : best.filesystemType;
}

function readProcSelfMounts(): string | null {
    try {
        return readFileSync(PROC_SELF_MOUNTS, "utf8");
    } catch {
        return null;
    }
}

let mountTableReader: () => string | null = readProcSelfMounts;

/** Test seam: the mount table is a property of the machine, not of the code. */
export function __setMountTableReaderForTests(reader: (() => string | null) | null): void {
    mountTableReader = reader ?? readProcSelfMounts;
}

export function __resetMountTableReaderForTests(): void {
    mountTableReader = readProcSelfMounts;
}

/**
 * Resolve symlinks before matching, or a database reached through a symlinked
 * ancestor would be compared against canonical mount points and fall through to
 * "no match". The file itself may not exist yet on a first open, in which case
 * the directory is resolved and the basename appended.
 */
function canonicalizeForLookup(path: string): string {
    try {
        return realpathSync(path);
    } catch {
        // The database file is normally created before this runs; a direct
        // initializer call on a not-yet-created path is the case that lands here.
    }
    try {
        return join(realpathSync(dirname(path)), basename(path));
    } catch {
        return path;
    }
}

/**
 * The filesystem type backing `dbPath` when WAL mode must not be used there,
 * or null when the path is on a filesystem where WAL is safe — including when
 * the mount table cannot be read at all, since the fallback must never be
 * decided by a failed lookup.
 */
export function detectWalUnsafeFilesystem(dbPath: string): string | null {
    const mountTable = mountTableReader();
    if (mountTable === null) return null;
    const filesystemType = filesystemTypeFor(
        canonicalizeForLookup(dbPath),
        parseMountTable(mountTable),
    );
    if (filesystemType === null) return null;
    return WAL_UNSAFE_FILESYSTEMS.has(filesystemType) ? filesystemType : null;
}
