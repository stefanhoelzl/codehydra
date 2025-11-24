use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Session info from GET /session endpoint
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub id: String,
    // Note: Session does NOT have a status field - status is tracked separately
}

/// Session status from GET /session/status endpoint or session.status events
/// Maps to OpenCode's SessionStatus type
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum SessionStatus {
    Idle,
    Busy,
    Retry {
        attempt: i32,
        message: String,
        next: i64,
    },
}

impl SessionStatus {
    pub fn is_busy(&self) -> bool {
        matches!(self, SessionStatus::Busy | SessionStatus::Retry { .. })
    }
}

/// Response from GET /session/status endpoint
/// When all sessions are idle, returns an empty array []
/// When sessions are busy, format may vary - we handle both cases
pub type SessionStatusMap = HashMap<String, SessionStatus>;

/// Response from GET /session endpoint - list of sessions
pub type SessionList = Vec<Session>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Event {
    #[serde(rename = "type")]
    pub event_type: String,
    #[serde(default)]
    pub properties: serde_json::Value,
}

/// Properties for session.status event
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionStatusEventProperties {
    #[serde(rename = "sessionID")]
    pub session_id: String,
    pub status: SessionStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PathResponse {
    pub worktree: String,
    pub directory: String,
}
