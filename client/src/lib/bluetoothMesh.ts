import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";

/**
 * Native bridge to the Android Bluetooth mesh (the vendored bitchat mesh,
 * `com.bitchat.android.*`, fronted by `BluetoothMeshPlugin.java`).
 *
 * This is an Android-only capability: a true offline BLE mesh requires the
 * peripheral (advertise) + central (scan) dual role, background scanning and a
 * foreground service — none of which the browser's Web Bluetooth offers. On
 * web/iOS the plugin methods reject/no-op and the Mesh UI shows an
 * "unavailable" state.
 *
 * The mesh's cryptographic identity stays bitchat-native (Curve25519/Ed25519);
 * only the human-readable nickname is sourced from the logged-in Nostr profile
 * via {@link BluetoothMeshPlugin.setNickname}.
 */
export interface MeshMessage {
  /** Stable message id (uppercase UUID, from the wire payload). */
  id: string;
  /** Sender nickname as announced on the mesh. */
  sender: string;
  /** Plaintext message body. */
  content: string;
  /** Wire timestamp in epoch milliseconds. */
  timestamp: number;
  /** 8-byte (16-hex) mesh peer id of the sender, if known. */
  senderPeerID: string | null;
  /** Channel name (`#name`) if the message was sent to one; null = public. */
  channel: string | null;
  /** Whether this was an encrypted private (DM) message. */
  isPrivate: boolean;
}

export interface MeshPeer {
  peerID: string;
  nickname: string;
  isConnected?: boolean;
  isDirectConnection?: boolean;
  isVerified?: boolean;
  lastSeen?: number;
  noisePublicKey?: string;
}

export interface BluetoothMeshPlugin {
  /** Whether this device/platform can run the BLE mesh at all. */
  isAvailable(): Promise<{ available: boolean }>;
  /**
   * Set the nickname announced on the mesh. The web layer passes the logged-in
   * Nostr profile display name; the native side persists it and re-announces.
   */
  setNickname(options: { nickname: string }): Promise<void>;
  /**
   * Request BLE permissions (if needed) and start advertising/scanning + the
   * foreground service. Resolves with this device's mesh peer id.
   */
  start(): Promise<{ peerID: string }>;
  /** Stop the mesh and the foreground service. */
  stop(): Promise<void>;
  /** Send a public (broadcast) mesh message, flooded over BLE with TTL. */
  sendMessage(options: { content: string }): Promise<void>;
  /**
   * Send an Armada private-channel message. `content` is an already-sealed,
   * framed channel blob (see {@link encodeChannelFrame}); it rides as an
   * ordinary signed broadcast so unmodified bitchat relays it without being
   * able to read it. Channel membership/decryption is entirely in the JS layer.
   */
  sendChannelMessage(options: { content: string }): Promise<void>;
  /** Send an encrypted 1:1 mesh direct message using bitchat Noise sessions. */
  sendPrivateMessage(options: {
    content: string;
    peerID: string;
    nickname?: string;
    messageID?: string;
  }): Promise<void>;
  /** Current peer roster (peerID → nickname). */
  getPeers(): Promise<{ peers: MeshPeer[] }>;

  /** A message was received off the mesh (public, channel, or decrypted DM). */
  addListener(
    eventName: "message",
    listener: (data: MeshMessage) => void,
  ): Promise<PluginListenerHandle>;
  /** The peer roster changed. */
  addListener(
    eventName: "peers",
    listener: (data: { peers: MeshPeer[] }) => void,
  ): Promise<PluginListenerHandle>;
  /** A delivery ack arrived for one of our sent messages. */
  addListener(
    eventName: "deliveryAck",
    listener: (data: { messageID: string; peerID: string }) => void,
  ): Promise<PluginListenerHandle>;
  /** A read receipt arrived for one of our sent messages. */
  addListener(
    eventName: "readReceipt",
    listener: (data: { messageID: string; peerID: string }) => void,
  ): Promise<PluginListenerHandle>;
}

export const BluetoothMesh = registerPlugin<BluetoothMeshPlugin>("BluetoothMesh");
