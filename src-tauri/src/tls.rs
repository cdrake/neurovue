// Send to iPad's encrypted channel: Rust's side of tls.m. A connection here is
// a Unix socket carrying plain HTTP; tls.m carries it over TLS 1.3 on the
// network and works out the code both ends show.

use std::{
    ffi::{c_char, c_int, c_void, CStr, CString},
    net::SocketAddr,
    os::fd::{FromRawFd, OwnedFd},
    os::unix::net::UnixStream,
    time::Duration,
};

type AcceptFn = extern "C" fn(*mut c_void, c_int, *const c_char, *const c_char);

extern "C" {
    fn nv_tls_listen(
        on_accept: AcceptFn,
        release: extern "C" fn(*mut c_void),
        context: *mut c_void,
        out: *mut *mut c_void,
    ) -> u16;
    fn nv_tls_listener_alive(handle: *mut c_void) -> bool;
    fn nv_tls_listener_cancel(handle: *mut c_void);
    fn nv_tls_connect(
        host: *const c_char,
        port: u16,
        pin: *const u8,
        timeout_ms: u32,
        code: *mut c_char,
        certificate: *mut u8,
        error: *mut c_char,
        error_length: usize,
    ) -> c_int;
}

/// A connection whose code exchange completed.
pub(crate) struct Accepted {
    pub stream: OwnedFd,
    /// The sender's IP, as this device saw it.
    pub peer: String,
    /// The six digits the sender shows too.
    pub code: String,
}

type OnAccept = Box<dyn Fn(Accepted) + Send + Sync>;

/// Listening until dropped.
pub(crate) struct Listener {
    handle: *mut c_void,
    pub port: u16,
}

// tls.m's handle is an Objective-C object safe to use from any thread.
unsafe impl Send for Listener {}
unsafe impl Sync for Listener {}

extern "C" fn accepted(context: *mut c_void, fd: c_int, peer: *const c_char, code: *const c_char) {
    // SAFETY: context is the OnAccept tls.m holds until it calls release;
    // tls.m hands over fd and passes NUL-terminated strings.
    let on_accept = unsafe { &*(context as *const OnAccept) };
    let accepted = unsafe {
        Accepted {
            stream: OwnedFd::from_raw_fd(fd),
            peer: CStr::from_ptr(peer).to_string_lossy().into_owned(),
            code: CStr::from_ptr(code).to_string_lossy().into_owned(),
        }
    };
    on_accept(accepted);
}

extern "C" fn release(context: *mut c_void) {
    // SAFETY: tls.m calls this once, after the last call to accepted.
    drop(unsafe { Box::from_raw(context as *mut OnAccept) });
}

/// Listens on every interface, on a port the system picks.
pub(crate) fn listen(
    on_accept: impl Fn(Accepted) + Send + Sync + 'static,
) -> std::io::Result<Listener> {
    let on_accept: *mut OnAccept = Box::into_raw(Box::new(Box::new(on_accept)));
    let mut handle = std::ptr::null_mut();
    // SAFETY: tls.m owns on_accept from here and frees it through release.
    let port = unsafe { nv_tls_listen(accepted, release, on_accept.cast(), &mut handle) };
    if port == 0 {
        return Err(std::io::Error::other("couldn't listen for encrypted sends"));
    }
    Ok(Listener { handle, port })
}

impl Listener {
    /// False once the system has taken the listener (a suspended iOS app).
    #[cfg_attr(not(target_os = "ios"), allow(dead_code))]
    pub(crate) fn alive(&self) -> bool {
        // SAFETY: handle is live until Drop.
        unsafe { nv_tls_listener_alive(self.handle) }
    }
}

impl Drop for Listener {
    fn drop(&mut self) {
        // SAFETY: releases tls.m's handle; on_accept goes once in-flight
        // handshakes are done with it.
        unsafe { nv_tls_listener_cancel(self.handle) };
    }
}

/// An encrypted connection to a listener.
pub(crate) struct Connected {
    pub stream: UnixStream,
    pub code: String,
    /// SHA-256 of the listener's certificate, to pin a later connection to.
    pub certificate: [u8; 32],
}

/// Connects to `address`. With `pin`, refuses a listener whose certificate
/// differs: the same device, not just the same address.
pub(crate) fn connect(
    address: SocketAddr,
    pin: Option<&[u8; 32]>,
    wait: Duration,
) -> Result<Connected, String> {
    let host = CString::new(address.ip().to_string()).expect("no NUL in an IP");
    let mut code = [0 as c_char; 7];
    let mut certificate = [0u8; 32];
    let mut error = [0 as c_char; 256];
    // SAFETY: buffers are the sizes tls.m writes; pin is 32 bytes or null.
    let fd = unsafe {
        nv_tls_connect(
            host.as_ptr(),
            address.port(),
            pin.map_or(std::ptr::null(), |pin| pin.as_ptr()),
            wait.as_millis().try_into().unwrap_or(u32::MAX),
            code.as_mut_ptr(),
            certificate.as_mut_ptr(),
            error.as_mut_ptr(),
            error.len(),
        )
    };
    if fd < 0 {
        // SAFETY: tls.m NUL-terminates error.
        return Err(unsafe { CStr::from_ptr(error.as_ptr()) }
            .to_string_lossy()
            .into_owned());
    }
    Ok(Connected {
        // SAFETY: tls.m hands over fd.
        stream: unsafe { UnixStream::from_raw_fd(fd) },
        code: unsafe { CStr::from_ptr(code.as_ptr()) }
            .to_string_lossy()
            .into_owned(),
        certificate,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::sync::mpsc;

    fn loopback(port: u16) -> SocketAddr {
        SocketAddr::from(([127, 0, 0, 1], port))
    }

    #[test]
    fn both_ends_agree_on_the_code_and_carry_bytes() {
        let (tx, rx) = mpsc::channel();
        let tx = std::sync::Mutex::new(tx);
        let listener = listen(move |accepted| tx.lock().unwrap().send(accepted).unwrap()).unwrap();
        let mut sender = connect(loopback(listener.port), None, Duration::from_secs(5)).unwrap();
        let accepted = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(sender.code, accepted.code);
        assert_eq!(sender.code.len(), 6);
        assert_eq!(accepted.peer, "127.0.0.1");

        // As HTTP does: a request, then a response and close.
        let mut receiver = UnixStream::from(accepted.stream);
        sender.stream.write_all(b"hello").unwrap();
        let mut got = [0; 5];
        receiver.read_exact(&mut got).unwrap();
        assert_eq!(&got, b"hello");
        receiver.write_all(b"back").unwrap();
        drop(receiver);
        let mut back = Vec::new();
        sender.stream.read_to_end(&mut back).unwrap();
        assert_eq!(back, b"back");
    }

    #[test]
    fn large_bodies_wait_for_a_slow_reader_and_a_late_reply() {
        let (tx, rx) = mpsc::channel();
        let tx = std::sync::Mutex::new(tx);
        let listener = listen(move |accepted| tx.lock().unwrap().send(accepted).unwrap()).unwrap();
        let mut sender = connect(loopback(listener.port), None, Duration::from_secs(5)).unwrap();
        let mut receiver =
            UnixStream::from(rx.recv_timeout(Duration::from_secs(5)).unwrap().stream);
        let body: Vec<u8> = (0..8 << 20).map(|i| i as u8).collect();
        let reader = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            let mut got = vec![0; 8 << 20];
            receiver.read_exact(&mut got).unwrap();
            // Like waiting for Accept before answering.
            std::thread::sleep(Duration::from_millis(300));
            receiver.write_all(b"accepted").unwrap();
            got
        });
        sender.stream.write_all(&body).unwrap();
        let mut reply = Vec::new();
        sender.stream.read_to_end(&mut reply).unwrap();
        assert_eq!(reply, b"accepted");
        assert!(reader.join().unwrap() == body);
    }

    #[test]
    fn dropping_the_listener_frees_its_callback() {
        let held = std::sync::Arc::new(());
        let (tx, rx) = mpsc::channel();
        let tx = std::sync::Mutex::new(tx);
        let captured = held.clone();
        let listener = listen(move |accepted| {
            let _ = &captured;
            tx.lock().unwrap().send(accepted).unwrap();
        })
        .unwrap();
        let sender = connect(loopback(listener.port), None, Duration::from_secs(5)).unwrap();
        drop(rx.recv_timeout(Duration::from_secs(5)).unwrap());
        drop(sender);
        drop(listener);
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while std::sync::Arc::strong_count(&held) > 1 {
            assert!(std::time::Instant::now() < deadline, "callback leaked");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    fn sessions_differ_and_pins_hold() {
        let (tx, rx) = mpsc::channel();
        let tx = std::sync::Mutex::new(tx);
        let listener = listen(move |accepted| tx.lock().unwrap().send(accepted).unwrap()).unwrap();
        let address = loopback(listener.port);
        let first = connect(address, None, Duration::from_secs(5)).unwrap();
        let second = connect(address, Some(&first.certificate), Duration::from_secs(5)).unwrap();
        // One in a million they collide by chance.
        assert_ne!(first.code, second.code);
        assert!(connect(address, Some(&[0; 32]), Duration::from_secs(5)).is_err());
        drop(rx);
    }
}
