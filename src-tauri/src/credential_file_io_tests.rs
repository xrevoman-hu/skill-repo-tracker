use super::*;
use std::os::unix::fs::{symlink, DirBuilderExt, PermissionsExt};

fn roots() -> (tempfile::TempDir, PathBuf, PathBuf) {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().canonicalize().unwrap();
    let managed = root.join("managed");
    fs::DirBuilder::new().mode(0o700).create(&managed).unwrap();
    (directory, root, managed)
}

#[test]
fn export_keeps_exact_bytes_and_private_permissions() {
    let (_directory, root, managed) = roots();
    let path = root.join("中文 key.pem");
    let selection =
        Selection::capture(path.clone(), "record:1:key".into(), &managed, false).unwrap();
    selection
        .stage(b"exact\0bytes\r\n", &managed)
        .unwrap()
        .commit()
        .unwrap();
    assert_eq!(fs::read(&path).unwrap(), b"exact\0bytes\r\n");
    assert_eq!(
        fs::metadata(path).unwrap().permissions().mode() & 0o777,
        0o600
    );
}

#[test]
fn changed_target_or_symlink_is_never_overwritten() {
    let (_directory, root, managed) = roots();
    let path = root.join("existing");
    fs::write(&path, "old").unwrap();
    let selected = Selection::capture(path.clone(), String::new(), &managed, false).unwrap();
    let staged = selected.stage(b"secret", &managed).unwrap();
    fs::write(&path, "external change").unwrap();
    assert!(staged.commit().is_err());
    assert_eq!(fs::read(&path).unwrap(), b"external change");
    let alias = root.join("alias");
    symlink(&path, &alias).unwrap();
    assert!(Selection::capture(alias, String::new(), &managed, true).is_err());
}

#[test]
fn cancel_drops_staging_and_managed_destinations_are_rejected() {
    let (_directory, root, managed) = roots();
    let path = root.join("result");
    let selected = Selection::capture(path.clone(), String::new(), &managed, false).unwrap();
    drop(selected.stage(b"secret", &managed).unwrap());
    assert!(!path.exists());
    assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
    assert_eq!(fs::read_dir(&managed).unwrap().count(), 0);
    assert!(Selection::capture(path, String::new(), &root, false).is_err());
}
