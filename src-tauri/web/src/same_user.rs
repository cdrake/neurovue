//! Serve only the user who started neurovue-web.
//!
//! The server listens on a localhost TCP port with no login, which is fine on a
//! laptop but not on a shared Linux host (an HPC node under Neurodesk): any
//! other user there can connect to 127.0.0.1:<port> and browse, open, and
//! download this user's files. Neurodesk's webapp proxy can only reach a TCP
//! port and can't add credentials, so instead each connection is attributed to
//! the user who owns the connecting socket, from /proc/net/tcp, and refused
//! unless that is us. Apptainer shares the host network namespace, so the
//! lookup also sees connections from outside the container. The check runs
//! once per connection, when it is accepted, so the answer belongs to that
//! connection rather than to a port number a different process might reuse.
//!
//! Linux only. Elsewhere (macOS/Windows development) every connection passes.

use axum::{
    extract::{connect_info::Connected, ConnectInfo, Request},
    http::StatusCode,
    middleware::Next,
    response::{IntoResponse, Response},
    serve::IncomingStream,
};
use std::net::SocketAddr;

/// Who is on the other end of a connection.
#[derive(Clone, Copy, Debug)]
pub struct Peer {
    addr: SocketAddr,
    /// The uid owning the connecting socket; None if it couldn't be found.
    uid: Option<u32>,
}

impl Connected<IncomingStream<'_>> for Peer {
    fn connect_info(stream: IncomingStream<'_>) -> Self {
        let addr = stream.remote_addr();
        let uid = stream
            .local_addr()
            .ok()
            .and_then(|ours| socket_owner(addr, ours));
        Peer { addr, uid }
    }
}

/// Middleware: refuse requests on connections another user opened.
pub async fn require_same_user(
    ConnectInfo(peer): ConnectInfo<Peer>,
    request: Request,
    next: Next,
) -> Response {
    if !cfg!(target_os = "linux") || peer.uid == Some(crate::private_dir::current_uid()) {
        return next.run(request).await;
    }
    match peer.uid {
        Some(uid) => eprintln!(
            "neurovue-web: refused {} {} from {} (uid {uid}, not this user)",
            request.method(),
            request.uri().path(),
            peer.addr
        ),
        None => eprintln!(
            "neurovue-web: refused {} {} from {} (couldn't identify the connecting user)",
            request.method(),
            request.uri().path(),
            peer.addr
        ),
    }
    (
        StatusCode::FORBIDDEN,
        "This NeuroVue server belongs to another user.",
    )
        .into_response()
}

/// The uid owning the socket at `peer` that is connected to `ours`.
#[cfg(target_os = "linux")]
fn socket_owner(peer: SocketAddr, ours: SocketAddr) -> Option<u32> {
    let table = if peer.is_ipv4() {
        "/proc/net/tcp"
    } else {
        "/proc/net/tcp6"
    };
    let text = std::fs::read_to_string(table).ok()?;
    owner_in_table(&text, &proc_net_addr(peer), &proc_net_addr(ours))
}

#[cfg(not(target_os = "linux"))]
fn socket_owner(_peer: SocketAddr, _ours: SocketAddr) -> Option<u32> {
    None
}

/// Find the row whose local end is `local` and remote end is `remote` in a
/// /proc/net/tcp{,6} table, and return its uid column.
fn owner_in_table(table: &str, local: &str, remote: &str) -> Option<u32> {
    table.lines().skip(1).find_map(|line| {
        // sl local_address rem_address st tx:rx tr:when retrnsmt uid ...
        let fields: Vec<&str> = line.split_whitespace().collect();
        (fields.get(1) == Some(&local) && fields.get(2) == Some(&remote))
            .then(|| fields.get(7)?.parse().ok())
            .flatten()
    })
}

/// An address as /proc/net/tcp{,6} prints it: each 32-bit word of the IP in
/// host byte order as hex, then the port in hex.
fn proc_net_addr(addr: SocketAddr) -> String {
    let words: Vec<[u8; 4]> = match addr {
        SocketAddr::V4(v4) => vec![v4.ip().octets()],
        SocketAddr::V6(v6) => v6
            .ip()
            .octets()
            .chunks_exact(4)
            .map(|chunk| [chunk[0], chunk[1], chunk[2], chunk[3]])
            .collect(),
    };
    let ip: String = words
        .iter()
        .map(|word| format!("{:08X}", u32::from_ne_bytes(*word)))
        .collect();
    format!("{ip}:{:04X}", addr.port())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Little-endian hosts (x86_64, aarch64) print 127.0.0.1 as 0100007F.
    #[cfg(target_endian = "little")]
    #[test]
    fn formats_addresses_like_proc_net() {
        assert_eq!(
            proc_net_addr("127.0.0.1:8090".parse().unwrap()),
            "0100007F:1F9A"
        );
        assert_eq!(
            proc_net_addr("[::1]:443".parse().unwrap()),
            "00000000000000000000000001000000:01BB"
        );
    }

    #[test]
    fn finds_the_owner_of_the_matching_connection() {
        let table = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:1F9A 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1001        0 1 1 0 100 0 0 10 0
   1: 0100007F:C350 0100007F:1F9A 01 00000000:00000000 00:00000000 00000000  1002        0 2 1 0 20 4 30 10 -1
   2: 0100007F:1F9A 0100007F:C350 01 00000000:00000000 00:00000000 00000000  1001        0 3 1 0 20 4 30 10 -1
";
        // The client end (local C350 -> remote 1F9A) belongs to uid 1002.
        assert_eq!(
            owner_in_table(table, "0100007F:C350", "0100007F:1F9A"),
            Some(1002)
        );
        assert_eq!(
            owner_in_table(table, "0100007F:C351", "0100007F:1F9A"),
            None
        );
    }
}
