/**
 * @file test_support.rs
 * @description Shared Rust test helpers for backend command/service smoke tests.
 *
 * This module intentionally stays under `cfg(test)` and provides:
 *   - an in-memory SecureKeyStore implementation
 *   - a SQLite pool initialized with the runtime migrations
 *   - a minimal HTTP mock server for reqwest-based probe/stream tests
 */

use std::{
    collections::HashMap,
    io,
    net::SocketAddr,
    sync::{Arc, Mutex},
};

use sqlx::{
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions},
    SqlitePool,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::oneshot,
    task::JoinHandle,
};

use crate::state::SecureKeyStore;

// ============================================================================
// Secure Key Store
// ============================================================================

/** In-memory secure storage used only by backend tests. */
pub struct TestKeyStore {
    entries: Mutex<HashMap<String, String>>,
}

impl TestKeyStore {
    /** Create an empty in-memory key store. */
    pub fn new() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
        }
    }
}

impl SecureKeyStore for TestKeyStore {
    fn save(&self, provider_id: &str, key: &str) -> Result<String, String> {
        self.entries
            .lock()
            .map_err(|error| error.to_string())?
            .insert(provider_id.to_string(), key.to_string());
        Ok(format!("test-key://{provider_id}"))
    }

    fn load(&self, provider_id: &str) -> Result<Option<String>, String> {
        Ok(self
            .entries
            .lock()
            .map_err(|error| error.to_string())?
            .get(provider_id)
            .cloned())
    }

    fn delete(&self, provider_id: &str) -> Result<(), String> {
        self.entries
            .lock()
            .map_err(|error| error.to_string())?
            .remove(provider_id);
        Ok(())
    }

    fn exists(&self, provider_id: &str) -> Result<bool, String> {
        Ok(self
            .entries
            .lock()
            .map_err(|error| error.to_string())?
            .contains_key(provider_id))
    }
}

// ============================================================================
// SQLite Test Pool
// ============================================================================

/** Build a fresh SQLite in-memory pool with the runtime migrations applied. */
pub async fn init_test_pool() -> SqlitePool {
    let options = SqliteConnectOptions::new()
        .filename(":memory:")
        .create_if_missing(true)
        .foreign_keys(true)
        .journal_mode(SqliteJournalMode::Wal);

    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .expect("failed to create sqlite test pool");

    run_migrations(&pool).await;
    pool
}

/** Apply the runtime SQL migrations to a test pool. */
async fn run_migrations(pool: &SqlitePool) {
    let migrations = [
        include_str!("db/migrations/0001_init.sql"),
        include_str!("db/migrations/0002_sibling_unique.sql"),
        include_str!("db/migrations/0003_provider_models_and_branch_preferences.sql"),
    ];

    for migration in migrations {
        let clean_sql = migration
            .lines()
            .filter(|line| !line.trim().starts_with("--"))
            .collect::<Vec<_>>()
            .join("\n");

        for statement in clean_sql.split(';') {
            let trimmed = statement.trim();
            if trimmed.is_empty() {
                continue;
            }

            if let Err(error) = sqlx::query(trimmed).execute(pool).await {
                if !error.to_string().contains("duplicate column name") {
                    panic!("failed to run test migration `{trimmed}`: {error}");
                }
            }
        }
    }
}

// ============================================================================
// HTTP Mock Server
// ============================================================================

/** A recorded HTTP request received by the mock server. */
#[derive(Debug, Clone)]
pub struct RecordedHttpRequest {
    pub method: String,
    pub path: String,
    pub headers: HashMap<String, String>,
    pub body: String,
}

/** A fixed mock response served for a matching method/path pair. */
#[derive(Debug, Clone)]
pub struct MockHttpRoute {
    pub method: &'static str,
    pub path: &'static str,
    pub status_code: u16,
    pub content_type: &'static str,
    pub body: String,
    pub extra_headers: Vec<(String, String)>,
}

impl MockHttpRoute {
    /** Build a basic route with no extra headers. */
    pub fn new(
        method: &'static str,
        path: &'static str,
        status_code: u16,
        content_type: &'static str,
        body: impl Into<String>,
    ) -> Self {
        Self {
            method,
            path,
            status_code,
            content_type,
            body: body.into(),
            extra_headers: Vec::new(),
        }
    }
}

/** Handle to a background mock HTTP server spawned for a test. */
pub struct MockHttpServer {
    address: SocketAddr,
    requests: Arc<Mutex<Vec<RecordedHttpRequest>>>,
    shutdown_tx: Option<oneshot::Sender<()>>,
    task: Option<JoinHandle<()>>,
}

impl MockHttpServer {
    /** Base URL exposed by the mock server. */
    pub fn base_url(&self) -> String {
        format!("http://{}", self.address)
    }

    /** Snapshot all recorded requests in arrival order. */
    pub fn recorded_requests(&self) -> Vec<RecordedHttpRequest> {
        self.requests
            .lock()
            .expect("request recorder poisoned")
            .clone()
    }
}

impl Drop for MockHttpServer {
    fn drop(&mut self) {
        if let Some(shutdown_tx) = self.shutdown_tx.take() {
            let _ = shutdown_tx.send(());
        }

        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

/** Spawn a lightweight HTTP/1.1 server with fixed routes for reqwest tests. */
pub async fn spawn_mock_http_server(routes: Vec<MockHttpRoute>) -> MockHttpServer {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("failed to bind mock http listener");
    let address = listener
        .local_addr()
        .expect("failed to read mock http listener address");
    let routes = Arc::new(routes);
    let requests = Arc::new(Mutex::new(Vec::new()));
    let recorded_requests = requests.clone();
    let (shutdown_tx, mut shutdown_rx) = oneshot::channel::<()>();

    let task = tokio::spawn(async move {
        loop {
            tokio::select! {
                biased;
                _ = &mut shutdown_rx => {
                    break;
                }
                accept_result = listener.accept() => {
                    let Ok((mut stream, _)) = accept_result else {
                        break;
                    };

                    let routes = routes.clone();
                    let requests = recorded_requests.clone();

                    tokio::spawn(async move {
                        let _ = handle_connection(&mut stream, routes, requests).await;
                    });
                }
            }
        }
    });

    MockHttpServer {
        address,
        requests,
        shutdown_tx: Some(shutdown_tx),
        task: Some(task),
    }
}

/** Read one request, record it, and write the configured response. */
async fn handle_connection(
    stream: &mut tokio::net::TcpStream,
    routes: Arc<Vec<MockHttpRoute>>,
    requests: Arc<Mutex<Vec<RecordedHttpRequest>>>,
) -> io::Result<()> {
    let mut buffer = Vec::new();
    let headers_end = loop {
        let mut chunk = [0_u8; 1024];
        let bytes_read = stream.read(&mut chunk).await?;
        if bytes_read == 0 {
            return Ok(());
        }

        buffer.extend_from_slice(&chunk[..bytes_read]);

        if let Some(index) = find_headers_end(&buffer) {
            break index;
        }
    };

    let header_text = String::from_utf8_lossy(&buffer[..headers_end]).to_string();
    let mut lines = header_text.split("\r\n");
    let request_line = lines.next().unwrap_or_default();
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts.next().unwrap_or_default().to_string();
    let path = request_parts.next().unwrap_or_default().to_string();

    let mut headers = HashMap::new();
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }

    let content_length = headers
        .get("content-length")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);

    let body_start = headers_end + 4;
    let mut body_bytes = buffer[body_start..].to_vec();
    while body_bytes.len() < content_length {
        let mut chunk = vec![0_u8; content_length - body_bytes.len()];
        let bytes_read = stream.read(&mut chunk).await?;
        if bytes_read == 0 {
            break;
        }
        body_bytes.extend_from_slice(&chunk[..bytes_read]);
    }

    let body = String::from_utf8_lossy(&body_bytes).to_string();

    requests
        .lock()
        .expect("request recorder poisoned")
        .push(RecordedHttpRequest {
            method: method.clone(),
            path: path.clone(),
            headers: headers.clone(),
            body,
        });

    let route = routes
        .iter()
        .find(|route| route.method == method && route.path == path);

    let (status_code, content_type, response_body, extra_headers) = match route {
        Some(route) => (
            route.status_code,
            route.content_type,
            route.body.clone(),
            route.extra_headers.clone(),
        ),
        None => (
            404,
            "text/plain; charset=utf-8",
            format!("unhandled mock route: {method} {path}"),
            Vec::new(),
        ),
    };

    let status_text = status_text(status_code);
    let mut response = format!(
        "HTTP/1.1 {status_code} {status_text}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n",
        response_body.as_bytes().len()
    );

    for (name, value) in extra_headers {
        response.push_str(&format!("{name}: {value}\r\n"));
    }

    response.push_str("\r\n");
    response.push_str(&response_body);
    stream.write_all(response.as_bytes()).await?;
    stream.shutdown().await
}

/** Locate the HTTP header/body separator in a read buffer. */
fn find_headers_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|window| window == b"\r\n\r\n")
}

/** Minimal reason phrases for the HTTP codes used by backend tests. */
fn status_text(status_code: u16) -> &'static str {
    match status_code {
        200 => "OK",
        201 => "Created",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        _ => "OK",
    }
}
