//! Download URLs and checksums for runtime dependencies.
//!
//! This module provides:
//! - Node.js binary download URLs for each platform
//! - SHA256 checksums for binary verification

use super::Platform;
use crate::runtime_versions::{NODE_VERSION, PYTHON_BUILD_DATE, PYTHON_VERSION};

/// Get the SHA256 checksum for Node.js binary on the given platform.
///
/// These checksums are from https://nodejs.org/dist/v{VERSION}/SHASUMS256.txt
pub fn node_checksum(platform: Platform) -> &'static str {
    // Checksums for Node.js v22.21.1
    match platform {
        Platform::LinuxX64 => "680d3f30b24a7ff24b98db5e96f294c0070f8f9078df658da1bce1b9c9873c88",
        Platform::LinuxArm64 => "e660365729b434af422bcd2e8e14228637ecf24a1de2cd7c916ad48f2a0521e1",
        Platform::MacOSX64 => "8e3dc89614debe66c2a6ad2313a1adb06eb37db6cd6c40d7de6f7d987f7d1afd",
        Platform::MacOSArm64 => "c170d6554fba83d41d25a76cdbad85487c077e51fa73519e41ac885aa429d8af",
        Platform::WindowsX64 => "3c624e9fbe07e3217552ec52a0f84e2bdc2e6ffa7348f3fdfb9fbf8f42e23fcf",
    }
}

/// Get the download URL for Node.js binary on the given platform.
///
/// URLs point to the official Node.js distribution site.
pub fn node_download_url(platform: Platform) -> String {
    let archive_name = platform.node_archive_name(NODE_VERSION);
    let extension = platform.node_archive_extension();
    format!("https://nodejs.org/dist/v{NODE_VERSION}/{archive_name}{extension}")
}

/// Get the SHA256 checksum for Python binary on the given platform.
///
/// These checksums are from https://github.com/astral-sh/python-build-standalone/releases/download/20251202/
pub fn python_checksum(platform: Platform) -> &'static str {
    // Checksums for Python 3.14.1+20251202
    match platform {
        Platform::LinuxX64 => "a72f313bad49846e5e9671af2be7476033a877c80831cf47f431400ccb520090",
        Platform::LinuxArm64 => "5dde7dba0b8ef34c0d5cb8a721254b1e11028bfc09ff06664879c245fe8df73f",
        Platform::MacOSX64 => "f25ce050e1d370f9c05c9623b769ffa4b269a6ae17e611b435fd2b8b09972a88",
        Platform::MacOSArm64 => "cdf1ba0789f529fa34bb5b5619c5da9757ac1067d6b8dd0ee8b78e50078fc561",
        Platform::WindowsX64 => "cb478a5a37eb93ce4d3c27ae64d211d6a5a42475ae53f666a8d1570e71fcf409",
    }
}

/// Get the download URL for Python binary on the given platform.
///
/// URLs point to the python-build-standalone GitHub releases.
pub fn python_download_url(platform: Platform) -> String {
    let archive_name = platform.python_archive_name(PYTHON_VERSION, PYTHON_BUILD_DATE);
    format!("https://github.com/astral-sh/python-build-standalone/releases/download/{PYTHON_BUILD_DATE}/{archive_name}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_node_download_url_format() {
        let url = node_download_url(Platform::LinuxX64);
        assert!(url.starts_with("https://nodejs.org/dist/v"));
        assert!(url.contains(NODE_VERSION));
        assert!(url.contains("node-v"));
        assert!(url.contains("linux-x64"));
        assert!(url.ends_with(".tar.xz"));
    }

    #[test]
    fn test_node_download_url_all_platforms() {
        let platforms = [
            (Platform::LinuxX64, "linux-x64", ".tar.xz"),
            (Platform::LinuxArm64, "linux-arm64", ".tar.xz"),
            (Platform::MacOSX64, "darwin-x64", ".tar.gz"),
            (Platform::MacOSArm64, "darwin-arm64", ".tar.gz"),
            (Platform::WindowsX64, "win-x64", ".zip"),
        ];

        for (platform, expected_arch, expected_ext) in platforms {
            let url = node_download_url(platform);
            assert!(
                url.contains(expected_arch),
                "URL for {platform:?} should contain {expected_arch}: {url}"
            );
            assert!(
                url.ends_with(expected_ext),
                "URL for {platform:?} should end with {expected_ext}: {url}"
            );
        }
    }

    #[test]
    fn test_node_checksum_returns_string() {
        let platforms = [
            Platform::LinuxX64,
            Platform::LinuxArm64,
            Platform::MacOSX64,
            Platform::MacOSArm64,
            Platform::WindowsX64,
        ];

        for platform in platforms {
            let checksum = node_checksum(platform);
            assert!(
                !checksum.is_empty(),
                "Checksum for {platform:?} should not be empty"
            );
        }
    }

    // Compile-time assertion that NODE_VERSION is not empty
    const _: () = assert!(!NODE_VERSION.is_empty());

    #[test]
    fn test_node_version_is_valid() {
        let parts: Vec<&str> = NODE_VERSION.split('.').collect();
        assert_eq!(
            parts.len(),
            3,
            "Version should have 3 parts: {NODE_VERSION}"
        );
        for part in parts {
            assert!(
                part.parse::<u32>().is_ok(),
                "Version part '{part}' should be a number"
            );
        }
    }

    #[test]
    fn test_python_download_url_format() {
        let url = python_download_url(Platform::LinuxX64);
        assert!(url.starts_with(
            "https://github.com/astral-sh/python-build-standalone/releases/download/"
        ));
        assert!(url.contains(PYTHON_BUILD_DATE));
        assert!(url.contains("cpython-"));
        assert!(url.contains("linux-gnu"));
        assert!(url.ends_with("-install_only.tar.gz"));
    }

    #[test]
    fn test_python_download_url_all_platforms() {
        let test_cases = vec![
            (Platform::LinuxX64, "x86_64-unknown-linux-gnu"),
            (Platform::LinuxArm64, "aarch64-unknown-linux-gnu"),
            (Platform::MacOSX64, "x86_64-apple-darwin"),
            (Platform::MacOSArm64, "aarch64-apple-darwin"),
            (Platform::WindowsX64, "x86_64-pc-windows-msvc"),
        ];

        for (platform, expected_arch) in test_cases {
            let url = python_download_url(platform);
            assert!(
                url.contains(expected_arch),
                "URL for {platform:?} should contain {expected_arch}: {url}"
            );
            assert!(
                url.contains(PYTHON_VERSION),
                "URL should contain Python version {PYTHON_VERSION}: {url}"
            );
            assert!(
                url.contains(PYTHON_BUILD_DATE),
                "URL should contain build date {PYTHON_BUILD_DATE}: {url}"
            );
        }
    }

    #[test]
    fn test_python_checksum_returns_string() {
        let platforms = [
            Platform::LinuxX64,
            Platform::LinuxArm64,
            Platform::MacOSX64,
            Platform::MacOSArm64,
            Platform::WindowsX64,
        ];

        for platform in platforms {
            let checksum = python_checksum(platform);
            assert!(
                !checksum.is_empty(),
                "Checksum for {platform:?} should not be empty"
            );
        }
    }

    // Compile-time assertions
    const _: () = assert!(!PYTHON_VERSION.is_empty());
    const _: () = assert!(!PYTHON_BUILD_DATE.is_empty());
}
