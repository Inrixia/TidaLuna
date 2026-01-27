use crate::state::{CURRENT_TRACK, SERVER_ADDR, TrackInfo};
use libmpv2::{Format, Mpv, events::Event, events::PropertyData};
use std::sync::mpsc;
use std::thread;

#[derive(Debug, serde::Serialize, Clone)]
pub struct AudioDevice {
    #[serde(rename = "controllableVolume")]
    pub controllable_volume: bool,
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub r#type: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
struct MpvDeviceEntry {
    name: String,
    description: String,
}

#[derive(Debug)]
pub enum PlayerEvent {
    TimeUpdate(f64),
    Duration(f64),
    StateChange(String),
    AudioDevices(Vec<AudioDevice>, Option<String>),
}

enum PlayerCommand {
    Load(String),
    Play,
    Pause,
    Stop,
    Seek(f64),
    SetVolume(f64),
    GetAudioDevices(Option<String>),
    SetAudioDevice { id: String, exclusive: bool },
}

pub struct Player {
    cmd_tx: mpsc::Sender<PlayerCommand>,
}

// --- Helper Function for Logging ---
fn log_audio_state(mpv: &Mpv) {
    // 1. Fetch Audio State & Driver
    let exclusive: bool = mpv.get_property("audio-exclusive").unwrap_or(false);
    let filters: String = mpv.get_property("af").unwrap_or_else(|_| "".into());
    let driver: String = mpv.get_property("ao").unwrap_or_else(|_| "auto".into());

    // 2. Fetch Source Params (Decoder Output)
    let src_rate: i64 = mpv.get_property("audio-params/samplerate").unwrap_or(0);
    let src_fmt: String = mpv
        .get_property("audio-params/format")
        .unwrap_or_else(|_| "?".into());
    let src_ch: String = mpv
        .get_property("audio-params/hr-channels")
        .unwrap_or_else(|_| "?".into());

    // 3. Fetch Output Params (Hardware/DAC Input)
    let out_rate: i64 = mpv.get_property("audio-out-params/samplerate").unwrap_or(0);
    let out_fmt: String = mpv
        .get_property("audio-out-params/format")
        .unwrap_or_else(|_| "?".into());
    let out_ch: String = mpv
        .get_property("audio-out-params/hr-channels")
        .unwrap_or_else(|_| "?".into());

    // 4. Determine Bit Perfection
    // True if Source matches Output exactly and no filters are active.
    let is_bit_perfect =
        src_rate == out_rate && src_fmt == out_fmt && src_ch == out_ch && filters.is_empty();

    // 5. Log Status
    eprintln!(
        "[AUDIO] Driver: {} (Exclusive: {}) | Perfect: {} \n\
         \t -> Source: {}Hz / {} / {}\n\
         \t -> Output: {}Hz / {} / {}\n\
         \t -> Filters: {}",
        driver,
        if exclusive { "ON" } else { "OFF" },
        if is_bit_perfect {
            "YES"
        } else {
            "NO (Resampled/Converted)"
        },
        src_rate,
        src_fmt,
        src_ch,
        out_rate,
        out_fmt,
        out_ch,
        if filters.is_empty() { "None" } else { &filters }
    );
}

impl Player {
    pub fn new<F>(callback: F) -> anyhow::Result<Self>
    where
        F: Fn(PlayerEvent) + Send + 'static,
    {
// Set locale before MPV init
unsafe {
        // 1. Forzamos el locale de C para evitar el error "Non-C locale"
        let locale = std::ffi::CString::new("C").unwrap();
        libc::setlocale(libc::LC_ALL, locale.as_ptr());

        // 2. Mantenemos las variables de entorno por seguridad
        std::env::set_var("LC_ALL", "C");
        std::env::set_var("LC_NUMERIC", "C");
    }
let mut mpv = Mpv::with_initializer(|init| {
    init.set_option("config", "no")?;
    init.set_option("terminal", "no")?;
    init.set_option("msg-level", "all=error")?;
    Ok(())
}).map_err(|e| anyhow::anyhow!("MPV Init Error: {:?}", e))?;

        mpv.observe_property("time-pos", Format::Double, 0)
            .map_err(|e| anyhow::anyhow!("MPV Observe Error: {:?}", e))?;
        mpv.observe_property("duration", Format::Double, 0)
            .map_err(|e| anyhow::anyhow!("MPV Observe Error: {:?}", e))?;
        mpv.observe_property("pause", Format::Flag, 0)
            .map_err(|e| anyhow::anyhow!("MPV Observe Error: {:?}", e))?;
        mpv.observe_property("idle-active", Format::Flag, 0)
            .map_err(|e| anyhow::anyhow!("MPV Observe Error: {:?}", e))?;

        let (cmd_tx, cmd_rx) = mpsc::channel::<PlayerCommand>();
        let mut duration = 0.0;
        let mut pending_active = false;
        thread::spawn(move || {
            loop {
                match mpv.wait_event(0.25) {
                    Some(Ok(event)) => match event {
                        Event::PropertyChange { name, change, .. } => match name {
                            "time-pos" => {
                                if let PropertyData::Double(time) = change {
                                    if time > 0.0 {
                                        callback(PlayerEvent::TimeUpdate(time));
                                    }
                                }
                            }
                            "duration" => {
                                if let PropertyData::Double(dur) = change {
                                    callback(PlayerEvent::Duration(dur));
                                    duration = dur;
                                    if pending_active {
                                        callback(PlayerEvent::StateChange("active".to_string()));
                                        pending_active = false;
                                    }
                                }
                            }
                            "pause" => {
                                if let PropertyData::Flag(paused) = change {
                                    let state = if paused { "paused" } else { "active" };
                                    callback(PlayerEvent::StateChange(state.to_string()));
                                }
                            }
                            _ => {}
                        },
                        Event::EndFile(_) => {
                            callback(PlayerEvent::TimeUpdate(duration));
                            callback(PlayerEvent::StateChange("completed".to_string()));
                            duration = 0.0;
                            pending_active = false;
                        }
                        Event::StartFile => {
                            pending_active = true;
                        }
                        _ => {}
                    },
                    Some(Err(e)) => eprintln!("MPV Event Loop Error: {:?}", e),
                    _ => {}
                }

                while let Ok(cmd) = cmd_rx.try_recv() {
                    let res = match cmd {
                        PlayerCommand::Load(url) => {
                            let r = mpv.command("loadfile", &[&url]);
                            // Log AFTER loading so we see the new format
                            log_audio_state(&mpv);
                            r // Return the Result
                        }
                        PlayerCommand::Play => {
                            let r = mpv.set_property("pause", false);
                            log_audio_state(&mpv);
                            r
                        }
                        PlayerCommand::Pause => {
                            let r = mpv.set_property("pause", true);
                            log_audio_state(&mpv);
                            r
                        }
                        PlayerCommand::Stop => mpv.command("stop", &[]),
                        PlayerCommand::Seek(time) => mpv.set_property("time-pos", time),
                        PlayerCommand::SetVolume(vol) => mpv.set_property("volume", vol),
                        PlayerCommand::GetAudioDevices(req_id) => {
                            let remove = vec!["openal"];
                            let devices = match mpv.get_property::<String>("audio-device-list") {
                                Ok(json) => {
                                    match serde_json::from_str::<Vec<MpvDeviceEntry>>(&json) {
                                        Ok(entries) => entries
                                            .into_iter()
                                            .filter(|d| !remove.iter().any(|id| id == &d.name))
                                            .map(|d| {
                                                if d.name == "auto" {
                                                    AudioDevice {
                                                        controllable_volume: true,
                                                        id: "default".to_string(),
                                                        name: "System Default".to_string(),
                                                        r#type: Some("systemDefault".to_string()),
                                                    }
                                                } else {
                                                    AudioDevice {
                                                        controllable_volume: true,
                                                        id: d.name.clone(),
                                                        name: d.description,
                                                        r#type: None,
                                                    }
                                                }
                                            })
                                            .collect(),
                                        Err(e) => {
                                            eprintln!("Failed to parse audio-device-list: {}", e);
                                            Vec::new()
                                        }
                                    }
                                }
                                Err(e) => {
                                    eprintln!("Failed to read audio-device-list: {:?}", e);
                                    Vec::new()
                                }
                            };
                            callback(PlayerEvent::AudioDevices(devices, req_id));
                            Ok(())
                        }
                        PlayerCommand::SetAudioDevice { id, exclusive } => {
                            // 1. Set Exclusive Mode (Best Effort)
                            if let Err(e) = mpv.set_property("audio-exclusive", exclusive) {
                                eprintln!("[WARN] Failed to set audio-exclusive: {}", e);
                            }

                            if exclusive {
                                // Force volume to 100% to bypass software mixing
                                let _ = mpv.set_property("volume", 100);
                                let _ = mpv.set_property("audio-channels", "auto");
                            }

                            // 2. Set the Device
                            // We pass &id to ensure we don't consume the variable before printing it below
                            let result = mpv.set_property("audio-device", id.clone());

                            // 3. Verify and Log to Stderr
                            match &result {
                                Ok(_) => {
                                    log_audio_state(&mpv);
                                }
                                Err(e) => eprintln!(
                                    "[ERROR] Failed to switch audio device to '{}': {}",
                                    id, e
                                ),
                            }

                            result
                        }
                    };

                    if let Err(e) = res {
                        eprintln!("MPV Command Execution Error: {:?}", e);
                    }
                }
            }
        });

        Ok(Self { cmd_tx })
    }

    pub fn load(&self, url: String, _format: String, key: String) -> anyhow::Result<()> {
        {
            let mut lock = CURRENT_TRACK.lock().unwrap();
            *lock = Some(TrackInfo {
                url: url.clone(),
                key: key.clone(),
            });
        }

        let stream_url = {
            let lock = SERVER_ADDR.lock().unwrap();
            let addr = lock
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("Streaming server not ready"))?;
            format!("http://{}/stream", addr)
        };

        self.cmd_tx
            .send(PlayerCommand::Load(stream_url))
            .map_err(|_| anyhow::anyhow!("Player thread is dead"))?;

        Ok(())
    }

    pub fn play(&self) -> anyhow::Result<()> {
        self.cmd_tx
            .send(PlayerCommand::Play)
            .map_err(|_| anyhow::anyhow!("Player thread is dead"))
    }

    pub fn pause(&self) -> anyhow::Result<()> {
        self.cmd_tx
            .send(PlayerCommand::Pause)
            .map_err(|_| anyhow::anyhow!("Player thread is dead"))
    }

    pub fn stop(&self) -> anyhow::Result<()> {
        self.cmd_tx
            .send(PlayerCommand::Stop)
            .map_err(|_| anyhow::anyhow!("Player thread is dead"))
    }

    pub fn seek(&self, time: f64) -> anyhow::Result<()> {
        self.cmd_tx
            .send(PlayerCommand::Seek(time))
            .map_err(|_| anyhow::anyhow!("Player thread is dead"))
    }

    pub fn set_volume(&self, volume: f64) -> anyhow::Result<()> {
        self.cmd_tx
            .send(PlayerCommand::SetVolume(volume))
            .map_err(|_| anyhow::anyhow!("Player thread is dead"))
    }

    pub fn get_audio_devices(&self, req_id: Option<String>) -> anyhow::Result<()> {
        self.cmd_tx
            .send(PlayerCommand::GetAudioDevices(req_id))
            .map_err(|_| anyhow::anyhow!("Player thread is dead"))
    }

    pub fn set_audio_device(&self, device_id: String, exclusive: bool) -> anyhow::Result<()> {
        self.cmd_tx
            .send(PlayerCommand::SetAudioDevice {
                id: device_id,
                exclusive,
            })
            .map_err(|_| anyhow::anyhow!("Player thread is dead"))
    }
}
