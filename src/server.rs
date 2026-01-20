use crate::decrypt::FlacDecryptor;
use crate::state::CURRENT_TRACK;
use bytes::Bytes;
use futures_util::StreamExt;
use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt, StreamBody};
use hyper::body::{Frame, Incoming};
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use std::convert::Infallible;
use std::net::SocketAddr;
use tokio::sync::mpsc;

pub async fn start_server() {
    let addr: SocketAddr = ([127, 0, 0, 1], 19384).into();

    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("Failed to bind server: {}", e);
            return;
        }
    };
    println!("Streaming server listening on http://{}", addr);

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
    let resp = client.get(&track.url).send().await?;

    if !resp.status().is_success() {
        anyhow::bail!("Upstream status: {}", resp.status());
    }

    let decryptor = FlacDecryptor::new(&track.key)?;
    let mut stream = resp.bytes_stream();
    let mut offset = 0u64;

    let (tx, rx) = mpsc::channel::<Result<Frame<Bytes>, anyhow::Error>>(10);

    tokio::spawn(async move {
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
