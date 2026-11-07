
    // ── Armada conformance fixtures (local only) ──────────────────────────────
    // Writes $ARMADA_FIXTURES/<name>.json: every event on the relay, the keys a
    // member holds, and what Vector folds, so Armada's fold can be checked against it.

    async fn armada_dump(name: &str, relay: &MemoryRelay, community: &CommunityV2, members: &[(&str, &Keys)]) {
        let Ok(dir) = std::env::var("ARMADA_FIXTURES") else { return };
        let hex = crate::simd::hex::bytes_to_hex_32;
        let events = relay.fetch(&Query::default(), &community.relays).await.unwrap();
        let plane = control::ControlPlane::of(community);
        let editions: Vec<ParsedEdition> = events.iter().filter(|w| w.pubkey == plane.pk()).filter_map(|w| plane.open_edition(w).ok()).collect();
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

    /// A Community made on the legacy Roster, as Armada made them, then moved to ranked roles
    /// and edited in Vector: a Category, a voice Channel in it, and a text Channel.
    #[tokio::test]
    async fn armada_fixture_switched() {
        let (_tmp, _guard, owner) = init_test_db();
        let relay = MemoryRelay::new();
        let relays = vec!["wss://r".to_string()];
        let community = create_community(&relay, "Switched", relays.clone(), None).await.unwrap();
        let held = || crate::db::community::load_community_v2(community.id()).unwrap().unwrap();
        follow_control(&relay, &held()).await.unwrap();
        let _news = create_public_channel(&relay, &held(), "news").await.unwrap();
        follow_control(&relay, &held()).await.unwrap();
        let _staff = create_private_channel(&relay, &held(), "staff").await.unwrap();
        follow_control(&relay, &held()).await.unwrap();

        activate_roles_v2(&relay, &held(), crate::community::v2::roles::EVERYONE_DEFAULT).await.unwrap();
        follow_control(&relay, &held()).await.unwrap();

        let voice = create_category(&relay, &held(), "Voice").await.unwrap();
        follow_control(&relay, &held()).await.unwrap();
        let hangout = create_channel_in(&relay, &held(), "hangout", false, Some(voice)).await.unwrap();
        follow_control(&relay, &held()).await.unwrap();
        edit_channel_details(&relay, &held(), &hangout, "hangout", None, crate::community::v2::community::ChannelView::Voice).await.unwrap();
        follow_control(&relay, &held()).await.unwrap();
        let _chat = create_channel_in(&relay, &held(), "after-switch", false, None).await.unwrap();
        follow_control(&relay, &held()).await.unwrap();

        armada_dump("switched", &relay, &held(), &[("owner", &owner), ("stranger", &Keys::generate())]).await;
    }

    /// A Community refounded in Vector (as making it Private does, CORD-06 §3), with a voice
    /// Channel and a text Channel made after: dumped with the owner's key and the epoch-0
    /// material a device that missed the Refounding still holds.
    #[tokio::test]
    async fn armada_fixture_refounded() {
        let (_tmp, _guard, owner) = init_test_db();
        let relay = MemoryRelay::new();
        let relays = vec!["wss://r".to_string()];
        let community = create_community_on_roles_v2(&relay, "Refounded", relays.clone(), None).await.unwrap();
        let held = || crate::db::community::load_community_v2(community.id()).unwrap().unwrap();
        follow_control(&relay, &held()).await.unwrap();
        let _before = create_public_channel(&relay, &held(), "before").await.unwrap();
        follow_control(&relay, &held()).await.unwrap();
        let epoch0 = held();

        refound_community(&relay, &held(), &[]).await.unwrap();
        follow_control(&relay, &held()).await.unwrap();

        let voice = create_category(&relay, &held(), "Voice").await.unwrap();
        follow_control(&relay, &held()).await.unwrap();
        let hangout = create_channel_in(&relay, &held(), "hangout", false, Some(voice)).await.unwrap();
        follow_control(&relay, &held()).await.unwrap();
        edit_channel_details(&relay, &held(), &hangout, "hangout", None, crate::community::v2::community::ChannelView::Voice).await.unwrap();
        follow_control(&relay, &held()).await.unwrap();
        let _after = create_channel_in(&relay, &held(), "after", false, None).await.unwrap();
        follow_control(&relay, &held()).await.unwrap();

        armada_dump("refounded", &relay, &held(), &[("owner", &owner)]).await;
        if let Ok(dir) = std::env::var("ARMADA_FIXTURES") {
            let hex = crate::simd::hex::bytes_to_hex_32;
            let extra = serde_json::json!({
                "owner_sk": owner.secret_key().to_secret_hex(),
                "epoch0": { "root": hex(&epoch0.community_root), "root_epoch": epoch0.root_epoch.0, "control_pk": epoch0.control_pk.map(|p| p.to_hex()) },
            });
            std::fs::write(format!("{dir}/refounded.extra.json"), serde_json::to_string_pretty(&extra).unwrap()).unwrap();
        }
    }

    /// Kobold's history as its owner made it: a legacy Community, switched in Vector, its
    /// public Channels made private and a private voice Channel added, then the owner's
    /// Community List republished. Dumped with the owner's key, so Armada can rebuild what
    /// the owner's other device holds from that List alone.
    #[tokio::test]
    async fn armada_fixture_owner_list() {
        let (_tmp, _guard, owner) = init_test_db();
        let relay = MemoryRelay::new();
        let relays = vec!["wss://r".to_string()];
        let community = create_community(&relay, "Owner", relays.clone(), None).await.unwrap();
        let held = || crate::db::community::load_community_v2(community.id()).unwrap().unwrap();
        follow_control(&relay, &held()).await.unwrap();
        let support = create_public_channel(&relay, &held(), "support").await.unwrap();
        follow_control(&relay, &held()).await.unwrap();
        activate_roles_v2(&relay, &held(), crate::community::v2::roles::EVERYONE_DEFAULT).await.unwrap();
        follow_control(&relay, &held()).await.unwrap();
        let general = held().channels[0].id;
        privatize_channel(&relay, &held(), &general).await.unwrap();
        follow_control(&relay, &held()).await.unwrap();
        privatize_channel(&relay, &held(), &support).await.unwrap();
        follow_control(&relay, &held()).await.unwrap();
        let voice = create_channel_in(&relay, &held(), "Voice Chat", true, None).await.unwrap();
        follow_control(&relay, &held()).await.unwrap();
        edit_channel_details(&relay, &held(), &voice, "Voice Chat", None, crate::community::v2::community::ChannelView::Voice).await.unwrap();
        follow_control(&relay, &held()).await.unwrap();
        republish_community_list(&relay, Some(community.id())).await.unwrap();

        armada_dump("owner_list", &relay, &held(), &[("owner", &owner)]).await;
        if let Ok(dir) = std::env::var("ARMADA_FIXTURES") {
            let extra = serde_json::json!({ "owner_sk": owner.secret_key().to_secret_hex() });
            std::fs::write(format!("{dir}/owner_list.extra.json"), serde_json::to_string_pretty(&extra).unwrap()).unwrap();
        }
    }

    /// Two accounts: the owner, and a member who joins by Direct Invite and is then let into a
    /// Private Channel by a Role, takes a Nickname, is timed out, and posts. Dumped as the member
    /// holds it: their keys, after every delivery they could adopt.
    #[tokio::test]
    async fn armada_fixture_members() {
        let (bed, owner, member) = TestBed::new();
        bed.swap_to(&owner);
        let community = create_community_on_roles_v2(&bed.relay, "Members", bed.relays.clone(), None).await.unwrap();
        let held = || crate::db::community::load_community_v2(community.id()).unwrap().unwrap();
        follow_control(&bed.relay, &held()).await.unwrap();
        let general = held().channels[0].id;
        send_direct_invite(&bed.relay, &held(), &member.keys.public_key(), None, None).await.unwrap();

        bed.swap_to(&member);
        let invite = fetch_direct_invite(&bed.relay, &bed.relays, &member.keys.public_key()).await;
        let joined = accept_direct_invite(&bed.relay, &invite).await.unwrap();
        follow_control(&bed.relay, &joined).await.unwrap();

        bed.swap_to(&owner);
        follow_control(&bed.relay, &held()).await.unwrap();
        let vip = create_role_v2(&bed.relay, &held(), "VIP", 0x00ff00, 0).await.unwrap();
        follow_control(&bed.relay, &held()).await.unwrap();
        let lounge = create_private_channel(&bed.relay, &held(), "vip-lounge").await.unwrap();
        follow_control(&bed.relay, &held()).await.unwrap();
        set_overwrite(&bed.relay, &held(), lounge.0, crate::community::roles::OverwriteTarget::Role(vip.clone()), Permissions::VIEW_CHANNEL, 0).await.unwrap();
        follow_control(&bed.relay, &held()).await.unwrap();
        set_member_roles(&bed.relay, &held(), &member.keys.public_key(), vec![vip.clone()]).await.unwrap();
        follow_control(&bed.relay, &held()).await.unwrap();
        let _ = access_duty(&bed.relay, &held()).await;
        let announcements = create_public_channel(&bed.relay, &held(), "announcements").await.unwrap();
        follow_control(&bed.relay, &held()).await.unwrap();
        set_overwrite(&bed.relay, &held(), announcements.0, crate::community::roles::OverwriteTarget::Everyone, 0, Permissions::SEND_MESSAGES).await.unwrap();
        follow_control(&bed.relay, &held()).await.unwrap();
        send_message(&bed.relay, &held(), &announcements, "welcome, read the rules").await.unwrap();
        send_message(&bed.relay, &held(), &lounge, "the VIP lounge is open").await.unwrap();
        set_nickname(&bed.relay, &held(), &owner.keys.public_key(), "The Boss").await.unwrap();
        timeout_member(&bed.relay, &held(), &member.keys.public_key(), 3600).await.unwrap();

        bed.swap_to(&member);
        let mine = || crate::db::community::load_community_v2(community.id()).unwrap().unwrap();
        follow_control(&bed.relay, &mine()).await.unwrap();
        let collected = collect_access(&bed.relay, &mine()).await.unwrap();
        assert_eq!(collected, 1, "the member collects the lounge's key");
        absorb_parked_channel_keys(&mine(), &crate::db::current_session());
        follow_control(&bed.relay, &mine()).await.unwrap();
        set_nickname(&bed.relay, &mine(), &member.keys.public_key(), "Newbie").await.unwrap();
        send_message(&bed.relay, &mine(), &general, "hi all").await.unwrap();

        armada_dump(
            "members",
            &bed.relay,
            &mine(),
            &[("owner", &owner.keys), ("member", &member.keys)],
        )
        .await;
        if let Ok(dir) = std::env::var("ARMADA_FIXTURES") {
            let extra = serde_json::json!({ "member_secret": member.keys.secret_key().to_secret_hex(), "member": member.keys.public_key().to_hex(), "owner": owner.keys.public_key().to_hex(), "general": crate::simd::hex::bytes_to_hex_32(&general.0), "announcements": crate::simd::hex::bytes_to_hex_32(&announcements.0), "lounge": crate::simd::hex::bytes_to_hex_32(&lounge.0) });
            std::fs::write(format!("{dir}/members.actors.json"), serde_json::to_string_pretty(&extra).unwrap()).unwrap();
        }
    }

    #[tokio::test]
    async fn armada_fixture_writers() {
        use crate::community::roles::OverwriteTarget;
        let (bed, owner, member, community, general) = restricted_bed(false).await;
        let held = || crate::db::community::load_community_v2(community.id()).unwrap().unwrap();
        bed.swap_to(&owner);
        send_message(&bed.relay, &held(), &general, "read the rules").await.unwrap();
        set_overwrite(&bed.relay, &held(), general.0, OverwriteTarget::Member(member.keys.public_key().to_hex()), Permissions::SEND_MESSAGES, 0).await.unwrap();
        bed.swap_to(&member);
        follow_control(&bed.relay, &held()).await.unwrap();
        assert_eq!(collect_writers(&bed.relay, &held()).await.unwrap(), 1, "the member collects the live writer key");
        assert!(can_post(&held(), &general));
        send_message(&bed.relay, &held(), &general, "a writer's post").await.unwrap();
        let ch = held().channel(&general).unwrap().clone();
        let (epoch, secret, _) = writing::live_writer(&held(), &ch).unwrap();
        let cert = writing::my_cert(&held(), &ch, epoch).unwrap();

        armada_dump("writers", &bed.relay, &held(), &[("owner", &owner.keys), ("member", &member.keys)]).await;
        if let Ok(dir) = std::env::var("ARMADA_FIXTURES") {
            let extra = serde_json::json!({
                "member_secret": member.keys.secret_key().to_secret_hex(),
                "member": member.keys.public_key().to_hex(),
                "owner": owner.keys.public_key().to_hex(),
                "general": crate::simd::hex::bytes_to_hex_32(&general.0),
                "writer_epoch": epoch.0,
                "writer_secret": crate::simd::hex::bytes_to_hex_32(&secret),
                "writer_cert": crate::simd::hex::bytes_to_hex_string(&cert),
            });
            std::fs::write(format!("{dir}/writers.actors.json"), serde_json::to_string_pretty(&extra).unwrap()).unwrap();
        }
    }

    #[tokio::test]
    async fn armada_fixture_history() {
        let (bed, owner, _x, community) = v2_bed_with_admin("History").await;
        let held = || crate::db::community::load_community_v2(community.id()).unwrap().unwrap();
        let ch = create_private_channel(&bed.relay, &held(), "inner").await.unwrap();
        let chan = crate::simd::hex::bytes_to_hex_32(&ch.0);
        let cid_hex = crate::simd::hex::bytes_to_hex_32(&community.id().0);
        send_chat_message(&bed.relay, &held(), &ch, "early", None, &[], vec![]).await.unwrap();
        let first = held().channel(&ch).unwrap().epoch;
        rekey_channel_excluding(&bed.relay, &held(), &ch, &crate::db::community::get_community_roles(&cid_hex).unwrap(), &[], &[]).await.unwrap();
        send_chat_message(&bed.relay, &held(), &ch, "later", None, &[], vec![]).await.unwrap();
        let now = held().channel(&ch).unwrap().epoch;
        // Two readers let in after the rotation; one is denied history in this channel.
        let readers = create_role_v2(&bed.relay, &held(), "Readers", 0, 0).await.unwrap();
        set_overwrite(&bed.relay, &held(), ch.0, crate::community::roles::OverwriteTarget::Role(readers.clone()), Permissions::VIEW_CHANNEL, 0).await.unwrap();
        let (m, n) = (Keys::generate(), Keys::generate());
        set_member_roles(&bed.relay, &held(), &m.public_key(), vec![readers.clone()]).await.unwrap();
        set_member_roles(&bed.relay, &held(), &n.public_key(), vec![readers]).await.unwrap();
        set_overwrite(&bed.relay, &held(), ch.0, crate::community::roles::OverwriteTarget::Member(n.public_key().to_hex()), 0, Permissions::READ_MESSAGE_HISTORY).await.unwrap();
        follow_control(&bed.relay, &held()).await.unwrap();
        let before: Vec<String> = bed.relay.fetch(&Query::default(), &held().relays).await.unwrap().iter().map(|e| e.id.to_hex()).collect();
        let mut keys: Vec<serde_json::Value> = crate::db::community::held_epoch_keys(&cid_hex, &chan).unwrap().into_iter().map(|(e, k)| serde_json::json!({ "epoch": e.0, "key": crate::simd::hex::bytes_to_hex_32(&k) })).collect();
        keys.push(serde_json::json!({ "epoch": now.0, "key": crate::simd::hex::bytes_to_hex_32(&held().channel(&ch).unwrap().key.unwrap()) }));
        let done = access_duty(&bed.relay, &held()).await.unwrap();
        assert_eq!(done.delivered, 2, "the reader by delivery, the one denied history by a fresh epoch");
        let rotated = held().channel(&ch).unwrap().epoch;
        assert!(rotated > now);

        armada_dump("history", &bed.relay, &held(), &[("owner", &owner.keys)]).await;
        if let Ok(dir) = std::env::var("ARMADA_FIXTURES") {
            let extra = serde_json::json!({
                "owner": owner.keys.public_key().to_hex(),
                "owner_secret": owner.keys.secret_key().to_secret_hex(),
                "reader": m.public_key().to_hex(),
                "reader_secret": m.secret_key().to_secret_hex(),
                "denied": n.public_key().to_hex(),
                "denied_secret": n.secret_key().to_secret_hex(),
                "channel": chan,
                "first_epoch": first.0,
                "epoch_before_duty": now.0,
                "epoch_after_duty": rotated.0,
                "owner_keys_before_duty": keys,
                "events_before_duty": before,
            });
            std::fs::write(format!("{dir}/history.actors.json"), serde_json::to_string_pretty(&extra).unwrap()).unwrap();
        }
    }

    async fn fixture_event_ids(relay: &MemoryRelay, c: &CommunityV2) -> Vec<String> {
        relay.fetch(&Query::default(), &c.relays).await.unwrap().iter().map(|e| e.id.to_hex()).collect()
    }

    #[tokio::test]
    async fn armada_fixture_writer_duty() {
        use crate::community::roles::OverwriteTarget;
        let (bed, owner, member) = TestBed::new();
        let held = |c: &CommunityV2| crate::db::community::load_community_v2(c.id()).unwrap().unwrap();
        bed.swap_to(&owner);
        let community = create_community(&bed.relay, "Duty", bed.relays.clone(), None).await.unwrap();
        activate_roles_v2(&bed.relay, &community, crate::community::v2::roles::EVERYONE_DEFAULT).await.unwrap();
        follow_control(&bed.relay, &community).await.unwrap();
        let general = community.channels[0].id;
        let role = create_role_v2(&bed.relay, &held(&community), "Member", 0, 0).await.unwrap();
        set_member_roles(&bed.relay, &held(&community), &member.keys.public_key(), vec![role]).await.unwrap();
        send_direct_invite(&bed.relay, &held(&community), &member.keys.public_key(), None, None).await.unwrap();
        bed.swap_to(&member);
        accept_direct_invite(&bed.relay, &fetch_direct_invite(&bed.relay, &bed.relays, &member.keys.public_key()).await).await.unwrap();
        follow_control(&bed.relay, &held(&community)).await.unwrap();
        bed.swap_to(&owner);
        follow_control(&bed.relay, &held(&community)).await.unwrap();
        sync_guestbook(&bed.relay, &held(&community)).await.unwrap();
        let before_restrict = fixture_event_ids(&bed.relay, &held(&community)).await;
        // The restrict mints writer epoch 1: only the owner may post, so only the owner is served.
        set_overwrite(&bed.relay, &held(&community), general.0, OverwriteTarget::Everyone, 0, Permissions::SEND_MESSAGES).await.unwrap();
        follow_control(&bed.relay, &held(&community)).await.unwrap();
        let ch = held(&community).channel(&general).unwrap().clone();
        let (epoch, secret, _) = writing::live_writer(&held(&community), &ch).unwrap();
        let certifier = writing::certifier_held(&held(&community), &ch, epoch).unwrap();
        // Overwrite events only, so the delivery to the member is what follows.
        let before_grant = fixture_event_ids(&bed.relay, &held(&community)).await;
        set_overwrite(&bed.relay, &held(&community), general.0, OverwriteTarget::Member(member.keys.public_key().to_hex()), Permissions::SEND_MESSAGES, 0).await.unwrap();
        follow_control(&bed.relay, &held(&community)).await.unwrap();
        let after_grant = fixture_event_ids(&bed.relay, &held(&community)).await;
        // The member lost Send again: a single writer is stopped on the ledger.
        set_overwrite(&bed.relay, &held(&community), general.0, OverwriteTarget::Member(member.keys.public_key().to_hex()), 0, 0).await.unwrap();
        follow_control(&bed.relay, &held(&community)).await.unwrap();
        let after_lose = fixture_event_ids(&bed.relay, &held(&community)).await;
        // Reopened to everyone: the ledger opens.
        set_overwrite(&bed.relay, &held(&community), general.0, OverwriteTarget::Everyone, 0, 0).await.unwrap();
        follow_control(&bed.relay, &held(&community)).await.unwrap();

        armada_dump("writer_duty", &bed.relay, &held(&community), &[("owner", &owner.keys), ("member", &member.keys)]).await;
        if let Ok(dir) = std::env::var("ARMADA_FIXTURES") {
            let extra = serde_json::json!({
                "owner": owner.keys.public_key().to_hex(),
                "owner_secret": owner.keys.secret_key().to_secret_hex(),
                "member": member.keys.public_key().to_hex(),
                "member_secret": member.keys.secret_key().to_secret_hex(),
                "general": crate::simd::hex::bytes_to_hex_32(&general.0),
                "writer_epoch": epoch.0,
                "writer_secret": crate::simd::hex::bytes_to_hex_32(&secret),
                "certifier_secret": crate::simd::hex::bytes_to_hex_32(&certifier),
                "before_restrict": before_restrict,
                "before_grant": before_grant,
                "after_grant": after_grant,
                "after_lose": after_lose,
            });
            std::fs::write(format!("{dir}/writer_duty.actors.json"), serde_json::to_string_pretty(&extra).unwrap()).unwrap();
        }
    }
