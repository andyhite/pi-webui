//! #316 acceptance: "an updater dry-run against a placeholder/local host
//! succeeds." Hosting a real feed, and real signing, are explicitly
//! deferred (#309's ADR §6 -- "ships unsigned", a follow-up issue picks up
//! real certificates and hosting). What this proves instead: the plugin's
//! `check()` round-trip -- fetch the manifest, parse it, compare versions,
//! construct an `Update` -- against a real HTTP server this test starts and
//! owns, standing in for the eventual placeholder/local static host. It
//! does not exercise `download()`/`install()`: those verify the minisign
//! `signature` field against `tauri.conf.json`'s `pubkey`, which needs a
//! real signed artifact this deferred-signing dry run deliberately does not
//! produce (a placeholder signature string is enough for `check()`, which
//! never inspects it -- only `download()` does).

use std::io::{Read, Write};
use std::net::TcpListener;
use std::thread;

use tauri_plugin_updater::UpdaterExt;

#[tokio::test]
async fn updater_check_succeeds_against_a_local_placeholder_host() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("failed to bind the dry-run server");
    let port = listener.local_addr().unwrap().port();

    // The "Dynamic" manifest shape (a flat `url`/`signature` rather than a
    // per-target `platforms` map) sidesteps needing to know this runner's
    // exact `{os}-{arch}` key -- the placeholder host only needs to prove
    // the fetch-and-parse path, not simulate every real release target.
    let manifest = format!(
        "{{\"version\":\"99.0.0\",\"notes\":\"dry-run placeholder release (#316)\",\"pub_date\":\"2026-01-01T00:00:00Z\",\"url\":\"http://127.0.0.1:{port}/artifact.tar.gz\",\"signature\":\"placeholder-signature-not-verified-by-check\"}}"
    );

    let server = thread::spawn(move || {
        // One request is all this dry run needs: `check()` fetches the
        // manifest exactly once per endpoint and never the artifact itself.
        let (mut stream, _) = listener
            .accept()
            .expect("dry-run server never received a connection");
        let mut buf = [0u8; 1024];
        let _ = stream.read(&mut buf);
        let body = manifest.into_bytes();
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        stream
            .write_all(response.as_bytes())
            .expect("failed to write the dry-run response head");
        stream
            .write_all(&body)
            .expect("failed to write the dry-run response body");
    });

    // The real `tauri.conf.json` (via `generate_context!`), not
    // `tauri::test::mock_context`: the mocked context's `plugins` map has no
    // `updater` key at all, and the plugin's config type has no `Default` to
    // fall back to -- it needs a real, valid `plugins.updater` block to
    // initialize, which this app's own committed config already is. The
    // dry run below overrides its endpoint at runtime rather than relying on
    // the committed one (a real, if placeholder-hosted, production URL).
    let app = tauri::test::mock_builder()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .build(tauri::generate_context!())
        .expect("failed to build the mock app for the updater dry run");

    let endpoint = format!("http://127.0.0.1:{port}/update.json")
        .parse()
        .expect("dry-run endpoint URL must parse");

    let update = app
        .updater_builder()
        .endpoints(vec![endpoint])
        .expect("failed to configure the placeholder-host endpoint")
        .build()
        .expect("failed to build the updater against the placeholder host")
        .check()
        .await
        .expect("updater check against the placeholder host failed")
        .expect("expected the placeholder manifest's 99.0.0 to read as an available update");

    assert_eq!(update.version, "99.0.0");
    assert_eq!(update.download_url.port(), Some(port));

    server.join().expect("dry-run server thread panicked");
}
