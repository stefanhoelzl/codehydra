// src-tauri/src/agent_status.rs

use serde::{Deserialize, Serialize};

/// Channel capacity for status events.
/// Sized for ~10 workspaces × ~10 events during startup bursts.
/// If the frontend lags, older events will be dropped (acceptable for status updates).
pub const STATUS_EVENT_CHANNEL_CAPACITY: usize = 100;

/// Debounce interval for status updates (milliseconds).
/// Prevents UI churn when providers emit rapid updates.
pub const STATUS_DEBOUNCE_MS: u64 = 50;

/// Status counts from a single AgentStatusProvider
///
/// Note: Derives `Copy` since it only contains `u32` fields,
/// avoiding unnecessary allocations.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatusCounts {
    pub idle: u32,
    pub busy: u32,
}

impl AgentStatusCounts {
    pub fn new(idle: u32, busy: u32) -> Self {
        Self { idle, busy }
    }

    #[must_use]
    pub fn total(&self) -> u32 {
        self.idle + self.busy
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.total() == 0
    }

    /// Combine two status counts.
    /// Uses saturating arithmetic to prevent overflow/panic with many agents.
    pub fn combine(&self, other: &Self) -> Self {
        Self {
            idle: self.idle.saturating_add(other.idle),
            busy: self.busy.saturating_add(other.busy),
        }
    }
}

impl std::ops::Add for AgentStatusCounts {
    type Output = Self;

    fn add(self, other: Self) -> Self {
        self.combine(&other)
    }
}

impl std::ops::AddAssign for AgentStatusCounts {
    fn add_assign(&mut self, other: Self) {
        self.idle = self.idle.saturating_add(other.idle);
        self.busy = self.busy.saturating_add(other.busy);
    }
}

/// Aggregated status for a workspace (derived from all providers)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AggregatedAgentStatus {
    /// No agents running (grey)
    #[default]
    NoAgents,
    /// All agents are idle (green)
    AllIdle { count: u32 },
    /// All agents are busy (red)
    AllBusy { count: u32 },
    /// Some idle, some busy (mixed - half red/half green)
    Mixed { idle: u32, busy: u32 },
}

impl From<AgentStatusCounts> for AggregatedAgentStatus {
    fn from(counts: AgentStatusCounts) -> Self {
        match (counts.idle, counts.busy) {
            (0, 0) => AggregatedAgentStatus::NoAgents,
            (idle, 0) => AggregatedAgentStatus::AllIdle { count: idle },
            (0, busy) => AggregatedAgentStatus::AllBusy { count: busy },
            (idle, busy) => AggregatedAgentStatus::Mixed { idle, busy },
        }
    }
}

impl From<&AgentStatusCounts> for AggregatedAgentStatus {
    fn from(counts: &AgentStatusCounts) -> Self {
        // AgentStatusCounts is Copy, so we can dereference directly
        AggregatedAgentStatus::from(*counts)
    }
}

/// Event emitted when agent status changes for a workspace
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatusChangedEvent {
    /// Path to the workspace
    pub workspace_path: String,
    /// Aggregated status across all providers
    pub status: AggregatedAgentStatus,
    /// Total counts for detailed display
    pub counts: AgentStatusCounts,
}

/// Convert a Path to a String, returning an error for non-UTF8 paths.
/// This ensures consistent path representation between Rust and TypeScript.
///
/// # Errors
/// Returns an error if the path contains non-UTF8 characters.
pub fn path_to_string(path: &std::path::Path) -> Result<String, std::io::Error> {
    path.to_str().map(String::from).ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("Path contains non-UTF8 characters: {path:?}"),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // === AgentStatusCounts Tests ===

    #[test]
    fn test_counts_new() {
        let counts = AgentStatusCounts::new(3, 2);
        assert_eq!(counts.idle, 3);
        assert_eq!(counts.busy, 2);
    }

    #[test]
    fn test_counts_default() {
        let counts = AgentStatusCounts::default();
        assert_eq!(counts.idle, 0);
        assert_eq!(counts.busy, 0);
    }

    #[test]
    fn test_counts_total() {
        let counts = AgentStatusCounts::new(3, 2);
        assert_eq!(counts.total(), 5);
    }

    #[test]
    fn test_counts_total_zero() {
        let counts = AgentStatusCounts::default();
        assert_eq!(counts.total(), 0);
    }

    #[test]
    fn test_counts_is_empty_true() {
        let counts = AgentStatusCounts::default();
        assert!(counts.is_empty());
    }

    #[test]
    fn test_counts_is_empty_false_idle() {
        let counts = AgentStatusCounts::new(1, 0);
        assert!(!counts.is_empty());
    }

    #[test]
    fn test_counts_is_empty_false_busy() {
        let counts = AgentStatusCounts::new(0, 1);
        assert!(!counts.is_empty());
    }

    #[test]
    fn test_counts_combine() {
        let a = AgentStatusCounts::new(2, 1);
        let b = AgentStatusCounts::new(1, 3);
        let combined = a.combine(&b);
        assert_eq!(combined.idle, 3);
        assert_eq!(combined.busy, 4);
    }

    #[test]
    fn test_counts_add_operator() {
        let a = AgentStatusCounts::new(2, 1);
        let b = AgentStatusCounts::new(1, 3);
        let sum = a + b;
        assert_eq!(sum.idle, 3);
        assert_eq!(sum.busy, 4);
    }

    #[test]
    fn test_counts_add_assign_operator() {
        let mut a = AgentStatusCounts::new(2, 1);
        a += AgentStatusCounts::new(1, 3);
        assert_eq!(a.idle, 3);
        assert_eq!(a.busy, 4);
    }

    #[test]
    fn test_counts_equality() {
        let a = AgentStatusCounts::new(2, 1);
        let b = AgentStatusCounts::new(2, 1);
        let c = AgentStatusCounts::new(1, 2);
        assert_eq!(a, b);
        assert_ne!(a, c);
    }

    // === AggregatedAgentStatus Tests ===

    #[test]
    fn test_status_from_counts_no_agents() {
        let counts = AgentStatusCounts::new(0, 0);
        let status = AggregatedAgentStatus::from(counts);
        assert_eq!(status, AggregatedAgentStatus::NoAgents);
    }

    #[test]
    fn test_status_from_counts_all_idle() {
        let counts = AgentStatusCounts::new(3, 0);
        let status = AggregatedAgentStatus::from(counts);
        assert_eq!(status, AggregatedAgentStatus::AllIdle { count: 3 });
    }

    #[test]
    fn test_status_from_counts_all_busy() {
        let counts = AgentStatusCounts::new(0, 2);
        let status = AggregatedAgentStatus::from(counts);
        assert_eq!(status, AggregatedAgentStatus::AllBusy { count: 2 });
    }

    #[test]
    fn test_status_from_counts_mixed() {
        let counts = AgentStatusCounts::new(2, 3);
        let status = AggregatedAgentStatus::from(counts);
        assert_eq!(status, AggregatedAgentStatus::Mixed { idle: 2, busy: 3 });
    }

    #[test]
    fn test_status_from_counts_ref() {
        let counts = AgentStatusCounts::new(1, 1);
        let status = AggregatedAgentStatus::from(&counts);
        assert_eq!(status, AggregatedAgentStatus::Mixed { idle: 1, busy: 1 });
    }

    #[test]
    fn test_status_default() {
        let status = AggregatedAgentStatus::default();
        assert_eq!(status, AggregatedAgentStatus::NoAgents);
    }

    // === Serialization Tests ===

    #[test]
    fn test_counts_serialize() {
        let counts = AgentStatusCounts::new(2, 3);
        let json = serde_json::to_string(&counts).unwrap();
        assert!(json.contains("\"idle\":2"));
        assert!(json.contains("\"busy\":3"));
    }

    #[test]
    fn test_counts_deserialize() {
        let json = r#"{"idle":5,"busy":2}"#;
        let counts: AgentStatusCounts = serde_json::from_str(json).unwrap();
        assert_eq!(counts.idle, 5);
        assert_eq!(counts.busy, 2);
    }

    #[test]
    fn test_status_serialize_no_agents() {
        let status = AggregatedAgentStatus::NoAgents;
        let json = serde_json::to_string(&status).unwrap();
        assert!(json.contains("\"type\":\"noAgents\""));
    }

    #[test]
    fn test_status_serialize_all_idle() {
        let status = AggregatedAgentStatus::AllIdle { count: 3 };
        let json = serde_json::to_string(&status).unwrap();
        assert!(json.contains("\"type\":\"allIdle\""));
        assert!(json.contains("\"count\":3"));
    }

    #[test]
    fn test_status_serialize_all_busy() {
        let status = AggregatedAgentStatus::AllBusy { count: 2 };
        let json = serde_json::to_string(&status).unwrap();
        assert!(json.contains("\"type\":\"allBusy\""));
        assert!(json.contains("\"count\":2"));
    }

    #[test]
    fn test_status_serialize_mixed() {
        let status = AggregatedAgentStatus::Mixed { idle: 1, busy: 2 };
        let json = serde_json::to_string(&status).unwrap();
        assert!(json.contains("\"type\":\"mixed\""));
        assert!(json.contains("\"idle\":1"));
        assert!(json.contains("\"busy\":2"));
    }

    #[test]
    fn test_event_serialize() {
        let event = AgentStatusChangedEvent {
            workspace_path: "/path/to/workspace".to_string(),
            status: AggregatedAgentStatus::AllIdle { count: 2 },
            counts: AgentStatusCounts::new(2, 0),
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("\"workspacePath\":\"/path/to/workspace\""));
        assert!(json.contains("\"type\":\"allIdle\""));
    }

    // === Serialization Round-Trip Tests ===

    #[test]
    fn test_counts_serialize_deserialize_round_trip() {
        let original = AgentStatusCounts::new(5, 3);
        let json = serde_json::to_string(&original).unwrap();
        let deserialized: AgentStatusCounts = serde_json::from_str(&json).unwrap();
        assert_eq!(original, deserialized);
    }

    #[test]
    fn test_status_no_agents_round_trip() {
        let original = AggregatedAgentStatus::NoAgents;
        let json = serde_json::to_string(&original).unwrap();
        let deserialized: AggregatedAgentStatus = serde_json::from_str(&json).unwrap();
        assert_eq!(original, deserialized);
    }

    #[test]
    fn test_status_all_idle_round_trip() {
        let original = AggregatedAgentStatus::AllIdle { count: 5 };
        let json = serde_json::to_string(&original).unwrap();
        let deserialized: AggregatedAgentStatus = serde_json::from_str(&json).unwrap();
        assert_eq!(original, deserialized);
    }

    #[test]
    fn test_status_all_busy_round_trip() {
        let original = AggregatedAgentStatus::AllBusy { count: 3 };
        let json = serde_json::to_string(&original).unwrap();
        let deserialized: AggregatedAgentStatus = serde_json::from_str(&json).unwrap();
        assert_eq!(original, deserialized);
    }

    #[test]
    fn test_status_mixed_round_trip() {
        let original = AggregatedAgentStatus::Mixed { idle: 2, busy: 4 };
        let json = serde_json::to_string(&original).unwrap();
        let deserialized: AggregatedAgentStatus = serde_json::from_str(&json).unwrap();
        assert_eq!(original, deserialized);
    }

    // === Copy Trait Tests ===

    #[test]
    fn test_counts_is_copy() {
        let a = AgentStatusCounts::new(1, 2);
        let b = a; // Copy, not move
        assert_eq!(a, b); // a is still valid
    }

    #[test]
    fn test_counts_copy_in_function() {
        fn takes_copy(c: AgentStatusCounts) -> u32 {
            c.total()
        }
        let counts = AgentStatusCounts::new(3, 4);
        let total = takes_copy(counts);
        assert_eq!(total, 7);
        assert_eq!(counts.total(), 7); // counts still valid
    }

    // === Constants Tests ===
    // Using const assertions to validate at compile time

    const _: () = assert!(STATUS_EVENT_CHANNEL_CAPACITY >= 10);
    const _: () = assert!(STATUS_EVENT_CHANNEL_CAPACITY <= 1000);
    const _: () = assert!(STATUS_DEBOUNCE_MS >= 10);
    const _: () = assert!(STATUS_DEBOUNCE_MS <= 500);

    // === Path Conversion Tests ===

    #[test]
    fn test_path_to_string_valid() {
        let path = std::path::Path::new("/valid/utf8/path");
        let result = path_to_string(path);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "/valid/utf8/path");
    }

    #[test]
    fn test_path_to_string_with_spaces() {
        let path = std::path::Path::new("/path/with spaces/file.txt");
        let result = path_to_string(path);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "/path/with spaces/file.txt");
    }

    #[test]
    fn test_path_to_string_unicode() {
        let path = std::path::Path::new("/path/with/emojis/test");
        let result = path_to_string(path);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "/path/with/emojis/test");
    }
}
