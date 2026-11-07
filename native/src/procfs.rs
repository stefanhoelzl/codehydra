//! Linux: the `/proc` reads the polled scans make themselves, so each touches
//! only the processes it is about.
//!
//! The libraries read everything for every process: listeners resolves the
//! link of every fd on the machine to find a socket's owner, and sysinfo
//! re-reads a command line or environment it found empty — a kernel thread's,
//! or one it was not allowed to read — on every scan. Polled every few
//! seconds, that is most of the cost of watching processes.
//!
//! Compiled everywhere (it is plain `std::fs`), so its callers can branch on
//! `cfg!()` and every platform's branch builds and lints on any one of them;
//! only Linux calls it.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::ErrorKind;

use crate::once::OncePerProcess;

/// `st` of a socket in LISTEN state (`TCP_LISTEN`) in `/proc/net/tcp{,6}`.
const TCP_LISTEN: &str = "0A";

/// The local port of each listening socket in one `/proc/net/tcp{,6}` table,
/// by socket inode.
fn listening_in_table(table: &str, into: &mut HashMap<u64, u16>) {
    // sl local_address rem_address st tx_queue:rx_queue tr:tm->when retrnsmt uid timeout inode
    for line in table.lines().skip(1) {
        let fields: Vec<&str> = line.split_whitespace().collect();
        let (Some(local), Some(state), Some(inode)) = (fields.get(1), fields.get(3), fields.get(9))
        else {
            continue;
        };
        if *state != TCP_LISTEN {
            continue;
        }
        let Some(port) = local
            .rsplit_once(':')
            .and_then(|(_, port)| u16::from_str_radix(port, 16).ok())
        else {
            continue;
        };
        if let Ok(inode) = inode.parse::<u64>()
            && inode != 0
        {
            into.insert(inode, port);
        }
    }
}

/// The inode in an fd link of the form `socket:[12345]`.
fn socket_inode(link: &str) -> Option<u64> {
    link.strip_prefix("socket:[")?
        .strip_suffix(']')?
        .parse()
        .ok()
}

/// The TCP ports (IPv4 and IPv6) each of `pids` listens on, as `(pid, port)`
/// pairs without duplicates. Reads the socket tables once, then only the fds
/// of `pids`. A pid whose fds cannot be read (another user's) lists nothing.
pub fn listening_ports_of(pids: &HashSet<u32>) -> Vec<(u32, u16)> {
    let mut inodes = HashMap::new();
    for table in ["/proc/net/tcp", "/proc/net/tcp6"] {
        if let Ok(text) = fs::read_to_string(table) {
            listening_in_table(&text, &mut inodes);
        }
    }
    if inodes.is_empty() {
        return Vec::new();
    }
    let mut found = HashSet::new();
    for &pid in pids {
        let Ok(fds) = fs::read_dir(format!("/proc/{pid}/fd")) else {
            continue;
        };
        for fd in fds.flatten() {
            let Ok(link) = fs::read_link(fd.path()) else {
                continue;
            };
            if let Some(port) = link
                .to_str()
                .and_then(socket_inode)
                .and_then(|inode| inodes.get(&inode))
            {
                found.insert((pid, *port));
            }
        }
    }
    found.into_iter().collect()
}

/// The value of `name` in a NUL-separated `KEY=VALUE` block, as
/// `/proc/<pid>/environ` holds it. Names are case-sensitive.
fn value_in_environ(block: &[u8], name: &str) -> Option<String> {
    block.split(|byte| *byte == 0).find_map(|entry| {
        let rest = entry.strip_prefix(name.as_bytes())?.strip_prefix(b"=")?;
        Some(String::from_utf8_lossy(rest).into_owned())
    })
}

/// The arguments in a NUL-separated `/proc/<pid>/cmdline` block. Empty
/// arguments are dropped, as sysinfo drops them, so a command line reads the
/// same as it did when sysinfo read it.
fn args_in_cmdline(block: &[u8]) -> Vec<String> {
    block
        .split(|byte| *byte == 0)
        .filter(|arg| !arg.is_empty())
        .map(|arg| String::from_utf8_lossy(arg).into_owned())
        .collect()
}

/// What the process scan remembers of each process between scans: the
/// command line and environment, read once — empty and unreadable results
/// too — and whether the working directory was refused.
#[derive(Default)]
pub struct ProcessCache {
    cmdlines: OncePerProcess<Vec<String>>,
    /// The environment variable `environ` holds the values of.
    env_name: String,
    environ: OncePerProcess<Option<String>>,
    /// The processes that refused their working directory: same uid, but not
    /// dumpable (keyrings, agents, sandboxed browser processes) or in a user
    /// namespace this one has no say in. That stays so, while the process does.
    cwd_refused: OncePerProcess<()>,
}

impl ProcessCache {
    /// `pid`'s working directory, read on every scan — a process can `cd` —
    /// unless it refused it once. None when it is gone or not ours to read.
    pub fn cwd(&mut self, pid: u32, start_time: u64, process_name: &str) -> Option<String> {
        if self
            .cwd_refused
            .known(pid, start_time, process_name)
            .is_some()
        {
            return None;
        }
        match fs::read_link(format!("/proc/{pid}/cwd")) {
            Ok(path) => Some(path.to_string_lossy().into_owned()),
            Err(error) => {
                if error.kind() == ErrorKind::PermissionDenied {
                    self.cwd_refused.remember(pid, start_time, process_name, ());
                }
                None
            }
        }
    }

    /// `pid`'s arguments, read from `/proc` the first time this process is
    /// asked about. Empty for a process that is gone or has none (a zombie).
    pub fn cmdline(&mut self, pid: u32, start_time: u64, process_name: &str) -> &[String] {
        self.cmdlines.get(pid, start_time, process_name, || {
            fs::read(format!("/proc/{pid}/cmdline"))
                .map(|block| args_in_cmdline(&block))
                .unwrap_or_default()
        })
    }

    /// `name`'s value in `pid`'s environment, read from `/proc` the first
    /// time this process is asked about.
    pub fn env_value(
        &mut self,
        name: &str,
        pid: u32,
        start_time: u64,
        process_name: &str,
    ) -> Option<String> {
        if self.env_name != name {
            self.env_name = name.to_owned();
            self.environ = OncePerProcess::default();
        }
        self.environ
            .get(pid, start_time, process_name, || {
                fs::read(format!("/proc/{pid}/environ"))
                    .ok()
                    .and_then(|block| value_in_environ(&block, name))
            })
            .clone()
    }

    /// Forget the processes not in `alive`.
    pub fn retain(&mut self, alive: &HashSet<u32>) {
        self.cmdlines.retain(alive);
        self.environ.retain(alive);
        self.cwd_refused.retain(alive);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn listening_sockets_by_inode() {
        let table = "\
  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 4242 1 0 100 0 0 10 0
   1: 0100007F:A3B2 0100007F:1F90 01 00000000:00000000 00:00000000 00000000  1000        0 4343 1 0 20 4 30 10 -1
   2: 0100007F:0050 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 0 1 0 100 0 0 10 0
";
        let mut inodes = HashMap::new();
        listening_in_table(table, &mut inodes);
        // The established connection and the inode-less entry are skipped.
        assert_eq!(inodes, HashMap::from([(4242, 8080)]));
    }

    #[test]
    fn listening_ipv6_sockets() {
        let table = "\
  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000001000000:0BB8 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 777 1 0 100 0 0 10 0
";
        let mut inodes = HashMap::new();
        listening_in_table(table, &mut inodes);
        assert_eq!(inodes, HashMap::from([(777, 3000)]));
    }

    #[test]
    fn socket_links() {
        assert_eq!(socket_inode("socket:[4242]"), Some(4242));
        assert_eq!(socket_inode("pipe:[4242]"), None);
        assert_eq!(socket_inode("/dev/null"), None);
    }

    #[test]
    fn environ_values() {
        let block = b"PATH=/usr/bin\0CH_WS=ch::m::p::a=b\0CH_WS_OTHER=x\0";
        assert_eq!(
            value_in_environ(block, "CH_WS").as_deref(),
            Some("ch::m::p::a=b")
        );
        assert_eq!(value_in_environ(block, "CH"), None);
        assert_eq!(value_in_environ(block, "ch_ws"), None);
        assert_eq!(value_in_environ(b"", "CH_WS"), None);
    }

    #[test]
    fn cmdline_args() {
        assert_eq!(
            args_in_cmdline(b"node\0-e\0\0console.log(1)\0"),
            ["node", "-e", "console.log(1)"]
        );
        // A title rewritten in place (setproctitle): one argument with spaces.
        assert_eq!(args_in_cmdline(b"sshd: user [priv]"), ["sshd: user [priv]"]);
        assert!(args_in_cmdline(b"").is_empty());
    }

    #[test]
    #[cfg_attr(not(target_os = "linux"), ignore = "reads /proc")]
    fn this_process_from_proc() {
        let mut cache = ProcessCache::default();
        let pid = std::process::id();
        let own: Vec<String> = std::env::args().collect();
        assert_eq!(cache.cmdline(pid, 1, "test"), own.as_slice());
        // A variable this process does not have: the miss is remembered.
        assert_eq!(cache.env_value("_CH_NO_SUCH_VAR", pid, 1, "test"), None);
        assert!(cache.environ.known(pid, 1, "test").is_some());
        let path = std::env::var("PATH").ok();
        // Another variable starts over rather than answering the old one's miss.
        assert_eq!(cache.env_value("PATH", pid, 1, "test"), path);

        let here = std::env::current_dir().unwrap();
        assert_eq!(
            cache.cwd(pid, 1, "test"),
            Some(here.to_string_lossy().into_owned())
        );
        // A refusal is remembered: no read is made, so none can answer.
        cache.cwd_refused.remember(pid, 1, "test", ());
        assert_eq!(cache.cwd(pid, 1, "test"), None);
        // A pid that is gone is no refusal.
        assert_eq!(cache.cwd(u32::MAX, 1, "gone"), None);
        assert!(cache.cwd_refused.known(u32::MAX, 1, "gone").is_none());
    }
}
