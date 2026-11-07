    // ── Armada differential Channel/Category fixtures (local only) ────────────
    // Random Control Planes of Channel (vsk 2) and Category (vsk 15) editions —
    // renames, re-filing, positions, topics, forks, deletions — from managers and
    // non-managers, with a Role granting MANAGE_CHANNELS that may be stripped
    // midway. Each is folded by Vector's `apply_control_fold` over the whole plane
    // and over withheld slices floored at the full fold's heads. Writes
    // $ARMADA_FIXTURES/channel_fuzz.json. Appended after armada_roster_fuzz.rs (it
    // reuses `Lcg`, `fuzz_publish`).

    fn fuzz_dump_channels(c: &CommunityV2) -> serde_json::Value {
        let hex = crate::simd::hex::bytes_to_hex_32;
        let mut channels: Vec<serde_json::Value> = c
            .channels
            .iter()
            .map(|ch| {
                serde_json::json!({
                    "id": hex(&ch.id.0),
                    "name": ch.name,
                    "private": ch.private,
                    "category": ch.meta_extra.get("category"),
                    "position": ch.meta_extra.get("position"),
                    "topic": ch.meta_extra.get("topic"),
                })
            })
            .collect();
        channels.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
        let mut categories: Vec<serde_json::Value> = c
            .categories
            .iter()
            .map(|k| serde_json::json!({ "id": hex(&k.id), "name": k.name, "position": k.position }))
            .collect();
        categories.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
        serde_json::json!({ "channels": channels, "categories": categories })
    }

    #[tokio::test]
    async fn armada_fixture_channel_fuzz() {
        let Ok(dir) = std::env::var("ARMADA_FIXTURES") else { return };
        let hex = crate::simd::hex::bytes_to_hex_32;
        let cases: u64 = std::env::var("ARMADA_FUZZ_CASES").ok().and_then(|s| s.parse().ok()).unwrap_or(60);
        let base: u64 = std::env::var("ARMADA_FUZZ_SEED_BASE").ok().and_then(|s| s.parse().ok()).unwrap_or(0);
        let mut out = Vec::new();
        for seed in base..base + cases {
            let (_tmp, _guard, owner) = init_test_db();
            let relay = MemoryRelay::new();
            let community = create_community(&relay, "Fuzz", vec!["wss://r".into()], None).await.unwrap();
            let mut rng = Lcg(seed.wrapping_mul(0x9e3779b97f4a7c15) | 7);
            let others = [Keys::generate(), Keys::generate()];
            let manager_role = format!("{:02x}", 0xa0).repeat(32);
            let mut chains: std::collections::HashMap<[u8; 32], Vec<(u64, [u8; 32])>> = Default::default();
            let link = |rng: &mut Lcg, chains: &std::collections::HashMap<[u8; 32], Vec<(u64, [u8; 32])>>, eid: &[u8; 32]| -> (u64, Option<[u8; 32]>) {
                let Some(chain) = chains.get(eid).filter(|c| !c.is_empty()) else { return (1, None) };
                let top = chain.iter().map(|c| c.0).max().unwrap();
                if top > 1 && rng.chance(15) {
                    let below: Vec<_> = chain.iter().filter(|c| c.0 == top - 1).collect();
                    let p = below[rng.below(below.len() as u64) as usize];
                    return (top, Some(p.1));
                }
                let at: Vec<_> = chain.iter().filter(|c| c.0 == top).collect();
                (top + 1, Some(at[rng.below(at.len() as u64) as usize].1))
            };
            // The genesis editions already on the plane anchor their chains.
            for e in fetch_control(&relay, &community).await {
                chains.entry(e.entity_id).or_default().push((e.version, e.self_hash));
            }

            // Roles v2 with a manager Role granted to the first other member.
            let everyone_eid = crate::community::v2::derive::everyone_locator(community.id());
            let (v, p) = link(&mut rng, &chains, &everyone_eid);
            if let Some(h) = fuzz_publish(&relay, &community, &owner, vsk::ROLE_V2, everyone_eid, v, p, crate::community::v2::roles::everyone_content_json(crate::community::v2::roles::EVERYONE_DEFAULT), true, 1_000).await {
                chains.entry(everyone_eid).or_default().push((v, h));
            }
            let role_eid = crate::simd::hex::hex_to_bytes_32_checked(&manager_role).unwrap();
            let h = fuzz_publish(&relay, &community, &owner, vsk::ROLE_V2, role_eid, 1, None, crate::community::v2::roles::role_v2_content_json(&role_v2(&manager_role, "mods", "5", Permissions::MANAGE_CHANNELS)).unwrap(), true, 1_000).await;
            chains.entry(role_eid).or_default().push((1, h.unwrap()));
            let grant_eid = crate::community::v2::derive::grant_locator(community.id(), &others[0].public_key().to_bytes());
            let grant = |ids: Vec<String>| crate::community::v2::roles::grant_content_json(&MemberGrant { member: others[0].public_key().to_hex(), role_ids: ids }).unwrap();
            let h = fuzz_publish(&relay, &community, &owner, vsk::GRANT, grant_eid, 1, None, grant(vec![manager_role.clone()]), true, 1_000).await;
            chains.entry(grant_eid).or_default().push((1, h.unwrap()));

            let general = community.channels.first().map(|c| c.id.0).unwrap();
            let channel_ids: Vec<[u8; 32]> = std::iter::once(general).chain((0..3).map(|i| [0xd0 + i as u8; 32])).collect();
            let category_ids: Vec<[u8; 32]> = (0..2).map(|i| [0xe0 + i as u8; 32]).collect();
            let names = ["general", "news", "chat", "dev", "off-topic"];
            let ranks = ["1", "5", "9", "F", "K", "a", "m", "z"];

            let steps = 8 + rng.below(14);
            let mut at: u64 = 1_000;
            for _ in 0..steps {
                // Times move on unevenly and sometimes stand still.
                at += rng.below(3) * 7;
                let s = match rng.below(5) { 0 | 1 => owner.clone(), 2 | 3 => others[0].clone(), _ => others[1].clone() };
                let (vsk_code, eid, content): (&'static str, [u8; 32], String) = match rng.below(10) {
                    0..=5 => {
                        let eid = channel_ids[rng.below(channel_ids.len() as u64) as usize];
                        let mut o = serde_json::Map::new();
                        o.insert("name".into(), names[rng.below(names.len() as u64) as usize].into());
                        o.insert("private".into(), false.into());
                        if rng.chance(60) {
                            o.insert("category".into(), hex(&category_ids[rng.below(2) as usize]).into());
                        }
                        if rng.chance(60) {
                            o.insert("position".into(), ranks[rng.below(8) as usize].into());
                        }
                        if rng.chance(25) {
                            o.insert("topic".into(), "about".into());
                        }
                        if rng.chance(10) {
                            o.insert("deleted".into(), true.into());
                        }
                        (vsk::CHANNEL_METADATA, eid, serde_json::Value::Object(o).to_string())
                    }
                    6..=8 => {
                        let eid = category_ids[rng.below(2) as usize];
                        let mut o = serde_json::Map::new();
                        if rng.chance(12) {
                            o.insert("deleted".into(), true.into());
                        } else {
                            o.insert("name".into(), ["Text", "Voice", "Staff"][rng.below(3) as usize].into());
                            if rng.chance(70) {
                                o.insert("position".into(), ranks[rng.below(8) as usize].into());
                            }
                        }
                        (vsk::CATEGORY, eid, serde_json::Value::Object(o).to_string())
                    }
                    _ => {
                        // Strip or restore the manager's Role: their editions stand only while it holds.
                        let ids = if rng.chance(50) { vec![] } else { vec![manager_role.clone()] };
                        (vsk::GRANT, grant_eid, grant(ids))
                    }
                };
                let signer = if vsk_code == vsk::GRANT { owner.clone() } else { s };
                let (version, prev) = link(&mut rng, &chains, &eid);
                if let Some(h) = fuzz_publish(&relay, &community, &signer, vsk_code, eid, version, prev, content, true, at).await {
                    chains.entry(eid).or_default().push((version, h));
                }
            }

            let eds = fetch_control(&relay, &community).await;
            let authority = fold_authority(&community, &eds, &Floors::default());
            let full = apply_control_fold(&community, &eds, &Floors::default(), &authority);
            let folded_full = full.updated.clone().unwrap_or_else(|| community.clone());
            // A tracking reader: it stored what the full fold settled on (the Roster, the Banlist).
            let cid_hex = hex(&community.id().0);
            crate::db::community::set_community_roles(&cid_hex, &authority.roles, 1).unwrap();
            crate::db::community::set_community_banlist(&cid_hex, &authority.banned.iter().cloned().collect::<Vec<_>>(), 1).unwrap();
            let mut slices = vec![serde_json::json!({ "floors": false, "served": eds.iter().map(|e| hex(&e.inner_id)).collect::<Vec<_>>(), "vector": fuzz_dump_channels(&folded_full) })];
            let floor_of = |h: &FoldedHead, fam: &str| (h.entity_hex.clone(), (h.version, h.self_hash, Some(h.inner_id), Some(h.author), Some(crate::db::community::FloorFamily::of(fam))));
            let floors: Floors = authority
                .heads
                .iter()
                .map(|h| floor_of(h, crate::db::community::FLOOR_AUTHORITY))
                .chain(full.heads.iter().map(|h| floor_of(h, crate::db::community::FLOOR_CONTROL)))
                .collect();
            for _ in 0..2 {
                let served: Vec<ParsedEdition> = eds.iter().filter(|_| !rng.chance(25)).cloned().collect();
                let a = fold_authority(&folded_full, &served, &floors);
                let f = apply_control_fold(&folded_full, &served, &floors, &a);
                let c = f.updated.clone().unwrap_or_else(|| folded_full.clone());
                slices.push(serde_json::json!({ "floors": true, "served": served.iter().map(|e| hex(&e.inner_id)).collect::<Vec<_>>(), "vector": fuzz_dump_channels(&c) }));
            }
            let floor_rows: Vec<serde_json::Value> = authority
                .heads
                .iter()
                .chain(full.heads.iter())
                .map(|h| serde_json::json!({ "eid": h.entity_hex, "version": h.version, "hash": hex(&h.self_hash), "id": hex(&h.inner_id), "author": hex(&h.author) }))
                .collect();
            let wraps = relay.fetch(&Query::default(), &community.relays).await.unwrap();
            out.push(serde_json::json!({
                "seed": seed,
                "community": {
                    "id": hex(&community.id().0),
                    "owner": owner.public_key().to_hex(),
                    "root": hex(&community.community_root),
                    "root_epoch": community.root_epoch.0,
                    "control_pk": community.control_pk.map(|p| p.to_hex()),
                },
                "events": wraps,
                "floors": floor_rows,
                "slices": slices,
            }));
        }
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(format!("{dir}/channel_fuzz.json"), serde_json::to_string(&out).unwrap()).unwrap();
    }
