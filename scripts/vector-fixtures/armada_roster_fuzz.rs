
    // ── Armada differential Roster fixtures (local only) ──────────────────────
    // Random Control Planes built from Roles, Grants, `@everyone`, Tenures,
    // deletions, forks and Banlists, each folded by Vector's `fold_authority` with
    // no floors and again over withheld slices with the full fold's heads as
    // floors, the last with some floors missing their author. Writes
    // $ARMADA_FIXTURES/roster_fuzz.json for Armada to fold the same.

    struct Lcg(u64);
    impl Lcg {
        fn next(&mut self) -> u64 {
            self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            self.0 >> 33
        }
        fn below(&mut self, n: u64) -> u64 {
            self.next() % n
        }
        fn chance(&mut self, pct: u64) -> bool {
            self.below(100) < pct
        }
    }

    fn fuzz_dump_fold(f: &AuthoritySet, owner: &str, actors: &[String], scopes: &[String]) -> serde_json::Value {
        let hex = crate::simd::hex::bytes_to_hex_32;
        let mut roles: Vec<serde_json::Value> = f.roles.roles.iter().map(|r| serde_json::json!({ "id": r.role_id, "rank": r.rank, "permissions": r.permissions.0.to_string(), "name": r.name })).collect();
        roles.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
        let mut grants: Vec<String> = f.roles.grants.iter().map(|g| {
            let mut ids = g.role_ids.clone();
            ids.sort();
            format!("{}:{}", g.member, ids.join(","))
        }).collect();
        grants.sort();
        let mut heads: Vec<serde_json::Value> = f.heads.iter().map(|h| serde_json::json!({ "eid": h.entity_hex, "version": h.version, "hash": hex(&h.self_hash), "id": hex(&h.inner_id), "rebased": h.rebased })).collect();
        heads.sort_by(|a, b| a["eid"].as_str().cmp(&b["eid"].as_str()));
        let mut overwrites: Vec<String> = f.roles.overwrites.iter().map(|o| format!("{}|{:?}|{}|{}", o.scope, o.target, o.allow.0, o.deny.0)).collect();
        overwrites.sort();
        let perms: serde_json::Map<String, serde_json::Value> = actors
            .iter()
            .map(|a| {
                let row: Vec<String> = scopes
                    .iter()
                    .flat_map(|ch| [false, true].map(|private| f.roles.channel_permissions(Some(owner), a, ch, private).0.to_string()))
                    .collect();
                (a.clone(), serde_json::json!(row))
            })
            .collect();
        serde_json::json!({
            "overwrites": overwrites,
            "syncs": f.roles.syncs,
            "perms": perms,
            "everyone": f.roles.everyone.map(|b| b.0.to_string()),
            "legacy": f.roles.legacy_channels,
            "roles": roles,
            "grants": grants,
            "banned": f.banned,
            "banned_at": f.banned_at,
            "heads": heads,
            "converged": f.converged,
            "complete": f.complete,
        })
    }

    #[allow(clippy::too_many_arguments)]
    async fn fuzz_publish(relay: &MemoryRelay, community: &CommunityV2, s: &Keys, vsk_code: &str, eid: [u8; 32], version: u64, prev: Option<[u8; 32]>, content: String, marked: bool, at: u64) -> Option<[u8; 32]> {
        let group = control::ControlPlane::of(community).write_group().unwrap();
        let binding = marked.then(|| crate::community::v2::derive::edition_binding(community.id()));
        let cite = cite_on_relay(relay, community, s).await;
        let rumor = control::build_edition_rumor_bound(s.public_key(), vsk_code, &eid, version, prev.as_ref(), &content, at, cite.as_ref(), binding);
        let (wrap, _) = control::seal_control_edition(&rumor, &group, s, Timestamp::from_secs(at)).unwrap();
        relay.publish(&wrap, &community.relays).await.unwrap();
        let id = rumor.id.unwrap().to_bytes();
        fetch_control(relay, community).await.into_iter().find(|e| e.inner_id == id).map(|e| e.self_hash)
    }

    #[tokio::test]
    async fn armada_fixture_roster_fuzz() {
        let Ok(dir) = std::env::var("ARMADA_FIXTURES") else { return };
        let hex = crate::simd::hex::bytes_to_hex_32;
        let cases: u64 = std::env::var("ARMADA_FUZZ_CASES").ok().and_then(|s| s.parse().ok()).unwrap_or(60);
        let mut out = Vec::new();
        let base: u64 = std::env::var("ARMADA_FUZZ_SEED_BASE").ok().and_then(|s| s.parse().ok()).unwrap_or(0);
        for seed in base..base + cases {
            let (_tmp, _guard, owner) = init_test_db();
            let relay = MemoryRelay::new();
            let community = create_community(&relay, "Fuzz", vec!["wss://r".into()], None).await.unwrap();
            let mut rng = Lcg(seed.wrapping_mul(0x9e3779b97f4a7c15) | 1);
            let others = [Keys::generate(), Keys::generate(), Keys::generate()];
            let signer = |rng: &mut Lcg| -> Keys { match rng.below(4) { 0 | 1 => owner.clone(), i => others[(i - 2) as usize].clone() } };
            let roles: Vec<String> = (0..4).map(|i| format!("{:02x}", 0xa0 + i).repeat(32)).collect();
            let ranks = ["1", "5", "9", "F", "K", "a", "m", "z"];
            let scopes: Vec<String> = (0..3).map(|i| format!("{:02x}", 0xc0 + i).repeat(32)).collect();
            let channel_bits = [Permissions::VIEW_CHANNEL, Permissions::SEND_MESSAGES, Permissions::SPEAK, Permissions::MANAGE_MESSAGES, Permissions::BAN];
            let bits = [Permissions::MANAGE_ROLES, Permissions::MANAGE_CHANNELS, Permissions::BAN, Permissions::KICK, Permissions::CREATE_INVITE];
            // eid → the editions published there, as (version, hash).
            let mut chains: std::collections::HashMap<[u8; 32], Vec<(u64, [u8; 32])>> = Default::default();

            // Next link at `eid`: usually on the newest, sometimes a fork sibling of it.
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

            let everyone_eid = crate::community::v2::derive::everyone_locator(community.id());
            let h = fuzz_publish(&relay, &community, &owner, vsk::ROLE_V2, everyone_eid, 1, None, crate::community::v2::roles::everyone_content_json(crate::community::v2::roles::EVERYONE_DEFAULT), true, 1_000).await;
            chains.entry(everyone_eid).or_default().push((1, h.unwrap()));

            // Now and then a long plane, so chains run deep and forks stack.
            let steps = if rng.chance(15) { 30 + rng.below(20) } else { 6 + rng.below(12) };
            let mut at: u64 = 1_000;
            for _ in 0..steps {
                let s = signer(&mut rng);
                // Times move on unevenly and sometimes stand still, so ban marks have something to tell apart.
                at += rng.below(3) * 7;
                let (vsk_code, eid, content, marked): (&'static str, [u8; 32], String, bool) = match rng.below(15) {
                    14 => {
                        // A Channel edition squatting another kind's coordinate: it floors nothing there.
                        let eid = match rng.below(3) {
                            0 => crate::simd::hex::hex_to_bytes_32_checked(&roles[rng.below(4) as usize]).unwrap(),
                            1 => crate::community::v2::derive::grant_locator(community.id(), &others[rng.below(3) as usize].public_key().to_bytes()),
                            _ => {
                                use crate::community::roles::OverwriteTarget;
                                let scope = &scopes[rng.below(3) as usize];
                                let tb = crate::community::v2::roles::overwrite_target_bytes(community.id(), &OverwriteTarget::Everyone).unwrap();
                                crate::community::v2::derive::acl_locator(community.id(), &crate::simd::hex::hex_to_bytes_32_checked(scope).unwrap(), &tb)
                            }
                        };
                        (vsk::CHANNEL_METADATA, eid, r#"{"name":"squat","private":false}"#.to_string(), true)
                    }
                    10 | 11 => {
                        use crate::community::roles::{Overwrite, OverwriteTarget};
                        let scope = scopes[rng.below(3) as usize].clone();
                        let target = match rng.below(3) {
                            0 => OverwriteTarget::Everyone,
                            1 => OverwriteTarget::Role(roles[rng.below(4) as usize].clone()),
                            _ => OverwriteTarget::Member(others[rng.below(3) as usize].public_key().to_hex()),
                        };
                        let (mut allow, mut deny) = (0u64, 0u64);
                        for bit in channel_bits {
                            match rng.below(4) {
                                0 => allow |= bit,
                                1 => deny |= bit,
                                _ => {}
                            }
                        }
                        let tb = crate::community::v2::roles::overwrite_target_bytes(community.id(), &target).unwrap();
                        let eid = crate::community::v2::derive::acl_locator(community.id(), &crate::simd::hex::hex_to_bytes_32_checked(&scope).unwrap(), &tb);
                        let o = Overwrite { scope, target, allow: Permissions(allow), deny: Permissions(deny) };
                        (vsk::CHANNEL_ACL, eid, crate::community::v2::roles::overwrite_content_json(&o), true)
                    }
                    12 => {
                        let ch = scopes[rng.below(2) as usize].clone();
                        let cat = if rng.chance(70) { Some(scopes[2].clone()) } else { None };
                        let id = crate::community::ChannelId(crate::simd::hex::hex_to_bytes_32_checked(&ch).unwrap());
                        (vsk::CHANNEL_SYNC, crate::community::v2::derive::sync_locator(community.id(), &id), crate::community::v2::roles::sync_content_json(&ch, cat.as_deref()), true)
                    }
                    13 => {
                        // An unmarked vsk-13 edit, or a legacy vsk-1 Role: history on Roles v2.
                        let id = &roles[rng.below(4) as usize];
                        if rng.chance(50) {
                            (vsk::ROLE_V2, crate::simd::hex::hex_to_bytes_32_checked(id).unwrap(), crate::community::v2::roles::role_v2_content_json(&role_v2(id, "u", ranks[rng.below(8) as usize], Permissions::BAN)).unwrap(), false)
                        } else {
                            let legacy = Role { role_id: id.clone(), name: "legacy".into(), position: 1 + rng.below(5) as u32, permissions: Permissions(Permissions::MANAGE_ROLES), scope: RoleScope::Server, color: 0, rank: None, display: false, mentionable: false, extra: Default::default() };
                            (vsk::ROLE, crate::simd::hex::hex_to_bytes_32_checked(id).unwrap(), crate::community::v2::roles::role_content_json(&legacy).unwrap(), false)
                        }
                    }
                    0..=2 => {
                        let id = &roles[rng.below(4) as usize];
                        let mut b = 0u64;
                        for bit in bits {
                            if rng.chance(35) {
                                b |= bit;
                            }
                        }
                        let content = if rng.chance(8) {
                            crate::community::v2::roles::role_v2_deleted_json(id)
                        } else {
                            crate::community::v2::roles::role_v2_content_json(&role_v2(id, "r", ranks[rng.below(8) as usize], b)).unwrap()
                        };
                        (vsk::ROLE_V2, crate::simd::hex::hex_to_bytes_32_checked(id).unwrap(), content, true)
                    }
                    3..=5 => {
                        let m = others[rng.below(3) as usize].public_key();
                        let ids: Vec<String> = roles.iter().filter(|_| rng.chance(40)).cloned().collect();
                        let content = crate::community::v2::roles::grant_content_json(&MemberGrant { member: m.to_hex(), role_ids: ids }).unwrap();
                        (vsk::GRANT, crate::community::v2::derive::grant_locator(community.id(), &m.to_bytes()), content, rng.chance(50))
                    }
                    6 => {
                        let b = crate::community::v2::roles::EVERYONE_DEFAULT | if rng.chance(50) { Permissions::CREATE_INVITE } else { 0 };
                        // Sometimes the switch carries the Channels that stood before it (CORD-04 §2).
                        let legacy: Option<std::collections::BTreeSet<String>> = rng.chance(40).then(|| scopes.iter().filter(|_| rng.chance(50)).cloned().collect());
                        (vsk::ROLE_V2, everyone_eid, crate::community::v2::roles::everyone_content_json_with(b, legacy.as_ref()), true)
                    }
                    7 => {
                        let listed: Vec<String> = others.iter().filter(|_| rng.chance(30)).map(|k| k.public_key().to_hex()).collect();
                        (vsk::BANLIST, crate::community::v2::derive::banlist_locator(community.id()), crate::community::v2::roles::banlist_content_json(&listed).unwrap(), rng.chance(50))
                    }
                    _ => {
                        let m = &others[rng.below(3) as usize];
                        let eds = fetch_control(&relay, &community).await;
                        let mine: Vec<String> = eds.iter().filter(|e| e.author == m.public_key() && rng.chance(60)).map(|e| hex(&e.self_hash)).collect();
                        let mut b = 0u64;
                        for bit in bits {
                            if rng.chance(40) {
                                b |= bit;
                            }
                        }
                        let content = crate::community::v2::roles::tenure_content_json(&crate::community::v2::roles::TenureContent {
                            member: m.public_key().to_hex(),
                            sealed: vec![crate::community::v2::roles::TenureEntry { rank: ranks[rng.below(8) as usize].into(), permissions: b, heads: mine }],
                        })
                        .unwrap();
                        (vsk::TENURE, crate::community::v2::derive::tenure_locator(community.id(), &m.public_key().to_bytes(), &s.public_key().to_bytes()), content, true)
                    }
                };
                let (version, prev) = link(&mut rng, &chains, &eid);
                if let Some(h) = fuzz_publish(&relay, &community, &s, vsk_code, eid, version, prev, content, marked, at).await {
                    chains.entry(eid).or_default().push((version, h));
                }
            }

            let eds = fetch_control(&relay, &community).await;
            let owner_hex = owner.public_key().to_hex();
            let mut actors: Vec<String> = others.iter().map(|k| k.public_key().to_hex()).collect();
            actors.push(owner_hex.clone());
            let dump = |f: &AuthoritySet| fuzz_dump_fold(f, &owner_hex, &actors, &scopes);
            let full = fold_authority(&community, &eds, &Floors::default());
            // A tracking reader: it stored what the full fold settled on (the roster, the Banlist).
            let cid_hex = hex(&community.id().0);
            crate::db::community::set_community_roles(&cid_hex, &full.roles, 1).unwrap();
            crate::db::community::set_community_banlist(&cid_hex, &full.banned.iter().cloned().collect::<Vec<_>>(), 1).unwrap();
            let floors: Floors = full
                .heads
                .iter()
                .map(|h| (h.entity_hex.clone(), (h.version, h.self_hash, Some(h.inner_id), Some(h.author), Some(crate::db::community::FloorFamily::of(crate::db::community::FLOOR_AUTHORITY)))))
                .collect();
            let mut slices = vec![serde_json::json!({ "floors": false, "served": eds.iter().map(|e| hex(&e.inner_id)).collect::<Vec<_>>(), "vector": dump(&full) })];
            for k in 0..3 {
                let served: Vec<ParsedEdition> = eds.iter().filter(|_| !rng.chance(25)).cloned().collect();
                // The third holds some floors without their author, as an older stored head does.
                // Always the floors a banned member authored, so a ban meets a floor that names nobody.
                let banned_author = |f: &(u64, [u8; 32], Option<[u8; 32]>, Option<[u8; 32]>, Option<crate::db::community::FloorFamily>)| f.3.is_some_and(|a| full.banned.contains(&hex(&a)));
                let anon: Vec<String> = if k == 2 { floors.iter().filter(|(_, f)| banned_author(f) || rng.chance(40)).map(|(e, _)| e.clone()).collect() } else { Vec::new() };
                let mut slice_floors: Floors = floors.iter().map(|(e, f)| (e.clone(), if anon.contains(e) { (f.0, f.1, f.2, None, f.4) } else { f.clone() })).collect();
                // The second also holds the Control fold's floors for the Channel editions squatting
                // a Roster coordinate: another family's floor, which floors nothing here.
                let mut rows: Option<Vec<serde_json::Value>> = None;
                if k == 1 {
                    for e in eds.iter().filter(|e| e.vsk == vsk::CHANNEL_METADATA) {
                        let eid = hex(&e.entity_id);
                        slice_floors.entry(eid).or_insert((e.version, e.self_hash, Some(e.inner_id), Some(e.author.to_bytes()), Some(crate::db::community::FloorFamily::of(crate::db::community::FLOOR_CONTROL))));
                    }
                    rows = Some(slice_floors.iter().map(|(eid, f)| serde_json::json!({ "eid": eid, "version": f.0, "hash": hex(&f.1), "id": f.2.map(|i| hex(&i)), "author": f.3.map(|a| hex(&a)) })).collect());
                }
                let f = fold_authority(&community, &served, &slice_floors);
                let mut slice = serde_json::json!({ "floors": true, "anon": anon, "served": served.iter().map(|e| hex(&e.inner_id)).collect::<Vec<_>>(), "vector": dump(&f) });
                if let Some(rows) = rows {
                    slice["floor_rows"] = serde_json::json!(rows);
                }
                slices.push(slice);
            }
            // A reader that settled before any Banlist landed, holding older heads without their
            // author recorded where a ban would now name them, then served everything.
            let pre: Vec<ParsedEdition> = eds.iter().filter(|e| e.vsk != vsk::BANLIST).cloned().collect();
            let pre_fold = fold_authority(&community, &pre, &Floors::default());
            let pre_floors: Floors = pre_fold
                .heads
                .iter()
                .map(|h| (h.entity_hex.clone(), (h.version, h.self_hash, Some(h.inner_id), (!full.banned.contains(&hex(&h.author))).then_some(h.author), Some(crate::db::community::FloorFamily::of(crate::db::community::FLOOR_AUTHORITY)))))
                .collect();
            let pre_rows: Vec<serde_json::Value> = pre_fold
                .heads
                .iter()
                .map(|h| serde_json::json!({ "eid": h.entity_hex, "version": h.version, "hash": hex(&h.self_hash), "id": hex(&h.inner_id), "author": (!full.banned.contains(&hex(&h.author))).then(|| hex(&h.author)) }))
                .collect();
            let f = fold_authority(&community, &eds, &pre_floors);
            slices.push(serde_json::json!({ "floors": true, "floor_rows": pre_rows, "served": eds.iter().map(|e| hex(&e.inner_id)).collect::<Vec<_>>(), "vector": dump(&f) }));
            let floor_rows: Vec<serde_json::Value> = full.heads.iter().map(|h| serde_json::json!({ "eid": h.entity_hex, "version": h.version, "hash": hex(&h.self_hash), "id": hex(&h.inner_id), "author": hex(&h.author) })).collect();
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
                "scopes": scopes,
                "actors": actors,
                "events": wraps,
                "floors": floor_rows,
                "slices": slices,
            }));
        }
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(format!("{dir}/roster_fuzz.json"), serde_json::to_string(&out).unwrap()).unwrap();
    }
