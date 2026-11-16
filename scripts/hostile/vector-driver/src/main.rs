//! One headless Vector client (vector-sdk), driven by JSON lines on stdin and answering
//! JSON lines on stdout, for `scripts/hostile/compare.mjs`. Everything Concord it does is
//! the SDK's own code path; the commands only name which call to make.

use std::io::BufRead;
use std::sync::Arc;

use serde_json::{json, Value};
use vector_sdk::vector_core::community::CommunityId;
use vector_sdk::{NewChannel, NewCommunity, Overwrite, Permissions, RoleSpec, VectorBot};

fn now_ms() -> u128 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis()
}

fn out(v: Value) {
    println!("{v}");
}

async fn handle(bot: &VectorBot, cmd: &Value) -> Result<Value, String> {
    let s = |k: &str| cmd[k].as_str().unwrap_or_default().to_string();
    match cmd["cmd"].as_str().unwrap_or_default() {
        "whoami" => Ok(json!({ "npub": bot.npub() })),
        "create" => {
            let relays: Vec<String> = cmd["relays"].as_array().unwrap().iter().map(|r| r.as_str().unwrap().to_string()).collect();
            let community = bot.create_community(&s("name"), NewCommunity::default().relays(relays)).await.map_err(|e| e.to_string())?;
            // Created top first: each outranks the next, so a Holder can cut a Tester.
            let holder = community.create_role(RoleSpec::new("Holder").permissions(Permissions::MANAGE_CHANNELS)).await.map_err(|e| e.to_string())?;
            let granter_bits = cmd["granterPermissions"].as_u64().unwrap_or(Permissions::MANAGE_ROLES);
            let granter = community.create_role(RoleSpec::new("Granter").permissions(granter_bits)).await.map_err(|e| e.to_string())?;
            let member_role = cmd["memberRole"].as_str().unwrap_or("Verified").to_string();
            let testers = community.create_role(RoleSpec::new(&member_role).permissions(0u64)).await.map_err(|e| e.to_string())?;
            let read = Permissions::VIEW_CHANNEL | Permissions::SEND_MESSAGES | Permissions::READ_MESSAGE_HISTORY;
            let mut channels = Vec::new();
            let n = cmd["channels"].as_u64().unwrap_or(3);
            if cmd["layout"].as_str() == Some("channel") {
                // Each Channel carries its own overwrites.
                for i in 0..n {
                    let ch = community.create_channel_with(&format!("p{i}"), NewChannel::default().private()).await.map_err(|e| e.to_string())?;
                    ch.set_overwrite(Overwrite::role(&testers).allow(read)).await.map_err(|e| e.to_string())?;
                    ch.set_overwrite(Overwrite::role(&holder).allow(read)).await.map_err(|e| e.to_string())?;
                    channels.push(ch.id().to_string());
                }
            } else {
                // One Category lets the Role in, and every private Channel in it syncs to it.
                let category = community.create_category("Members").await.map_err(|e| e.to_string())?;
                category.set_overwrite(Overwrite::role(&testers).allow(read)).await.map_err(|e| e.to_string())?;
                category.set_overwrite(Overwrite::role(&holder).allow(read)).await.map_err(|e| e.to_string())?;
                for i in 0..n {
                    let ch = community.create_channel_with(&format!("p{i}"), NewChannel::default().private().in_category(category.id())).await.map_err(|e| e.to_string())?;
                    ch.sync_permissions(Some(&category)).await.map_err(|e| e.to_string())?;
                    channels.push(ch.id().to_string());
                }
            }
            let invite = community.create_invite().await.map_err(|e| e.to_string())?;
            Ok(json!({ "community": community.id(), "invite": invite, "channels": channels }))
        }
        "join" => {
            let community = bot.join(&s("invite")).await.map_err(|e| e.to_string())?;
            Ok(json!({ "community": community.id() }))
        }
        "roles" => {
            let community = bot.community(s("community"));
            let mut held = Vec::new();
            for name in cmd["roles"].as_array().unwrap() {
                let role = community.role_named(name.as_str().unwrap()).map_err(|e| e.to_string())?.ok_or("no such role")?;
                held.push(role);
            }
            community.member(s("npub")).set_roles(&held.iter().collect::<Vec<_>>()).await.map_err(|e| e.to_string())?;
            Ok(json!({}))
        }
        "toggle" => {
            let community = bot.community(s("community"));
            let role = community.role_named(&s("role")).map_err(|e| e.to_string())?.ok_or("no such role")?;
            let member = community.member(s("npub"));
            if cmd["on"].as_bool().unwrap_or(true) { member.add_role(&role).await } else { member.remove_role(&role).await }.map_err(|e| e.to_string())?;
            Ok(json!({}))
        }
        "can" => {
            let community = bot.community(s("community"));
            let bits = community.member(s("npub")).permissions().map_err(|e| e.to_string())?;
            Ok(json!({ "permissions": bits.0.to_string() }))
        }
        "state" => {
            let id = CommunityId(vector_sdk::vector_core::simd::hex::hex_to_bytes_32_checked(&s("community")).ok_or("bad id")?);
            let Some(c) = vector_sdk::vector_core::db::community::load_community_v2(&id)? else { return Ok(json!({ "held": false })) };
            let channels: Vec<Value> = c.channels.iter().filter(|ch| ch.private).map(|ch| json!({
                "id": vector_sdk::vector_core::simd::hex::bytes_to_hex_32(&ch.id.0),
                "key": ch.key.map(|k| vector_sdk::vector_core::simd::hex::bytes_to_hex_32(&k)),
                "epoch": ch.epoch.0,
            })).collect();
            Ok(json!({ "held": true, "channels": channels }))
        }
        other => Err(format!("unknown command {other}")),
    }
}

#[tokio::main]
async fn main() {
    let nsec = std::env::var("VECTOR_NSEC").expect("VECTOR_NSEC");
    let data = std::env::var("VECTOR_DATA_DIR").expect("VECTOR_DATA_DIR");
    let bot = VectorBot::builder().nsec(nsec).data_dir(data).build().await.expect("bot");
    out(json!({ "event": "ready", "npub": bot.npub(), "at": now_ms() }));
    // The receive loop: live subscriptions, follow passes, duties. Events themselves aren't needed.
    let listening = bot.clone();
    tokio::spawn(async move {
        let _ = listening.on_event(|_bot, _event| async move {}).await;
    });
    let bot = Arc::new(bot);
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines().map_while(Result::ok) {
            if tx.send(line).is_err() {
                break;
            }
        }
    });
    while let Some(line) = rx.recv().await {
        let Ok(cmd) = serde_json::from_str::<Value>(&line) else { continue };
        if cmd["cmd"] == "quit" {
            break;
        }
        let bot = bot.clone();
        tokio::spawn(async move {
            let started = now_ms();
            let reply = match handle(&bot, &cmd).await {
                Ok(v) => json!({ "id": cmd["id"], "ok": true, "result": v, "ms": now_ms() - started }),
                Err(e) => json!({ "id": cmd["id"], "ok": false, "error": e, "ms": now_ms() - started }),
            };
            out(reply);
        });
    }
}
