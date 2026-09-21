//! Whether SQLite's WAL mode can be trusted on the filesystem holding a database.
//!
//! WAL mode assumes two things of the filesystem that userspace cannot verify: a
//! shared-memory region (the `-shm` sidecar) that every connection sees
//! coherently and can lock, and fsync ordering that survives to the physical
//! medium, so the write-ahead log is durable before the database file is
//! modified. virtiofs serves the file from a host-side daemon across a VM
//! boundary, so neither holds — and what that costs is not a lost commit but a
//! damaged database file.
//!
//! That is not theoretical. On 2026-09-20 a host reboot destroyed this project's
//! `context.db` on a virtiofs mount, leaving a clobbered page-1 b-tree header, a
//! `sqlite_master` cell truncated mid-`CREATE TABLE`, and six duplicate pages —
//! damage a lost WAL tail cannot produce, and damage `sqlite3 .recover` could not
//! repair.
//!
//! The dashboard writes to that same database, so it has to make the same choice
//! the plugin makes. Opening it here without this check would put the file back
//! into WAL mode and quietly undo the plugin's fallback
//! (`packages/plugin/src/features/magic-context/wal-filesystem.ts` is the same
//! rule on the TypeScript side; the two must agree).
//!
//! Added to this list only with the evidence virtiofs has: a demonstrated
//! corruption, not a suspicion.

use std::path::{Path, PathBuf};

/// Filesystems whose WAL mode cannot be trusted. See the module docs.
const WAL_UNSAFE_FILESYSTEMS: &[&str] = &["virtiofs"];

const PROC_SELF_MOUNTS: &str = "/proc/self/mounts";

/// One line of the mount table, reduced to what the lookup needs.
#[derive(Debug, PartialEq, Eq)]
pub struct MountEntry {
    pub mount_point: String,
    pub filesystem_type: String,
}

/// Mount-table fields escape space, tab, newline and backslash as octal, so a
/// mount point containing a space would otherwise never prefix-match.
fn unescape_mount_field(field: &str) -> String {
    let mut unescaped = String::with_capacity(field.len());
    let mut characters = field.chars().peekable();
    while let Some(character) = characters.next() {
        if character != '\\' {
            unescaped.push(character);
            continue;
        }
        let mut octal = String::new();
        while octal.len() < 3 {
            match characters.peek() {
                Some(next) if ('0'..='7').contains(next) => {
                    octal.push(*next);
                    characters.next();
                }
                _ => break,
            }
        }
        match (
            octal.len(),
            u32::from_str_radix(&octal, 8).ok().and_then(char::from_u32),
        ) {
            (3, Some(decoded)) => unescaped.push(decoded),
            // Not an escape after all: keep the backslash and what followed it.
            _ => {
                unescaped.push('\\');
                unescaped.push_str(&octal);
            }
        }
    }
    unescaped
}

/// Parse `/proc/mounts` content into mount point + filesystem type pairs.
///
/// Unparsable lines are skipped rather than rejected: a surprising entry must not
/// be able to take storage down.
pub fn parse_mount_table(text: &str) -> Vec<MountEntry> {
    let mut entries = Vec::new();
    for line in text.lines() {
        // Fields are space-separated, and the kernel's escaping means no field
        // can contain an unescaped space, so whitespace splitting is safe.
        let mut fields = line.split_whitespace();
        let (Some(_device), Some(mount_point), Some(filesystem_type)) =
            (fields.next(), fields.next(), fields.next())
        else {
            continue;
        };
        entries.push(MountEntry {
            mount_point: unescape_mount_field(mount_point),
            filesystem_type: unescape_mount_field(filesystem_type),
        });
    }
    entries
}

/// True when `path` is `mount_point` itself or sits underneath it.
fn is_within_mount(mount_point: &str, path: &str) -> bool {
    let Some(remainder) = path.strip_prefix(mount_point) else {
        return false;
    };
    if remainder.is_empty() {
        return true;
    }
    // A mount point of "/" already ends in the separator; every other one needs
    // the next character to be one, or "/probe/store" would match "/probe/storex".
    mount_point.ends_with('/') || remainder.starts_with('/')
}

/// The filesystem type backing `path`: the *longest* mount point containing it,
/// because a nested mount is the one that actually holds the bytes.
pub fn filesystem_type_for<'a>(path: &str, mounts: &'a [MountEntry]) -> Option<&'a str> {
    mounts
        .iter()
        .filter(|entry| is_within_mount(&entry.mount_point, path))
        .max_by_key(|entry| entry.mount_point.len())
        .map(|entry| entry.filesystem_type.as_str())
}

/// Resolve symlinks before matching, or a database reached through a symlinked
/// ancestor would be compared against canonical mount points and fall through to
/// "no match". The file may not exist yet on a first open, in which case the
/// directory is resolved and the file name appended.
fn canonicalize_for_lookup(path: &Path) -> PathBuf {
    if let Ok(resolved) = path.canonicalize() {
        return resolved;
    }
    if let (Some(parent), Some(name)) = (path.parent(), path.file_name()) {
        if let Ok(resolved_parent) = parent.canonicalize() {
            return resolved_parent.join(name);
        }
    }
    path.to_path_buf()
}

/// The filesystem type backing `db_path` when WAL mode must not be used there,
/// or `None` when the path is on a filesystem where WAL is safe — including when
/// the mount table cannot be read, since the fallback must never be decided by a
/// failed lookup.
pub fn wal_unsafe_filesystem(db_path: &Path) -> Option<&'static str> {
    let mount_table = std::fs::read_to_string(PROC_SELF_MOUNTS).ok()?;
    wal_unsafe_filesystem_in(db_path, &mount_table)
}

fn wal_unsafe_filesystem_in(db_path: &Path, mount_table: &str) -> Option<&'static str> {
    let mounts = parse_mount_table(mount_table);
    let resolved = canonicalize_for_lookup(db_path);
    let filesystem_type = filesystem_type_for(&resolved.to_string_lossy(), &mounts)?;
    WAL_UNSAFE_FILESYSTEMS
        .iter()
        .copied()
        .find(|candidate| *candidate == filesystem_type)
}

#[cfg(test)]
mod tests {
    use super::{filesystem_type_for, parse_mount_table, wal_unsafe_filesystem_in};
    use std::path::Path;

    // Synthetic and deliberately non-existent, so no assertion depends on the
    // machine running the tests and no real path resolution can rewrite the
    // input out from under the lookup.
    const MOUNT_TABLE: &str = "\
/dev/sda1 / ext4 rw,relatime 0 0
none /probe/store virtiofs rw,relatime 0 0
tmpfs /probe/tmp tmpfs rw,nosuid 0 0
server:/export /probe/share nfs4 rw,addr=10.0.0.1 0 0
none /probe/with\\040space virtiofs rw 0 0";

    #[test]
    fn short_lines_are_skipped() {
        assert!(parse_mount_table("garbage\n\none two\n").is_empty());
    }

    #[test]
    fn octal_escaped_mount_points_are_unescaped() {
        let mounts = parse_mount_table(MOUNT_TABLE);
        assert!(mounts
            .iter()
            .any(|entry| entry.mount_point == "/probe/with space"
                && entry.filesystem_type == "virtiofs"));
    }

    #[test]
    fn the_longest_containing_mount_point_wins() {
        let mounts = parse_mount_table(MOUNT_TABLE);
        assert_eq!(
            filesystem_type_for("/probe/store/magic-context/context.db", &mounts),
            Some("virtiofs")
        );
        assert_eq!(
            filesystem_type_for("/probe/notes.md", &mounts),
            Some("ext4")
        );
    }

    #[test]
    fn a_mount_point_that_is_only_a_string_prefix_does_not_match() {
        let mounts = parse_mount_table(MOUNT_TABLE);
        assert_eq!(
            filesystem_type_for("/probe/storex/context.db", &mounts),
            Some("ext4")
        );
    }

    #[test]
    fn nothing_containing_the_path_has_no_answer() {
        assert_eq!(filesystem_type_for("/elsewhere/context.db", &[]), None);
    }

    #[test]
    fn virtiofs_is_reported_and_other_filesystems_are_not() {
        assert_eq!(
            wal_unsafe_filesystem_in(
                Path::new("/probe/store/magic-context/context.db"),
                MOUNT_TABLE
            ),
            Some("virtiofs")
        );
        assert_eq!(
            wal_unsafe_filesystem_in(Path::new("/probe/tmp/context.db"), MOUNT_TABLE),
            None
        );
        assert_eq!(
            wal_unsafe_filesystem_in(Path::new("/probe/notes.md"), MOUNT_TABLE),
            None
        );
        assert_eq!(
            wal_unsafe_filesystem_in(Path::new("/probe/share/context.db"), MOUNT_TABLE),
            None
        );
    }

    #[test]
    fn an_unreadable_mount_table_reports_nothing() {
        assert_eq!(
            wal_unsafe_filesystem_in(Path::new("/probe/store/magic-context/context.db"), ""),
            None
        );
    }
}
