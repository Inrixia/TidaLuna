use crate::state::{CURRENT_TRACK, TrackInfo};
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
    Load { url: String },
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

impl Player {
    pub fn new<F>(callback: F) -> anyhow::Result<Self>
    where
        F: Fn(PlayerEvent) + Send + 'static,
    {
        let mut mpv = Mpv::new().map_err(|e| anyhow::anyhow!("MPV Init Error: {:?}", e))?;

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
                        PlayerCommand::Load { url } => mpv.command("loadfile", &[&url]),
                        PlayerCommand::Play => mpv.set_property("pause", false),
                        PlayerCommand::Pause => mpv.set_property("pause", true),
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
                        PlayerCommand::SetAudioDevice { id, exclusive } => mpv
                            .set_property("audio-exclusive", exclusive)
                            .and_then(|_| mpv.set_property("audio-device", id)),
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

        self.cmd_tx
            .send(PlayerCommand::Load {
                url: "http://127.0.0.1:19384/stream".to_string(),
            })
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
