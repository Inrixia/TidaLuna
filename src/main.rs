#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod decrypt;
mod player;
mod server;
mod state;

use player::{Player, PlayerEvent};
use serde::Deserialize;
use state::TrackInfo;
use std::sync::Arc;
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
    Player(PlayerEvent),
    AutoLoad(TrackInfo),
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

    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap();

    let rt_handle = rt.handle().clone();

    rt_handle.spawn(async {
        server::start_server().await;
    });

    let proxy_player = proxy.clone();
    let proxy_autoload = proxy.clone();
    let player = Arc::new(
        Player::new(move |event| {
            let _ = proxy_player.send_event(UserEvent::Player(event));
        })
        .expect("Failed to initialize player"),
    );
    let player_clone = player.clone();

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
                 UserEvent::Player(player_event) => {
                     match player_event {
                        PlayerEvent::TimeUpdate(time) => {
                            let js = format!(
                                 "if (window.NativePlayerComponent && window.NativePlayerComponent.trigger) {{ window.NativePlayerComponent.trigger('mediacurrenttime', {}); }}",
                                 time
                             );
                             let _ = webview.evaluate_script(&js);
                        },
                         PlayerEvent::StateChange(state) => {
                             let js = format!(
                                 "if (window.NativePlayerComponent && window.NativePlayerComponent.trigger) {{ window.NativePlayerComponent.trigger('mediastate', '{}'); }}",
                                 state.to_string()
                             );
                             let _ = webview.evaluate_script(&js);

                             if state == "completed" {
                                 let proxy_autoload = proxy_autoload.clone();
                                 rt_handle.spawn(async move {
                                     if let Some(track) = server::next_preloaded_track().await {
                                         let _ = proxy_autoload.send_event(UserEvent::AutoLoad(track));
                                     }
                                 });
                             }
                         },
                         PlayerEvent::Duration(duration) => {
                                let js = format!(
                                    "if (window.NativePlayerComponent && window.NativePlayerComponent.trigger) {{ window.NativePlayerComponent.trigger('mediaduration', {}); }}",
                                    duration
                                );
                                let _ = webview.evaluate_script(&js);
                            },
                        PlayerEvent::AudioDevices(devices, req_id) => {
                             if let Ok(json_devices) = serde_json::to_string(&devices) {
                                 if let Some(id) = req_id {
                                     let js = format!("window.__TIDAL_IPC_RESPONSE__('{}', null, {})", id, json_devices);
                                     let _ = webview.evaluate_script(&js);
                                 } else {
                                      let js = format!(
                                          "if (window.NativePlayerComponent && window.NativePlayerComponent.trigger) {{ window.NativePlayerComponent.trigger('devices', {}); }}",
                                          json_devices
                                      );
                                      let _ = webview.evaluate_script(&js);
                                 }
                             }
                        }
                     }
                }
                UserEvent::AutoLoad(track) => {
                    if let Err(e) = player_clone.load(track.url, "flac".to_string(), track.key) {
                        eprintln!("Failed to auto-load preloaded track: {}", e);
                    }
                }
                UserEvent::Navigate(url) => {
                    println!("Navigating to: {}", url);
                    pending_navigation = Some(url);
                    let _ = webview.load_url("https://desktop.tidal.com/");
                }
                UserEvent::IpcMessage(msg) => {
                    println!("IPC Message: {:?}", msg);
                    match msg.channel.as_str() {
                        "player.load" => {
                             if let (Some(url), Some(format), Some(key)) = (
                                 msg.args.get(0).and_then(|v| v.as_str()),
                                 msg.args.get(1).and_then(|v| v.as_str()),
                                 msg.args.get(2).and_then(|v| v.as_str())
                             ) {
                                 if let Err(e) = player_clone.load(url.to_string(), format.to_string(), key.to_string()) {
                                     eprintln!("Failed to load track: {}", e);
                                 }
                             }
                        },
                        "player.preload" => {
                            if let (Some(url), Some(_format), Some(key)) = (
                                msg.args.get(0).and_then(|v| v.as_str()),
                                msg.args.get(1).and_then(|v| v.as_str()),
                                msg.args.get(2).and_then(|v| v.as_str())
                            ) {
                                let track = crate::state::TrackInfo {
                                    url: url.to_string(),
                                    key: key.to_string(),
                                };
                                rt_handle.spawn(async move {
                                    server::start_preload(track).await;
                                });
                            }
                        }
                        "player.preload.cancel" => {
                            rt_handle.spawn(async {
                                server::cancel_preload().await;
                            });
                        }
                        "player.play" => { let _ = player_clone.play(); },
                        "player.pause" => { let _ = player_clone.pause(); },
                        "player.stop" => { let _ = player_clone.stop(); },
                        "player.seek" => {
                            if let Some(time) = msg.args.get(0).and_then(|v| v.as_f64()) {
                                let _ = player_clone.seek(time);
                            }
                        },
                        "player.volume" => {
                            if let Some(vol) = msg.args.get(0).and_then(|v| v.as_f64()) {
                                let _ = player_clone.set_volume(vol);
                            }
                        },
                        "player.devices.get" => {
                            let _ = player_clone.get_audio_devices(msg.id);
                        },
                        "player.devices.set" => {
                            if let Some(id) = msg.args.get(0).and_then(|v| v.as_str()) {
                                 let exclusive = msg
                                     .args
                                     .get(1)
                                     .and_then(|v| v.as_str())
                                     .is_some_and(|mode| mode == "exclusive");
                                 let _ = player_clone.set_audio_device(id.to_string(), exclusive);
                            }
                        },
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
                                if url.starts_with("tidal://") {
                                    let command = url.replace("tidal://", "");
                                    let _ = webview.load_url(
                                        &("https://desktop.tidal.com/".to_string() + &command),
                                    );
                                }
                            }
                            update_window_state(&webview, &window);
                        }
                        _ => {}
                    }
                }
            },
            _ => (),
        }
    });
}
