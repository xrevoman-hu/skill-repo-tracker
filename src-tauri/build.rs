use std::{env, fs, path::Path};

use sha2::{Digest, Sha256};

const SOURCE_SHA256: &str = "7075f96cbabe45b4ecfc2e6b1745a625f856f695b0827a5506ce9ed85b906aa0";

fn required_environment(name: &str) -> String {
    println!("cargo:rerun-if-env-changed={name}");
    env::var(name).unwrap_or_else(|_| {
        panic!("missing native dependency preparation; use the repository npm build/verify entry")
    })
}

fn verify_native_dependency() {
    assert_eq!(required_environment("CARGO_CFG_TARGET_OS"), "macos");
    let target = required_environment("TARGET");
    assert!(
        matches!(
            target.as_str(),
            "aarch64-apple-darwin" | "x86_64-apple-darwin"
        ),
        "SQLCipher E0 has no validated build for this target"
    );
    let manifest = required_environment("CARGO_MANIFEST_DIR");
    let native = Path::new(&manifest)
        .join("target/credential-native/4.19.0")
        .join(&target);
    assert_eq!(
        Path::new(&required_environment("SQLCIPHER_LIB_DIR")),
        native.join("lib")
    );
    assert_eq!(
        Path::new(&required_environment("SQLCIPHER_INCLUDE_DIR")),
        native.join("include")
    );
    assert_eq!(required_environment("SQLCIPHER_STATIC"), "1");
    assert_eq!(required_environment("SQLCIPHER_NO_PKG_CONFIG"), "1");
    assert_eq!(required_environment("LIBSQLITE3_SYS_USE_PKG_CONFIG"), "0");
    assert_eq!(
        required_environment("SRT_CIPHER_SOURCE_SHA256"),
        SOURCE_SHA256
    );
    let receipt_path = native.join("build-receipt.json");
    println!("cargo:rerun-if-changed={}", receipt_path.display());
    let receipt: serde_json::Value = serde_json::from_slice(
        &fs::read(receipt_path).expect("SQLCipher build receipt must exist"),
    )
    .expect("SQLCipher build receipt must be valid JSON");
    assert_eq!(receipt["sourceSha256"], SOURCE_SHA256);
    assert_eq!(receipt["target"], target);
    assert_eq!(receipt["sqlcipher"], "4.19.0");
    assert_eq!(receipt["sqlite"], "3.53.4");
    assert_eq!(receipt["provider"], "commoncrypto");
    assert_eq!(receipt["deploymentTarget"], "12.0");
    for relative in [
        "lib/libsqlcipher.a",
        "include/sqlite3.h",
        "LICENSE.sqlcipher",
    ] {
        let file = native.join(relative);
        println!("cargo:rerun-if-changed={}", file.display());
        assert!(
            fs::symlink_metadata(&file)
                .expect("SQLCipher artifact must exist")
                .is_file(),
            "SQLCipher artifact must be an ordinary file"
        );
        let bytes = fs::read(&file).expect("read SQLCipher build artifact");
        let actual = format!("{:x}", Sha256::digest(&bytes));
        assert_eq!(receipt["files"][relative].as_str(), Some(actual.as_str()));
    }
    let header = fs::read_to_string(native.join("include/sqlite3.h"))
        .expect("SQLCipher header must be readable");
    assert!(header.contains("#define SQLITE_VERSION        \"3.53.4\""));
    println!("cargo:rustc-link-lib=framework=Security");
    println!("cargo:rustc-link-lib=framework=CoreFoundation");
}

fn main() {
    verify_native_dependency();
    tauri_build::build();
}
