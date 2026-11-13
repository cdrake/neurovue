// Marks this crate's build of the shared server sources (../src) so code there
// can tell it apart from the desktop app, e.g. to skip desktop-only tests.
fn main() {
    println!("cargo::rustc-check-cfg=cfg(neurovue_web)");
    println!("cargo::rustc-cfg=neurovue_web");
}
