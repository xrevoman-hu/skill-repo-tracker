use std::{
    collections::HashSet,
    error::Error,
    fmt,
    fs::{self, File, OpenOptions},
    io,
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[cfg(unix)]
use std::os::fd::AsRawFd;

use rusqlite::{params, Connection, OptionalExtension};

static OPERATION_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TempArtifactKind {
    Install,
    Sync,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LegacyTempName {
    pub(crate) slug: String,
    pub(crate) kind: TempArtifactKind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum SyncDestination {
    Missing,
    Normal,
    SameSourceSymlink,
    OtherSymlink { target: PathBuf },
    BrokenSymlink { target: PathBuf },
}

#[derive(Debug)]
pub(crate) enum TempArtifactError {
    Io(io::Error),
    Sqlite(rusqlite::Error),
    RegistryPoisoned,
    InvalidPath(String),
    InvalidState(String),
}

impl fmt::Display for TempArtifactError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "{error}"),
            Self::Sqlite(error) => write!(formatter, "{error}"),
            Self::RegistryPoisoned => write!(formatter, "temp artifact registry mutex poisoned"),
            Self::InvalidPath(message) => write!(formatter, "{message}"),
            Self::InvalidState(message) => write!(formatter, "{message}"),
        }
    }
}

impl Error for TempArtifactError {}

impl From<io::Error> for TempArtifactError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<rusqlite::Error> for TempArtifactError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Sqlite(error)
    }
}

type TempResult<T> = Result<T, TempArtifactError>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TempArtifactState {
    Building,
    Ready,
    Replacing,
    Completed,
    RecoveryRequired,
    Quarantined,
}

impl TempArtifactState {
    fn as_str(self) -> &'static str {
        match self {
            Self::Building => "building",
            Self::Ready => "ready",
            Self::Replacing => "replacing",
            Self::Completed => "completed",
            Self::RecoveryRequired => "recovery_required",
            Self::Quarantined => "quarantined",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "building" => Some(Self::Building),
            "ready" => Some(Self::Ready),
            "replacing" => Some(Self::Replacing),
            "completed" => Some(Self::Completed),
            "recovery_required" => Some(Self::RecoveryRequired),
            "quarantined" => Some(Self::Quarantined),
            _ => None,
        }
    }
}

impl TempArtifactKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Install => "install",
            Self::Sync => "sync",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "install" => Some(Self::Install),
            "sync" => Some(Self::Sync),
            _ => None,
        }
    }
}

#[derive(Debug, Clone)]
struct TempArtifactRecord {
    id: String,
    kind: TempArtifactKind,
    root_path: PathBuf,
    temp_path: PathBuf,
    original_path: PathBuf,
    dest_path: PathBuf,
    state: TempArtifactState,
    created_at_unix: i64,
    updated_at_unix: i64,
    quarantined_at_unix: Option<i64>,
    last_error: Option<String>,
}
struct NewTempArtifactRecord<'a> {
    id: &'a str,
    kind: TempArtifactKind,
    root: &'a Path,
    temp_path: &'a Path,
    original_path: &'a Path,
    destination: &'a Path,
    state: TempArtifactState,
    now_unix: i64,
}
#[derive(Clone)]
pub(crate) struct TempArtifactRegistry {
    connection: Arc<Mutex<Connection>>,
}

impl TempArtifactRegistry {
    pub(crate) fn open(database_path: &Path) -> TempResult<Self> {
        if let Some(parent) = database_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let connection = Connection::open(database_path)?;
        connection.execute_batch(
            "CREATE TABLE IF NOT EXISTS temp_artifacts (
               id TEXT PRIMARY KEY,
               kind TEXT NOT NULL,
               root_path TEXT NOT NULL,
               temp_path TEXT NOT NULL UNIQUE,
               original_path TEXT NOT NULL,
               dest_path TEXT NOT NULL DEFAULT '',
               state TEXT NOT NULL,
               created_at INTEGER NOT NULL,
               updated_at INTEGER NOT NULL,
               quarantined_at_unix INTEGER,
               last_error TEXT
             );
             CREATE INDEX IF NOT EXISTS temp_artifacts_state_updated
               ON temp_artifacts(state, updated_at);",
        )?;
        Ok(Self {
            connection: Arc::new(Mutex::new(connection)),
        })
    }

    fn with_connection<T>(
        &self,
        operation: impl FnOnce(&Connection) -> rusqlite::Result<T>,
    ) -> TempResult<T> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| TempArtifactError::RegistryPoisoned)?;
        Ok(operation(&connection)?)
    }

    fn record_for_path(&self, path: &Path) -> TempResult<Option<TempArtifactRecord>> {
        self.with_connection(|connection| {
            connection
                .query_row(
                    "SELECT id, kind, root_path, temp_path, original_path, dest_path,
                            state, created_at, updated_at, quarantined_at_unix, last_error
                     FROM temp_artifacts WHERE temp_path = ?1",
                    params![path.to_string_lossy()],
                    |row| {
                        let kind = row.get::<_, String>(1)?;
                        let state = row.get::<_, String>(6)?;
                        Ok(TempArtifactRecord {
                            id: row.get(0)?,
                            kind: TempArtifactKind::parse(&kind).unwrap_or(TempArtifactKind::Sync),
                            root_path: PathBuf::from(row.get::<_, String>(2)?),
                            temp_path: PathBuf::from(row.get::<_, String>(3)?),
                            original_path: PathBuf::from(row.get::<_, String>(4)?),
                            dest_path: PathBuf::from(row.get::<_, String>(5)?),
                            state: TempArtifactState::parse(&state)
                                .unwrap_or(TempArtifactState::RecoveryRequired),
                            created_at_unix: row.get(7)?,
                            updated_at_unix: row.get(8)?,
                            quarantined_at_unix: row.get(9)?,
                            last_error: row.get(10)?,
                        })
                    },
                )
                .optional()
        })
    }

    fn insert_record(&self, record: NewTempArtifactRecord<'_>) -> TempResult<()> {
        self.with_connection(|connection| {
            connection.execute(
                "INSERT INTO temp_artifacts
                 (id, kind, root_path, temp_path, original_path, dest_path, state,
                  created_at, updated_at, quarantined_at_unix)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8,
                         CASE WHEN ?7 = 'quarantined' THEN ?8 ELSE NULL END)",
                params![
                    record.id,
                    record.kind.as_str(),
                    record.root.to_string_lossy(),
                    record.temp_path.to_string_lossy(),
                    record.original_path.to_string_lossy(),
                    record.destination.to_string_lossy(),
                    record.state.as_str(),
                    record.now_unix,
                ],
            )?;
            Ok(())
        })
    }

    fn remove_record(&self, id: &str) -> TempResult<()> {
        self.with_connection(|connection| {
            connection.execute("DELETE FROM temp_artifacts WHERE id = ?1", params![id])?;
            Ok(())
        })
    }

    fn set_original_path(&self, id: &str, original_path: &Path) -> TempResult<()> {
        self.with_connection(|connection| {
            connection.execute(
                "UPDATE temp_artifacts
                 SET original_path = ?2, updated_at = ?3
                 WHERE id = ?1",
                params![
                    id,
                    original_path.to_string_lossy(),
                    system_time_seconds(SystemTime::now())
                ],
            )?;
            Ok(())
        })
    }

    fn transition(
        &self,
        id: &str,
        state: TempArtifactState,
        last_error: Option<&str>,
    ) -> TempResult<()> {
        self.with_connection(|connection| {
            connection.execute(
                "UPDATE temp_artifacts
                 SET state = ?2, updated_at = ?3, last_error = ?4
                 WHERE id = ?1",
                params![
                    id,
                    state.as_str(),
                    system_time_seconds(SystemTime::now()),
                    last_error
                ],
            )?;
            Ok(())
        })
    }

    fn quarantine_record(
        &self,
        record: Option<&TempArtifactRecord>,
        legacy_kind: TempArtifactKind,
        root: &Path,
        original_path: &Path,
        quarantine_path: &Path,
        now_unix: i64,
    ) -> TempResult<()> {
        let quarantine_path = quarantine_path.canonicalize()?;
        if let Some(record) = record {
            let relocated_original = record
                .original_path
                .strip_prefix(&record.temp_path)
                .map(|relative| quarantine_path.join(relative))
                .unwrap_or_else(|_| record.original_path.clone());
            return self.with_connection(|connection| {
                connection.execute(
                    "UPDATE temp_artifacts
                     SET temp_path = ?2, original_path = ?3, state = 'quarantined',
                         updated_at = ?4, quarantined_at_unix = ?4
                     WHERE id = ?1",
                    params![
                        record.id,
                        quarantine_path.to_string_lossy(),
                        relocated_original.to_string_lossy(),
                        now_unix
                    ],
                )?;
                Ok(())
            });
        }
        let id = unique_operation_id("legacy-temp");
        self.insert_record(NewTempArtifactRecord {
            id: &id,
            kind: legacy_kind,
            root,
            temp_path: &quarantine_path,
            original_path,
            destination: Path::new(""),
            state: TempArtifactState::Quarantined,
            now_unix,
        })
    }

    fn quarantined_records(&self) -> TempResult<Vec<TempArtifactRecord>> {
        self.with_connection(|connection| {
            let mut statement = connection.prepare(
                "SELECT id, kind, root_path, temp_path, original_path, dest_path,
                        state, created_at, updated_at, quarantined_at_unix, last_error
                 FROM temp_artifacts WHERE state = 'quarantined'",
            )?;
            let rows = statement
                .query_map([], |row| {
                    let kind = row.get::<_, String>(1)?;
                    let state = row.get::<_, String>(6)?;
                    Ok(TempArtifactRecord {
                        id: row.get(0)?,
                        kind: TempArtifactKind::parse(&kind).unwrap_or(TempArtifactKind::Sync),
                        root_path: PathBuf::from(row.get::<_, String>(2)?),
                        temp_path: PathBuf::from(row.get::<_, String>(3)?),
                        original_path: PathBuf::from(row.get::<_, String>(4)?),
                        dest_path: PathBuf::from(row.get::<_, String>(5)?),
                        state: TempArtifactState::parse(&state)
                            .unwrap_or(TempArtifactState::RecoveryRequired),
                        created_at_unix: row.get(7)?,
                        updated_at_unix: row.get(8)?,
                        quarantined_at_unix: row.get(9)?,
                        last_error: row.get(10)?,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
    }
}

pub(crate) struct CleanupRequest<'a> {
    pub(crate) registry: &'a TempArtifactRegistry,
    pub(crate) roots: &'a [PathBuf],
    pub(crate) quarantine_root: &'a Path,
    pub(crate) now: SystemTime,
    pub(crate) stale_after: Duration,
    pub(crate) quarantine_retention: Duration,
    pub(crate) dry_run: bool,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(crate) struct CleanupReport {
    pub(crate) found: usize,
    pub(crate) scanned: usize,
    pub(crate) removed: usize,
    pub(crate) quarantined: usize,
    pub(crate) deferred: usize,
    pub(crate) purged: usize,
    pub(crate) failed: usize,
    pub(crate) log: Vec<String>,
}

impl CleanupReport {
    pub(crate) fn task_summary(&self) -> String {
        format!(
            "found={} removed={} quarantined={} deferred={} failed={}",
            self.found, self.removed, self.quarantined, self.deferred, self.failed
        )
    }
}

pub(crate) struct TempArtifactGuard {
    registry: TempArtifactRegistry,
    id: String,
    path: PathBuf,
    destination: PathBuf,
    state: TempArtifactState,
    armed: bool,
}

impl TempArtifactGuard {
    pub(crate) fn create(
        registry: TempArtifactRegistry,
        root: &Path,
        destination: &Path,
        name: &str,
        kind: TempArtifactKind,
    ) -> TempResult<Self> {
        validate_skill_directory_name(name).map_err(TempArtifactError::InvalidPath)?;
        fs::create_dir_all(root)?;
        let canonical_root = root.canonicalize()?;
        let destination_parent = destination.parent().ok_or_else(|| {
            TempArtifactError::InvalidPath(format!(
                "destination has no parent: {}",
                destination.display()
            ))
        })?;
        let canonical_parent = destination_parent.canonicalize()?;
        if canonical_parent != canonical_root {
            return Err(TempArtifactError::InvalidPath(format!(
                "destination escapes temp root: {}",
                destination.display()
            )));
        }
        if destination.file_name().and_then(|value| value.to_str()) != Some(name) {
            return Err(TempArtifactError::InvalidPath(format!(
                "destination name does not match Skill name: {}",
                destination.display()
            )));
        }
        let destination = canonical_parent.join(name);

        for _ in 0..16 {
            let id = unique_operation_id(kind.as_str());
            let operation_component = unique_operation_id(name);
            let path = canonical_root.join(format!(".{operation_component}-{}-tmp", kind.as_str()));
            match fs::create_dir(&path) {
                Ok(()) => {
                    let now = system_time_seconds(SystemTime::now());
                    if let Err(error) = registry.insert_record(NewTempArtifactRecord {
                        id: &id,
                        kind,
                        root: &canonical_root,
                        temp_path: &path,
                        original_path: &path,
                        destination: &destination,
                        state: TempArtifactState::Building,
                        now_unix: now,
                    }) {
                        let _ = fs::remove_dir(&path);
                        return Err(error);
                    }
                    return Ok(Self {
                        registry,
                        id,
                        path,
                        destination,
                        state: TempArtifactState::Building,
                        armed: true,
                    });
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error.into()),
            }
        }
        Err(TempArtifactError::InvalidPath(
            "could not allocate a unique temp directory".to_string(),
        ))
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    pub(crate) fn payload_path(&self) -> PathBuf {
        self.path.join("payload")
    }

    pub(crate) fn destination(&self) -> &Path {
        &self.destination
    }

    pub(crate) fn record_original_path(&self, original_path: &Path) -> TempResult<()> {
        self.registry.set_original_path(&self.id, original_path)
    }

    pub(crate) fn mark_ready(&mut self) -> TempResult<()> {
        if self.state != TempArtifactState::Building {
            return Err(TempArtifactError::InvalidState(format!(
                "cannot mark {:?} temp ready",
                self.state
            )));
        }
        self.registry
            .transition(&self.id, TempArtifactState::Ready, None)?;
        self.state = TempArtifactState::Ready;
        Ok(())
    }

    pub(crate) fn mark_replacing(&mut self) -> TempResult<()> {
        if self.state != TempArtifactState::Ready {
            return Err(TempArtifactError::InvalidState(format!(
                "cannot mark {:?} temp replacing",
                self.state
            )));
        }
        self.registry
            .transition(&self.id, TempArtifactState::Replacing, None)?;
        self.state = TempArtifactState::Replacing;
        Ok(())
    }

    pub(crate) fn mark_recovery_required(&mut self, error: &str) -> TempResult<()> {
        if matches!(
            self.state,
            TempArtifactState::Completed | TempArtifactState::Quarantined
        ) {
            return Err(TempArtifactError::InvalidState(format!(
                "cannot preserve {:?} temp for recovery",
                self.state
            )));
        }
        self.registry
            .transition(&self.id, TempArtifactState::RecoveryRequired, Some(error))?;
        self.state = TempArtifactState::RecoveryRequired;
        Ok(())
    }

    pub(crate) fn mark_completed(mut self) -> TempResult<()> {
        if self.state != TempArtifactState::Replacing {
            return Err(TempArtifactError::InvalidState(format!(
                "cannot complete {:?} temp",
                self.state
            )));
        }
        match fs::symlink_metadata(&self.path) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
                fs::remove_dir_all(&self.path)?;
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Ok(_) => {
                return Err(TempArtifactError::InvalidPath(
                    "refusing to remove non-directory completed temp artifact".to_string(),
                ));
            }
            Err(error) => return Err(error.into()),
        }
        self.registry
            .transition(&self.id, TempArtifactState::Completed, None)?;
        self.state = TempArtifactState::Completed;
        self.registry.remove_record(&self.id)?;
        self.armed = false;
        Ok(())
    }

    pub(crate) fn mark_rolled_back(mut self) -> TempResult<()> {
        if self.state != TempArtifactState::Replacing {
            return Err(TempArtifactError::InvalidState(format!(
                "cannot roll back {:?} temp",
                self.state
            )));
        }

        let cleanup = match fs::symlink_metadata(&self.path) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
                fs::remove_dir_all(&self.path)
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Ok(_) => Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "refusing to remove non-directory temp artifact after rollback",
            )),
            Err(error) => Err(error),
        };

        if let Err(error) = cleanup {
            let message = format!("rollback restored destination but temp cleanup failed: {error}");
            self.registry.transition(
                &self.id,
                TempArtifactState::RecoveryRequired,
                Some(&message),
            )?;
            self.state = TempArtifactState::RecoveryRequired;
            return Err(TempArtifactError::Io(error));
        }

        self.registry
            .transition(&self.id, TempArtifactState::Completed, None)?;
        self.state = TempArtifactState::Completed;
        self.registry.remove_record(&self.id)?;
        self.armed = false;
        Ok(())
    }
}

impl Drop for TempArtifactGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        match self.state {
            TempArtifactState::Building | TempArtifactState::Ready => {
                let cleanup = match fs::symlink_metadata(&self.path) {
                    Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
                        fs::remove_dir_all(&self.path)
                    }
                    Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
                    Ok(_) => Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "refusing to remove non-directory temp artifact",
                    )),
                    Err(error) => Err(error),
                };
                match cleanup {
                    Ok(()) => {
                        let _ = self.registry.remove_record(&self.id);
                    }
                    Err(error) => {
                        let _ = self.registry.transition(
                            &self.id,
                            self.state,
                            Some(&format!("RAII cleanup failed: {error}")),
                        );
                    }
                }
            }
            TempArtifactState::Replacing => {
                let _ = self.registry.transition(
                    &self.id,
                    TempArtifactState::RecoveryRequired,
                    Some("operation ended during destination replacement"),
                );
            }
            TempArtifactState::Completed => {
                let _ = self.registry.remove_record(&self.id);
            }
            TempArtifactState::RecoveryRequired | TempArtifactState::Quarantined => {}
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct FilesystemMutationLock {
    path: PathBuf,
}

#[derive(Debug)]
pub(crate) struct FilesystemMutationGuard {
    file: File,
}

impl FilesystemMutationLock {
    pub(crate) fn new(data_dir: &Path) -> io::Result<Self> {
        fs::create_dir_all(data_dir)?;
        Ok(Self {
            path: data_dir.join("skill-filesystem.lock"),
        })
    }

    pub(crate) fn acquire(&self) -> io::Result<FilesystemMutationGuard> {
        let file = self.open_file()?;
        lock_file(&file, false)?;
        Ok(FilesystemMutationGuard { file })
    }

    pub(crate) fn try_acquire(&self) -> io::Result<Option<FilesystemMutationGuard>> {
        let file = self.open_file()?;
        match lock_file(&file, true) {
            Ok(()) => Ok(Some(FilesystemMutationGuard { file })),
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => Ok(None),
            Err(error) => Err(error),
        }
    }

    fn open_file(&self) -> io::Result<File> {
        OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&self.path)
    }
}

#[cfg(unix)]
fn lock_file(file: &File, nonblocking: bool) -> io::Result<()> {
    let operation = libc::LOCK_EX | if nonblocking { libc::LOCK_NB } else { 0 };
    // SAFETY: flock only reads the valid descriptor and operation flags.
    let result = unsafe { libc::flock(file.as_raw_fd(), operation) };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(not(unix))]
fn lock_file(_file: &File, _nonblocking: bool) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "filesystem mutation locks are only implemented on Unix",
    ))
}

impl Drop for FilesystemMutationGuard {
    fn drop(&mut self) {
        #[cfg(unix)]
        {
            // SAFETY: the descriptor stays valid for the duration of this call.
            let _ = unsafe { libc::flock(self.file.as_raw_fd(), libc::LOCK_UN) };
        }
    }
}

pub(crate) fn unique_operation_id(prefix: &str) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    operation_id_at(prefix, nanos)
}

fn operation_id_at(prefix: &str, nanos: u128) -> String {
    let sequence = OPERATION_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}-{nanos:019}-{sequence}")
}

pub(crate) fn validate_skill_directory_name(value: &str) -> Result<(), String> {
    if value.is_empty() || value.contains(['/', '\\', '\0']) {
        return Err("Skill name must be one path component".to_string());
    }
    let mut components = Path::new(value).components();
    match (components.next(), components.next()) {
        (Some(Component::Normal(component)), None) if component == value => Ok(()),
        _ => Err("Skill name must be one normal path component".to_string()),
    }
}

pub(crate) fn parse_legacy_temp_name(value: &str) -> Option<LegacyTempName> {
    let value = value.strip_prefix('.')?;
    let (stem, kind) = if let Some(stem) = value.strip_suffix("-install-tmp") {
        (stem, TempArtifactKind::Install)
    } else if let Some(stem) = value.strip_suffix("-sync-tmp") {
        (stem, TempArtifactKind::Sync)
    } else {
        return None;
    };
    let (slug, timestamp) = stem.rsplit_once('-')?;
    if validate_skill_directory_name(slug).is_err()
        || timestamp.len() != 19
        || !timestamp.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    Some(LegacyTempName {
        slug: slug.to_string(),
        kind,
    })
}

pub(crate) fn classify_sync_destination(
    source: &Path,
    destination: &Path,
) -> io::Result<SyncDestination> {
    let metadata = match fs::symlink_metadata(destination) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(SyncDestination::Missing)
        }
        Err(error) => return Err(error),
    };
    if !metadata.file_type().is_symlink() {
        return Ok(SyncDestination::Normal);
    }

    let target = fs::read_link(destination)?;
    let canonical_source = source.canonicalize()?;
    match destination.canonicalize() {
        Ok(canonical_destination) if canonical_destination == canonical_source => {
            Ok(SyncDestination::SameSourceSymlink)
        }
        Ok(_) => Ok(SyncDestination::OtherSymlink { target }),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            Ok(SyncDestination::BrokenSymlink { target })
        }
        Err(error) => Err(error),
    }
}

#[cfg(unix)]
fn is_cross_device_rename(error: &io::Error) -> bool {
    error.raw_os_error() == Some(libc::EXDEV)
}

#[cfg(not(unix))]
fn is_cross_device_rename(_error: &io::Error) -> bool {
    false
}

fn record_quarantine_rename_failure(
    report: &mut CleanupReport,
    candidate: &Path,
    quarantine_path: &Path,
    error: &io::Error,
) {
    if is_cross_device_rename(error) {
        report.deferred += 1;
        report.log.push(format!(
            "defer cross-filesystem quarantine {} -> {}; move this directory to the quarantine path manually: {error}",
            candidate.display(),
            quarantine_path.display()
        ));
    } else {
        report.failed += 1;
        report.log.push(format!(
            "quarantine rename failed {} -> {}: {error}",
            candidate.display(),
            quarantine_path.display()
        ));
    }
}

pub(crate) fn cleanup_stale_temp_artifacts(
    request: CleanupRequest<'_>,
) -> TempResult<CleanupReport> {
    let mut report = CleanupReport::default();
    let now_unix = system_time_seconds(request.now);
    let stale_seconds = request.stale_after.as_secs().min(i64::MAX as u64) as i64;
    let mut visited_roots = HashSet::new();

    for configured_root in request.roots {
        let configured_metadata = match fs::symlink_metadata(configured_root) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => {
                report.failed += 1;
                report.log.push(format!(
                    "cleanup root metadata unavailable {}: {error}",
                    configured_root.display()
                ));
                continue;
            }
        };
        if configured_metadata.file_type().is_symlink() {
            report.log.push(format!(
                "skip symlinked cleanup root {}",
                configured_root.display()
            ));
            continue;
        }
        let root = match configured_root.canonicalize() {
            Ok(root) => root,
            Err(error) => {
                report.failed += 1;
                report.log.push(format!(
                    "cleanup root unavailable {}: {error}",
                    configured_root.display()
                ));
                continue;
            }
        };
        if !visited_roots.insert(root.clone()) {
            continue;
        }
        let entries = match fs::read_dir(&root) {
            Ok(entries) => entries,
            Err(error) => {
                report.failed += 1;
                report.log.push(format!(
                    "cleanup root unreadable {}: {error}",
                    root.display()
                ));
                continue;
            }
        };
        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) => {
                    report.failed += 1;
                    report
                        .log
                        .push(format!("cleanup entry unreadable: {error}"));
                    continue;
                }
            };
            let candidate = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            let metadata = match fs::symlink_metadata(&candidate) {
                Ok(metadata) => metadata,
                Err(error) => {
                    report.failed += 1;
                    report.log.push(format!(
                        "cleanup metadata failed {}: {error}",
                        candidate.display()
                    ));
                    continue;
                }
            };
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                continue;
            }
            let record = match request.registry.record_for_path(&candidate) {
                Ok(record) => record,
                Err(error) => {
                    report.failed += 1;
                    report.log.push(format!(
                        "cleanup registry lookup failed {}: {error}",
                        candidate.display()
                    ));
                    continue;
                }
            };
            if let Some(record) = &record {
                let destination_is_contained = record.dest_path.parent() == Some(root.as_path());
                if record.root_path != root || !destination_is_contained {
                    report.failed += 1;
                    report.log.push(format!(
                        "refuse registered temp with inconsistent containment {}",
                        candidate.display()
                    ));
                    continue;
                }
            }
            let legacy_name = parse_legacy_temp_name(&name);
            if record.is_none() && legacy_name.is_none() {
                continue;
            }
            report.scanned += 1;
            report.found += 1;
            let modified_unix = match metadata.modified() {
                Ok(modified) => system_time_seconds(modified),
                Err(error) => {
                    report.failed += 1;
                    report.log.push(format!(
                        "cleanup mtime unavailable {}: {error}",
                        candidate.display()
                    ));
                    continue;
                }
            };
            let effective_modified = record
                .as_ref()
                .map(|record| {
                    record
                        .created_at_unix
                        .max(record.updated_at_unix)
                        .max(modified_unix)
                })
                .unwrap_or(modified_unix);
            if effective_modified > now_unix || now_unix - effective_modified < stale_seconds {
                report.deferred += 1;
                report
                    .log
                    .push(format!("defer young temp {}", candidate.display()));
                continue;
            }

            let can_remove = record.as_ref().is_some_and(|record| {
                matches!(
                    record.state,
                    TempArtifactState::Building | TempArtifactState::Ready
                )
            });
            if can_remove {
                if request.dry_run {
                    report.removed += 1;
                    report.log.push(format!(
                        "would remove registered temp {}",
                        candidate.display()
                    ));
                    continue;
                }
                match fs::remove_dir_all(&candidate) {
                    Ok(()) => {
                        if let Some(record) = &record {
                            if let Err(error) = request.registry.remove_record(&record.id) {
                                report.failed += 1;
                                report.log.push(format!(
                                    "removed temp but registry cleanup failed {}: {error}",
                                    candidate.display()
                                ));
                                continue;
                            }
                        }
                        report.removed += 1;
                        report
                            .log
                            .push(format!("removed registered temp {}", candidate.display()));
                    }
                    Err(error) => {
                        report.failed += 1;
                        report.log.push(format!(
                            "remove registered temp failed {}: {error}",
                            candidate.display()
                        ));
                    }
                }
                continue;
            }

            let quarantine_path = request
                .quarantine_root
                .join(unique_operation_id("orphan-temp"));
            if request.dry_run {
                report.quarantined += 1;
                report
                    .log
                    .push(format!("would quarantine temp {}", candidate.display()));
                continue;
            }
            if let Err(error) = fs::create_dir_all(request.quarantine_root) {
                report.failed += 1;
                report.log.push(format!(
                    "create quarantine failed {}: {error}",
                    request.quarantine_root.display()
                ));
                continue;
            }
            match fs::rename(&candidate, &quarantine_path) {
                Ok(()) => match request.registry.quarantine_record(
                    record.as_ref(),
                    record
                        .as_ref()
                        .map(|record| record.kind)
                        .or_else(|| legacy_name.as_ref().map(|name| name.kind))
                        .unwrap_or(TempArtifactKind::Sync),
                    &root,
                    &candidate,
                    &quarantine_path,
                    now_unix,
                ) {
                    Ok(()) => {
                        report.quarantined += 1;
                        report.log.push(format!(
                            "quarantined temp {} -> {}{}",
                            candidate.display(),
                            quarantine_path.display(),
                            record
                                .as_ref()
                                .and_then(|record| record.last_error.as_deref())
                                .map(|error| format!(" (recovery reason: {error})"))
                                .unwrap_or_default()
                        ));
                    }
                    Err(error) => {
                        let _ = fs::rename(&quarantine_path, &candidate);
                        report.failed += 1;
                        report.log.push(format!(
                            "quarantine registry update failed {}: {error}",
                            candidate.display()
                        ));
                    }
                },
                Err(error) => {
                    record_quarantine_rename_failure(
                        &mut report,
                        &candidate,
                        &quarantine_path,
                        &error,
                    );
                }
            }
        }
    }

    purge_expired_quarantine(&request, now_unix, &mut report)?;
    Ok(report)
}

fn purge_expired_quarantine(
    request: &CleanupRequest<'_>,
    now_unix: i64,
    report: &mut CleanupReport,
) -> TempResult<()> {
    let retention_seconds = request.quarantine_retention.as_secs().min(i64::MAX as u64) as i64;
    let quarantine_root = match request.quarantine_root.canonicalize() {
        Ok(path) => Some(path),
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => {
            report.failed += 1;
            report.log.push(format!(
                "quarantine root unavailable {}: {error}",
                request.quarantine_root.display()
            ));
            None
        }
    };
    for record in request.registry.quarantined_records()? {
        let Some(quarantined_at) = record.quarantined_at_unix else {
            continue;
        };
        if quarantined_at > now_unix || now_unix - quarantined_at < retention_seconds {
            continue;
        }
        let Some(root) = quarantine_root.as_ref() else {
            continue;
        };
        if record.temp_path.parent() != Some(root.as_path()) {
            report.failed += 1;
            report.log.push(format!(
                "refuse quarantine path outside root {}",
                record.temp_path.display()
            ));
            continue;
        }
        if request.dry_run {
            report.purged += 1;
            continue;
        }
        match fs::symlink_metadata(&record.temp_path) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
                if let Err(error) = fs::remove_dir_all(&record.temp_path) {
                    report.failed += 1;
                    report.log.push(format!(
                        "purge quarantine failed {}: {error}",
                        record.temp_path.display()
                    ));
                    continue;
                }
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Ok(_) => {
                report.failed += 1;
                report.log.push(format!(
                    "refuse non-directory quarantine {}",
                    record.temp_path.display()
                ));
                continue;
            }
            Err(error) => {
                report.failed += 1;
                report.log.push(format!(
                    "quarantine metadata failed {}: {error}",
                    record.temp_path.display()
                ));
                continue;
            }
        }
        request.registry.remove_record(&record.id)?;
        report.purged += 1;
        report.removed += 1;
        report.log.push(format!(
            "purged quarantined temp {}",
            record.temp_path.display()
        ));
    }
    Ok(())
}

fn system_time_seconds(time: SystemTime) -> i64 {
    match time.duration_since(UNIX_EPOCH) {
        Ok(duration) => duration.as_secs().min(i64::MAX as u64) as i64,
        Err(error) => -(error.duration().as_secs().min(i64::MAX as u64) as i64),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skill_directory_name_must_be_one_normal_component() {
        assert!(validate_skill_directory_name("demo-skill").is_ok());
        assert!(validate_skill_directory_name("中文 Skill").is_ok());

        for invalid in ["", ".", "..", "../escape", "nested/skill", "/absolute"] {
            assert!(
                validate_skill_directory_name(invalid).is_err(),
                "{invalid} should be rejected"
            );
        }
    }

    #[test]
    fn legacy_temp_name_matches_only_the_historic_suffix_format() {
        let parsed = parse_legacy_temp_name(".web-access-1787707160032652000-sync-tmp")
            .expect("historic sync temp should match");
        assert_eq!(parsed.slug, "web-access");
        assert_eq!(parsed.kind, TempArtifactKind::Sync);

        let install = parse_legacy_temp_name(".demo-1787707160032652000-install-tmp")
            .expect("historic install temp should match");
        assert_eq!(install.kind, TempArtifactKind::Install);

        for valid in [
            ".web.access-1787707160032652000-sync-tmp",
            ".中文 Skill-1787707160032652000-sync-tmp",
        ] {
            assert!(
                parse_legacy_temp_name(valid).is_some(),
                "{valid} should preserve a valid historic Skill name"
            );
        }

        for invalid in [
            "web-access-1787707160032652000-sync-tmp",
            ".web-access-sync-tmp-1787707160032652000",
            ".web-access-178770716003265200-sync-tmp",
            ".web-access-17877071600326520000-sync-tmp",
            ".web-access-1787707160032652000-sync-tmp-extra",
            "..-1787707160032652000-sync-tmp",
            ".nested/skill-1787707160032652000-sync-tmp",
        ] {
            assert!(
                parse_legacy_temp_name(invalid).is_none(),
                "{invalid} must not match"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn sync_destination_distinguishes_same_other_broken_and_normal_paths() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        let other = root.path().join("other");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::create_dir_all(&other).unwrap();

        let same_link = root.path().join("same-link");
        symlink(&source, &same_link).unwrap();
        assert_eq!(
            classify_sync_destination(&source, &same_link).unwrap(),
            SyncDestination::SameSourceSymlink
        );

        let other_link = root.path().join("other-link");
        symlink(&other, &other_link).unwrap();
        assert!(matches!(
            classify_sync_destination(&source, &other_link).unwrap(),
            SyncDestination::OtherSymlink { .. }
        ));

        let broken_link = root.path().join("broken-link");
        symlink("missing", &broken_link).unwrap();
        assert!(matches!(
            classify_sync_destination(&source, &broken_link).unwrap(),
            SyncDestination::BrokenSymlink { .. }
        ));

        assert_eq!(
            classify_sync_destination(&source, &other).unwrap(),
            SyncDestination::Normal
        );
        assert_eq!(
            classify_sync_destination(&source, &root.path().join("missing")).unwrap(),
            SyncDestination::Missing
        );
    }

    #[test]
    fn filesystem_mutation_lock_excludes_a_second_holder() {
        let root = tempfile::tempdir().unwrap();
        let lock = FilesystemMutationLock::new(root.path()).unwrap();
        let contender = FilesystemMutationLock::new(root.path()).unwrap();

        let held = lock.acquire().unwrap();
        assert!(contender.try_acquire().unwrap().is_none());

        drop(held);
        assert!(contender.try_acquire().unwrap().is_some());
    }

    #[test]
    fn operation_ids_remain_unique_with_the_same_nanosecond_and_concurrently() {
        use std::collections::HashSet;

        let first = operation_id_at("sync", 1_787_707_160_032_652_000);
        let second = operation_id_at("sync", 1_787_707_160_032_652_000);
        assert_ne!(first, second);
        assert!(first.starts_with("sync-1787707160032652000-"));

        let handles = (0..32)
            .map(|_| std::thread::spawn(|| unique_operation_id("task")))
            .collect::<Vec<_>>();
        let ids = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect::<HashSet<_>>();
        assert_eq!(ids.len(), 32);
    }

    #[cfg(unix)]
    #[test]
    fn startup_cleanup_quarantines_only_stale_direct_legacy_directories() {
        use std::{ffi::CString, os::unix::ffi::OsStrExt, time::Duration};

        fn set_mtime(path: &Path, seconds: i64) {
            let path = CString::new(path.as_os_str().as_bytes()).unwrap();
            let times = [
                libc::timespec {
                    tv_sec: seconds,
                    tv_nsec: 0,
                },
                libc::timespec {
                    tv_sec: seconds,
                    tv_nsec: 0,
                },
            ];
            // SAFETY: path and times point to valid values for this call.
            assert_eq!(
                unsafe { libc::utimensat(libc::AT_FDCWD, path.as_ptr(), times.as_ptr(), 0) },
                0
            );
        }

        let sandbox = tempfile::tempdir().unwrap();
        let root = sandbox.path().join("skills");
        let quarantine = sandbox.path().join("app-data").join("temp-quarantine");
        std::fs::create_dir_all(&root).unwrap();
        let stale = root.join(".old-1787707160032652000-sync-tmp");
        let young = root.join(".young-1787707160032652001-sync-tmp");
        let near_match = root.join(".near-1787707160032652000-sync-tmp-extra");
        let nested = root
            .join("nested")
            .join(".nested-1787707160032652000-sync-tmp");
        for path in [&stale, &young, &near_match, &nested] {
            std::fs::create_dir_all(path).unwrap();
        }

        let now_seconds = 2_000_000_000_i64;
        set_mtime(&stale, now_seconds - 24 * 60 * 60);
        set_mtime(&young, now_seconds - 24 * 60 * 60 + 1);
        set_mtime(&near_match, now_seconds - 30 * 60 * 60);
        set_mtime(&nested, now_seconds - 30 * 60 * 60);

        let registry = TempArtifactRegistry::open(&sandbox.path().join("registry.sqlite")).unwrap();
        let report = cleanup_stale_temp_artifacts(CleanupRequest {
            registry: &registry,
            roots: std::slice::from_ref(&root),
            quarantine_root: &quarantine,
            now: UNIX_EPOCH + Duration::from_secs(now_seconds as u64),
            stale_after: Duration::from_secs(24 * 60 * 60),
            quarantine_retention: Duration::from_secs(30 * 24 * 60 * 60),
            dry_run: false,
        })
        .unwrap();

        assert_eq!(report.quarantined, 1);
        assert_eq!(report.deferred, 1);
        assert!(!stale.exists());
        assert!(young.exists());
        assert!(near_match.exists());
        assert!(nested.exists());
        assert_eq!(std::fs::read_dir(quarantine).unwrap().count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn all_observed_legacy_sync_temp_names_are_quarantined_as_fixtures() {
        use std::{ffi::CString, os::unix::ffi::OsStrExt, time::Duration};

        fn set_mtime(path: &Path, seconds: i64) {
            let path = CString::new(path.as_os_str().as_bytes()).unwrap();
            let times = [
                libc::timespec {
                    tv_sec: seconds,
                    tv_nsec: 0,
                },
                libc::timespec {
                    tv_sec: seconds,
                    tv_nsec: 0,
                },
            ];
            assert_eq!(
                unsafe { libc::utimensat(libc::AT_FDCWD, path.as_ptr(), times.as_ptr(), 0) },
                0
            );
        }

        let observed = [
            ".guizang-social-card-skill-1781954021575873000-sync-tmp",
            ".guizang-social-card-skill-1781954033571372000-sync-tmp",
            ".guizang-social-card-skill-1781954034352540000-sync-tmp",
            ".orange-line-illustration-1782973572307152000-sync-tmp",
            ".orange-line-illustration-1783061214429562000-sync-tmp",
            ".orange-line-illustration-1783063504868587000-sync-tmp",
            ".orange-line-illustration-1783478005813765000-sync-tmp",
            ".skill-creator-1785246797438258000-sync-tmp",
            ".skill-creator-1785246797441480000-sync-tmp",
            ".web-access-1786063378800783000-sync-tmp",
            ".web-access-1787707148206260000-sync-tmp",
            ".web-access-1787707160032652000-sync-tmp",
        ];
        let sandbox = tempfile::tempdir().unwrap();
        let root = sandbox.path().join("skills");
        let quarantine = sandbox.path().join("quarantine");
        std::fs::create_dir_all(&root).unwrap();
        let now_seconds = 2_000_000_000_i64;
        for name in observed {
            assert!(parse_legacy_temp_name(name).is_some(), "fixture {name}");
            let candidate = root.join(name);
            std::fs::create_dir(&candidate).unwrap();
            set_mtime(&candidate, now_seconds - 25 * 60 * 60);
        }

        let registry = TempArtifactRegistry::open(&sandbox.path().join("registry.sqlite")).unwrap();
        let report = cleanup_stale_temp_artifacts(CleanupRequest {
            registry: &registry,
            roots: std::slice::from_ref(&root),
            quarantine_root: &quarantine,
            now: UNIX_EPOCH + Duration::from_secs(now_seconds as u64),
            stale_after: Duration::from_secs(24 * 60 * 60),
            quarantine_retention: Duration::from_secs(30 * 24 * 60 * 60),
            dry_run: false,
        })
        .unwrap();

        assert_eq!(report.found, observed.len());
        assert_eq!(report.quarantined, observed.len());
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 0);
        assert_eq!(
            std::fs::read_dir(&quarantine).unwrap().count(),
            observed.len()
        );
    }

    #[cfg(unix)]
    #[test]
    fn cleanup_skips_future_files_and_symlinks_and_continues_after_root_error() {
        use std::{ffi::CString, os::unix::ffi::OsStrExt, os::unix::fs::symlink};

        fn set_mtime(path: &Path, seconds: i64) {
            let path = CString::new(path.as_os_str().as_bytes()).unwrap();
            let times = [
                libc::timespec {
                    tv_sec: seconds,
                    tv_nsec: 0,
                },
                libc::timespec {
                    tv_sec: seconds,
                    tv_nsec: 0,
                },
            ];
            assert_eq!(
                unsafe { libc::utimensat(libc::AT_FDCWD, path.as_ptr(), times.as_ptr(), 0) },
                0
            );
        }

        let sandbox = tempfile::tempdir().unwrap();
        let root = sandbox.path().join("skills");
        let quarantine = sandbox.path().join("quarantine");
        std::fs::create_dir_all(&root).unwrap();
        let now_seconds = 2_000_000_000_i64;
        let stale = root.join(".stale-1787707160032652000-sync-tmp");
        let future = root.join(".future-1787707160032652000-sync-tmp");
        let regular_file = root.join(".file-1787707160032652000-sync-tmp");
        let external = sandbox.path().join("external");
        let symlink_candidate = root.join(".link-1787707160032652000-sync-tmp");
        std::fs::create_dir(&stale).unwrap();
        std::fs::create_dir(&future).unwrap();
        std::fs::write(&regular_file, "not a directory").unwrap();
        std::fs::create_dir(&external).unwrap();
        symlink(&external, &symlink_candidate).unwrap();
        set_mtime(&stale, now_seconds - 25 * 60 * 60);
        set_mtime(&future, now_seconds + 60);

        let unreadable_root = sandbox.path().join("not-a-directory");
        std::fs::write(&unreadable_root, "file").unwrap();
        let registry = TempArtifactRegistry::open(&sandbox.path().join("registry.sqlite")).unwrap();
        let report = cleanup_stale_temp_artifacts(CleanupRequest {
            registry: &registry,
            roots: &[unreadable_root, root.clone()],
            quarantine_root: &quarantine,
            now: UNIX_EPOCH + Duration::from_secs(now_seconds as u64),
            stale_after: Duration::from_secs(24 * 60 * 60),
            quarantine_retention: Duration::from_secs(30 * 24 * 60 * 60),
            dry_run: false,
        })
        .unwrap();

        assert_eq!(report.failed, 1);
        assert_eq!(report.quarantined, 1);
        assert_eq!(report.deferred, 1);
        assert!(!stale.exists());
        assert!(future.exists());
        assert!(regular_file.exists());
        assert!(symlink_candidate
            .symlink_metadata()
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(external.exists());
    }

    #[cfg(unix)]
    #[test]
    fn startup_cleanup_never_follows_a_symlinked_scan_root() {
        use std::{ffi::CString, os::unix::ffi::OsStrExt, os::unix::fs::symlink, time::Duration};

        fn set_mtime(path: &Path, seconds: i64) {
            let path = CString::new(path.as_os_str().as_bytes()).unwrap();
            let times = [
                libc::timespec {
                    tv_sec: seconds,
                    tv_nsec: 0,
                },
                libc::timespec {
                    tv_sec: seconds,
                    tv_nsec: 0,
                },
            ];
            assert_eq!(
                unsafe { libc::utimensat(libc::AT_FDCWD, path.as_ptr(), times.as_ptr(), 0) },
                0
            );
        }

        let sandbox = tempfile::tempdir().unwrap();
        let external_root = sandbox.path().join("cc-switch-skills");
        let configured_root = sandbox.path().join("codex-skills");
        let quarantine = sandbox.path().join("quarantine");
        std::fs::create_dir_all(&external_root).unwrap();
        symlink(&external_root, &configured_root).unwrap();
        let stale = external_root.join(".external-1787707160032652000-sync-tmp");
        std::fs::create_dir(&stale).unwrap();
        let now_seconds = 2_000_000_000_i64;
        set_mtime(&stale, now_seconds - 25 * 60 * 60);

        let registry = TempArtifactRegistry::open(&sandbox.path().join("registry.sqlite")).unwrap();
        let report = cleanup_stale_temp_artifacts(CleanupRequest {
            registry: &registry,
            roots: std::slice::from_ref(&configured_root),
            quarantine_root: &quarantine,
            now: UNIX_EPOCH + Duration::from_secs(now_seconds as u64),
            stale_after: Duration::from_secs(24 * 60 * 60),
            quarantine_retention: Duration::from_secs(30 * 24 * 60 * 60),
            dry_run: false,
        })
        .unwrap();

        assert_eq!(report.found, 0);
        assert_eq!(report.quarantined, 0);
        assert_eq!(report.failed, 0);
        assert!(stale.exists());
        assert!(configured_root
            .symlink_metadata()
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(!quarantine.exists());
    }

    #[cfg(unix)]
    #[test]
    fn cross_filesystem_quarantine_is_deferred_with_an_explicit_manual_path() {
        let mut report = CleanupReport::default();
        let candidate = Path::new("/Volumes/external/.demo-1787707160032652000-sync-tmp");
        let quarantine =
            Path::new("/Users/example/Library/Application Support/app/temp-quarantine");

        record_quarantine_rename_failure(
            &mut report,
            candidate,
            quarantine,
            &io::Error::from_raw_os_error(libc::EXDEV),
        );

        assert_eq!(report.deferred, 1);
        assert_eq!(report.failed, 0);
        assert!(report.log[0].contains("cross-filesystem"));
        assert!(report.log[0].contains(&candidate.to_string_lossy().to_string()));
        assert!(report.log[0].contains(&quarantine.to_string_lossy().to_string()));
    }

    #[cfg(unix)]
    #[test]
    fn startup_cleanup_removes_safe_registered_states_and_quarantines_recovery() {
        use std::{ffi::CString, os::unix::ffi::OsStrExt, time::Duration};

        fn set_mtime(path: &Path, seconds: i64) {
            let path = CString::new(path.as_os_str().as_bytes()).unwrap();
            let times = [
                libc::timespec {
                    tv_sec: seconds,
                    tv_nsec: 0,
                },
                libc::timespec {
                    tv_sec: seconds,
                    tv_nsec: 0,
                },
            ];
            assert_eq!(
                unsafe { libc::utimensat(libc::AT_FDCWD, path.as_ptr(), times.as_ptr(), 0) },
                0
            );
        }

        let sandbox = tempfile::tempdir().unwrap();
        let root = sandbox.path().join("skills");
        std::fs::create_dir_all(&root).unwrap();
        let registry = TempArtifactRegistry::open(&sandbox.path().join("registry.sqlite")).unwrap();

        let building = TempArtifactGuard::create(
            registry.clone(),
            &root,
            &root.join("building"),
            "building",
            TempArtifactKind::Sync,
        )
        .unwrap();
        let building_path = building.path().to_path_buf();
        std::mem::forget(building);

        let mut ready = TempArtifactGuard::create(
            registry.clone(),
            &root,
            &root.join("ready"),
            "ready",
            TempArtifactKind::Install,
        )
        .unwrap();
        ready.mark_ready().unwrap();
        let ready_path = ready.path().to_path_buf();
        std::mem::forget(ready);

        let mut recovery = TempArtifactGuard::create(
            registry.clone(),
            &root,
            &root.join("recovery"),
            "recovery",
            TempArtifactKind::Sync,
        )
        .unwrap();
        recovery
            .mark_recovery_required("destination rollback failed")
            .unwrap();
        let recovery_path = recovery.path().to_path_buf();
        std::mem::forget(recovery);

        let now_seconds = 2_000_000_000_i64;
        for path in [&building_path, &ready_path, &recovery_path] {
            set_mtime(path, now_seconds - 24 * 60 * 60);
        }
        let quarantine = sandbox.path().join("quarantine");
        let report = cleanup_stale_temp_artifacts(CleanupRequest {
            registry: &registry,
            roots: std::slice::from_ref(&root),
            quarantine_root: &quarantine,
            now: UNIX_EPOCH + Duration::from_secs(now_seconds as u64),
            stale_after: Duration::from_secs(24 * 60 * 60),
            quarantine_retention: Duration::from_secs(30 * 24 * 60 * 60),
            dry_run: false,
        })
        .unwrap();

        assert_eq!(report.removed, 2);
        assert_eq!(report.quarantined, 1);
        assert!(!building_path.exists());
        assert!(!ready_path.exists());
        assert!(!recovery_path.exists());
        let quarantined_path = std::fs::read_dir(&quarantine)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path()
            .canonicalize()
            .unwrap();
        let quarantined_record = registry
            .record_for_path(&quarantined_path)
            .unwrap()
            .unwrap();
        assert_eq!(quarantined_record.root_path, root.canonicalize().unwrap());
        assert_eq!(quarantined_record.original_path, quarantined_path);
        assert_eq!(
            quarantined_record.dest_path,
            root.canonicalize().unwrap().join("recovery")
        );
        assert!(quarantined_record.created_at_unix <= quarantined_record.updated_at_unix);
        assert_eq!(
            quarantined_record.last_error.as_deref(),
            Some("destination rollback failed")
        );
    }

    #[test]
    fn temp_guard_enforces_lifecycle_and_preserves_interrupted_replacement() {
        let sandbox = tempfile::tempdir().unwrap();
        let root = sandbox.path().join("skills");
        std::fs::create_dir_all(&root).unwrap();
        let registry = TempArtifactRegistry::open(&sandbox.path().join("registry.sqlite")).unwrap();

        let building_path = {
            let guard = TempArtifactGuard::create(
                registry.clone(),
                &root,
                &root.join("building"),
                "building",
                TempArtifactKind::Install,
            )
            .unwrap();
            guard.path().to_path_buf()
        };
        assert!(!building_path.exists());
        assert!(registry.record_for_path(&building_path).unwrap().is_none());

        let mut replacing = TempArtifactGuard::create(
            registry.clone(),
            &root,
            &root.join("replacing"),
            "replacing",
            TempArtifactKind::Sync,
        )
        .unwrap();
        assert!(replacing.mark_replacing().is_err());
        replacing.mark_ready().unwrap();
        replacing.mark_replacing().unwrap();
        let replacing_path = replacing.path().to_path_buf();
        drop(replacing);
        assert!(replacing_path.exists());
        assert_eq!(
            registry
                .record_for_path(&replacing_path)
                .unwrap()
                .unwrap()
                .state,
            TempArtifactState::RecoveryRequired
        );

        let destination = root.join("completed");
        let mut completed = TempArtifactGuard::create(
            registry.clone(),
            &root,
            &destination,
            "completed",
            TempArtifactKind::Install,
        )
        .unwrap();
        completed.mark_ready().unwrap();
        completed.mark_replacing().unwrap();
        let completed_temp = completed.path().to_path_buf();
        std::fs::rename(&completed_temp, &destination).unwrap();
        completed.mark_completed().unwrap();
        assert!(destination.exists());
        assert!(registry.record_for_path(&completed_temp).unwrap().is_none());
    }

    #[test]
    fn rollback_success_discards_temp_while_restore_failure_preserves_recovery() {
        let sandbox = tempfile::tempdir().unwrap();
        let root = sandbox.path().join("skills");
        std::fs::create_dir_all(&root).unwrap();
        let registry = TempArtifactRegistry::open(&sandbox.path().join("registry.sqlite")).unwrap();

        let restored_destination = root.join("restored");
        std::fs::create_dir_all(&restored_destination).unwrap();
        std::fs::write(restored_destination.join("old.txt"), "old").unwrap();
        let mut rolled_back = TempArtifactGuard::create(
            registry.clone(),
            &root,
            &restored_destination,
            "restored",
            TempArtifactKind::Install,
        )
        .unwrap();
        std::fs::write(rolled_back.path().join("new.txt"), "new").unwrap();
        rolled_back.mark_ready().unwrap();
        rolled_back.mark_replacing().unwrap();
        let discarded_temp = rolled_back.path().to_path_buf();

        rolled_back.mark_rolled_back().unwrap();

        assert_eq!(
            std::fs::read_to_string(restored_destination.join("old.txt")).unwrap(),
            "old"
        );
        assert!(!discarded_temp.exists());
        assert!(registry.record_for_path(&discarded_temp).unwrap().is_none());

        let failed_destination = root.join("restore-failed");
        let mut restore_failed = TempArtifactGuard::create(
            registry.clone(),
            &root,
            &failed_destination,
            "restore-failed",
            TempArtifactKind::Sync,
        )
        .unwrap();
        std::fs::write(restore_failed.path().join("new.txt"), "new").unwrap();
        restore_failed.mark_ready().unwrap();
        restore_failed.mark_replacing().unwrap();
        let preserved_temp = restore_failed.path().to_path_buf();

        restore_failed
            .mark_recovery_required("fault injection: restoring old destination failed")
            .unwrap();
        drop(restore_failed);

        assert!(preserved_temp.exists());
        assert_eq!(
            registry
                .record_for_path(&preserved_temp)
                .unwrap()
                .unwrap()
                .state,
            TempArtifactState::RecoveryRequired
        );
    }

    #[test]
    fn quarantine_is_purged_at_thirty_days_and_report_has_task_summary() {
        let sandbox = tempfile::tempdir().unwrap();
        let root = sandbox.path().join("skills");
        let quarantine = sandbox.path().join("quarantine");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(root.join(".legacy-1787707160032652000-sync-tmp")).unwrap();
        let registry = TempArtifactRegistry::open(&sandbox.path().join("registry.sqlite")).unwrap();
        let first_now = SystemTime::now() + Duration::from_secs(1);
        let first = cleanup_stale_temp_artifacts(CleanupRequest {
            registry: &registry,
            roots: &[root],
            quarantine_root: &quarantine,
            now: first_now,
            stale_after: Duration::ZERO,
            quarantine_retention: Duration::from_secs(30 * 24 * 60 * 60),
            dry_run: false,
        })
        .unwrap();
        assert_eq!(first.quarantined, 1);

        let second = cleanup_stale_temp_artifacts(CleanupRequest {
            registry: &registry,
            roots: &[],
            quarantine_root: &quarantine,
            now: first_now + Duration::from_secs(30 * 24 * 60 * 60),
            stale_after: Duration::from_secs(24 * 60 * 60),
            quarantine_retention: Duration::from_secs(30 * 24 * 60 * 60),
            dry_run: false,
        })
        .unwrap();

        assert_eq!(second.purged, 1);
        assert_eq!(second.removed, 1);
        assert_eq!(
            second.task_summary(),
            "found=0 removed=1 quarantined=0 deferred=0 failed=0"
        );
        assert_eq!(std::fs::read_dir(quarantine).unwrap().count(), 0);
    }
}
