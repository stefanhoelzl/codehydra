use crate::opencode::{types, OpenCodeClient, OpenCodeError};
use async_trait::async_trait;
use futures::{stream::BoxStream, TryStreamExt};
use reqwest_eventsource::{Event, EventSource};
use std::path::PathBuf;

pub struct DefaultOpenCodeClient {
    base_url: String,
    client: reqwest::Client,
}

impl DefaultOpenCodeClient {
    pub fn new(port: u16) -> Self {
        Self {
            // Use localhost to support IPv4/IPv6
            base_url: format!("http://localhost:{}", port),
            client: reqwest::Client::new(),
        }
    }
}

#[async_trait]
impl OpenCodeClient for DefaultOpenCodeClient {
    async fn get_workspace_path(&self) -> Result<PathBuf, OpenCodeError> {
        let url = format!("{}/path", self.base_url);
        let resp = self.client.get(&url).send().await?;
        let data: types::PathResponse = resp.json().await?;
        let path_str = if !data.worktree.is_empty() {
            data.worktree
        } else {
            data.directory
        };
        Ok(PathBuf::from(path_str))
    }

    async fn get_session_status(&self) -> Result<types::SessionStatusMap, OpenCodeError> {
        let url = format!("{}/session/status", self.base_url);
        let resp = self.client.get(&url).send().await?;
        
        // The /session/status endpoint returns:
        // - [] (empty array) when no sessions are busy (all idle)
        // - A map { sessionId: status } when sessions have explicit statuses
        // We need to handle both cases
        let text = resp.text().await?;
        
        // Try to parse as map first
        if let Ok(status_map) = serde_json::from_str::<types::SessionStatusMap>(&text) {
            return Ok(status_map);
        }
        
        // If that fails, try as empty array (which means "all idle")
        if let Ok(arr) = serde_json::from_str::<Vec<serde_json::Value>>(&text) {
            if arr.is_empty() {
                // Empty array = no busy sessions = return empty map
                return Ok(types::SessionStatusMap::new());
            }
        }
        
        // If neither works, return a JSON parsing error
        Err(OpenCodeError::Json(serde_json::from_str::<types::SessionStatusMap>(&text).unwrap_err()))
    }

    async fn subscribe_events(
        &self,
    ) -> Result<BoxStream<'static, Result<types::Event, OpenCodeError>>, OpenCodeError> {
        let url = format!("{}/event", self.base_url);
        let event_source = EventSource::get(&url);

        let stream = event_source
            .map_err(|_| OpenCodeError::StreamInterrupted) // Simplify error mapping
            .try_filter_map(|event| async move {
                match event {
                    Event::Open => Ok(None),
                    Event::Message(msg) => {
                        match serde_json::from_str::<types::Event>(&msg.data) {
                            Ok(data) => Ok(Some(data)),
                            Err(_) => Ok(None), // Skip invalid JSON
                        }
                    }
                }
            });

        Ok(Box::pin(stream))
    }
}

#[derive(Debug)]
pub struct DefaultClientFactory;

impl crate::opencode::ClientFactory for DefaultClientFactory {
    fn create_client(&self, port: u16) -> Box<dyn OpenCodeClient> {
        Box::new(DefaultOpenCodeClient::new(port))
    }
}
