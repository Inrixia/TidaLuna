use std::sync::{Arc, Mutex};
use once_cell::sync::Lazy;

#[derive(Clone, Debug)]
pub struct TrackInfo {
    pub url: String,
    pub key: String,
}

pub static CURRENT_TRACK: Lazy<Arc<Mutex<Option<TrackInfo>>>> = Lazy::new(|| {
    Arc::new(Mutex::new(None))
});
