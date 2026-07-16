use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    http::Method,
    response::IntoResponse,
    routing::get,
    Json, Router,
};
use dashmap::DashMap;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::broadcast;
use tower_http::cors::{Any, CorsLayer};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Match {
    pub id: String,
    pub home_team: String,
    pub away_team: String,
    pub score: String,
    pub status: String,
    pub minute: i32,
    pub league: String,
    pub updated_at: String,
}

#[derive(Clone)]
pub struct AppState {
    pub matches: Arc<DashMap<String, Match>>,
    pub tx: broadcast::Sender<Match>,
}

async fn connect_upstream(ws_url: &str, state: AppState) {
    loop {
        match tokio_tungstenite::connect_async(ws_url).await {
            Ok((ws_stream, _)) => {
                println!("[Rust] Connecté au WebSocket upstream: {}", ws_url);
                let (_, mut read) = ws_stream.split();

                while let Some(Ok(msg)) = read.next().await {
                    // Utilisation explicite du type tungstenite::Message
                    if let tokio_tungstenite::tungstenite::Message::Text(text) = msg {
                        if let Ok(payload) =
                            serde_json::from_str::<serde_json::Value>(&text)
                        {
                            let data = payload
                                .get("data")
                                .or_else(|| payload.as_object().map(|_| &payload));

                            if let Some(data) = data {
                                if let Ok(m) =
                                    serde_json::from_value::<Match>(data.clone())
                                {
                                    state.matches.insert(m.id.clone(), m.clone());
                                    let _ = state.tx.send(m);
                                }
                            }
                        }
                    }
                }
                println!("[Rust] WebSocket upstream déconnecté, reconnexion...");
            }
            Err(e) => {
                eprintln!(
                    "[Rust] Erreur connexion upstream: {} — reconnexion dans 5s",
                    e
                );
                tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
            }
        }
    }
}

async fn get_matches(State(state): State<AppState>) -> Json<serde_json::Value> {
    let all: Vec<Match> = state
        .matches
        .iter()
        .map(|entry| entry.value().clone())
        .collect();

    Json(serde_json::json!({
        "count": all.len(),
        "matches": all
    }))
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: AppState) {
    let (mut sender, _) = socket.split();
    let mut rx = state.tx.subscribe();

    println!("[Rust] Client WebSocket connecté");

    loop {
        match rx.recv().await {
            Ok(match_data) => {
                let payload = serde_json::json!({
                    "type": "LIVE_UPDATE",
                    "data": match_data
                });
                if sender
                    .send(Message::Text(payload.to_string()))
                    .await
                    .is_err()
                {
                    break;
                }
            }
            Err(broadcast::error::RecvError::Lagged(n)) => {
                eprintln!("[Rust] Lag broadcast: {} messages perdus", n);
            }
            Err(broadcast::error::RecvError::Closed) => break,
        }
    }
}

#[tokio::main]
async fn main() {
    let upstream_url =
        std::env::var("UPSTREAM_WS").unwrap_or_else(|_| "ws://localhost:3000".to_string());
    let bind_addr =
        std::env::var("BIND_ADDR").unwrap_or_else(|_| "0.0.0.0:9090".to_string());

    let (tx, _) = broadcast::channel(2048);
    let state = AppState {
        matches: Arc::new(DashMap::new()),
        tx,
    };

    let state_clone = state.clone();
    tokio::spawn(async move {
        connect_upstream(&upstream_url, state_clone).await;
    });

    let cors = CorsLayer::new()
        .allow_methods([Method::GET])
        .allow_origin(Any);

    let app = Router::new()
        .route("/api/matches", get(get_matches))
        .route("/ws", get(ws_handler))
        .layer(cors)
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(&bind_addr).await.unwrap();
    println!("[Rust] Serveur sur {}", bind_addr);
    axum::serve(listener, app).await.unwrap();
        }
