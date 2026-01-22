use once_cell::sync::Lazy;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use tokio::sync::Mutex as TokioMutex;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TrackInfo {
    pub url: String,
    pub key: String,
}

pub static CURRENT_TRACK: Lazy<Arc<Mutex<Option<TrackInfo>>>> =
    Lazy::new(|| Arc::new(Mutex::new(None)));

pub static SERVER_ADDR: Lazy<Arc<Mutex<Option<SocketAddr>>>> =
    Lazy::new(|| Arc::new(Mutex::new(None)));

#[derive(Debug)]
pub struct PreloadedTrack {
    pub track: TrackInfo,
    pub data: Vec<u8>,
}

#[derive(Debug)]
pub struct PreloadState {
    pub task: Option<tokio::task::JoinHandle<()>>,
    pub data: Option<PreloadedTrack>,
}

pub static PRELOAD_STATE: Lazy<TokioMutex<PreloadState>> = Lazy::new(|| {
    TokioMutex::new(PreloadState {
        task: None,
        data: None,
    })
});
