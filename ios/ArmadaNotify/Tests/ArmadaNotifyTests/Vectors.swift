import XCTest

@testable import ArmadaNotify

/// Vectors generated with the EXACT libraries the web client uses —
/// nostr-tools' `nip44`/`pure` over `@noble` — so these pin wire compatibility
/// with the app rather than merely with this file's own idea of NIP-44. The
/// generator lives in the commit message for this suite; regenerate it the same
/// way if a vector ever has to change, and treat a change that is not explained
/// by a protocol change as a bug here rather than a stale expectation.
let vectorsJson = #"""
{"concordWepoch":{"streamPk":"ea30e481fab3a05021e6b6af31de31d8be7d3e85eb2a47ea23c460056b71c060","convKey":"d1694f2dcef2e07d3b5d1e247542637214b79b3acfe37daffc4b959d5a8b4a19","epoch":"4","channelId":"abababababababababababababababababababababababababababababababab","plain":{"kind":1059,"content":"Ak5tZMS5/b0ISkJ2dX9kNnYwwMKm5bDjFM2FNPsJeyCebbOk1OQaBv+H1FVtH0hrseA1NCdDif7Vct3XE5ZUHltxTwmg/Sv0FbElnowqnARRp7gltiHrQayf8jVs+O4eccXff79iK6CgO901D47vwmxljP6DwZAN0RyfLXVXt8b1pLrJPSXsVNSbm5lPIquSm6hh50mpXlN3Zk4z6RrOZpkFOpxoh7liWziMb6PjRXEEaFGWC9gQ8T8IW9UTO6Dh1LSLUnQqbNgPJFDOmW9lakcCcdXaxJ5Xx60QgXhSuOMSu0nTopgjKq7j9K0GQx8yVve/yA1URgX4pILW/vddyNyxxsPYf50H50lAMh71Dw4S0xliPvgWpgJxOTSahu1CaB2smW4lOQCKuVpP4uDY7AxUr5KBxDEDsS+KXE7SiB04emoqfGrCUnT8fKDpbCfwzuhiPhPjEQ8elCxJoe68Cmy8B6+poQejLpIkWc7Ns0MkBassazMCGJafItBa/NE1LDK1hdV1nCiAAJr9niyfXFY3kQ+xh95znkhQRTXeVI61BiLkOoI/rRwxP7sbVTkEpjZZoaBKq/yEXXFROxh7a1YpUmYLfyR5NYk3quzzaDBbm5EMKRxYw3HPR3Gh6mRTnIyWFCkMT21OpWKfvkm5+CXqA9PSIkNDOPkvpsR5755fBk6TtJbSsJ0aj+BN0oZGwKQgRv5T4QeaKrtnAXgmWMQR5x+gBq8scNvjrBwnIkLog5X/CNYuYb2LH0S+XPEFGiVNwGgVld1OdqxnUqEVogzOpWYeSUKE5erc9b6Fr20ovYrCxWwBj+sRGkmZ7q/LeijQm7+csukDQXCKMGamP3meJyol4jfz41nYldDNGwBaVHvhopHMQ2c5E3gbE/FJYArXQfjskv1K2dtYlfzLVn0Z/3vFGM01tCs5vYOV/JAYla8uaelSohVQHxsN0oI+ZBZyWBSul25bt0PzpYyO7sCUXvaDTZwofGvUt9wZ2oQac9UWDsglgjLwscqV9NRRr10oehwJJ73XKbtGjeQlWdSx93BumXJRjfwQF4ZH7iXJwOjiE8sF+arDvAOlvLQOTrByo+ZGoTsuQoTMljEHQnCw88abtN3Fz1lsKaDkK4j1hRClSqLVt6oqg7yWAkfP5c/4Es9aL59WHvugwMqNnjykxJ7aP+sQYcZMqtywbscAlZUhLeyQLlQkSKz0V7RtI8gd7PoFBoiq8j5olL/sfUYztaebvyoWz3OTFtW/T0VNgaYBXs9tz3B6d9UA7reZzk/m","tags":[["p","237f78168f2537daeda920d70f79606bf721cc611d7baf50f81f3225e4c328ba"]],"created_at":1750000000,"pubkey":"ea30e481fab3a05021e6b6af31de31d8be7d3e85eb2a47ea23c460056b71c060","id":"17cab6f6d70c03c1cfb66daab003e4af0762592841d981726064b74bfaf0f10c","sig":"e23a1c6559eb65949269aa84f1a6e68559f4148689eed9dde8fb55f63df2faccf9d37dd23f0d6bda99c91e9762b9885da4b94e86284db4f9ab7062afc3796b9b"},"forged":{"kind":1059,"content":"AlqAS888R0Uuyt4KtOdgDDlUOkOLtUvgzl4vKT3UtxzDOh4Gyf56WxzwgDQR5aP2zr59uYk/M3C4jo2GoPxhyX9y87K4RnNy8Zx7Z/OrlI2IAL9keKR/+TKF/a2rPIEtlbSxMGoz0YgfgNrwzsylaXbNZL81KIIREJBcH2RANpv7gzI9swCCEEEDiHxG3Nab+BuhH30JCQnXOsgO12XdinQUHLo1pOYXdBpk96A/haIJDYQ88Wgc2aqYhzrZGXgIY8amUG/P6EuvFvyf5pIKVFkpX9aswQv1pSNmzKd4VmTNj6s+4bgduspVsO7MgOz4/npi9toY2vBmgpIxg46U2xhJ0kajSbQUTAzCiqUWfnZpVgXckN3FKGkSTxVv+zRZpVC9Va+EYQkyUwSmH8NpGp4fGtSHKaLBvZMddkJfXFH48EclC1mwDcACsu4UUiiOpIvyEP7uAo1xOcOcvOvh98kjbz3iJLTgY/+vKuctmTV9esUNQjia3z0K7h29ajO1vCP8XNn0ceNyY9AgFmIDHnI47Sj1S086bpM5IeM34JaWmIZAI8b+ShAYTqhBq46IslcmC35OccyKfqQlNXy+0gPQRJDq04J36qdLbKa5C2fB/9OnInuOFO+UkRwzjEpD/CRzXlgBxabjN5CKquJrVP8Knym6sXG/fn7SJP+U3U+uQiM7iAU7KWKyaA2YHUrlMnYe/eJv6HezGmaLvmKVigIX3p9mbKH3qLTwPe4F3opkQDlGS12YG7Ncnixja75qYnlMSxZsqSWYeoEzn6oXxbs/1EnOs7DTcydL0aQe7fKN9qQvufwWFcFITqyhzy5E3WiDpZCvwmo5jW4Idw2aPIbYh85gIrNHkiZC8RsDFXQxfAJ0lIN0HMjJhT04jNDfNi/fOyLkEiUTOhm6dxfPizKV3ruZFjQCGqh9m8z/iYSmf8abtp4k8DUg5SuSqt7h4URjmaq8NQQZuvNhF/8S/z3kTFJishdu/5SjJ1QVKHv5DKW4sp9lYXtVGK+Pk1yQNlMBRs8sWaEpYPDnaf1h/jihdS61S/wpiuSN2N13+X8lAbgHUpR2UX5erGMn6YfZCw6xI2YnNPDHz2uMJ6V0kh+NgeL0CL6lz3l3M8E1gqtMRtMRf+q//D7IQ/m/u+YUbPONMQOiKWJgoM+fCTTU7r2/ZRq7+p/DRRYBfBqv+OQxXqIV2LMhJshHOo0Kd6BeFRqfKuCvQeRsX0VQYcYmTJ1EqjS66uNHFF5GoM89g2YilB26NZt+DFxvhYYFXeLcvlOwPJxduJusyrfDEVttqCosSj1WFt69p3aU7e3ywHz+TQPDJN8/8GiaUE2PJpv6v+DETuvhNm9KyYEpivLGWVSeI+md+XweMTx6q/AyyQkx3vyECJr9imUf7WzhgKImQ5GznF10dJ6OnBSd0qY/h7aWxH9SWnhXlvNr0Q6boJxG3dQ=","tags":[["p","4c77612d160e449f214fa90b47983e07f223ded9320db9fe99762847f0f13f4f"]],"created_at":1750000000,"pubkey":"ea30e481fab3a05021e6b6af31de31d8be7d3e85eb2a47ea23c460056b71c060","id":"fd565de1b33b8d496c25a120d58481d6f9b70709ecb54c7ba5670ba5cc5fb653","sig":"d9482508b9b16c47770ec53cfa036a44e5f4ac505b7ee3470986ca1b407fac81fda32df0a13d34265a25bf8e246f0cd72ab9debfced5c0b684cb29ddf057949d"}},"sha256_empty":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","sha256_abc":"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad","alicePk":"1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f","bobPk":"4d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766","aliceSk":"0101010101010101010101010101010101010101010101010101010101010101","bobSk":"0202020202020202020202020202020202020202020202020202020202020202","convKey":"59c6d24d9c3a7bf8ca4cec54031a3e2ecfaa553452a2b2fa3147e31ee55f33d5","rumorId":"aabb22043dcf60205fc2a7e72df3e001fc74c7ba4ce89d09593bddb06bda7eba","dmWrap":{"kind":1059,"content":"Au7Ko1Stnq2okweGDu1iLsDYrcMMKMdn6ecjxsO/AmNGwkobIA/yuS/lpWF0gQSOcgwdvQNnc6U/vIUqf8/ioOhl3KlukjtjT+6GICOnL9TlqbqCctmK759gFZg1NSBi/jTjkDl4uV0qn9njGLdGC1XjuYvBp52iyx7BtmWvpjw+vwnrWYd0Gp21GRDURTiLaPNcyG5rYOMakpDagVW5x8sgMo/ZxjdvwLFz5ZBIg5l52H7XOSPGAVNMbc3Jnzq82DRXiva4PYjkk+Xo1+/GTs40EN/VkmDyr9O3aBPJzYDI8LYafevBsJPB7P9uIGVwG8D6UNy/Z+Yc/9QyVVRxelIz9ZO2KCh+7f9Dz8qr1TITS3vpvv1On7Dn/qYz3RZF2LcvzmDfjZAdhiPyES5/gCVbL9WfwafrPFABYCebzAuC6a4cf5GQH3270B9F48I/1DTPEREJHYYsc6OEol07ilLR5Y1Chs/6DspYvy34TzduYEpIPpTaCU6Y8ymqOE7vigsWlOpO7YU9b8j4pTJf/rcd/hFHU/Wx8tAw3XQn3zllNqSx44YRLtbY52grczcEw81JQNcETWOH2y6+jTAS20nWPJftttiDAysCIrSqRRTsb8pbrBalqNlSgc9wSR/cXDZ1nozACITZwnLTyXYF/U2pF3pYCUkCcOJtKm0W0oH6H1gGXoXsirEZAeVJEBApAZbfXI7r0pBvubM1ZjdLP7k2Reh6xvDLCq5fQJJGTgjFxcBa9dVGYAYGirkGwq4MdOw/JFZBlqc5z3PY6DIqHgliJm4yaZQlBl4JTe/kGlCPaLp5mp99gtNKG6qtWFhxesBR0mLkciitiwlJF1vJtAmfX2NaVvOyucPA2sfjWn6ZhQvqqNPyAyRFaOfvMyZs+i6x4V/q+/JpL/mtcjjJL9dsNLz/6EFrzIrN9tsH6RLa9MSwnFSCxpQYv0yfGCDwztHSu1uFgWDPuYxbGXGE/0/fwVvd8WmpP3uY8f4HthwolXjlE7xZ5FA1TqAVXUXRoe5kPq7HiRJXc9Mc5/W7cjyld+Po424EaM0p+aKbhZf4uDUrCFjL/DfX2/iWnAeFYbuOYwzVTYXe9LQ80zYT9/Y8V+a/sXdJ50dBXrUkHkZVZf1j5SoxmyE6DpRYMwdPsiqTjCbKq3xyDbiAB4TjT/AGPbulYkUyaPCQbHw0tAj5M30YFdrQhdS4aUGmLW4GC4kYP3sElowKn8aH51q5IyYkVgEWfYyPORmM+OGk5eW/NNtTGa+krjUcBMdcWDn+o71F","tags":[["p","1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f"]],"created_at":1699999001,"pubkey":"531fe6068134503d2723133227c867ac8fa6c83c537e9a44c3c5bdbdcb1fe337","id":"5d88fdfae7176f168f496817b9129087c30bc0fd775ef063d57c16ae8bfb0fb6","sig":"66269e527e431f529fc232cd3a1787e3cf5e851e199cc5a0f0e84a9f9ec1ce1ddb9e45fcb8034f38fbfe6631351565f89ea433bd5df9012025fa45e751d38b39"},"concord":{"streamPk":"462779ad4aad39514614751a71085f2f10e1c7a593e4e030efb5b8721ce55b0b","convKey":"4470c20ec5a19d50c500f13fa1288c3473c123aa50d60ac1b46ed109b77c6545","channelId":"abababababababababababababababababababababababababababababababab","epoch":"7","wrap":{"kind":1059,"content":"AqOWErqAyjZYaC9KpURBQLJn/TYXon3F5KWSGw8ErLbgHAOTdJFY4hNKz84H5guEr2yKmVJKHi+c5RJIKO9DEEiLOo6RK0BKdA/9vsqo+8Ri1efjAG+E/xMNm6aTQdbPCDwX9GrEXki7zqqssqMSdht1sx5uEW/5aWlVwslKKnJI0rYRLNAHRv6MgHnXnst0yfnv7705mPdDMInWNa3CNjpWVVG9tBgJd1YL5UZQ7QuYUm87ePau/XQo/oC/yQtZo6IQ6ScugOqiIOQzzzTvMdUr7ks5PF2RLanF8TJSzZDw59xsbqxpJLRFA0FRPac5CC+jx0UdnYtgLzY1lBAT+2OwWeg8DIZFjUrT82FV8Cg8H/0NhLJyYXhoOPXT2xKnPW2rL3Ymlj+7WIbGguM1fX+wTU+1I+D3lQMZlXJmQeUpyvfSYxgaDnjAyf/XM1lol97Ry57rpjQ9WA081eJWecn58Pa/AFfz4QIchMqjm9MKy/hGd4mkZvwlgrbdKxPjlDydeys8Ove0Dfh3KYTVN6opZUxcPoYEnDPYjZYSmxJ6BBigxhP3i8fFMoMBZ/ew4OWX5c7GETNiNl/E4Fs/r85lkqbaBW3c4Uc8TSXlljOb3GuFidoo9j0peQ9BLuVed+WWoqX1CnShvi8MQh+TpS3dWXDsn25fCcmDXeEo6z1mk0N8ipxNH5heMtl0lJbV+t4b0eBSh9qwNCbHWcZw8DYExNlRgHO421mTNLkCXAZI7NiTTr8TUYoaQBZT9CBs4CehOTewwJccFl4aCU/a60O+PPiw0j2wyiB7wUZApxfZAzcFGJhnwNgOXgt511inT1iQYtr5pE/O767rORvkGD88NkGE+1dd2nhXiZo1UfB1SWFyPaM9xujV11rrwY9BLcPTZKiAmJcIn/vInYioSpfIdT/X/xefVyssMX499nyAuQGBDsZslDOT2jBlGGBQHIda1KiKCJJmhrv3N0FhD83E4eX0uZAmxj4N4aEePiFTvctSkcvBZog/lohKrVQvmVC3c7Eni3qRYM49bvdVYmS5/N1EEFWQVGXq2iOm9WVV4/6xlYzCZSbH6fYDUB++vp5rs7Mjt4PkocTQfhQvPjs/1nCVBccNV7e5fNaXb2O07uYH9jsn7mtAcP4/OIE6sUK+C62xUhNdXr+tcO9UQ0dbFSZyo874NhbdUTLsYtnw3BYd0a3NAYK8pLNHoKiT8Hv9LvAI7v+jWhNWpjLN9mSMPaX3RMfr9xA43Q1NVfr75vBMZXD0oBdcVEhlcrw0A3du","tags":[["p","1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f"]],"created_at":1700000500,"pubkey":"462779ad4aad39514614751a71085f2f10e1c7a593e4e030efb5b8721ce55b0b","id":"515124381efb1cd0dd168c07f7fb9b92af26d7459f93971bfcb1f1ce46b8eb51","sig":"5e54467c5f00ecfb906af3850500c92246d70be5b748a1f44f9f035c79087d691a8667eea1f11cf25bb02ea79be7f6d29ad812a2b8718d089e6bd97158008bf1"},"rumorId":"8edb072ebbfee27c31bcf7e8914d6fea0e84640fd8c8d69f4db3aec1b6a968b4"}}
"""#

let vectors: [String: Any] = {
    guard let data = vectorsJson.data(using: .utf8),
        let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { fatalError("test vectors are not valid JSON") }
    return object
}()

func vectorString(_ key: String) -> String { vectors[key] as! String }
func vectorObject(_ key: String) -> [String: Any] { vectors[key] as! [String: Any] }

/// A properly signed event, in the shape the gateway inlines into a push
/// payload.
///
/// NIP-29 group messages are the one plane that arrives in the CLEAR, so
/// nothing about opening them establishes who wrote them and `prepare` checks
/// the signature itself. That makes an unsigned fixture indistinguishable
/// from a forgery — correctly — so group tests have to sign, which is what this
/// is for. `id` is computed rather than supplied so it always agrees with the
/// body; pass `forgedPubkey` to keep a valid signature while claiming to be
/// somebody else, which is the attack the check exists to refuse.
func signedEvent(
    secretKeyHex: String,
    kind: Int,
    tags: [[String]],
    content: String,
    createdAt: Int = 1_700_000_000,
    forgedPubkey: String? = nil
) -> [String: Any] {
    guard let sk = Hex.decode(secretKeyHex),
          let pubkey = Secp256k1.xonlyPublicKey(secretKey: sk)
    else { fatalError("test secret key is not a valid key") }

    var event: [String: Any] = [
        "pubkey": forgedPubkey ?? pubkey,
        "created_at": createdAt,
        "kind": kind,
        "tags": tags,
        "content": content,
    ]
    guard let parsed = NostrEvent.parse(event) else { fatalError("test event does not parse") }
    let id = parsed.computedId
    guard let digest = Hex.decode(id),
          let sig = Secp256k1.schnorrSign(message: digest, secretKey: sk)
    else { fatalError("test event could not be signed") }

    event["id"] = id
    event["sig"] = sig
    return event
}

/// `event` as nostr-push2 delivers it over APNs: the `napp.push.payload` keys
/// at the top level of `userInfo`.
func napp(_ event: [String: Any], relays: [String] = []) -> [AnyHashable: Any] {
    [
        "$type": "napp.push.payload",
        "event_id": event["id"] as? String ?? "",
        "event": event,
        "relays": relays,
    ]
}
