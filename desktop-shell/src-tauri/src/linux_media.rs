//! Linux media integration is independent of the station and the audio engine.
use crate::desktop::{DesktopState, MediaState};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};
use zbus::zvariant::{OwnedObjectPath, OwnedValue, Value};
use zbus::{fdo, interface, object_server::SignalEmitter, Connection};

const PATH: &str = "/org/mpris/MediaPlayer2";
#[derive(Clone, Default)]
pub struct Native {
    pub tray_available: Arc<std::sync::atomic::AtomicBool>,
    connection: Arc<Mutex<Option<Connection>>>,
    updates: Arc<tokio::sync::Mutex<()>>,
    power: Arc<tokio::sync::Mutex<Option<Inhibitor>>>,
    power_attempt: Arc<Mutex<Option<Instant>>>,
}
enum Inhibitor {
    Portal(Connection, OwnedObjectPath),
    Logind { _fd: zbus::zvariant::OwnedFd },
}

fn media(app: &AppHandle) -> MediaState {
    app.state::<DesktopState>()
        .session
        .lock()
        .ok()
        .and_then(|g| g.as_ref().filter(|s| s.ready).map(|s| s.media.clone()))
        .unwrap_or_default()
}
fn command(app: &AppHandle, action: &str, value: Option<f64>) -> fdo::Result<()> {
    crate::desktop::dispatch(app, serde_json::json!({ "action": action, "value": value }))
        .map_err(fdo::Error::Failed)
}

struct Root {
    app: AppHandle,
}
#[interface(name = "org.mpris.MediaPlayer2")]
impl Root {
    fn raise(&self) {
        crate::tray::focus_main_window(&self.app);
    }
    fn quit(&self) {
        crate::tray::shutdown(&self.app);
    }
    #[zbus(property)]
    fn can_quit(&self) -> bool {
        true
    }
    #[zbus(property)]
    fn can_raise(&self) -> bool {
        true
    }
    #[zbus(property)]
    fn has_track_list(&self) -> bool {
        false
    }
    #[zbus(property)]
    fn identity(&self) -> &str {
        "Soundsible"
    }
    #[zbus(property)]
    fn desktop_entry(&self) -> &str {
        "Soundsible"
    }
    #[zbus(property)]
    fn supported_uri_schemes(&self) -> Vec<String> {
        Vec::new()
    }
    #[zbus(property)]
    fn supported_mime_types(&self) -> Vec<String> {
        Vec::new()
    }
}
struct Player {
    app: AppHandle,
}
#[interface(name = "org.mpris.MediaPlayer2.Player")]
impl Player {
    fn play(&self) -> fdo::Result<()> {
        command(&self.app, "play", None)
    }
    fn pause(&self) -> fdo::Result<()> {
        command(&self.app, "pause", None)
    }
    fn play_pause(&self) -> fdo::Result<()> {
        command(&self.app, "toggle", None)
    }
    fn stop(&self) -> fdo::Result<()> {
        command(&self.app, "stop", None)
    }
    fn next(&self) -> fdo::Result<()> {
        if !media(&self.app).can_next {
            return Ok(());
        }
        command(&self.app, "next", None)
    }
    fn previous(&self) -> fdo::Result<()> {
        if !media(&self.app).can_previous {
            return Ok(());
        }
        command(&self.app, "previous", None)
    }
    fn seek(&self, offset: i64) -> fdo::Result<()> {
        if !media(&self.app).can_seek {
            return Ok(());
        }
        command(&self.app, "seekBy", Some(offset as f64 / 1_000_000.0))
    }
    fn set_position(&self, track_id: OwnedObjectPath, position: i64) -> fdo::Result<()> {
        let m = media(&self.app);
        if !m.can_seek
            || track_id.as_str() != m.track_path()
            || position < 0
            || position as f64 > m.duration * 1_000_000.0
        {
            return Ok(());
        }
        command(&self.app, "seek", Some(position as f64 / 1_000_000.0))
    }
    fn open_uri(&self, _uri: &str) -> fdo::Result<()> {
        Err(fdo::Error::NotSupported(
            "Use Soundsible's library to select music.".into(),
        ))
    }
    #[zbus(property)]
    fn playback_status(&self) -> String {
        media(&self.app).status().into()
    }
    #[zbus(property)]
    fn loop_status(&self) -> String {
        match media(&self.app).repeat.as_str() {
            "one" => "Track",
            "all" => "Playlist",
            _ => "None",
        }
        .into()
    }
    #[zbus(property)]
    fn set_loop_status(&mut self, value: &str) -> fdo::Result<()> {
        if !matches!(value, "None" | "Track" | "Playlist") {
            return Err(fdo::Error::InvalidArgs("Unknown repeat mode.".into()));
        }
        crate::desktop::dispatch(
            &self.app,
            serde_json::json!({ "action": "repeat", "mode": value }),
        )
        .map_err(fdo::Error::Failed)
    }
    #[zbus(property)]
    fn shuffle(&self) -> bool {
        media(&self.app).shuffle
    }
    #[zbus(property)]
    fn set_shuffle(&mut self, value: bool) -> fdo::Result<()> {
        crate::desktop::dispatch(
            &self.app,
            serde_json::json!({ "action": "shuffle", "enabled": value }),
        )
        .map_err(fdo::Error::Failed)
    }
    #[zbus(property)]
    fn rate(&self) -> f64 {
        let rate = media(&self.app).rate;
        if rate > 0.0 {
            rate
        } else {
            1.0
        }
    }
    #[zbus(property)]
    fn set_rate(&mut self, value: f64) -> fdo::Result<()> {
        if (value - self.rate()).abs() > f64::EPSILON {
            return Err(fdo::Error::NotSupported(
                "Playback rate is managed by Soundsible.".into(),
            ));
        }
        Ok(())
    }
    #[zbus(property)]
    fn minimum_rate(&self) -> f64 {
        self.rate().min(1.0)
    }
    #[zbus(property)]
    fn maximum_rate(&self) -> f64 {
        self.rate().max(1.0)
    }
    #[zbus(property)]
    fn volume(&self) -> f64 {
        media(&self.app).volume
    }
    #[zbus(property)]
    fn set_volume(&mut self, value: f64) -> fdo::Result<()> {
        if !value.is_finite() {
            return Err(fdo::Error::InvalidArgs("Invalid volume.".into()));
        }
        command(&self.app, "volume", Some(value.clamp(0.0, 1.0)))
    }
    #[zbus(property(emits_changed_signal = "false"))]
    fn position(&self) -> i64 {
        let state = self.app.state::<DesktopState>();
        let g = state.session.lock().expect("desktop session lock");
        let Some(s) = g.as_ref().filter(|s| s.ready) else {
            return 0;
        };
        let elapsed = if s.media.playing {
            s.updated.elapsed().as_secs_f64() * s.media.rate
        } else {
            0.0
        };
        ((s.media.position + elapsed).min(s.media.duration).max(0.0) * 1_000_000.0) as i64
    }
    #[zbus(property)]
    fn metadata(&self) -> HashMap<String, OwnedValue> {
        let m = media(&self.app);
        let mut fields = HashMap::new();
        fields.insert(
            "mpris:trackid".into(),
            Value::from(OwnedObjectPath::try_from(m.track_path()).unwrap())
                .try_to_owned()
                .unwrap(),
        );
        if m.track_id.is_empty() {
            return fields;
        }
        fields.insert(
            "xesam:title".into(),
            Value::from(m.title).try_to_owned().unwrap(),
        );
        fields.insert(
            "xesam:artist".into(),
            Value::from(vec![m.artist]).try_to_owned().unwrap(),
        );
        fields.insert(
            "xesam:album".into(),
            Value::from(m.album).try_to_owned().unwrap(),
        );
        fields.insert(
            "mpris:length".into(),
            OwnedValue::from((m.duration * 1_000_000.0) as i64),
        );
        let state = self.app.state::<DesktopState>();
        if let Ok(guard) = state.session.lock() {
            if let Some(path) = guard.as_ref().and_then(|s| s.art_path.as_ref()) {
                if let Ok(url) = url::Url::from_file_path(path) {
                    fields.insert(
                        "mpris:artUrl".into(),
                        Value::from(url.to_string()).try_to_owned().unwrap(),
                    );
                }
            }
        }
        fields
    }
    #[zbus(property)]
    fn can_go_next(&self) -> bool {
        media(&self.app).can_next
    }
    #[zbus(property)]
    fn can_go_previous(&self) -> bool {
        media(&self.app).can_previous
    }
    #[zbus(property)]
    fn can_play(&self) -> bool {
        !media(&self.app).track_id.is_empty()
    }
    #[zbus(property)]
    fn can_pause(&self) -> bool {
        self.can_play()
    }
    #[zbus(property)]
    fn can_seek(&self) -> bool {
        media(&self.app).can_seek
    }
    #[zbus(property(emits_changed_signal = "false"))]
    fn can_control(&self) -> bool {
        true
    }
    #[zbus(signal)]
    async fn seeked(emitter: &SignalEmitter<'_>, position: i64) -> zbus::Result<()>;
}

impl Native {
    pub fn available(&self) -> bool {
        self.connection.lock().is_ok_and(|g| g.is_some())
    }
    pub fn update(&self, app: AppHandle, previous: MediaState) {
        let native = self.clone();
        tauri::async_runtime::spawn(async move {
            let _serial = native.updates.lock().await;
            let next = media(&app);
            native.power(next.playing).await;
            let conn = native.connection.lock().ok().and_then(|g| g.clone());
            let Some(conn) = conn else {
                return;
            };
            let Ok(iface) = conn.object_server().interface::<_, Player>(PATH).await else {
                return;
            };
            let p = iface.get().await;
            let ctx = iface.signal_emitter();
            if previous.status() != next.status() {
                let _ = p.playback_status_changed(ctx).await;
            }
            if previous.track_id != next.track_id
                || previous.title != next.title
                || previous.artist != next.artist
                || previous.album != next.album
                || previous.duration != next.duration
                || previous.artwork != next.artwork
            {
                let _ = p.metadata_changed(ctx).await;
            }
            if previous.volume != next.volume {
                let _ = p.volume_changed(ctx).await;
            }
            if previous.shuffle != next.shuffle {
                let _ = p.shuffle_changed(ctx).await;
            }
            if previous.repeat != next.repeat {
                let _ = p.loop_status_changed(ctx).await;
            }
            if previous.rate != next.rate {
                let _ = p.rate_changed(ctx).await;
                let _ = p.minimum_rate_changed(ctx).await;
                let _ = p.maximum_rate_changed(ctx).await;
            }
            if previous.can_next != next.can_next {
                let _ = p.can_go_next_changed(ctx).await;
            }
            if previous.can_previous != next.can_previous {
                let _ = p.can_go_previous_changed(ctx).await;
            }
            if previous.can_seek != next.can_seek {
                let _ = p.can_seek_changed(ctx).await;
            }
            if previous.track_id.is_empty() != next.track_id.is_empty() {
                let _ = p.can_play_changed(ctx).await;
                let _ = p.can_pause_changed(ctx).await;
            }
            if previous.track_id == next.track_id && next.seek_serial != previous.seek_serial {
                let _ = Player::seeked(ctx, (next.position * 1_000_000.0) as i64).await;
            }
        });
    }
    async fn power(&self, playing: bool) {
        let mut guard = self.power.lock().await;
        if !playing {
            if let Some(Inhibitor::Portal(conn, path)) = guard.take() {
                if let Ok(proxy) = zbus::Proxy::new(
                    &conn,
                    "org.freedesktop.portal.Desktop",
                    path.as_str(),
                    "org.freedesktop.portal.Request",
                )
                .await
                {
                    let _: zbus::Result<()> = proxy.call("Close", &()).await;
                }
            }
            *self.power_attempt.lock().unwrap() = None;
            // Dropping a logind FD releases its lock.
            return;
        }
        if guard.is_some() {
            return;
        }
        {
            let mut attempt = self.power_attempt.lock().unwrap();
            if attempt.is_some_and(|at| at.elapsed() < Duration::from_secs(60)) {
                return;
            }
            *attempt = Some(Instant::now());
        }
        let inhibitor = tokio::time::timeout(Duration::from_secs(3), acquire_inhibitor()).await;
        match inhibitor {
            Ok(Ok(value)) => *guard = Some(value),
            Ok(Err(error)) => eprintln!("Desktop suspend inhibition unavailable: {error}"),
            Err(_) => eprintln!("Desktop suspend inhibition timed out"),
        }
    }
}

async fn acquire_inhibitor() -> zbus::Result<Inhibitor> {
    if let Ok(conn) = Connection::session().await {
        if let Ok(proxy) = zbus::Proxy::new(
            &conn,
            "org.freedesktop.portal.Desktop",
            "/org/freedesktop/portal/desktop",
            "org.freedesktop.portal.Inhibit",
        )
        .await
        {
            let options: HashMap<&str, Value<'_>> =
                HashMap::from([("reason", Value::from("Soundsible is playing audio"))]);
            let response: zbus::Result<OwnedObjectPath> =
                proxy.call("Inhibit", &("", 4u32, options)).await;
            if let Ok(path) = response {
                return Ok(Inhibitor::Portal(conn, path));
            }
        }
    }
    let conn = Connection::system().await?;
    let proxy = zbus::Proxy::new(
        &conn,
        "org.freedesktop.login1",
        "/org/freedesktop/login1",
        "org.freedesktop.login1.Manager",
    )
    .await?;
    let fd: zbus::zvariant::OwnedFd = proxy
        .call(
            "Inhibit",
            &("sleep", "Soundsible", "Playing audio", "block"),
        )
        .await?;
    Ok(Inhibitor::Logind { _fd: fd })
}

pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let connection = zbus::connection::Builder::session()
            .and_then(|b| b.name("org.mpris.MediaPlayer2.soundsible"))
            .and_then(|b| b.serve_at(PATH, Root { app: app.clone() }))
            .and_then(|b| b.serve_at(PATH, Player { app: app.clone() }));
        match connection {
            Ok(builder) => match builder.build().await {
                Ok(conn) => {
                    *app.state::<DesktopState>()
                        .native
                        .connection
                        .lock()
                        .unwrap() = Some(conn)
                }
                Err(error) => eprintln!("Desktop MPRIS unavailable: {error}"),
            },
            Err(error) => eprintln!("Desktop MPRIS unavailable: {error}"),
        }
        if let Ok(conn) = Connection::session().await {
            if let Ok(proxy) = zbus::Proxy::new(
                &conn,
                "org.freedesktop.DBus",
                "/org/freedesktop/DBus",
                "org.freedesktop.DBus",
            )
            .await
            {
                let available: zbus::Result<bool> = proxy
                    .call("NameHasOwner", &("org.kde.StatusNotifierWatcher",))
                    .await;
                app.state::<DesktopState>().native.tray_available.store(
                    available.unwrap_or(false),
                    std::sync::atomic::Ordering::Relaxed,
                );
            }
        }
        loop {
            tokio::time::sleep(Duration::from_secs(5)).await;
            let state = app.state::<DesktopState>();
            let previous = {
                let mut g = state.session.lock().unwrap();
                g.as_mut()
                    .filter(|s| s.ready && s.updated.elapsed() > Duration::from_secs(30))
                    .map(|s| {
                        let old = s.media.clone();
                        s.media = MediaState::default();
                        s.ready = false;
                        old
                    })
            };
            if let Some(old) = previous {
                state.native.update(app.clone(), old);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};
    struct Portal {
        calls: Arc<AtomicU32>,
        flags: Arc<AtomicU32>,
    }
    #[interface(name = "org.freedesktop.portal.Inhibit")]
    impl Portal {
        fn inhibit(
            &self,
            _window: &str,
            flags: u32,
            _options: HashMap<String, OwnedValue>,
        ) -> OwnedObjectPath {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.flags.store(flags, Ordering::SeqCst);
            OwnedObjectPath::try_from("/org/freedesktop/portal/desktop/request/soundsible").unwrap()
        }
    }
    struct Request {
        closes: Arc<AtomicU32>,
    }
    #[interface(name = "org.freedesktop.portal.Request")]
    impl Request {
        fn close(&self) {
            self.closes.fetch_add(1, Ordering::SeqCst);
        }
    }

    #[tokio::test]
    #[ignore = "Requires a disposable session bus: dbus-run-session cargo test -- --ignored"]
    async fn suspend_lock_is_bounded_to_playback_and_does_not_inhibit_screen_lock() {
        let calls = Arc::new(AtomicU32::new(0));
        let flags = Arc::new(AtomicU32::new(0));
        let closes = Arc::new(AtomicU32::new(0));
        let _conn = zbus::connection::Builder::session()
            .unwrap()
            .name("org.freedesktop.portal.Desktop")
            .unwrap()
            .serve_at(
                "/org/freedesktop/portal/desktop",
                Portal {
                    calls: calls.clone(),
                    flags: flags.clone(),
                },
            )
            .unwrap()
            .serve_at(
                "/org/freedesktop/portal/desktop/request/soundsible",
                Request {
                    closes: closes.clone(),
                },
            )
            .unwrap()
            .build()
            .await
            .unwrap();
        let native = Native::default();
        native.power(true).await;
        native.power(true).await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(flags.load(Ordering::SeqCst), 4);
        native.power(false).await;
        assert_eq!(closes.load(Ordering::SeqCst), 1);
        assert!(native.power.lock().await.is_none());
        native.power(true).await;
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        native.power(false).await;
        assert_eq!(closes.load(Ordering::SeqCst), 2);
    }
}
