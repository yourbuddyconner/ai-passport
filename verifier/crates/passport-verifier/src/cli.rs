//! CLI argument parsing for the Hello World server
use clap::Parser;

/// AI Passport trace verifier
#[derive(Parser, Debug)]
#[command(
    name = "passport-verifier",
    version,
    about = "AI Passport trace verifier"
)]
pub struct Cli {
    /// IP address to listen on
    #[arg(long, default_value = "127.0.0.1")]
    pub host: String,

    /// Port to listen on
    #[arg(long, default_value = "44020")]
    pub port: u16,

    /// Path to the quorum key file
    #[arg(long, default_value = qos_core::QUORUM_FILE)]
    pub quorum_file: String,

    /// Path to the ephemeral key file used for app proofs
    #[arg(long, default_value = qos_core::EPHEMERAL_KEY_FILE)]
    pub ephemeral_file: String,
}
