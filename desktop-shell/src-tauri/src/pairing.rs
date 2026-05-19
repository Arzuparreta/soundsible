use crate::state::{load_runtime_state, read_owner_token};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use image::Luma;
use qrcode::QrCode;
use serde_json::Value;
use std::io::Cursor;
use std::time::Duration;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

fn api_base_url() -> Result<String, String> {
    let runtime = load_runtime_state().ok_or_else(|| "Engine is not running.".to_string())?;
    Ok(runtime.base_url.trim_end_matches('/').to_string())
}

fn admin_request(method: &str, path: &str, body: Option<Value>) -> Result<Value, String> {
    let base = api_base_url()?;
    let token = read_owner_token()?;
    let url = format!("{base}{path}");
    let agent = ureq::AgentBuilder::new().timeout(REQUEST_TIMEOUT).build();

    let response = match method {
        "GET" => agent
            .get(&url)
            .set("X-Soundsible-Admin-Token", &token)
            .call()
            .map_err(|e| format!("Request failed: {e}"))?,
        "POST" => {
            let mut request = agent
                .post(&url)
                .set("X-Soundsible-Admin-Token", &token)
                .set("Content-Type", "application/json");
            if let Some(payload) = body {
                request = request.send_json(payload);
            }
            request
                .call()
                .map_err(|e| format!("Request failed: {e}"))?
        }
        _ => return Err("Unsupported HTTP method.".into()),
    };

    let status = response.status();
    let data: Value = response
        .into_json()
        .map_err(|e| format!("Invalid JSON response: {e}"))?;
    if !(200..300).contains(&status) {
        let message = data
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("Request failed");
        return Err(format!("{message} ({status})"));
    }
    Ok(data)
}

pub fn qr_png_data_url(text: &str) -> Result<String, String> {
    if text.trim().is_empty() {
        return Err("QR payload is empty.".into());
    }
    let code = QrCode::new(text.as_bytes()).map_err(|e| format!("QR encode failed: {e}"))?;
    let img = code
        .render::<Luma<u8>>()
        .min_dimensions(220, 220)
        .dark_color(Luma([0u8]))
        .light_color(Luma([255u8]))
        .build();
    let mut png = Cursor::new(Vec::new());
    img.write_to(&mut png, image::ImageFormat::Png)
        .map_err(|e| format!("PNG encode failed: {e}"))?;
    Ok(format!(
        "data:image/png;base64,{}",
        STANDARD.encode(png.into_inner())
    ))
}

#[tauri::command]
pub fn pairing_create_session() -> Result<Value, String> {
    admin_request(
        "POST",
        "/api/pairing/sessions",
        Some(serde_json::json!({
            "auto_confirm": true,
            "display_active": true,
        })),
    )
}

#[tauri::command]
pub fn pairing_list_sessions() -> Result<Value, String> {
    admin_request("GET", "/api/pairing/sessions", None)
}

#[tauri::command]
pub fn pairing_display_close(session_id: String) -> Result<Value, String> {
    admin_request(
        "POST",
        &format!("/api/pairing/sessions/{session_id}/display-close"),
        None,
    )
}

#[tauri::command]
pub fn pairing_cancel_session(session_id: String) -> Result<Value, String> {
    admin_request(
        "POST",
        &format!("/api/pairing/sessions/{session_id}/cancel"),
        None,
    )
}

#[tauri::command]
pub fn pairing_list_devices() -> Result<Value, String> {
    admin_request("GET", "/api/paired-devices", None)
}

#[tauri::command]
pub fn pairing_revoke_device(token_id: String) -> Result<Value, String> {
    admin_request(
        "POST",
        &format!("/api/paired-devices/{token_id}/revoke"),
        None,
    )
}

#[tauri::command]
pub fn pairing_qr_data_url(qr_text: String) -> Result<String, String> {
    qr_png_data_url(&qr_text)
}
