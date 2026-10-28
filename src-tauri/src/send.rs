// The Mac's half of Send to iPad: offer a staged file to a receiver found by
// bonjour.rs, wait while the person there accepts or declines, then upload
// it. The protocol is receive.rs's; the two requests are plain HTTP/1.1 on a
// TcpStream, which is all a local transfer needs.

use std::{
    fs::File,
    io::{Read, Write},
    net::{SocketAddr, TcpStream, ToSocketAddrs},
    path::Path,
    time::Duration,
};

/// A receiver seen on the network (bonjour.rs), as the page lists it.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub(crate) struct SendTarget {
    /// The device's name, as the person set it.
    pub name: String,
    pub host: String,
    pub port: u16,
}

impl SendTarget {
    /// Where to connect, IPv4 first: the receiver listens on IPv4 only.
    pub(crate) fn addresses(&self) -> Vec<SocketAddr> {
        let mut addresses: Vec<SocketAddr> = (self.host.as_str(), self.port)
            .to_socket_addrs()
            .map(|found| found.collect())
            .unwrap_or_default();
        addresses.sort_by_key(|address| !address.is_ipv4());
        addresses
    }
}

/// Longer than the receiver waits for an answer (receive.rs OFFER_TIMEOUT),
/// so its "timed out" reply arrives rather than our own.
const ANSWER_WAIT: Duration = Duration::from_secs(135);
const CONNECT_WAIT: Duration = Duration::from_secs(5);
/// Per read or write during the upload, not the whole transfer.
const TRANSFER_STALL: Duration = Duration::from_secs(30);

/// Offers `path` to the receiver at `addresses` and uploads it once accepted.
/// The error is a sentence for the status line.
pub(crate) fn send_file(
    addresses: &[SocketAddr],
    device: &str,
    path: &Path,
    from: &str,
) -> Result<(), String> {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("send: the file has no name")?;
    let size = std::fs::metadata(path)
        .map_err(|error| format!("send: {error}"))?
        .len();
    let offer = serde_json::json!({ "name": name, "from": from, "size": size }).to_string();

    let mut stream = connect(addresses, device)?;
    stream
        .set_read_timeout(Some(ANSWER_WAIT))
        .map_err(|error| format!("send: {error}"))?;
    let (status, body) = request(
        &mut stream,
        "POST /offer",
        "application/json",
        offer.len() as u64,
        &mut offer.as_bytes(),
    )
    .map_err(|error| format!("Couldn't reach {device}: {error}"))?;
    match status {
        200 => {}
        403 => return Err(format!("{device} declined {name}.")),
        408 => return Err(format!("No one answered on {device}.")),
        409 => return Err(format!("{device} is already being offered a file.")),
        415 => return Err(format!("{device} can't open {name}.")),
        503 => return Err(format!("NeuroVue on {device} isn't ready to receive.")),
        other => return Err(format!("{device} refused the file ({other}).")),
    }
    let token = serde_json::from_slice::<serde_json::Value>(&body)
        .ok()
        .and_then(|reply| reply["token"].as_str().map(str::to_owned))
        .ok_or_else(|| format!("{device} sent an unexpected answer."))?;

    let mut file = File::open(path).map_err(|error| format!("send: {error}"))?;
    let mut stream = connect(addresses, device)?;
    stream
        .set_read_timeout(Some(TRANSFER_STALL))
        .and_then(|()| stream.set_write_timeout(Some(TRANSFER_STALL)))
        .map_err(|error| format!("send: {error}"))?;
    let (status, _) = request(
        &mut stream,
        &format!("PUT /upload/{token}"),
        "application/octet-stream",
        size,
        &mut file,
    )
    .map_err(|error| format!("Sending to {device} failed: {error}"))?;
    if status != 200 {
        return Err(format!("{device} didn't keep the file ({status})."));
    }
    Ok(())
}

fn connect(addresses: &[SocketAddr], device: &str) -> Result<TcpStream, String> {
    addresses
        .iter()
        .find_map(|address| TcpStream::connect_timeout(address, CONNECT_WAIT).ok())
        .ok_or_else(|| format!("Couldn't reach {device}. Is NeuroVue open on it?"))
}

/// Sends one request with a `length`-byte body read from `body`, and returns
/// the response's status and body.
fn request(
    stream: &mut TcpStream,
    request_line: &str,
    content_type: &str,
    length: u64,
    body: &mut dyn Read,
) -> std::io::Result<(u16, Vec<u8>)> {
    write!(
        stream,
        "{request_line} HTTP/1.1\r\nHost: neurovue\r\nContent-Type: {content_type}\r\n\
         Content-Length: {length}\r\nConnection: close\r\n\r\n"
    )?;
    std::io::copy(body, stream)?;
    stream.flush()?;

    let mut response = Vec::new();
    stream.read_to_end(&mut response)?;
    let split = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| std::io::Error::other("no HTTP response"))?;
    let status = std::str::from_utf8(&response[..split])
        .ok()
        .and_then(|head| head.split_whitespace().nth(1))
        .and_then(|code| code.parse().ok())
        .ok_or_else(|| std::io::Error::other("no HTTP status"))?;
    Ok((status, response[split + 4..].to_vec()))
}

/// This Mac's name, as the receiver's prompt shows it.
pub(crate) fn device_name() -> String {
    #[cfg(target_os = "macos")]
    if let Ok(output) = std::process::Command::new("scutil")
        .args(["--get", "ComputerName"])
        .output()
    {
        let name = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if output.status.success() && !name.is_empty() {
            return name;
        }
    }
    "A Mac".to_string()
}
