#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use serde::Deserialize;
use tao::{
    event::{Event, WindowEvent},
    event_loop::{ControlFlow, EventLoopBuilder},
    window::WindowBuilder,
};
use wry::WebViewBuilder;

#[derive(Deserialize, Debug)]
struct IpcMessage {
    channel: String,
    #[serde(default)]
    args: Vec<serde_json::Value>,
    #[serde(default)]
    id: Option<String>,
}

#[derive(Debug)]
enum UserEvent {
    Navigate(String),
    IpcMessage(IpcMessage),
}

fn main() -> wry::Result<()> {
    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let window = WindowBuilder::new()
        .with_title("tidal-rs")
        .with_decorations(false)
        .build(&event_loop)
        .unwrap();

    let proxy = event_loop.create_proxy();
    let proxy_nav = proxy.clone();
    let proxy_new_window = proxy.clone();

    let script = include_str!(concat!(env!("OUT_DIR"), "/bundle.js"));

    let builder = WebViewBuilder::new()
        .with_url("https://desktop.tidal.com/")
        .with_initialization_script(script)
        .with_user_agent("Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) TIDAL/9999.9999.9999 Chrome/126.0.6478.127 Electron/31.2.1 Safari/537.36")
        .with_ipc_handler(move |req| {
            let s = req.body();
            if let Ok(msg) = serde_json::from_str::<IpcMessage>(s) {
                let _ = proxy.send_event(UserEvent::IpcMessage(msg));
            } else {
                println!("Received unknown IPC message: {}", s);
            }
        })
        .with_navigation_handler(move |url| {
            if url.starts_with("tidal://") {
                let _ = proxy_nav.send_event(UserEvent::Navigate(url));
                return false;
            }
            true
        })
        .with_new_window_req_handler(move |url, _features| {
            if url.starts_with("tidal://") {
                let _ = proxy_new_window.send_event(UserEvent::Navigate(url));
                return wry::NewWindowResponse::Deny;
            }
            wry::NewWindowResponse::Allow
        });

    #[cfg(any(
        target_os = "windows",
        target_os = "macos",
        target_os = "ios",
        target_os = "android"
    ))]
    let webview = builder.build(&window)?;

    #[cfg(not(any(
        target_os = "windows",
        target_os = "macos",
        target_os = "ios",
        target_os = "android"
    )))]
    let webview = {
        use tao::platform::unix::WindowExtUnix;
        use wry::WebViewBuilderExtUnix;
        let vbox = window.default_vbox().unwrap();
        builder.build_gtk(vbox)?
    };

    let mut pending_navigation = std::env::args().find(|arg| arg.starts_with("tidal://"));

    let mut user_settings = serde_json::Map::new();

    let update_window_state = |webview: &wry::WebView, window: &tao::window::Window| {
        let is_maximized = window.is_maximized();
        let is_fullscreen = window.fullscreen().is_some();
        let js = format!(
            "if (window.__TIDAL_CALLBACKS__ && window.__TIDAL_CALLBACKS__.window && window.__TIDAL_CALLBACKS__.window.updateState) {{ window.__TIDAL_CALLBACKS__.window.updateState({}, {}); }}",
            is_maximized, is_fullscreen
        );
        let _ = webview.evaluate_script(&js);
    };

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;

        match event {
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                ..
            } => *control_flow = ControlFlow::Exit,
            Event::WindowEvent {
                event: WindowEvent::Resized(_) | WindowEvent::Moved(_),
                ..
            } => {
                update_window_state(&webview, &window);
            }
            Event::UserEvent(user_event) => match user_event {
                UserEvent::Navigate(url) => {
                    println!("Navigating to: {}", url);
                    pending_navigation = Some(url);
                    let _ = webview.load_url("https://desktop.tidal.com/");
                }
                UserEvent::IpcMessage(msg) => {
                    println!("IPC Message: {:?}", msg);
                    match msg.channel.as_str() {
                        "window.close" => *control_flow = ControlFlow::Exit,
                        "window.maximize" => {
                            window.set_maximized(true);
                            update_window_state(&webview, &window);
                        }
                        "window.minimize" => {
                            window.set_minimized(true);
                            update_window_state(&webview, &window);
                        }
                        "window.unmaximize" => {
                            window.set_maximized(false);
                            update_window_state(&webview, &window);
                        }
                        "window.state.get" => {
                            if let Some(id) = msg.id {
                                let is_maximized = window.is_maximized();
                                let is_fullscreen = window.fullscreen().is_some();
                                let value = serde_json::json!({
                                    "isMaximized": is_maximized,
                                    "isFullscreen": is_fullscreen
                                });
                                let js = format!(
                                    "window.__TIDAL_IPC_RESPONSE__('{}', null, {})",
                                    id, value
                                );
                                let _ = webview.evaluate_script(&js);
                            }
                        }
                        "web.loaded" => {
                            if let Some(url) = pending_navigation.take() {
                                let command = url.replace("tidal://", "");
                                let _ = webview.load_url(
                                    &("https://desktop.tidal.com/".to_string() + &command),
                                );
                            }

                            update_window_state(&webview, &window);
                        }
                        "user.settings.get" => {
                            if let Some(id) = msg.id {
                                let key = msg.args.first().and_then(|v| v.as_str()).unwrap_or("");
                                let value = user_settings
                                    .get(key)
                                    .cloned()
                                    .unwrap_or(serde_json::Value::Null);
                                let js = format!(
                                    "window.__TIDAL_IPC_RESPONSE__('{}', null, {})",
                                    id, value
                                );
                                let _ = webview.evaluate_script(&js);
                            }
                        }
                        "user.settings.set" => {
                            if let (Some(key), Some(value)) =
                                (msg.args.first().and_then(|v| v.as_str()), msg.args.get(1))
                            {
                                user_settings.insert(key.to_string(), value.clone());
                            }
                            if let Some(id) = msg.id {
                                let js =
                                    format!("window.__TIDAL_IPC_RESPONSE__('{}', null, null)", id);
                                let _ = webview.evaluate_script(&js);
                            }
                        }
                        "user.session.update" => {
                            if let Some(id) = msg.id {
                                let js =
                                    format!("window.__TIDAL_IPC_RESPONSE__('{}', null, null)", id);
                                let _ = webview.evaluate_script(&js);
                            }
                        }
                        "user.session.clear" => {
                            if let Some(id) = msg.id {
                                let js =
                                    format!("window.__TIDAL_IPC_RESPONSE__('{}', null, null)", id);
                                let _ = webview.evaluate_script(&js);
                            }
                        }
                        _ => {}
                    }
                }
            },
            _ => (),
        }
    });
}
