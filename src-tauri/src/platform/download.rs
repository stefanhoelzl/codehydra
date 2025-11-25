//! Download URLs and checksums for runtime dependencies.
//!
//! This module provides:
//! - Node.js binary download URLs for each platform
//! - SHA256 checksums for binary verification

use super::Platform;
use crate::runtime_versions::NODE_VERSION;

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
            assert!(!checksum.is_empty(), "Checksum for {platform:?} should not be empty");
        }
    }

    // Compile-time assertion that NODE_VERSION is not empty
    const _: () = assert!(!NODE_VERSION.is_empty());

    #[test]
    fn test_node_version_is_valid() {
        let parts: Vec<&str> = NODE_VERSION.split('.').collect();
        assert_eq!(parts.len(), 3, "Version should have 3 parts: {NODE_VERSION}");
        for part in parts {
            assert!(
                part.parse::<u32>().is_ok(),
                "Version part '{part}' should be a number"
            );
        }
    }
}
