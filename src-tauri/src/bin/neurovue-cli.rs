//! Headless NeuroVue for NeuroFlow steps; see `neurovue_lib::headless`.
//! Build with `cargo run --features cli --bin neurovue-cli`.

fn main() {
    std::process::exit(neurovue_lib::headless::main(
        std::env::args().skip(1).collect(),
    ));
}
