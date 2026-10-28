// Finding Send to iPad receivers on the local network: every receiver
// advertises itself, and a sender (a Mac, or an iPad sending a drawing back)
// browses for them. Both ends go through the system's mDNSResponder (dns_sd, in libSystem) rather than opening a
// multicast socket of our own, which iOS only allows with an entitlement
// Apple has to grant. iOS still asks the person for local network access,
// and Info.plist must list SERVICE_TYPE under NSBonjourServices.

use crate::send::SendTarget;
use std::ffi::CStr;
use std::ffi::{c_char, c_void, CString};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const SERVICE_TYPE: &str = "_neurovue._tcp";

#[repr(C)]
struct DnsServiceOpaque {
    _private: [u8; 0],
}
type DnsServiceRef = *mut DnsServiceOpaque;
type DnsServiceErrorType = i32;
type DnsServiceFlags = u32;

const FLAGS_ADD: DnsServiceFlags = 0x2;
const NO_ERROR: DnsServiceErrorType = 0;

type RegisterReply = Option<
    unsafe extern "C" fn(
        DnsServiceRef,
        DnsServiceFlags,
        DnsServiceErrorType,
        *const c_char,
        *const c_char,
        *const c_char,
        *mut c_void,
    ),
>;
type BrowseReply = unsafe extern "C" fn(
    DnsServiceRef,
    DnsServiceFlags,
    u32,
    DnsServiceErrorType,
    *const c_char,
    *const c_char,
    *const c_char,
    *mut c_void,
);
type ResolveReply = unsafe extern "C" fn(
    DnsServiceRef,
    DnsServiceFlags,
    u32,
    DnsServiceErrorType,
    *const c_char,
    *const c_char,
    u16,
    u16,
    *const u8,
    *mut c_void,
);

extern "C" {
    #[allow(clippy::too_many_arguments)]
    fn DNSServiceRegister(
        sd_ref: *mut DnsServiceRef,
        flags: DnsServiceFlags,
        interface_index: u32,
        name: *const c_char,
        regtype: *const c_char,
        domain: *const c_char,
        host: *const c_char,
        port: u16,
        txt_len: u16,
        txt_record: *const c_void,
        callback: RegisterReply,
        context: *mut c_void,
    ) -> DnsServiceErrorType;
    fn DNSServiceBrowse(
        sd_ref: *mut DnsServiceRef,
        flags: DnsServiceFlags,
        interface_index: u32,
        regtype: *const c_char,
        domain: *const c_char,
        callback: BrowseReply,
        context: *mut c_void,
    ) -> DnsServiceErrorType;
    fn DNSServiceResolve(
        sd_ref: *mut DnsServiceRef,
        flags: DnsServiceFlags,
        interface_index: u32,
        name: *const c_char,
        regtype: *const c_char,
        domain: *const c_char,
        callback: ResolveReply,
        context: *mut c_void,
    ) -> DnsServiceErrorType;
    fn DNSServiceRefSockFD(sd_ref: DnsServiceRef) -> i32;
    fn DNSServiceProcessResult(sd_ref: DnsServiceRef) -> DnsServiceErrorType;
    fn DNSServiceRefDeallocate(sd_ref: DnsServiceRef);
}

/// Owns a dns_sd reference and deallocates it when dropped.
struct Service(DnsServiceRef);

impl Drop for Service {
    fn drop(&mut self) {
        // SAFETY: the ref came from a successful dns_sd call and is dropped once.
        unsafe { DNSServiceRefDeallocate(self.0) }
    }
}

// SAFETY: dns_sd refs may be used from any thread, one at a time; the
// advertised one is only kept alive, then deallocated.
unsafe impl Send for Service {}

/// This run's TXT record entry, `id=<random>`: browsing also finds our own
/// receiver, and this is how it knows to leave it out.
fn own_id() -> &'static str {
    static ID: OnceLock<String> = OnceLock::new();
    ID.get_or_init(|| {
        use std::hash::{BuildHasher, Hasher};
        let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
        hasher.write_u32(std::process::id());
        format!("id={:016x}", hasher.finish())
    })
}

/// Advertises this device's receiver on `port` under the device's own name,
/// until the app quits or advertises again (iOS drops a suspended app's
/// registration, so it advertises anew on resuming).
pub(crate) fn advertise(port: u16) -> Result<(), String> {
    static ADVERTISED: Mutex<Option<Service>> = Mutex::new(None);
    let regtype = CString::new(SERVICE_TYPE).expect("no NUL in the service type");
    // A TXT record is length-prefixed strings.
    let id = own_id();
    let mut txt = vec![id.len() as u8];
    txt.extend_from_slice(id.as_bytes());
    let mut advertised = ADVERTISED
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    // Withdrawn first, or the new one would be renamed "Name (2)".
    advertised.take();
    // On a Mac, the name it sends under, so a drawing sent back finds it; on
    // iOS, the device's own name (null), which the app can't read.
    #[cfg(target_os = "ios")]
    let name: Option<CString> = None;
    #[cfg(not(target_os = "ios"))]
    let name = CString::new(crate::send::device_name()).ok();
    let mut sd_ref: DnsServiceRef = std::ptr::null_mut();
    // SAFETY: valid out-pointer and C strings; a null name means the device
    // name, and a null callback means we don't ask to hear how it went.
    let error = unsafe {
        DNSServiceRegister(
            &mut sd_ref,
            0,
            0,
            name.as_ref().map_or(std::ptr::null(), |name| name.as_ptr()),
            regtype.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            port.to_be(),
            txt.len() as u16,
            txt.as_ptr().cast(),
            None,
            std::ptr::null_mut(),
        )
    };
    if error != NO_ERROR {
        return Err(format!("Bonjour register failed ({error})"));
    }
    *advertised = Some(Service(sd_ref));
    Ok(())
}

struct Found {
    name: String,
    domain: String,
}

/// The receivers that answer within `wait`, other than this device's own.
pub(crate) fn browse(wait: Duration) -> Result<Vec<SendTarget>, String> {
    let regtype = CString::new(SERVICE_TYPE).expect("no NUL in the service type");
    let mut found: Vec<Found> = Vec::new();
    let mut sd_ref: DnsServiceRef = std::ptr::null_mut();
    // SAFETY: valid out-pointer and C strings; `found` outlives the ref, which
    // is deallocated (by `Service`) before this function returns.
    let error = unsafe {
        DNSServiceBrowse(
            &mut sd_ref,
            0,
            0,
            regtype.as_ptr(),
            std::ptr::null(),
            on_browse,
            (&mut found as *mut Vec<Found>).cast(),
        )
    };
    if error != NO_ERROR {
        return Err(format!("Bonjour browse failed ({error})"));
    }
    let browser = Service(sd_ref);
    pump(&browser, Instant::now() + wait);
    drop(browser);

    let mut targets = Vec::new();
    for service in found {
        if let Some(target) = resolve(&service, Duration::from_secs(2)) {
            targets.push(target);
        }
    }
    Ok(targets)
}

fn resolve(service: &Found, wait: Duration) -> Option<SendTarget> {
    let name = CString::new(service.name.as_str()).ok()?;
    let regtype = CString::new(SERVICE_TYPE).ok()?;
    let domain = CString::new(service.domain.as_str()).ok()?;
    let mut resolved: Option<Resolved> = None;
    let mut sd_ref: DnsServiceRef = std::ptr::null_mut();
    // SAFETY: as in `browse`; `resolved` outlives the ref.
    let error = unsafe {
        DNSServiceResolve(
            &mut sd_ref,
            0,
            0,
            name.as_ptr(),
            regtype.as_ptr(),
            domain.as_ptr(),
            on_resolve,
            (&mut resolved as *mut Option<Resolved>).cast(),
        )
    };
    if error != NO_ERROR {
        return None;
    }
    let resolver = Service(sd_ref);
    let deadline = Instant::now() + wait;
    while resolved.is_none() && pump_once(&resolver, deadline) {}
    drop(resolver);
    let Resolved { host, port, is_own } = resolved?;
    if is_own {
        return None;
    }
    Some(SendTarget {
        name: service.name.clone(),
        host,
        port,
    })
}

/// Handles replies until `deadline`.
fn pump(service: &Service, deadline: Instant) {
    while pump_once(service, deadline) {}
}

/// Waits for one reply until `deadline` and handles it; false once the
/// deadline passes or the connection fails.
fn pump_once(service: &Service, deadline: Instant) -> bool {
    let left = deadline.saturating_duration_since(Instant::now());
    if left.is_zero() {
        return false;
    }
    // SAFETY: a live ref; the fd stays owned by dns_sd.
    let fd = unsafe { DNSServiceRefSockFD(service.0) };
    if fd < 0 {
        return false;
    }
    let mut poll = libc::pollfd {
        fd,
        events: libc::POLLIN,
        revents: 0,
    };
    let millis = left.as_millis().clamp(1, i32::MAX as u128) as i32;
    // SAFETY: one valid pollfd.
    let ready = unsafe { libc::poll(&mut poll, 1, millis) };
    if ready <= 0 {
        return ready == 0 && Instant::now() < deadline;
    }
    // SAFETY: the fd is readable, so this won't block; it runs our callback.
    unsafe { DNSServiceProcessResult(service.0) == NO_ERROR }
}

unsafe extern "C" fn on_browse(
    _sd_ref: DnsServiceRef,
    flags: DnsServiceFlags,
    _interface_index: u32,
    error: DnsServiceErrorType,
    name: *const c_char,
    _regtype: *const c_char,
    domain: *const c_char,
    context: *mut c_void,
) {
    if error != NO_ERROR || name.is_null() || domain.is_null() {
        return;
    }
    // SAFETY: `context` is the `Vec<Found>` passed to DNSServiceBrowse, and the
    // strings are valid for the call.
    let found = unsafe { &mut *context.cast::<Vec<Found>>() };
    let name = unsafe { CStr::from_ptr(name) }
        .to_string_lossy()
        .into_owned();
    let domain = unsafe { CStr::from_ptr(domain) }
        .to_string_lossy()
        .into_owned();
    // A device on Wi-Fi and Ethernet is reported once per interface.
    let known = found.iter().position(|service| service.name == name);
    match (flags & FLAGS_ADD != 0, known) {
        (true, None) => found.push(Found { name, domain }),
        (false, Some(index)) => {
            found.remove(index);
        }
        _ => {}
    }
}

struct Resolved {
    host: String,
    port: u16,
    /// Our own receiver, by its TXT record.
    is_own: bool,
}

unsafe extern "C" fn on_resolve(
    _sd_ref: DnsServiceRef,
    _flags: DnsServiceFlags,
    _interface_index: u32,
    error: DnsServiceErrorType,
    _fullname: *const c_char,
    host: *const c_char,
    port: u16,
    txt_len: u16,
    txt_record: *const u8,
    context: *mut c_void,
) {
    if error != NO_ERROR || host.is_null() {
        return;
    }
    // SAFETY: `context` is the `Option` passed to DNSServiceResolve, and the
    // host string is valid for the call.
    let resolved = unsafe { &mut *context.cast::<Option<Resolved>>() };
    let host = unsafe { CStr::from_ptr(host) }
        .to_string_lossy()
        .into_owned();
    let txt: &[u8] = if txt_record.is_null() {
        &[]
    } else {
        // SAFETY: dns_sd passes `txt_len` valid bytes for the call.
        unsafe { std::slice::from_raw_parts(txt_record, txt_len.into()) }
    };
    *resolved = Some(Resolved {
        host,
        port: u16::from_be(port),
        is_own: txt_entries(txt).any(|entry| entry == own_id().as_bytes()),
    });
}

/// A TXT record's strings, each prefixed by its length.
fn txt_entries(mut txt: &[u8]) -> impl Iterator<Item = &[u8]> {
    std::iter::from_fn(move || {
        let (&len, rest) = txt.split_first()?;
        let entry = rest.get(..len.into())?;
        txt = &rest[entry.len()..];
        Some(entry)
    })
}
