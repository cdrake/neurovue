//! Headless NeuroVue for NeuroFlow steps; see `neurovue_lib::headless`.

fn main() {
    std::process::exit(neurovue_lib::headless::main(
        std::env::args().skip(1).collect(),
    ));
}
