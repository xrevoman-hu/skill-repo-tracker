use std::{
    fs, io,
    path::{Path, PathBuf},
};

use crate::backup_fs::{identity_from_path, DirectoryIdentity};

#[derive(Debug)]
pub(crate) struct CreatedSettingsDirectory {
    path: PathBuf,
    identity: DirectoryIdentity,
}

impl CreatedSettingsDirectory {
    #[cfg(test)]
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }
}

pub(crate) fn create_settings_directory_tree(
    path: &Path,
    created_directories: &mut Vec<CreatedSettingsDirectory>,
) -> io::Result<()> {
    let mut candidates = path
        .ancestors()
        .filter(|candidate| !candidate.as_os_str().is_empty())
        .collect::<Vec<_>>();
    candidates.reverse();

    for candidate in candidates {
        match fs::create_dir(candidate) {
            Ok(()) => match identity_from_path(candidate) {
                Ok(identity) => created_directories.push(CreatedSettingsDirectory {
                    path: candidate.to_path_buf(),
                    identity,
                }),
                Err(identity_error) => {
                    let cleanup_result = fs::remove_dir(candidate);
                    let details = cleanup_result
                        .err()
                        .map_or_else(String::new, |cleanup_error| {
                            format!("; immediate cleanup failed: {cleanup_error}")
                        });
                    return Err(io::Error::new(
                        identity_error.kind(),
                        format!(
                            "could not capture newly created directory identity: {identity_error}{details}"
                        ),
                    ));
                }
            },
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                let metadata = fs::metadata(candidate)?;
                if !metadata.is_dir() {
                    return Err(io::Error::new(
                        io::ErrorKind::NotADirectory,
                        format!("{} is not a directory", candidate.to_string_lossy()),
                    ));
                }
            }
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

pub(crate) fn cleanup_created_settings_directories(
    created_directories: &[CreatedSettingsDirectory],
) -> Vec<String> {
    created_directories
        .iter()
        .rev()
        .filter_map(|created| {
            let current_identity = match identity_from_path(&created.path) {
                Ok(identity) => identity,
                Err(identity_error) if identity_error.kind() == io::ErrorKind::NotFound => {
                    return None;
                }
                Err(identity_error) => {
                    return Some(format!(
                        "{}: ownership could not be revalidated; preserved directory ({identity_error})",
                        created.path.to_string_lossy()
                    ));
                }
            };
            if current_identity != created.identity {
                return Some(format!(
                    "{}: identity changed; preserved directory",
                    created.path.to_string_lossy()
                ));
            }
            match fs::remove_dir(&created.path) {
                Ok(()) => None,
                Err(cleanup_error) if cleanup_error.kind() == io::ErrorKind::NotFound => None,
                Err(cleanup_error) => Some(format!(
                    "{}: {cleanup_error}",
                    created.path.to_string_lossy()
                )),
            }
        })
        .collect()
}
