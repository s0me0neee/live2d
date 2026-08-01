use futures_util::StreamExt;
use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use std::collections::HashMap;
use zbus::zvariant::{ObjectPath, OwnedObjectPath, OwnedValue, Value};
use zbus::{Connection, Proxy};

const PORTAL_DEST: &str = "org.freedesktop.portal.Desktop";
const PORTAL_PATH: &str = "/org/freedesktop/portal/desktop";

// Debug tracing to stderr (visible in `pnpm dev`). Prefixed so it's greppable and
// clearly attributable to the native module.
macro_rules! log {
    ($($arg:tt)*) => {{
        eprintln!("[global_hotkey] {}", format!($($arg)*));
    }};
}

type BoxError = Box<dyn std::error::Error + Send + Sync>;
type Setup<T> = std::result::Result<T, BoxError>;

// Bounds the blocking `start()` call below — it runs on Electron's main thread during
// boot, so a hung session-bus connect must not be able to freeze the app forever.
const READY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

#[napi(object)]
pub struct Shortcut {
    pub id: String,
    pub description: String,
    pub preferred_trigger: String,
}

/// Registers `app_id` with the host portal, opens a GlobalShortcuts session, binds
/// `shortcuts`, and invokes `on_activated(id)` whenever the compositor triggers one.
///
/// Blocks until the portal session is bound (so registration failures surface as a
/// thrown error), then keeps a background thread alive for the process lifetime
/// delivering activations. Linux/Wayland only: the portal rejects the session unless
/// `app_id` resolves to an installed `.desktop` the host registry accepts.
#[napi]
pub fn start(
    app_id: String,
    shortcuts: Vec<Shortcut>,
    on_activated: ThreadsafeFunction<String>,
) -> Result<()> {
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<std::result::Result<(), String>>();

    std::thread::spawn(move || {
        let runtime = match tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            Ok(rt) => rt,
            Err(e) => {
                let _ = ready_tx.send(Err(e.to_string()));
                return;
            }
        };
        runtime.block_on(run(app_id, shortcuts, on_activated, ready_tx));
    });

    match ready_rx.recv_timeout(READY_TIMEOUT) {
        Ok(Ok(())) => Ok(()),
        Ok(Err(e)) => Err(Error::from_reason(e)),
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => Err(Error::from_reason(
            "portal did not respond within the timeout — is a GlobalShortcuts-capable portal running?",
        )),
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
            Err(Error::from_reason("global_hotkey worker exited before setup"))
        }
    }
}

async fn run(
    app_id: String,
    shortcuts: Vec<Shortcut>,
    on_activated: ThreadsafeFunction<String>,
    ready_tx: std::sync::mpsc::Sender<std::result::Result<(), String>>,
) {
    let ready = ready_tx.clone();
    let outcome: Setup<()> = async move {
        let conn = Connection::session().await?;
        log!("connected to session bus as {:?}", conn.unique_name());

        let registry = Proxy::new(
            &conn,
            PORTAL_DEST,
            PORTAL_PATH,
            "org.freedesktop.host.portal.Registry",
        )
        .await?;
        let empty: HashMap<&str, Value> = HashMap::new();
        registry
            .call::<_, _, ()>("Register", &(app_id.as_str(), empty))
            .await?;
        log!("Registry.Register({app_id}) ok");

        let global_shortcuts = Proxy::new(
            &conn,
            PORTAL_DEST,
            PORTAL_PATH,
            "org.freedesktop.portal.GlobalShortcuts",
        )
        .await?;

        let session = create_session(&conn, &global_shortcuts).await?;
        log!("session created: {session}");
        bind_shortcuts(&conn, &global_shortcuts, &session, &shortcuts).await?;
        log!(
            "bound {} shortcut(s): {:?}",
            shortcuts.len(),
            shortcuts.iter().map(|s| &s.id).collect::<Vec<_>>()
        );

        let mut activations = global_shortcuts.receive_signal("Activated").await?;
        log!("listening for Activated signals");
        let _ = ready.send(Ok(()));

        while let Some(msg) = activations.next().await {
            log!("Activated signal received (signature {:?})", msg.body().signature());
            match msg
                .body()
                .deserialize::<(OwnedObjectPath, String, u64, HashMap<String, OwnedValue>)>()
            {
                Ok((_session, id, _timestamp, _opts)) => {
                    log!("-> shortcut id = {id}");
                    on_activated.call(Ok(id), ThreadsafeFunctionCallMode::NonBlocking);
                }
                Err(e) => log!("failed to deserialize Activated body: {e}"),
            }
        }
        log!("Activated stream ended");
        // The signal stream only ends if the session bus connection drops (compositor
        // restart, etc.) — tell JS so it isn't left silently believing hotkeys still work.
        on_activated.call(
            Err(Error::from_reason("global_hotkey: Activated stream ended")),
            ThreadsafeFunctionCallMode::NonBlocking,
        );
        Ok(())
    }
    .await;

    if let Err(e) = outcome {
        log!("setup failed: {e}");
        let _ = ready_tx.send(Err(e.to_string()));
    }
}

// Subscribe on the Response signal's predicted path BEFORE issuing the call, so a fast
// reply can't race us.
async fn await_response(
    conn: &Connection,
    handle_token: &str,
) -> Setup<(Proxy<'static>, zbus::proxy::SignalStream<'static>)> {
    let unique = conn
        .unique_name()
        .ok_or("no unique name on the session bus")?
        .as_str()
        .to_owned();
    let sender = unique.trim_start_matches(':').replace('.', "_");
    let request_path = format!("/org/freedesktop/portal/desktop/request/{sender}/{handle_token}");
    let request = Proxy::new(
        conn,
        PORTAL_DEST,
        request_path,
        "org.freedesktop.portal.Request",
    )
    .await?;
    let stream = request.receive_signal("Response").await?;
    Ok((request, stream))
}

async fn create_session(conn: &Connection, global_shortcuts: &Proxy<'_>) -> Setup<String> {
    let token = "web2d_create";
    let (_request, mut stream) = await_response(conn, token).await?;

    let mut options: HashMap<&str, Value> = HashMap::new();
    options.insert("handle_token", Value::from(token));
    options.insert("session_handle_token", Value::from("web2d"));
    let _handle: OwnedObjectPath = global_shortcuts.call("CreateSession", &(options,)).await?;

    let msg = stream.next().await.ok_or("no CreateSession response")?;
    let (code, results): (u32, HashMap<String, OwnedValue>) = msg.body().deserialize()?;
    if code != 0 {
        return Err(format!("CreateSession failed (portal response code {code})").into());
    }

    let raw = results.get("session_handle").ok_or("missing session_handle")?;
    let session = String::try_from(raw.try_clone()?)
        .or_else(|_| OwnedObjectPath::try_from(raw.try_clone()?).map(|p| p.as_str().to_owned()))
        .map_err(|_| "session_handle was neither string nor object path")?;
    Ok(session)
}

async fn bind_shortcuts(
    conn: &Connection,
    global_shortcuts: &Proxy<'_>,
    session: &str,
    shortcuts: &[Shortcut],
) -> Setup<()> {
    let token = "web2d_bind";
    let (_request, mut stream) = await_response(conn, token).await?;

    let session_path = ObjectPath::try_from(session)?;
    let mut list: Vec<(String, HashMap<String, Value>)> = Vec::new();
    for s in shortcuts {
        let mut meta: HashMap<String, Value> = HashMap::new();
        meta.insert("description".to_owned(), Value::from(s.description.clone()));
        if !s.preferred_trigger.is_empty() {
            meta.insert(
                "preferred_trigger".to_owned(),
                Value::from(s.preferred_trigger.clone()),
            );
        }
        list.push((s.id.clone(), meta));
    }
    let mut options: HashMap<&str, Value> = HashMap::new();
    options.insert("handle_token", Value::from(token));
    let _handle: OwnedObjectPath = global_shortcuts
        .call("BindShortcuts", &(session_path, list, "", options))
        .await?;

    let msg = stream.next().await.ok_or("no BindShortcuts response")?;
    let (code, _results): (u32, HashMap<String, OwnedValue>) = msg.body().deserialize()?;
    if code != 0 {
        return Err(format!("BindShortcuts failed (portal response code {code})").into());
    }
    Ok(())
}
