//! A Concord voice Channel's peer-to-peer call (CORD-07 §8), as Vector runs it:
//! a fresh endpoint per call speaking `concord/voice/1`, one QUIC connection per
//! peer, and the audio in unreliable datagrams.
//!
//! As dumb as the gossip half. Which peers to dial or keep, the datagram header,
//! the video stream format and the media itself are decided in
//! `src/concord/lib/irohVoice.ts`, `irohVideo.ts` and `src/lib/irohVoice/`; this
//! moves datagrams and whole unidirectional streams (Vector's video frames and
//! controls, one per stream) between connections and says when one comes or goes.

use std::collections::HashMap;
use std::rc::Rc;
use std::cell::RefCell;
use std::time::Duration;

use iroh::endpoint::{Connection, QuicTransportConfig, VarInt};
use iroh::{Endpoint, EndpointAddr, EndpointId, RelayMode, RelayUrl, TransportAddr};
use wasm_bindgen::prelude::*;

use crate::{err, wasm_sleep};

/// Vector's `VOICE_ALPN`: a different protocol from the 1:1 call's `vector/call/1`.
pub const VOICE_ALPN: &[u8] = b"concord/voice/1";
/// Vector's `DATAGRAM_SEND_BUFFER`: a choked link drops its oldest frames rather
/// than queueing seconds of speech.
const DATAGRAM_SEND_BUFFER: usize = 4096;
const CONNECT_TIMEOUT_MS: i32 = 15_000;
/// Vector's cap on a call's peers; a dial past it is refused here too.
const MAX_LINKS: usize = 14;
/// Vector's `MAX_VIDEO_FRAME`, plus the stream's type byte and frame header.
const MAX_STREAM: usize = 1024 * 1024 + 17;
/// Vector's `INBOUND_FRAME_TIMEOUT`: a stream not whole by then is a lost frame.
const STREAM_TIMEOUT_MS: i32 = 2_000;

type Links = Rc<RefCell<HashMap<[u8; 32], Connection>>>;

/// The relays of the iroh release this build ships, as a browser dials them: what CORD-07 §8
/// calls iroh's defaults, so the page's list can't drift from the crate's.
#[wasm_bindgen(js_name = defaultVoiceRelays)]
pub fn default_voice_relays() -> Vec<String> {
    default_relays().iter().map(|u| browser_relay(u).to_string()).collect()
}

fn default_relays() -> Vec<RelayUrl> {
    iroh::defaults::prod::default_relay_map().urls::<Vec<RelayUrl>>()
}

#[wasm_bindgen]
pub struct VoiceNode {
    endpoint: Endpoint,
    links: Links,
    on_datagram: js_sys::Function,
    on_link: js_sys::Function,
    on_closed: js_sys::Function,
    on_stream: js_sys::Function,
}

#[wasm_bindgen]
impl VoiceNode {
    /// Bind a call's endpoint, homed on `relays` (empty: iroh's defaults), as Vector's
    /// `bind` takes them. A browser has no UDP, so every path is through one of them, and
    /// a bind no relay answers within the bound is refused: nobody could dial it.
    ///
    /// `on_link(idHex, inbound)` fires for every connection that lands, before any
    /// of its datagrams; `on_datagram(idHex, bytes)` per datagram; `on_closed(idHex)`
    /// when a link ends, whoever ended it; `on_stream(idHex, bytes)` per whole
    /// unidirectional stream, or `on_stream(idHex, undefined)` for one that broke off.
    pub async fn bind(
        relays: Vec<String>,
        on_link: js_sys::Function,
        on_datagram: js_sys::Function,
        on_closed: js_sys::Function,
        on_stream: js_sys::Function,
    ) -> Result<VoiceNode, JsError> {
        let urls: Vec<RelayUrl> = if relays.is_empty() {
            default_relays()
        } else {
            relays.iter().filter_map(|r| r.parse::<RelayUrl>().ok()).collect()
        };
        if urls.is_empty() {
            return Err(JsError::new("no usable voice relay"));
        }
        // Vector's voice tuning (vector-core `calls/voice.rs` `bind`): a short idle
        // timeout, so a peer that vanished is dropped from the mix within seconds.
        let transport = QuicTransportConfig::builder()
            .keep_alive_interval(Duration::from_secs(5))
            .max_idle_timeout(Some(
                Duration::from_secs(30)
                    .try_into()
                    .map_err(|_| JsError::new("idle timeout out of range"))?,
            ))
            .send_observed_address_reports(false)
            .receive_observed_address_reports(false)
            .stream_receive_window(VarInt::from_u32(512 * 1024))
            .receive_window(VarInt::from_u32(2 * 1024 * 1024))
            .max_concurrent_uni_streams(VarInt::from_u32(256))
            .datagram_send_buffer_size(DATAGRAM_SEND_BUFFER)
            .build();
        let endpoint = Endpoint::builder(iroh::endpoint::presets::Minimal)
            .relay_mode(RelayMode::Custom(urls.iter().map(browser_relay).collect()))
            .alpns(vec![VOICE_ALPN.to_vec()])
            .transport_config(transport)
            .bind()
            .await
            .map_err(err)?;
        // Bounded, as in `RealtimeNode::new`: an unreachable relay never resolves.
        let homed = matches!(
            futures_util::future::select(std::pin::pin!(endpoint.online()), std::pin::pin!(wasm_sleep(8_000))).await,
            futures_util::future::Either::Left(_)
        );
        if !homed {
            endpoint.close().await;
            return Err(JsError::new("no voice relay answered"));
        }

        let node = VoiceNode {
            endpoint: endpoint.clone(),
            links: Rc::new(RefCell::new(HashMap::new())),
            on_datagram,
            on_link,
            on_closed,
            on_stream,
        };
        // Every inbound connection is reported, and the page closes the ones its
        // presence doesn't bind to a member who may connect (Vector `acceptor`).
        let (links, cbs) = (node.links.clone(), node.callbacks());
        wasm_bindgen_futures::spawn_local(async move {
            while let Some(incoming) = endpoint.accept().await {
                let (links, cbs) = (links.clone(), cbs.clone());
                wasm_bindgen_futures::spawn_local(async move {
                    if let Ok(conn) = incoming.await {
                        if conn.alpn() == VOICE_ALPN {
                            adopt(&links, &cbs, conn, true);
                        } else {
                            conn.close(0u32.into(), b"wrong protocol");
                        }
                    }
                });
            }
        });
        Ok(node)
    }

    /// Our endpoint id, hex: the `endpoint` tag of our presence.
    #[wasm_bindgen(js_name = endpointHex)]
    pub fn endpoint_hex(&self) -> String {
        hex(self.endpoint.id().as_bytes())
    }

    /// The relay we are reached through: the `relay` tag of our presence.
    #[wasm_bindgen(js_name = relayUrl)]
    pub fn relay_url(&self) -> Option<String> {
        self.endpoint.addr().addrs.iter().find_map(|a| match a {
            TransportAddr::Relay(u) => Some(u.to_string()),
            _ => None,
        })
    }

    /// Dial a peer through the relay its presence names. Resolves once linked;
    /// rejects on a failed or timed-out dial, or when already linked.
    pub async fn dial(&self, id_hex: &str, relay: &str) -> Result<(), JsError> {
        let id = parse_id(id_hex).ok_or_else(|| JsError::new("endpoint must be 64 hex digits"))?;
        let relay: RelayUrl = relay.parse().map_err(err)?;
        if self.links.borrow().contains_key(&id) {
            return Err(JsError::new("already linked"));
        }
        let eid = EndpointId::from_bytes(&id).map_err(err)?;
        let addr = EndpointAddr { id: eid, addrs: [TransportAddr::Relay(browser_relay(&relay))].into_iter().collect() };
        let connect = std::pin::pin!(self.endpoint.connect(addr, VOICE_ALPN));
        let timeout = std::pin::pin!(wasm_sleep(CONNECT_TIMEOUT_MS));
        match futures_util::future::select(connect, timeout).await {
            futures_util::future::Either::Left((Ok(conn), _)) => {
                if adopt(&self.links, &self.callbacks(), conn, false) {
                    Ok(())
                } else {
                    Err(JsError::new("already linked"))
                }
            }
            futures_util::future::Either::Left((Err(e), _)) => Err(err(e)),
            futures_util::future::Either::Right(_) => Err(JsError::new("dial timed out")),
        }
    }

    /// One datagram to one peer. A full send buffer drops the oldest, as Vector's
    /// engines do; a peer not linked is skipped.
    pub fn send(&self, id_hex: &str, datagram: Vec<u8>) -> bool {
        let Some(id) = parse_id(id_hex) else { return false };
        let conn = self.links.borrow().get(&id).cloned();
        conn.is_some_and(|c| c.send_datagram(datagram.into()).is_ok())
    }

    /// One whole unidirectional stream to a peer: a video frame or a control. Never waits
    /// for stream credit — a peer that has none skips this one (Vector `ship`) — and resets
    /// a stream not delivered within `stale_ms`. Resolves whether it went.
    #[wasm_bindgen(js_name = sendStream)]
    pub async fn send_stream(&self, id_hex: &str, bytes: Vec<u8>, priority: i32, stale_ms: i32) -> bool {
        let Some(id) = parse_id(id_hex) else { return false };
        let conn = self.links.borrow().get(&id).cloned();
        let Some(conn) = conn else { return false };
        let Some(Ok(mut s)) = futures_util::FutureExt::now_or_never(conn.open_uni()) else { return false };
        let _ = s.set_priority(priority);
        let outcome = {
            let sent = async { s.write_chunk(bytes.into()).await.is_ok() && s.finish().is_ok() && s.stopped().await.is_ok() };
            match futures_util::future::select(std::pin::pin!(sent), std::pin::pin!(wasm_sleep(stale_ms))).await {
                futures_util::future::Either::Left((ok, _)) => Some(ok),
                futures_util::future::Either::Right(_) => None,
            }
        };
        outcome.unwrap_or_else(|| {
            let _ = s.reset(VarInt::from_u32(1));
            false
        })
    }

    /// The selected path's round trip to a peer, in ms; 0 when not linked.
    #[wasm_bindgen(js_name = rttMs)]
    pub fn rtt_ms(&self, id_hex: &str) -> u32 {
        let Some(id) = parse_id(id_hex) else { return 0 };
        let conn = self.links.borrow().get(&id).cloned();
        conn.and_then(|c| c.paths().iter().find(|p| p.is_selected()).map(|p| p.rtt().as_millis() as u32)).unwrap_or(0)
    }

    /// End one peer's link; `on_closed` follows.
    pub fn unlink(&self, id_hex: &str, reason: &str) {
        let Some(id) = parse_id(id_hex) else { return };
        let conn = self.links.borrow_mut().remove(&id);
        if let Some(c) = conn {
            c.close(0u32.into(), reason.as_bytes());
            let _ = self.on_closed.call1(&JsValue::NULL, &JsValue::from_str(id_hex));
        }
    }

    /// Leave the call: every link and the endpoint.
    pub async fn close(&self) {
        let all: Vec<Connection> = self.links.borrow_mut().drain().map(|(_, c)| c).collect();
        for c in all {
            c.close(0u32.into(), b"left");
        }
        self.endpoint.close().await;
    }

    fn callbacks(&self) -> Callbacks {
        Rc::new((self.on_link.clone(), self.on_datagram.clone(), self.on_closed.clone(), self.on_stream.clone()))
    }
}

type Callbacks = Rc<(js_sys::Function, js_sys::Function, js_sys::Function, js_sys::Function)>;

/// Take a connection as the link to its peer, unless one is held already or the
/// call is full (Vector `link`), and read its datagrams until it closes.
fn adopt(links: &Links, cbs: &Callbacks, conn: Connection, inbound: bool) -> bool {
    let id = *conn.remote_id().as_bytes();
    {
        let mut held = links.borrow_mut();
        if held.contains_key(&id) || held.len() >= MAX_LINKS {
            conn.close(0u32.into(), b"already connected");
            return false;
        }
        held.insert(id, conn.clone());
    }
    let id_hex = JsValue::from_str(&hex(&id));
    let _ = cbs.0.call2(&JsValue::NULL, &id_hex, &JsValue::from_bool(inbound));
    // Every stream the peer opens, read whole, in the order they arrive.
    let (streams, stream_cbs, stream_id) = (conn.clone(), cbs.clone(), id_hex.clone());
    wasm_bindgen_futures::spawn_local(async move {
        while let Ok(mut s) = streams.accept_uni().await {
            let (cbs, id) = (stream_cbs.clone(), stream_id.clone());
            wasm_bindgen_futures::spawn_local(async move {
                let whole = {
                    let read = std::pin::pin!(s.read_to_end(MAX_STREAM));
                    match futures_util::future::select(read, std::pin::pin!(wasm_sleep(STREAM_TIMEOUT_MS))).await {
                        futures_util::future::Either::Left((Ok(bytes), _)) => Some(bytes),
                        _ => None,
                    }
                };
                let arg = match &whole {
                    Some(bytes) => js_sys::Uint8Array::from(&bytes[..]).into(),
                    None => {
                        let _ = s.stop(VarInt::from_u32(0));
                        JsValue::UNDEFINED
                    }
                };
                let _ = cbs.3.call2(&JsValue::NULL, &id, &arg);
            });
        }
    });
    let (links, cbs) = (links.clone(), cbs.clone());
    wasm_bindgen_futures::spawn_local(async move {
        while let Ok(datagram) = conn.read_datagram().await {
            let bytes = js_sys::Uint8Array::from(&datagram[..]);
            let _ = cbs.1.call2(&JsValue::NULL, &id_hex, &bytes);
        }
        // Only the link this loop read: a replacement for the same peer stays.
        let same = links.borrow().get(&id).is_some_and(|c| c.stable_id() == conn.stable_id());
        if same {
            links.borrow_mut().remove(&id);
            let _ = cbs.2.call1(&JsValue::NULL, &id_hex);
        }
    });
    true
}

/// A relay as a browser can dial it: WebKit refuses a WebSocket to a fully
/// qualified host, and iroh spells its relays with the trailing dot (Vector
/// `browser_relay`).
fn browser_relay(url: &RelayUrl) -> RelayUrl {
    let mut u: url::Url = (**url).clone();
    if let Some(host) = u.host_str().and_then(|h| h.strip_suffix('.')).map(str::to_string) {
        let _ = u.set_host(Some(&host));
    }
    RelayUrl::from(u)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn parse_id(s: &str) -> Option<[u8; 32]> {
    if s.len() != 64 || !s.is_ascii() {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, chunk) in s.as_bytes().chunks(2).enumerate() {
        out[i] = u8::from_str_radix(std::str::from_utf8(chunk).ok()?, 16).ok()?;
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_endpoint_id_is_exactly_64_hex_digits() {
        let id: [u8; 32] = std::array::from_fn(|i| i as u8);
        assert_eq!(parse_id(&hex(&id)), Some(id));
        assert_eq!(parse_id(&hex(&id).to_uppercase()), Some(id));
        assert!(parse_id(&hex(&id)[..62]).is_none());
        assert!(parse_id(&format!("{}zz", &hex(&id)[..62])).is_none());
    }

    #[test]
    fn the_default_relays_are_the_iroh_releases_without_the_trailing_dot() {
        let relays = default_voice_relays();
        assert!(!relays.is_empty());
        assert!(relays.iter().all(|r| r.starts_with("https://") && !r.contains(".iroh.link./")));
        assert!(relays.contains(&"https://euc1-1.relay.n0.iroh.link/".to_string()));
    }

    #[test]
    fn a_relay_loses_its_trailing_dot_for_the_browser() {
        let url: RelayUrl = "https://euc1-1.relay.n0.iroh.link./".parse().unwrap();
        assert_eq!(browser_relay(&url).to_string(), "https://euc1-1.relay.n0.iroh.link/");
    }
}
