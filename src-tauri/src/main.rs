mod credential_auth;
mod credential_backup;
mod credential_file_inspect;
mod credential_ipc;
mod credential_leases;
mod credential_mcp;
mod credential_product;
use skill_repo_tracker_lib::credential_protocol;
mod credential_records;
mod credential_runtime;
mod credential_store;

fn main() {
    if let Some(result) =
        credential_mcp::dispatch_from_env().or_else(credential_runtime::dispatch_from_env)
    {
        if let Err(code) = result {
            eprintln!("Credential runtime: {code}");
            std::process::exit(1);
        }
        return;
    }
    skill_repo_tracker_lib::run();
}
