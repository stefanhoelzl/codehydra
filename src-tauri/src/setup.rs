//! Setup event types for runtime initialization.
//!
//! These types are used to communicate setup progress from the backend to the frontend.
//! The frontend just renders what it receives - all logic is in the backend.

use serde::Serialize;

/// Events emitted during runtime setup.
///
/// These events are serialized and sent to the frontend via Tauri's event system.
/// The frontend just renders what it receives - all logic is in the backend.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SetupEvent {
    /// Update UI with current state (message and step statuses).
    Update {
        message: String,
        steps: Vec<StepStatus>,
    },
    /// Setup completed successfully.
    Complete,
    /// Setup failed with an error message.
    Failed { error: String },
}

/// Status of a single setup step for UI display.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StepStatus {
    pub label: String,
    pub state: StepState,
}

/// Visual state of a setup step.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum StepState {
    #[default]
    Pending,
    InProgress,
    Completed,
    Failed,
}

/// Builder for constructing step status list.
///
/// All steps default to `Pending`. Use the builder methods to set
/// specific step states, then call `build()` to get the `Vec<StepStatus>`.
///
/// # Example
///
/// ```
/// use codehydra_lib::setup::{StepsBuilder, StepState};
///
/// let steps = StepsBuilder::new()
///     .node(StepState::Completed)
///     .code_server(StepState::InProgress)
///     .build();
/// ```
#[derive(Debug, Clone, Default)]
pub struct StepsBuilder {
    node: StepState,
    code_server: StepState,
    opencode: StepState,
    extensions: StepState,
}

impl StepsBuilder {
    /// Create a new builder with all steps set to `Pending`.
    pub fn new() -> Self {
        Self::default()
    }

    /// Set the Node.js runtime step state.
    pub fn node(mut self, state: StepState) -> Self {
        self.node = state;
        self
    }

    /// Set the code-server step state.
    pub fn code_server(mut self, state: StepState) -> Self {
        self.code_server = state;
        self
    }

    /// Set the opencode step state.
    pub fn opencode(mut self, state: StepState) -> Self {
        self.opencode = state;
        self
    }

    /// Set the extensions step state.
    pub fn extensions(mut self, state: StepState) -> Self {
        self.extensions = state;
        self
    }

    /// Build the vector of step statuses.
    pub fn build(self) -> Vec<StepStatus> {
        vec![
            StepStatus {
                label: "Node.js runtime".into(),
                state: self.node,
            },
            StepStatus {
                label: "code-server".into(),
                state: self.code_server,
            },
            StepStatus {
                label: "OpenCode".into(),
                state: self.opencode,
            },
            StepStatus {
                label: "Extensions".into(),
                state: self.extensions,
            },
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_steps_builder_defaults_to_pending() {
        let steps = StepsBuilder::new().build();
        assert_eq!(steps.len(), 4);
        assert_eq!(steps[0].state, StepState::Pending);
        assert_eq!(steps[1].state, StepState::Pending);
        assert_eq!(steps[2].state, StepState::Pending);
        assert_eq!(steps[3].state, StepState::Pending);
    }

    #[test]
    fn test_steps_builder_sets_individual_states() {
        let steps = StepsBuilder::new()
            .node(StepState::Completed)
            .code_server(StepState::InProgress)
            .opencode(StepState::Pending)
            .extensions(StepState::Failed)
            .build();

        assert_eq!(steps[0].label, "Node.js runtime");
        assert_eq!(steps[0].state, StepState::Completed);
        assert_eq!(steps[1].label, "code-server");
        assert_eq!(steps[1].state, StepState::InProgress);
        assert_eq!(steps[2].label, "OpenCode");
        assert_eq!(steps[2].state, StepState::Pending);
        assert_eq!(steps[3].label, "Extensions");
        assert_eq!(steps[3].state, StepState::Failed);
    }

    #[test]
    fn test_steps_builder_partial_override() {
        // Only set node, others should remain Pending
        let steps = StepsBuilder::new().node(StepState::InProgress).build();

        assert_eq!(steps[0].state, StepState::InProgress);
        assert_eq!(steps[1].state, StepState::Pending);
        assert_eq!(steps[2].state, StepState::Pending);
        assert_eq!(steps[3].state, StepState::Pending);
    }

    #[test]
    fn test_setup_event_update_serialization() {
        let event = SetupEvent::Update {
            message: "Installing...".to_string(),
            steps: StepsBuilder::new().node(StepState::InProgress).build(),
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains(r#""type":"update""#));
        assert!(json.contains(r#""message":"Installing...""#));
        assert!(json.contains(r#""state":"inProgress""#));
    }

    #[test]
    fn test_setup_event_complete_serialization() {
        let event = SetupEvent::Complete;
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains(r#""type":"complete""#));
    }

    #[test]
    fn test_setup_event_failed_serialization() {
        let event = SetupEvent::Failed {
            error: "Something went wrong".to_string(),
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains(r#""type":"failed""#));
        assert!(json.contains(r#""error":"Something went wrong""#));
    }

    #[test]
    fn test_step_state_serialization() {
        assert_eq!(
            serde_json::to_string(&StepState::Pending).unwrap(),
            r#""pending""#
        );
        assert_eq!(
            serde_json::to_string(&StepState::InProgress).unwrap(),
            r#""inProgress""#
        );
        assert_eq!(
            serde_json::to_string(&StepState::Completed).unwrap(),
            r#""completed""#
        );
        assert_eq!(
            serde_json::to_string(&StepState::Failed).unwrap(),
            r#""failed""#
        );
    }
}
