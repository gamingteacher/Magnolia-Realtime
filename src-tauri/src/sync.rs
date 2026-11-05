//! Cloud Sync's native side (the fork's real-time collaboration feature).
//!
//! The sync engine itself runs in the renderer (src/renderer/sync). The
//! backend holds what must not live in the web layer: the Supabase
//! credentials and login session, encrypted at rest with a key kept in the
//! OS keychain (the role Electron's `safeStorage` used to play); the
//! per-project sync state; and source-file transfer to and from Supabase
//! Storage.

use crate::state::AppState;
use crate::storage::user_data_dir;
use aes_gcm::aead::{Aead, AeadCore, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::Engine;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use tauri::State;

const KEYCHAIN_SERVICE: &str = "com.magnolia.app.sync";
const KEYCHAIN_USER: &str = "encryption-key";
const MAX_UPLOAD: usize = 200 * 1024 * 1024;

type CmdResult<T> = Result<T, String>;

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SyncConfig {
    url: String,
    anon_key: String,
}

fn config_file() -> PathBuf {
    user_data_dir().join("magnolia-sync.enc")
}

fn session_file() -> PathBuf {
    user_data_dir().join("magnolia-sync-session.enc")
}

fn state_file(key: &str) -> PathBuf {
    let digest = hex(&Sha256::digest(key.as_bytes()));
    user_data_dir().join(format!("magnolia-sync-state-{}.json", &digest[..24]))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// ── Encryption at rest ──

/// The AES key, created on first use and kept in the OS keychain.
fn secret_key() -> Result<[u8; 32], String> {
    let unavailable = |e: keyring::Error| format!("OS secure storage is not available ({e})");
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_USER).map_err(unavailable)?;
    match entry.get_password() {
        Ok(encoded) => STANDARD
            .decode(encoded)
            .ok()
            .and_then(|b| <[u8; 32]>::try_from(b).ok())
            .ok_or_else(|| "OS secure storage holds an invalid key".to_string()),
        Err(keyring::Error::NoEntry) => {
            let key = Aes256Gcm::generate_key(OsRng);
            entry
                .set_password(&STANDARD.encode(key))
                .map_err(unavailable)?;
            Ok(key.into())
        }
        Err(e) => Err(unavailable(e)),
    }
}

fn encrypt(plain: &[u8]) -> Result<Vec<u8>, String> {
    let key = secret_key()?;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let mut out = nonce.to_vec();
    out.extend(
        cipher
            .encrypt(&nonce, plain)
            .map_err(|_| "Encryption failed".to_string())?,
    );
    Ok(out)
}

fn decrypt(data: &[u8]) -> Option<Vec<u8>> {
    if data.len() < 12 {
        return None;
    }
    let key = secret_key().ok()?;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
    cipher
        .decrypt(Nonce::from_slice(&data[..12]), &data[12..])
        .ok()
}

fn load_config() -> Option<SyncConfig> {
    let data = std::fs::read(config_file()).ok()?;
    serde_json::from_slice(&decrypt(&data)?).ok()
}

fn clear_session_file() {
    let _ = std::fs::remove_file(session_file());
}

// ── Validation ──

/// Only publishable/anon keys, only over https (http for localhost).
pub fn validate_config(url: &str, anon_key: &str) -> Option<String> {
    let Ok(u) = reqwest::Url::parse(url) else {
        return Some("Invalid URL".into());
    };
    let local = matches!(u.host_str(), Some("localhost") | Some("127.0.0.1"));
    if u.scheme() != "https" && !(local && u.scheme() == "http") {
        return Some("URL must use https".into());
    }
    if anon_key.starts_with("sb_secret_") {
        return Some(
            "Secret keys must never be used in Magnolia. Use the publishable (anon) key.".into(),
        );
    }
    if anon_key.starts_with("sb_publishable_") {
        return None;
    }
    let invalid = || Some("Key is not a Supabase publishable/anon key".to_string());
    let parts: Vec<&str> = anon_key.split('.').collect();
    if parts.len() != 3 {
        return invalid();
    }
    let Some(payload) = URL_SAFE_NO_PAD
        .decode(parts[1].trim_end_matches('='))
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
    else {
        return invalid();
    };
    if payload.get("role").and_then(Value::as_str) == Some("service_role") {
        return Some(
            "Service-role keys must never be used in Magnolia. Use the anon/public key.".into(),
        );
    }
    None
}

// ── Per-project state (project link, outbox, last seq) ──
// Holds project data, so it stays on this machine.

#[tauri::command]
pub async fn sync_load_state(key: String) -> CmdResult<Option<Value>> {
    Ok(std::fs::read(state_file(&key))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok()))
}

#[tauri::command]
pub async fn sync_save_state(key: String, state: Value) -> CmdResult<bool> {
    let text = serde_json::to_vec(&state).map_err(|e| e.to_string())?;
    std::fs::write(state_file(&key), text).map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
pub async fn sync_delete_state(key: String) -> CmdResult<bool> {
    let _ = std::fs::remove_file(state_file(&key));
    Ok(true)
}

// ── Login session ──

#[tauri::command]
pub async fn sync_save_session(session: String) -> CmdResult<bool> {
    std::fs::write(session_file(), encrypt(session.as_bytes())?).map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
pub async fn sync_load_session() -> CmdResult<Option<String>> {
    let Ok(data) = std::fs::read(session_file()) else {
        return Ok(None);
    };
    // A session that can't be decrypted is as good as none: sign in again.
    Ok(decrypt(&data).and_then(|b| String::from_utf8(b).ok()))
}

#[tauri::command]
pub async fn sync_clear_session() -> CmdResult<()> {
    clear_session_file();
    Ok(())
}

// ── Connection settings ──

#[tauri::command]
pub async fn sync_get_config() -> CmdResult<Value> {
    let c = load_config();
    Ok(json!({ "url": c.as_ref().map(|c| c.url.as_str()).unwrap_or(""), "hasKey": c.is_some() }))
}

/// The key is only handed to renderer code that runs the sync engine.
#[tauri::command]
pub async fn sync_get_keys() -> CmdResult<Option<SyncConfig>> {
    Ok(load_config())
}

#[tauri::command]
pub async fn sync_set_config(url: String, anon_key: String) -> CmdResult<Value> {
    if let Some(error) = validate_config(&url, &anon_key) {
        return Ok(json!({ "ok": false, "error": error }));
    }
    let data = match encrypt(
        json!({ "url": url, "anonKey": anon_key })
            .to_string()
            .as_bytes(),
    ) {
        Ok(d) => d,
        Err(error) => return Ok(json!({ "ok": false, "error": error })),
    };
    if let Some(previous) = load_config()
        && (previous.url != url || previous.anon_key != anon_key)
    {
        clear_session_file();
    }
    std::fs::write(config_file(), data).map_err(|e| e.to_string())?;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn sync_clear_config() -> CmdResult<Value> {
    let _ = std::fs::remove_file(config_file());
    clear_session_file();
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn sync_test_connection() -> CmdResult<Value> {
    let Some(c) = load_config() else {
        return Ok(json!({ "ok": false, "error": "Not configured" }));
    };
    let res = reqwest::Client::new()
        .get(format!("{}/rest/v1/", c.url.trim_end_matches('/')))
        .header("apikey", &c.anon_key)
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await;
    Ok(match res {
        Ok(r) if r.status().is_success() => json!({ "ok": true }),
        Ok(r) => json!({ "ok": false, "error": format!("HTTP {}", r.status().as_u16()) }),
        Err(e) => json!({ "ok": false, "error": e.to_string() }),
    })
}

// ── Source files in Supabase Storage ──

fn storage_request(
    c: &SyncConfig,
    method: reqwest::Method,
    path: &str,
    token: &str,
) -> reqwest::RequestBuilder {
    reqwest::Client::new()
        .request(
            method,
            format!("{}/storage/v1/object/{path}", c.url.trim_end_matches('/')),
        )
        .header("apikey", &c.anon_key)
        .bearer_auth(token)
}

/// Storage paths are built from renderer input; keep them to one segment.
fn safe_segment(s: &str) -> bool {
    !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

#[tauri::command]
pub async fn sync_upload_binary(
    state: State<'_, AppState>,
    token: String,
    project_id: String,
    handle: String,
    ext: String,
) -> CmdResult<Value> {
    let fail = |error: &str| Ok(json!({ "ok": false, "error": error }));
    if !safe_segment(&project_id) || !safe_segment(&ext) {
        return fail("Invalid project or file type");
    }
    let Some(c) = load_config() else {
        return fail("Not configured");
    };
    let Some(bytes) = state.store.resolve(&handle) else {
        return fail("Binary not found");
    };
    if bytes.len() > MAX_UPLOAD {
        return fail("File exceeds the 200 MB sync limit");
    }
    let sha256 = hex(&Sha256::digest(bytes.as_slice()));
    let path = format!("sources/{project_id}/{sha256}.{ext}");
    let exists = storage_request(
        &c,
        reqwest::Method::HEAD,
        &format!("authenticated/{path}"),
        &token,
    )
    .send()
    .await
    .map_err(|e| e.to_string())?
    .status()
    .is_success();
    if !exists {
        let res = storage_request(&c, reqwest::Method::POST, &path, &token)
            .header("Content-Type", "application/octet-stream")
            .body(bytes.as_ref().clone())
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !res.status().is_success() && res.status().as_u16() != 409 {
            return fail(&format!("Upload failed (HTTP {})", res.status().as_u16()));
        }
    }
    Ok(json!({ "ok": true, "sha256": sha256, "size": bytes.len() }))
}

#[tauri::command]
pub async fn sync_download_binary(
    state: State<'_, AppState>,
    token: String,
    project_id: String,
    sha256: String,
    ext: String,
) -> CmdResult<Value> {
    let fail = |error: &str| Ok(json!({ "ok": false, "error": error }));
    if !safe_segment(&project_id) || !safe_segment(&sha256) || !safe_segment(&ext) {
        return fail("Invalid project or file type");
    }
    let Some(c) = load_config() else {
        return fail("Not configured");
    };
    let res = storage_request(
        &c,
        reqwest::Method::GET,
        &format!("authenticated/sources/{project_id}/{sha256}.{ext}"),
        &token,
    )
    .send()
    .await
    .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return fail(&format!("Download failed (HTTP {})", res.status().as_u16()));
    }
    let bytes = res.bytes().await.map_err(|e| e.to_string())?.to_vec();
    if hex(&Sha256::digest(&bytes)) != sha256 {
        return fail("Checksum mismatch");
    }
    Ok(json!({ "ok": true, "handle": state.store.put_overlay(bytes, &ext) }))
}

// ── Opening a cloud project from the welcome screen ──

#[tauri::command]
pub async fn sync_take_pending_connect(state: State<'_, AppState>) -> CmdResult<Option<String>> {
    Ok(state.pending_connect.lock().unwrap().take())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_secret_and_insecure_config() {
        assert!(validate_config("http://example.com", "sb_publishable_x").is_some());
        assert!(validate_config("https://x.supabase.co", "sb_secret_x").is_some());
        assert!(validate_config("https://x.supabase.co", "sb_publishable_x").is_none());
        assert!(validate_config("http://localhost:54321", "sb_publishable_x").is_none());
    }

    #[test]
    fn rejects_service_role_jwt() {
        let payload = URL_SAFE_NO_PAD.encode(br#"{"role":"service_role"}"#);
        assert!(validate_config("https://x.supabase.co", &format!("a.{payload}.c")).is_some());
        let anon = URL_SAFE_NO_PAD.encode(br#"{"role":"anon"}"#);
        assert!(validate_config("https://x.supabase.co", &format!("a.{anon}.c")).is_none());
    }
}
