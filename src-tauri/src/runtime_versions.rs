//! Pinned runtime versions for Chime.
//!
//! This module contains the pinned versions for all runtime dependencies.
//! These versions are manually updated when needed.

use std::collections::HashMap;

/// Pinned Node.js LTS version (v22 required by code-server).
pub const NODE_VERSION: &str = "22.21.1";

/// Pinned code-server version.
pub const CODE_SERVER_VERSION: &str = "4.106.2";

/// Get the required extensions with their pinned versions.
///
/// Returns a HashMap mapping extension IDs to their versions.
/// Uses Open VSX registry (code-server default).
///
/// # Example
///
/// ```
/// use chime_lib::runtime_versions::get_required_extensions;
///
/// let extensions = get_required_extensions();
/// assert!(extensions.contains_key("Anthropic.claude-code"));
/// ```
pub fn get_required_extensions() -> HashMap<&'static str, &'static str> {
    let mut extensions = HashMap::new();
    extensions.insert("Anthropic.claude-code", "2.0.50");
    // Add more extensions here in the future
    extensions
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_node_version_is_valid_semver() {
        // Version should be in semver format (x.y.z)
        let parts: Vec<&str> = NODE_VERSION.split('.').collect();
        assert_eq!(parts.len(), 3, "NODE_VERSION should have 3 parts: {}", NODE_VERSION);
        for part in parts {
            assert!(
                part.parse::<u32>().is_ok(),
                "NODE_VERSION part '{}' should be a number",
                part
            );
        }
    }

    #[test]
    fn test_code_server_version_is_valid_semver() {
        // Version should be in semver format (x.y.z)
        let parts: Vec<&str> = CODE_SERVER_VERSION.split('.').collect();
        assert_eq!(
            parts.len(),
            3,
            "CODE_SERVER_VERSION should have 3 parts: {}",
            CODE_SERVER_VERSION
        );
        for part in parts {
            assert!(
                part.parse::<u32>().is_ok(),
                "CODE_SERVER_VERSION part '{}' should be a number",
                part
            );
        }
    }

    #[test]
    fn test_get_required_extensions_contains_claude() {
        let extensions = get_required_extensions();
        assert!(
            extensions.contains_key("Anthropic.claude-code"),
            "Extensions should include Claude Code"
        );
    }

    #[test]
    fn test_get_required_extensions_version_format() {
        let extensions = get_required_extensions();
        for (extension_id, version) in extensions {
            // Extension ID should have format "Publisher.name"
            assert!(
                extension_id.contains('.'),
                "Extension ID '{}' should have format 'Publisher.name'",
                extension_id
            );

            // Version should not be empty
            assert!(
                !version.is_empty(),
                "Version for '{}' should not be empty",
                extension_id
            );
        }
    }
}
