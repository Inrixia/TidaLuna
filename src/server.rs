use crate::decrypt::FlacDecryptor;
use crate::state::{CURRENT_TRACK, PRELOAD_STATE, PreloadedTrack, SERVER_ADDR, TrackInfo};
use bytes::Bytes;
use futures_util::StreamExt;
use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt, StreamBody};
use hyper::body::{Frame, Incoming};
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use reqwest::header::RANGE;
use std::convert::Infallible;
use std::net::SocketAddr;
use tokio::sync::mpsc;

const PRELOAD_BYTES: usize = 512 * 1024;

pub async fn start_server() {
    let addr: SocketAddr = ([127, 0, 0, 1], 0).into();

    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("Failed to bind server: {}", e);
            return;
        }
    };

    let actual_addr = match listener.local_addr() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("Failed to get local address: {}", e);
            return;
        }
    };

    {
        let mut lock = SERVER_ADDR.lock().unwrap();
        *lock = Some(actual_addr);
    }

    println!("Streaming server listening on http://{}", actual_addr);

    loop {
        let (stream, _) = match listener.accept().await {
            Ok(s) => s,
            Err(e) => {
                eprintln!("Accept error: {}", e);
                continue;
            }
        };
        let io = hyper_util::rt::TokioIo::new(stream);

        tokio::task::spawn(async move {
            if let Err(err) = hyper::server::conn::http1::Builder::new()
                .serve_connection(io, service_fn(handle_request))
                .await
            {
                eprintln!("Error serving connection: {:?}", err);
            }
        });
    }
}

async fn handle_request(
    _req: Request<Incoming>,
) -> Result<Response<BoxBody<Bytes, anyhow::Error>>, Infallible> {
    let track = {
        let lock = CURRENT_TRACK.lock().unwrap();
        lock.clone()
    };

    if let Some(track_info) = track {
        match process_stream(track_info).await {
            Ok(response) => Ok(response),
            Err(e) => {
                eprintln!("Stream error: {}", e);
                Ok(Response::builder()
                    .status(StatusCode::INTERNAL_SERVER_ERROR)
                    .body(BodyExt::boxed(
                        http_body_util::Full::new(Bytes::from(format!("Error: {}", e)))
                            .map_err(|_| anyhow::anyhow!("Unreachable")),
                    ))
                    .unwrap())
            }
        }
    } else {
        Ok(Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(BodyExt::boxed(
                http_body_util::Full::new(Bytes::from("No track loaded"))
                    .map_err(|_| anyhow::anyhow!("Unreachable")),
            ))
            .unwrap())
    }
}

async fn process_stream(
    track: crate::state::TrackInfo,
) -> anyhow::Result<Response<BoxBody<Bytes, anyhow::Error>>> {
    let client = reqwest::Client::new();
    let preload = take_preloaded_if_match(&track).await;
    let preload_len = preload.as_ref().map(|p| p.data.len()).unwrap_or(0) as u64;

    let mut resp = if preload_len > 0 {
        client
            .get(&track.url)
            .header(RANGE, format!("bytes={}-", preload_len))
            .send()
            .await?
    } else {
        client.get(&track.url).send().await?
    };

    let mut use_preload = preload_len > 0;
    if !resp.status().is_success() {
        anyhow::bail!("Upstream status: {}", resp.status());
    }

    if use_preload && resp.status() != StatusCode::PARTIAL_CONTENT {
        use_preload = false;
        resp = client.get(&track.url).send().await?;
        if !resp.status().is_success() {
            anyhow::bail!("Upstream status: {}", resp.status());
        }
    }

    let decryptor = FlacDecryptor::new(&track.key)?;
    let mut stream = resp.bytes_stream();
    let mut offset = if use_preload { preload_len } else { 0u64 };

    let (tx, rx) = mpsc::channel::<Result<Frame<Bytes>, anyhow::Error>>(10);

    let preload_to_send = if use_preload {
        preload.map(|p| p.data)
    } else {
        None
    };

    tokio::spawn(async move {
        if let Some(preloaded) = preload_to_send {
            if tx
                .send(Ok(Frame::data(Bytes::from(preloaded))))
                .await
                .is_err()
            {
                return;
            }
        }
        while let Some(item) = stream.next().await {
            match item {
                Ok(chunk) => match decryptor.decrypt_chunk(&chunk, offset) {
                    Ok(decrypted) => {
                        let len = decrypted.len() as u64;
                        offset += len;
                        if tx
                            .send(Ok(Frame::data(Bytes::from(decrypted))))
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                    Err(e) => {
                        let _ = tx.send(Err(e)).await;
                        break;
                    }
                },
                Err(e) => {
                    let _ = tx.send(Err(e.into())).await;
                    break;
                }
            }
        }
    });

    let stream_body = StreamBody::new(tokio_stream::wrappers::ReceiverStream::new(rx));

    Ok(Response::builder()
        .status(StatusCode::OK)
        .header("Content-Type", "audio/flac")
        .body(BodyExt::boxed(stream_body))?)
}

pub async fn start_preload(track: TrackInfo) {
    cancel_preload().await;

    let handle = tokio::spawn(async move {
        if track.key.is_empty() || track.url.is_empty() {
            return;
        }

        let client = reqwest::Client::new();
        let resp = match client
            .get(&track.url)
            .header(
                RANGE,
                format!("bytes=0-{}", PRELOAD_BYTES.saturating_sub(1)),
            )
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                eprintln!("Preload request failed: {}", e);
                return;
            }
        };

        if !resp.status().is_success() {
            eprintln!("Preload upstream status: {}", resp.status());
            return;
        }

        let decryptor = match FlacDecryptor::new(&track.key) {
            Ok(d) => d,
            Err(e) => {
                eprintln!("Preload decryptor error: {}", e);
                return;
            }
        };

        let mut stream = resp.bytes_stream();
        let mut offset = 0u64;
        let mut buffer: Vec<u8> = Vec::with_capacity(PRELOAD_BYTES);

        while let Some(item) = stream.next().await {
            match item {
                Ok(chunk) => match decryptor.decrypt_chunk(&chunk, offset) {
                    Ok(decrypted) => {
                        offset += chunk.len() as u64;
                        let remaining = PRELOAD_BYTES.saturating_sub(buffer.len());
                        if remaining == 0 {
                            break;
                        }
                        if decrypted.len() <= remaining {
                            buffer.extend_from_slice(&decrypted);
                        } else {
                            buffer.extend_from_slice(&decrypted[..remaining]);
                        }
                        if buffer.len() >= PRELOAD_BYTES {
                            break;
                        }
                    }
                    Err(e) => {
                        eprintln!("Preload decrypt error: {}", e);
                        break;
                    }
                },
                Err(e) => {
                    eprintln!("Preload stream error: {}", e);
                    break;
                }
            }
        }

        if !buffer.is_empty() {
            let mut lock = PRELOAD_STATE.lock().await;
            lock.data = Some(PreloadedTrack {
                track,
                data: buffer,
            });
        }
    });

    let mut lock = PRELOAD_STATE.lock().await;
    lock.task = Some(handle);
}

pub async fn cancel_preload() {
    let mut lock = PRELOAD_STATE.lock().await;
    if let Some(handle) = lock.task.take() {
        handle.abort();
    }
    lock.data = None;
}

pub async fn next_preloaded_track() -> Option<TrackInfo> {
    let current = {
        let lock = CURRENT_TRACK.lock().unwrap();
        lock.clone()
    };

    let lock = PRELOAD_STATE.lock().await;
    let candidate = lock.data.as_ref().map(|d| d.track.clone());

    match (current, candidate) {
        (Some(curr), Some(next)) if curr == next => None,
        (_, next) => next,
    }
}

async fn take_preloaded_if_match(track: &TrackInfo) -> Option<PreloadedTrack> {
    let mut lock = PRELOAD_STATE.lock().await;
    if let Some(data) = lock.data.as_ref() {
        if data.track == *track {
            return lock.data.take();
        }
    }
    None
}
