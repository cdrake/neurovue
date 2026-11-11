//! NeuroVue in a browser; see `neurovue_lib::web`.
//! Build with `cargo run --features web --bin neurovue-web`.

fn main() {
    std::process::exit(neurovue_lib::web::main(std::env::args().skip(1).collect()));
}
