fn main() {
    let target = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    if target == "macos" || target == "ios" {
        // Send to iPad's TLS (src/tls.m): the OS's Network.framework.
        println!("cargo:rerun-if-changed=src/tls.m");
        cc::Build::new()
            .file("src/tls.m")
            .flag("-fobjc-arc")
            .flag("-Wno-unused-parameter")
            .compile("neurovue_tls");
        for framework in ["Foundation", "Network", "Security"] {
            println!("cargo:rustc-link-lib=framework={framework}");
        }
    }
    tauri_build::build()
}
