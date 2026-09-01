use std::{fs, io, path::Path};

#[cfg(unix)]
use std::{
    ffi::CString,
    fs::File,
    mem::MaybeUninit,
    os::unix::{
        ffi::OsStrExt,
        fs::MetadataExt,
        io::{AsRawFd, FromRawFd},
    },
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum DirectoryIdentity {
    #[cfg(unix)]
    Unix { device: u64, inode: u64 },
    #[cfg(not(unix))]
    Canonical(std::path::PathBuf),
}

pub(crate) fn identity_from_metadata(metadata: &fs::Metadata) -> io::Result<DirectoryIdentity> {
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "backup path is not an owned directory",
        ));
    }
    #[cfg(unix)]
    {
        Ok(DirectoryIdentity::Unix {
            device: metadata.dev(),
            inode: metadata.ino(),
        })
    }
    #[cfg(not(unix))]
    {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "backup directory identity requires Unix file descriptors",
        ))
    }
}

pub(crate) fn identity_from_path(path: &Path) -> io::Result<DirectoryIdentity> {
    identity_from_metadata(&fs::symlink_metadata(path)?)
}

#[cfg(unix)]
fn relative_name(value: &str) -> io::Result<CString> {
    CString::new(value.as_bytes()).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "backup relative name contains a NUL byte",
        )
    })
}

#[cfg(unix)]
pub(crate) fn open_directory_path(path: &Path) -> io::Result<File> {
    let path = CString::new(path.as_os_str().as_bytes()).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "backup directory path contains a NUL byte",
        )
    })?;
    // SAFETY: path is NUL-terminated and open returns a new descriptor on success.
    let descriptor = unsafe {
        libc::open(
            path.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if descriptor < 0 {
        Err(io::Error::last_os_error())
    } else {
        // SAFETY: open returned a new owned descriptor.
        Ok(unsafe { File::from_raw_fd(descriptor) })
    }
}

#[cfg(unix)]
pub(crate) fn identity_at(directory: &File, name: &str) -> io::Result<DirectoryIdentity> {
    let name = relative_name(name)?;
    let mut stat = MaybeUninit::<libc::stat>::uninit();
    // SAFETY: directory is valid, name is NUL-terminated, and stat is writable.
    let result = unsafe {
        libc::fstatat(
            directory.as_raw_fd(),
            name.as_ptr(),
            stat.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    };
    if result != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: fstatat initialized stat after returning success.
    let stat = unsafe { stat.assume_init() };
    if stat.st_mode & libc::S_IFMT != libc::S_IFDIR {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "backup path is not an owned directory",
        ));
    }
    Ok(DirectoryIdentity::Unix {
        device: stat.st_dev as u64,
        inode: stat.st_ino,
    })
}

#[cfg(unix)]
pub(crate) fn mkdir_at(directory: &File, name: &str) -> io::Result<()> {
    let name = relative_name(name)?;
    // SAFETY: directory is valid and name is NUL-terminated.
    let result = unsafe { libc::mkdirat(directory.as_raw_fd(), name.as_ptr(), 0o700) };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(unix)]
pub(crate) fn open_directory_at(directory: &File, name: &str) -> io::Result<File> {
    let name = relative_name(name)?;
    // SAFETY: directory is valid and name is NUL-terminated.
    let descriptor = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if descriptor < 0 {
        Err(io::Error::last_os_error())
    } else {
        // SAFETY: openat returned a new owned descriptor.
        Ok(unsafe { File::from_raw_fd(descriptor) })
    }
}

#[cfg(unix)]
pub(crate) fn open_new_file_at(directory: &File, name: &str) -> io::Result<File> {
    let name = relative_name(name)?;
    // SAFETY: directory is valid and name is NUL-terminated.
    let descriptor = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            name.as_ptr(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o600,
        )
    };
    if descriptor < 0 {
        Err(io::Error::last_os_error())
    } else {
        // SAFETY: openat returned a new owned descriptor.
        Ok(unsafe { File::from_raw_fd(descriptor) })
    }
}

#[cfg(unix)]
pub(crate) fn rename_at(directory: &File, from: &str, to: &str) -> io::Result<()> {
    let from = relative_name(from)?;
    let to = relative_name(to)?;
    #[cfg(target_os = "macos")]
    // SAFETY: directory is valid and both names are NUL-terminated.
    let result = unsafe {
        libc::renameatx_np(
            directory.as_raw_fd(),
            from.as_ptr(),
            directory.as_raw_fd(),
            to.as_ptr(),
            libc::RENAME_EXCL,
        )
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    // SAFETY: directory is valid and both names are NUL-terminated.
    let result = unsafe {
        libc::renameat(
            directory.as_raw_fd(),
            from.as_ptr(),
            directory.as_raw_fd(),
            to.as_ptr(),
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(unix)]
pub(crate) fn unlink_at(directory: &File, name: &str, flags: libc::c_int) -> io::Result<()> {
    let name = relative_name(name)?;
    // SAFETY: directory is valid and name is NUL-terminated.
    let result = unsafe { libc::unlinkat(directory.as_raw_fd(), name.as_ptr(), flags) };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(unix)]
pub(crate) fn entry_exists_at(directory: &File, name: &str) -> io::Result<bool> {
    let name = relative_name(name)?;
    let mut stat = MaybeUninit::<libc::stat>::uninit();
    // SAFETY: directory is valid, name is NUL-terminated, and stat is writable.
    let result = unsafe {
        libc::fstatat(
            directory.as_raw_fd(),
            name.as_ptr(),
            stat.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    };
    if result == 0 {
        Ok(true)
    } else {
        let error = io::Error::last_os_error();
        if error.kind() == io::ErrorKind::NotFound {
            Ok(false)
        } else {
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn directory_identity_rejects_files_and_symlinks() {
        use std::os::unix::fs::symlink;

        let sandbox = tempfile::tempdir().unwrap();
        let directory = sandbox.path().join("owned-directory");
        let file = sandbox.path().join("ordinary-file");
        let link = sandbox.path().join("directory-link");
        fs::create_dir(&directory).unwrap();
        fs::write(&file, b"fictional").unwrap();
        symlink(&directory, &link).unwrap();

        assert!(matches!(
            identity_from_path(&file).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        ));
        assert!(matches!(
            identity_from_path(&link).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        ));
        assert_eq!(
            identity_from_path(&directory).unwrap(),
            identity_from_metadata(&fs::metadata(&directory).unwrap()).unwrap()
        );
    }

    #[cfg(unix)]
    #[test]
    fn directory_relative_primitives_report_invalid_and_conflicting_entries() {
        let sandbox = tempfile::tempdir().unwrap();
        let directory = open_directory_path(sandbox.path()).unwrap();

        let nul_error = mkdir_at(&directory, "invalid\0name").unwrap_err();
        assert_eq!(nul_error.kind(), io::ErrorKind::InvalidInput);
        let path_nul_error = open_directory_path(Path::new("invalid\0path")).unwrap_err();
        assert_eq!(path_nul_error.kind(), io::ErrorKind::InvalidInput);

        mkdir_at(&directory, "child").unwrap();
        assert_eq!(
            identity_at(&directory, "child").unwrap(),
            identity_from_path(&sandbox.path().join("child")).unwrap()
        );
        assert!(mkdir_at(&directory, "child").is_err());
        assert!(open_directory_at(&directory, "child").is_ok());

        fs::write(sandbox.path().join("plain-file"), b"fictional").unwrap();
        assert_eq!(
            identity_at(&directory, "plain-file").unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        assert!(open_directory_at(&directory, "plain-file").is_err());
        assert!(entry_exists_at(&directory, "plain-file").unwrap());
        assert!(!entry_exists_at(&directory, "missing").unwrap());
        assert_eq!(
            identity_at(&directory, "missing").unwrap_err().kind(),
            io::ErrorKind::NotFound
        );
        assert_eq!(
            entry_exists_at(&directory, "plain-file/child")
                .unwrap_err()
                .raw_os_error(),
            Some(libc::ENOTDIR)
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn exclusive_rename_never_replaces_an_existing_entry() {
        use std::io::Write;

        let sandbox = tempfile::tempdir().unwrap();
        let directory = open_directory_path(sandbox.path()).unwrap();
        let mut first = open_new_file_at(&directory, "first.tmp").unwrap();
        let mut published = open_new_file_at(&directory, "published.zip").unwrap();
        first.write_all(b"first").unwrap();
        published.write_all(b"published").unwrap();
        drop(first);
        drop(published);

        let error = rename_at(&directory, "first.tmp", "published.zip").unwrap_err();
        assert_eq!(error.raw_os_error(), Some(libc::EEXIST));
        assert_eq!(
            fs::read(sandbox.path().join("published.zip")).unwrap(),
            b"published"
        );
        assert_eq!(
            fs::read(sandbox.path().join("first.tmp")).unwrap(),
            b"first"
        );
    }
}
