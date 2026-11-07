//! What the process scan remembers of each process between scans, so a read
//! that answers the same every time — a command line, an environment, a
//! refusal — is made once per process, not once per scan.

use std::collections::{HashMap, HashSet};

/// Which process a remembered value belongs to. A process's command line and
/// environment are fixed until it execs; an exec keeps the pid and start time
/// but changes the name, so the name is part of the identity too.
#[derive(PartialEq, Eq)]
struct Identity {
    start_time: u64,
    name: String,
}

/// One value per process, by pid. A pid that now names another process (a new
/// start time) or an exec'd one (a new name) has no value.
pub struct OncePerProcess<T> {
    entries: HashMap<u32, (Identity, T)>,
}

impl<T> Default for OncePerProcess<T> {
    fn default() -> Self {
        Self {
            entries: HashMap::new(),
        }
    }
}

impl<T> OncePerProcess<T> {
    /// The value remembered for this process, if any.
    pub fn known(&self, pid: u32, start_time: u64, name: &str) -> Option<&T> {
        self.entries
            .get(&pid)
            .filter(|(known, _)| known.start_time == start_time && known.name == name)
            .map(|(_, value)| value)
    }

    pub fn remember(&mut self, pid: u32, start_time: u64, name: &str, value: T) {
        let identity = Identity {
            start_time,
            name: name.to_owned(),
        };
        self.entries.insert(pid, (identity, value));
    }

    /// This process's value: the remembered one, or `read`'s when it has none.
    pub fn get(&mut self, pid: u32, start_time: u64, name: &str, read: impl FnOnce() -> T) -> &T {
        if self.known(pid, start_time, name).is_none() {
            self.remember(pid, start_time, name, read());
        }
        &self.entries[&pid].1
    }

    /// Forget the processes not in `alive`.
    pub fn retain(&mut self, alive: &HashSet<u32>) {
        self.entries.retain(|pid, _| alive.contains(pid));
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.entries.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_once_per_process() {
        let mut values = OncePerProcess::default();
        let mut reads = 0;
        let mut get = |values: &mut OncePerProcess<u32>, start, name| {
            *values.get(7, start, name, || {
                reads += 1;
                reads
            })
        };
        assert_eq!(get(&mut values, 1, "a"), 1);
        // The same process: remembered, not read again.
        assert_eq!(get(&mut values, 1, "a"), 1);
        // An exec (new name) or a reused pid (new start time) reads again.
        assert_eq!(get(&mut values, 1, "b"), 2);
        assert_eq!(get(&mut values, 2, "b"), 3);
        assert_eq!(values.known(7, 1, "a"), None);
        values.retain(&HashSet::new());
        assert_eq!(values.len(), 0);
    }
}
