use crate::state::{CURRENT_TRACK, TrackInfo};
use libmpv2::{Format, Mpv, events::Event, events::PropertyData};
use std::sync::mpsc;
use std::thread;

#[derive(Debug)]
pub enum PlayerEvent {
    TimeUpdate(f64),
    Duration(f64),
    StateChange(String),
}

enum PlayerCommand {
    Load { url: String },
    Play,
    Pause,
    Stop,
    Seek(f64),
    SetVolume(f64),
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

        thread::spawn(move || {
            loop {
                match mpv.wait_event(0.25) {
                    Some(Ok(event)) => match event {
                        Event::PropertyChange { name, change, .. } => match name {
                            "time-pos" => {
                                if let PropertyData::Double(time) = change {
                                    callback(PlayerEvent::TimeUpdate(time));
                                }
                            }
                            "duration" => {
                                if let PropertyData::Double(dur) = change {
                                    callback(PlayerEvent::Duration(dur));
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
                        Event::EndFile(0) => {
                            callback(PlayerEvent::StateChange("ended".to_string()));
                        }
                        Event::FileLoaded => {
                            callback(PlayerEvent::StateChange("active".to_string()));
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
}
