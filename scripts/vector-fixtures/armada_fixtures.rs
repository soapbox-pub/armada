
    // ── Armada conformance fixtures (local only) ──────────────────────────────
    // Writes $ARMADA_FIXTURES/<name>.json: every event on the relay, the keys a
    // member holds, and what Vector folds, so Armada's fold can be checked against it.

    async fn armada_dump(name: &str, relay: &MemoryRelay, community: &CommunityV2, members: &[(&str, &Keys)]) {
        let Ok(dir) = std::env::var("ARMADA_FIXTURES") else { return };
        let hex = crate::simd::hex::bytes_to_hex_32;
        let events = relay.fetch(&Query::default(), &community.relays).await.unwrap();
        let editions = fetch_control(relay, community).await;
        let authority = fold_authority(community, &editions, &Floors::default());
        let held = crate::db::community::load_community_v2(community.id()).unwrap().unwrap();
        let channels: Vec<serde_json::Value> = held
            .channels
            .iter()
            .map(|c| {
                serde_json::json!({
                    "id": hex(&c.id.0),
                    "name": c.name,
                    "private": c.private,
                    "key": c.key.map(|k| hex(&k)),
                    "epoch": c.epoch.0,
                    "extra": c.meta_extra,
                    "custom": c.meta_custom,
                    "writers": c.writers.as_ref().map(|w| format!("{w:?}")),
                })
            })
            .collect();
        let categories: Vec<serde_json::Value> = held
            .categories
            .iter()
            .map(|c| serde_json::json!({ "id": hex(&c.id), "name": c.name, "position": c.position }))
            .collect();
        let owner_hex = held.owner().unwrap().to_hex();
        let effective: serde_json::Map<String, serde_json::Value> = members
            .iter()
            .map(|(label, k)| {
                let pk = k.public_key().to_hex();
                let per_channel: serde_json::Map<String, serde_json::Value> = held
                    .channels
                    .iter()
                    .map(|c| (hex(&c.id.0), serde_json::json!(authority.roles.channel_permissions(Some(&owner_hex), &pk, &hex(&c.id.0), c.private).0.to_string())))
                    .collect();
                (label.to_string(), serde_json::json!({ "pubkey": pk, "server": authority.roles.effective_permissions(&pk).0.to_string(), "channels": per_channel }))
            })
            .collect();
        let doc = serde_json::json!({
            "community": {
                "id": hex(&held.id().0),
                "owner": owner_hex,
                "owner_salt": hex(&held.identity.owner_salt),
                "root": hex(&held.community_root),
                "root_epoch": held.root_epoch.0,
                "control_pk": held.control_pk.map(|p| p.to_hex()),
                "relays": held.relays,
            },
            "events": events,
            "vector": {
                "activated": authority.roles.everyone.is_some(),
                "roles": authority.roles,
                "banned": authority.banned,
                "converged": authority.converged,
                "name": held.name,
                "channels": channels,
                "categories": categories,
                "members": effective,
            },
        });
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(format!("{dir}/{name}.json"), serde_json::to_string_pretty(&doc).unwrap()).unwrap();
    }

    #[tokio::test]
    async fn armada_fixture_guild() {
        let (_tmp, _guard, owner) = init_test_db();
        let relay = MemoryRelay::new();
        let relays = vec!["wss://r".to_string()];
        let community = create_community_on_roles_v2(&relay, "Guild", relays.clone(), None).await.unwrap();
        let held = || crate::db::community::load_community_v2(community.id()).unwrap().unwrap();
        follow_control(&relay, &held()).await.unwrap();

        let admin = create_role_v2(&relay, &held(), "Admin", 0xe74c3c, Permissions::MANAGE_ROLES | Permissions::MANAGE_CHANNELS | Permissions::BAN | Permissions::KICK | Permissions::MANAGE_MESSAGES).await.unwrap();
        follow_control(&relay, &held()).await.unwrap();
        let mods = create_role_v2(&relay, &held(), "Mods", 0x3498db, Permissions::KICK | Permissions::MANAGE_MESSAGES | Permissions::MODERATE_MEMBERS).await.unwrap();
        follow_control(&relay, &held()).await.unwrap();
        let vip = create_role_v2(&relay, &held(), "VIP", 0, 0).await.unwrap();
        follow_control(&relay, &held()).await.unwrap();

        let alice = Keys::generate();
        let bob = Keys::generate();
        let carol = Keys::generate();
        set_member_roles(&relay, &held(), &alice.public_key(), vec![admin.clone()]).await.unwrap();
        follow_control(&relay, &held()).await.unwrap();
        set_member_roles(&relay, &held(), &bob.public_key(), vec![mods.clone()]).await.unwrap();
        follow_control(&relay, &held()).await.unwrap();
        set_member_roles(&relay, &held(), &carol.public_key(), vec![vip.clone()]).await.unwrap();
        follow_control(&relay, &held()).await.unwrap();

        let staff = create_category(&relay, &held(), "Staff").await.unwrap();
        follow_control(&relay, &held()).await.unwrap();
        let lounge = create_category(&relay, &held(), "Lounge").await.unwrap();
        follow_control(&relay, &held()).await.unwrap();
        set_overwrite(&relay, &held(), staff, crate::community::roles::OverwriteTarget::Everyone, 0, Permissions::VIEW_CHANNEL).await.unwrap();
        follow_control(&relay, &held()).await.unwrap();
        set_overwrite(&relay, &held(), staff, crate::community::roles::OverwriteTarget::Role(mods.clone()), Permissions::VIEW_CHANNEL, 0).await.unwrap();
        follow_control(&relay, &held()).await.unwrap();
        let staff_chat = create_channel_in(&relay, &held(), "staff-chat", false, Some(staff)).await.unwrap();
        follow_control(&relay, &held()).await.unwrap();
        let offtopic = create_channel_in(&relay, &held(), "off-topic", false, Some(lounge)).await.unwrap();
        follow_control(&relay, &held()).await.unwrap();
        edit_channel_details(&relay, &held(), &offtopic, "off-topic", Some("Anything goes"), crate::community::v2::community::ChannelView::Chat).await.unwrap();
        follow_control(&relay, &held()).await.unwrap();
        let hangout = create_channel_in(&relay, &held(), "hangout", false, Some(lounge)).await.unwrap();
        follow_control(&relay, &held()).await.unwrap();
        edit_channel_details(&relay, &held(), &hangout, "hangout", None, crate::community::v2::community::ChannelView::Voice).await.unwrap();
        follow_control(&relay, &held()).await.unwrap();
        let vip_room = create_private_channel(&relay, &held(), "vip-room").await.unwrap();
        follow_control(&relay, &held()).await.unwrap();
        set_overwrite(&relay, &held(), vip_room.0, crate::community::roles::OverwriteTarget::Role(vip.clone()), Permissions::VIEW_CHANNEL, 0).await.unwrap();
        follow_control(&relay, &held()).await.unwrap();
        let _ = staff_chat;

        armada_dump(
            "guild",
            &relay,
            &held(),
            &[("owner", &owner), ("alice", &alice), ("bob", &bob), ("carol", &carol), ("stranger", &Keys::generate())],
        )
        .await;
    }
