// Send to iPad's encrypted channel (see tls.rs): TLS 1.3 from Apple's
// Network.framework, so the app uses only the OS's encryption. Each side of a
// connection is bridged to a socketpair end the Rust code reads and writes as
// plain HTTP.
//
// The listener's certificate is self-signed and made in memory at first use,
// so nothing touches the keychain. The sender can't verify it, so both ends
// show a code instead, derived from the TLS session (RFC 5705 exporter) and
// two nonces exchanged commit-then-reveal: a man in the middle runs two
// sessions with different codes and can't steer either code to match the
// other, because each side's nonce is fixed before it sees the other's.

#import <CommonCrypto/CommonDigest.h>
#import <Foundation/Foundation.h>
#import <Network/Network.h>
#import <Security/Security.h>
#include <sys/socket.h>
#include <unistd.h>

#define NV_HASH CC_SHA256_DIGEST_LENGTH
static const char EXPORTER_LABEL[] = "EXPORTER-neurovue-send";
// Handshakes allowed per minute: guessing a 6-digit code needs about a million.
static const int HANDSHAKES_PER_MINUTE = 12;

typedef void (*nv_tls_accept_fn)(void *context, int fd, const char *peer, const char *code);

#pragma mark Identity

static NSData *der(uint8_t tag, NSData *body) {
    NSMutableData *out = [NSMutableData dataWithBytes:&tag length:1];
    NSUInteger n = body.length;
    if (n < 0x80) {
        uint8_t b = (uint8_t)n;
        [out appendBytes:&b length:1];
    } else if (n < 0x100) {
        uint8_t b[2] = {0x81, (uint8_t)n};
        [out appendBytes:b length:2];
    } else {
        uint8_t b[3] = {0x82, (uint8_t)(n >> 8), (uint8_t)n};
        [out appendBytes:b length:3];
    }
    [out appendData:body];
    return out;
}

static NSData *concat(NSArray<NSData *> *parts) {
    NSMutableData *out = [NSMutableData data];
    for (NSData *part in parts) [out appendData:part];
    return out;
}

static NSData *bitString(NSData *bits) {
    uint8_t unused = 0;
    return der(0x03, concat(@[[NSData dataWithBytes:&unused length:1], bits]));
}

/// A self-signed P-256 certificate for `key`, in DER.
static NSData *selfSignedCertificate(SecKeyRef key) {
    static const uint8_t ecP256[] = {0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
                                     0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07};
    static const uint8_t ecdsaSha256[] = {0x30, 0x0a, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02};
    static const uint8_t version3[] = {0xa0, 0x03, 0x02, 0x01, 0x02};
    static const uint8_t commonName[] = {0x06, 0x03, 0x55, 0x04, 0x03};
    SecKeyRef publicKey = SecKeyCopyPublicKey(key);
    NSData *point = CFBridgingRelease(SecKeyCopyExternalRepresentation(publicKey, NULL));
    CFRelease(publicKey);
    if (!point) return nil;
    NSData *algorithm = [NSData dataWithBytes:ecdsaSha256 length:sizeof ecdsaSha256];
    NSData *name = der(0x30, der(0x31, der(0x30, concat(@[
        [NSData dataWithBytes:commonName length:sizeof commonName],
        der(0x0c, [@"NeuroVue" dataUsingEncoding:NSUTF8StringEncoding]),
    ]))));
    NSData *validity = der(0x30, concat(@[
        der(0x17, [@"250101000000Z" dataUsingEncoding:NSASCIIStringEncoding]),
        der(0x17, [@"491231235959Z" dataUsingEncoding:NSASCIIStringEncoding]),
    ]));
    uint8_t serial[10] = {0x02, 0x08, 0x01};  // positive: leading byte below 0x80
    arc4random_buf(serial + 3, 7);
    NSData *tbs = der(0x30, concat(@[
        [NSData dataWithBytes:version3 length:sizeof version3],
        [NSData dataWithBytes:serial length:sizeof serial],
        algorithm, name, validity, name,
        der(0x30, concat(@[[NSData dataWithBytes:ecP256 length:sizeof ecP256], bitString(point)])),
    ]));
    NSData *signature = CFBridgingRelease(SecKeyCreateSignature(
        key, kSecKeyAlgorithmECDSASignatureMessageX962SHA256, (__bridge CFDataRef)tbs, NULL));
    if (!signature) return nil;
    return der(0x30, concat(@[tbs, algorithm, bitString(signature)]));
}

/// This process's listener identity, made once; nil if the OS refused.
static sec_identity_t listenerIdentity(void) {
    static sec_identity_t identity;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        SecKeyRef key = SecKeyCreateRandomKey((__bridge CFDictionaryRef) @{
            (id)kSecAttrKeyType : (id)kSecAttrKeyTypeECSECPrimeRandom,
            (id)kSecAttrKeySizeInBits : @256,
        }, NULL);
        if (!key) return;
        NSData *der = selfSignedCertificate(key);
        SecCertificateRef certificate = der ? SecCertificateCreateWithData(NULL, (__bridge CFDataRef)der) : NULL;
        SecIdentityRef secIdentity = certificate ? SecIdentityCreate(NULL, certificate, key) : NULL;
        if (secIdentity) {
            identity = sec_identity_create(secIdentity);
            CFRelease(secIdentity);
        }
        if (certificate) CFRelease(certificate);
        CFRelease(key);
    });
    return identity;
}

#pragma mark Code exchange

static void sha256(NSData *data, uint8_t out[NV_HASH]) {
    CC_SHA256(data.bytes, (CC_LONG)data.length, out);
}

static NSData *dataFrom(dispatch_data_t data) {
    NSMutableData *out = [NSMutableData data];
    if (data) dispatch_data_apply(data, ^bool(dispatch_data_t region, size_t offset, const void *bytes, size_t size) {
        [out appendBytes:bytes length:size];
        return true;
    });
    return out;
}

static void sendBytes(nw_connection_t connection, NSData *bytes, void (^done)(bool ok)) {
    dispatch_data_t data = dispatch_data_create(bytes.bytes, bytes.length, NULL, DISPATCH_DATA_DESTRUCTOR_DEFAULT);
    nw_connection_send(connection, data, NW_CONNECTION_DEFAULT_MESSAGE_CONTEXT, false, ^(nw_error_t error) {
        done(error == nil);
    });
}

static void receiveBytes(nw_connection_t connection, uint32_t length, void (^done)(NSData *bytes)) {
    nw_connection_receive(connection, length, length, ^(dispatch_data_t data, nw_content_context_t context, bool complete, nw_error_t error) {
        NSData *bytes = dataFrom(data);
        done(error == nil && bytes.length == length ? bytes : nil);
    });
}

static NSData *randomNonce(void) {
    NSMutableData *nonce = [NSMutableData dataWithLength:NV_HASH];
    arc4random_buf(nonce.mutableBytes, NV_HASH);
    return nonce;
}

/// Six digits from the session's exported secret and both nonces.
static NSString *sessionCode(nw_connection_t connection, NSData *senderNonce, NSData *receiverNonce) {
    nw_protocol_metadata_t metadata = nw_connection_copy_protocol_metadata(connection, nw_protocol_copy_tls_definition());
    if (!metadata) return nil;
    sec_protocol_metadata_t tls = nw_tls_copy_sec_protocol_metadata(metadata);
    dispatch_data_t secret = sec_protocol_metadata_create_secret(tls, sizeof EXPORTER_LABEL - 1, EXPORTER_LABEL, NV_HASH);
    if (!secret) return nil;
    uint8_t digest[NV_HASH];
    sha256(concat(@[dataFrom(secret), senderNonce, receiverNonce]), digest);
    uint32_t value = (uint32_t)digest[0] << 24 | (uint32_t)digest[1] << 16 | (uint32_t)digest[2] << 8 | digest[3];
    return [NSString stringWithFormat:@"%06u", value % 1000000];
}

/// Sender: commit to a nonce, take the receiver's, then reveal ours.
static void senderExchange(nw_connection_t connection, void (^done)(NSString *code)) {
    NSData *nonce = randomNonce();
    uint8_t commitment[NV_HASH];
    sha256(nonce, commitment);
    sendBytes(connection, [NSData dataWithBytes:commitment length:NV_HASH], ^(bool sent) {
        if (!sent) return done(nil);
        receiveBytes(connection, NV_HASH, ^(NSData *theirs) {
            if (!theirs) return done(nil);
            sendBytes(connection, nonce, ^(bool revealed) {
                done(revealed ? sessionCode(connection, nonce, theirs) : nil);
            });
        });
    });
}

/// Receiver: take the commitment, send our nonce, check the reveal.
static void receiverExchange(nw_connection_t connection, void (^done)(NSString *code)) {
    receiveBytes(connection, NV_HASH, ^(NSData *commitment) {
        if (!commitment) return done(nil);
        NSData *nonce = randomNonce();
        sendBytes(connection, nonce, ^(bool sent) {
            if (!sent) return done(nil);
            receiveBytes(connection, NV_HASH, ^(NSData *theirs) {
                uint8_t check[NV_HASH];
                if (theirs) sha256(theirs, check);
                bool kept = theirs && memcmp(check, commitment.bytes, NV_HASH) == 0;
                done(kept ? sessionCode(connection, theirs, nonce) : nil);
            });
        });
    });
}

#pragma mark Bridging

/// Writes what arrives on `connection` to `fd`, one receive at a time.
static void receiveInto(nw_connection_t connection, int fd, dispatch_queue_t writes, dispatch_group_t open) {
    nw_connection_receive(connection, 1, 64 * 1024, ^(dispatch_data_t data, nw_content_context_t context, bool complete, nw_error_t error) {
        dispatch_async(writes, ^{
            __block bool ok = error == nil;
            if (data) dispatch_data_apply(data, ^bool(dispatch_data_t region, size_t offset, const void *bytes, size_t size) {
                for (size_t done = 0; ok && done < size;) {
                    ssize_t n = write(fd, (const uint8_t *)bytes + done, size - done);
                    if (n <= 0) ok = false; else done += (size_t)n;
                }
                return ok;
            });
            if (ok && !complete) {
                receiveInto(connection, fd, writes, open);
                return;
            }
            shutdown(fd, ok ? SHUT_WR : SHUT_RDWR);
            dispatch_group_leave(open);
        });
    });
}

/// Copies between `connection` and `fd` until both directions end, then
/// closes both. Reads from `fd` wait for each send, so memory stays bounded.
static void bridge(nw_connection_t connection, int fd) {
    dispatch_queue_t reads = dispatch_queue_create("neurovue.tls.read", DISPATCH_QUEUE_SERIAL);
    dispatch_queue_t writes = dispatch_queue_create("neurovue.tls.write", DISPATCH_QUEUE_SERIAL);
    dispatch_group_t open = dispatch_group_create();
    dispatch_group_enter(open);
    dispatch_group_enter(open);
    dispatch_group_notify(open, writes, ^{
        nw_connection_cancel(connection);
        close(fd);
    });
    // A failure ends both directions: the Rust side then sees EOF or an error.
    nw_connection_set_state_changed_handler(connection, ^(nw_connection_state_t state, nw_error_t error) {
        if (state == nw_connection_state_failed) shutdown(fd, SHUT_RDWR);
    });

    dispatch_async(reads, ^{
        uint8_t buffer[64 * 1024];
        dispatch_semaphore_t sent = dispatch_semaphore_create(0);
        for (;;) {
            ssize_t n = read(fd, buffer, sizeof buffer);
            if (n <= 0) {
                // TLS here has no half-close: the peer only sees the end once
                // the connection closes, so EOF from Rust closes it.
                nw_connection_send(connection, NULL, NW_CONNECTION_FINAL_MESSAGE_CONTEXT, true, ^(nw_error_t error) {
                    nw_connection_cancel(connection);
                });
                break;
            }
            __block bool ok = true;
            dispatch_data_t data = dispatch_data_create(buffer, (size_t)n, NULL, DISPATCH_DATA_DESTRUCTOR_DEFAULT);
            nw_connection_send(connection, data, NW_CONNECTION_DEFAULT_MESSAGE_CONTEXT, false, ^(nw_error_t error) {
                ok = error == nil;
                dispatch_semaphore_signal(sent);
            });
            dispatch_semaphore_wait(sent, DISPATCH_TIME_FOREVER);
            if (!ok) {
                shutdown(fd, SHUT_RDWR);
                break;
            }
        }
        dispatch_group_leave(open);
    });

    receiveInto(connection, fd, writes, open);
}

/// A socketpair: [0] for Rust, [1] for the bridge.
static bool makePair(int pair[2]) {
    if (socketpair(AF_UNIX, SOCK_STREAM, 0, pair) != 0) return false;
    int on = 1;
    setsockopt(pair[0], SOL_SOCKET, SO_NOSIGPIPE, &on, sizeof on);
    setsockopt(pair[1], SOL_SOCKET, SO_NOSIGPIPE, &on, sizeof on);
    return true;
}

static nw_parameters_t tlsParameters(void (^configure)(sec_protocol_options_t options)) {
    return nw_parameters_create_secure_tcp(^(nw_protocol_options_t tlsOptions) {
        sec_protocol_options_t options = nw_tls_copy_sec_protocol_options(tlsOptions);
        sec_protocol_options_set_min_tls_protocol_version(options, tls_protocol_version_TLSv13);
        configure(options);
    }, NW_PARAMETERS_DEFAULT_CONFIGURATION);
}

#pragma mark Listener

@interface NVTLSListener : NSObject {
  @public
    nw_listener_t listener;
    _Atomic bool ready;
}
@end
@implementation NVTLSListener
@end

/// Rust's accept callback. Every block that may call it holds this object, so
/// it's released only once the listener and the connections it accepted are
/// done with it.
@interface NVTLSCallback : NSObject {
  @public
    nv_tls_accept_fn call;
    void (*release)(void *);
    void *context;
}
@end
@implementation NVTLSCallback
- (void)dealloc { release(context); }
@end

static NSString *peerAddress(nw_connection_t connection) {
    nw_endpoint_t endpoint = nw_connection_copy_endpoint(connection);
    const char *host = endpoint && nw_endpoint_get_type(endpoint) == nw_endpoint_type_address
        ? nw_endpoint_copy_address_string(endpoint) : NULL;
    NSString *address = host ? @(host) : @"";
    free((void *)host);
    // An IPv4 peer on a dual-stack socket reads as ::ffff:a.b.c.d.
    return [address hasPrefix:@"::ffff:"] ? [address substringFromIndex:7] : address;
}

/// Starts listening and returns the port, or 0. `on_accept` hears, on a
/// background queue, each connection whose code exchange completed. Takes
/// `context`: `release` frees it once nothing can call `on_accept` any more.
uint16_t nv_tls_listen(nv_tls_accept_fn on_accept, void (*release)(void *), void *context, void **out) {
    NVTLSCallback *callback = [NVTLSCallback new];
    callback->call = on_accept;
    callback->release = release;
    callback->context = context;
    sec_identity_t identity = listenerIdentity();
    if (!identity) return 0;
    nw_listener_t listener = nw_listener_create(tlsParameters(^(sec_protocol_options_t options) {
        sec_protocol_options_set_local_identity(options, identity);
    }));
    if (!listener) return 0;
    NVTLSListener *handle = [NVTLSListener new];
    handle->listener = listener;
    dispatch_queue_t queue = dispatch_queue_create("neurovue.tls.listen", DISPATCH_QUEUE_SERIAL);
    NSMutableArray<NSDate *> *recent = [NSMutableArray array];
    nw_listener_set_queue(listener, queue);
    nw_listener_set_new_connection_handler(listener, ^(nw_connection_t connection) {
        [recent filterUsingPredicate:[NSPredicate predicateWithFormat:@"timeIntervalSinceNow > -60"]];
        if (recent.count >= HANDSHAKES_PER_MINUTE) return nw_connection_cancel(connection);
        [recent addObject:[NSDate date]];
        nw_connection_set_queue(connection, dispatch_queue_create("neurovue.tls.accepted", DISPATCH_QUEUE_SERIAL));
        nw_connection_set_state_changed_handler(connection, ^(nw_connection_state_t state, nw_error_t error) {
            if (state == nw_connection_state_failed) nw_connection_cancel(connection);
            if (state != nw_connection_state_ready) return;
            receiverExchange(connection, ^(NSString *code) {
                int pair[2];
                if (!code || !makePair(pair)) return nw_connection_cancel(connection);
                bridge(connection, pair[1]);
                callback->call(callback->context, pair[0], peerAddress(connection).UTF8String, code.UTF8String);
            });
        });
        nw_connection_start(connection);
    });
    dispatch_semaphore_t settled = dispatch_semaphore_create(0);
    nw_listener_set_state_changed_handler(listener, ^(nw_listener_state_t state, nw_error_t error) {
        bool wasReady = handle->ready;
        handle->ready = state == nw_listener_state_ready;
        if (!wasReady && state != nw_listener_state_invalid && state != nw_listener_state_waiting)
            dispatch_semaphore_signal(settled);
    });
    nw_listener_start(listener);
    dispatch_semaphore_wait(settled, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC));
    if (!handle->ready) {
        nw_listener_cancel(listener);
        return 0;
    }
    *out = (__bridge_retained void *)handle;
    return nw_listener_get_port(listener);
}

/// False once the system has taken the listener (a suspended iOS app).
bool nv_tls_listener_alive(void *handle) {
    return ((__bridge NVTLSListener *)handle)->ready;
}

void nv_tls_listener_cancel(void *handle) {
    NVTLSListener *owned = (__bridge_transfer NVTLSListener *)handle;
    nw_listener_cancel(owned->listener);
}

#pragma mark Connect

/// Connects to `host`:`port`, waiting up to `timeout_ms` for the handshake
/// and code exchange. Returns the Rust end of the bridge, or -1 with
/// `error` set. `pin`, if given, is the SHA-256 of the certificate the
/// listener must present; `certificate` receives the one it did.
int nv_tls_connect(const char *host, uint16_t port, const uint8_t *pin, uint32_t timeout_ms,
                   char code[7], uint8_t certificate[NV_HASH], char *error, size_t error_length) {
    __block NSString *failure = @"the connection closed";
    __block NSString *agreed;
    __block NSData *presented;
    __block bool mismatched = false;
    dispatch_queue_t queue = dispatch_queue_create("neurovue.tls.connect", DISPATCH_QUEUE_SERIAL);
    nw_parameters_t parameters = tlsParameters(^(sec_protocol_options_t options) {
        sec_protocol_options_set_verify_block(options, ^(sec_protocol_metadata_t metadata, sec_trust_t trust, sec_protocol_verify_complete_t complete) {
            SecTrustRef secTrust = sec_trust_copy_ref(trust);
            CFArrayRef chain = SecTrustCopyCertificateChain(secTrust);
            bool ok = chain && CFArrayGetCount(chain) > 0;
            if (ok) {
                NSData *leaf = CFBridgingRelease(SecCertificateCopyData((SecCertificateRef)CFArrayGetValueAtIndex(chain, 0)));
                uint8_t hash[NV_HASH];
                sha256(leaf, hash);
                presented = [NSData dataWithBytes:hash length:NV_HASH];
                ok = !pin || memcmp(pin, hash, NV_HASH) == 0;
                mismatched = !ok;
                if (mismatched) failure = @"it isn't the device that accepted";
            }
            if (chain) CFRelease(chain);
            CFRelease(secTrust);
            complete(ok);
        }, queue);
    });
    char portString[6];
    snprintf(portString, sizeof portString, "%u", port);
    nw_connection_t connection = nw_connection_create(nw_endpoint_create_host(host, portString), parameters);
    dispatch_semaphore_t settled = dispatch_semaphore_create(0);
    __block bool finished = false;
    void (^settle)(void) = ^{
        if (finished) return;
        finished = true;
        dispatch_semaphore_signal(settled);
    };
    nw_connection_set_queue(connection, queue);
    nw_connection_set_state_changed_handler(connection, ^(nw_connection_state_t state, nw_error_t nwError) {
        if (state == nw_connection_state_ready) {
            senderExchange(connection, ^(NSString *result) {
                agreed = result;
                settle();
            });
        } else if (state == nw_connection_state_waiting || state == nw_connection_state_failed) {
            if (nwError && !mismatched)
                failure = nw_error_get_error_domain(nwError) == nw_error_domain_posix
                    ? @(strerror(nw_error_get_error_code(nwError)))
                    : @"the secure connection failed";
            settle();
        }
    });
    nw_connection_start(connection);
    dispatch_semaphore_wait(settled, dispatch_time(DISPATCH_TIME_NOW, (int64_t)timeout_ms * NSEC_PER_MSEC));
    __block int fd = -1;
    dispatch_sync(queue, ^{
        int pair[2];
        if (agreed && presented && makePair(pair)) {
            memcpy(code, agreed.UTF8String, 7);
            memcpy(certificate, presented.bytes, NV_HASH);
            bridge(connection, pair[1]);
            fd = pair[0];
        } else {
            if (!finished) failure = @"timed out";
            finished = true;
            nw_connection_set_state_changed_handler(connection, NULL);
            nw_connection_cancel(connection);
            snprintf(error, error_length, "%s", failure.UTF8String);
        }
    });
    return fd;
}
