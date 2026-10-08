import { ArrowLeft } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useBackOrHome } from "@/hooks/useBackOrHome";
import { APP_NAME } from "@/lib/platform";

export function PrivacyPolicyPage() {
  const back = useBackOrHome();

  return (
    <main className="flex-1 min-w-0 flex flex-col safe-area-top">
      {/* Header — a detached floating command bar matching the settings page chrome. */}
      <header className="relative h-12 touch:h-14 mx-gutter mt-3 w-[calc(100%-2*var(--gutter))] max-w-2xl sm:mx-auto px-2 sidebar:px-3 flex items-center gap-1.5 shrink-0 clip-corner-lg bg-chrome">
        <Button variant="ghost" size="icon" className="size-9 shrink-0" aria-label="Back" onClick={back}>
          <ArrowLeft className="size-5" />
        </Button>
        <h1 className="font-semibold truncate leading-tight">Privacy Policy</h1>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto safe-area-bottom">
        <article className="max-w-2xl mx-auto px-4 sm:px-6 pb-16 pt-3 space-y-6 text-sm text-foreground/90 leading-relaxed">
          <p className="text-xs text-muted-foreground">Last updated: October 8, 2026</p>

          <section className="space-y-2">
            <h2 className="text-base font-bold text-foreground">Overview</h2>
            <p>
              {APP_NAME} is a client application for the <strong>Nostr protocol</strong>, an open, decentralized
              communication network. This privacy policy explains how {APP_NAME} handles your data and what
              information is shared when you use the app.
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="text-base font-bold text-foreground">How Nostr Works</h2>
            <p>
              Nostr is a decentralized protocol. When you publish content, it is sent to one or more <strong>relays</strong> (independent
              servers) that you choose. Content published to Nostr relays is <strong>public by default</strong> and may be
              visible to anyone, except where it is encrypted (direct messages and Concord communities, below).
            </p>
            <p>
              Out of the box, {APP_NAME} uses a few default servers, some of which are operated by Soapbox, the team
              behind {APP_NAME}: the relay <code>relay.ditto.pub</code>, the file server <code>blossom.ditto.pub</code>,
              the link-preview service at <code>ditto.pub</code>, and the voice broker at <code>armada.buzz</code>. The
              rest are run by independent operators. You can replace the relays, file servers and voice server in
              Settings, and anyone can host their own.
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="text-base font-bold text-foreground">Data We Collect</h2>
            <p>{APP_NAME} is designed to minimize data collection. Here is what the app accesses:</p>
            <ul className="list-disc list-inside space-y-1 ml-2">
              <li>
                <strong>Public key:</strong> Your Nostr public key is used to identify your account. It is not considered private information on the Nostr network.
              </li>
              <li>
                <strong>Relay connections:</strong> The app connects to Nostr relays on your behalf to fetch and publish events. Relay operators may log connection metadata such as your IP address.
              </li>
              <li>
                <strong>Local storage:</strong> Preferences, account information, and cached data are stored locally on your device. This data does not leave your device unless you explicitly publish it.
              </li>
              <li>
                <strong>Published events:</strong> Any content you publish (messages, reactions, profile updates, etc.) is sent to your configured relays and becomes part of the public Nostr network.
              </li>
            </ul>
          </section>

          <section className="space-y-2">
            <h2 className="text-base font-bold text-foreground">Private Keys</h2>
            <p>
              {APP_NAME} supports signing via browser extensions (NIP-07) and other external signers. When using
              these methods, your private key is managed by the signer and is <strong>never</strong> accessed or stored
              by {APP_NAME}. We strongly recommend using a browser extension or hardware signer to protect your
              private key.
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="text-base font-bold text-foreground">Direct Messages</h2>
            <p>
              Direct messages on Nostr are encrypted between sender and recipient using the NIP-04 or NIP-44
              encryption standards. While message content is encrypted, metadata such as the sender and recipient
              public keys and timestamps are visible on relays. Concord communities use end-to-end encryption
              (CORD-02) so that even the relay hosting a community cannot read message content.
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="text-base font-bold text-foreground">File Uploads</h2>
            <p>
              When you upload files (images, videos, etc.), they are sent to Blossom-compatible file servers. These
              servers are operated by third parties and may have their own privacy policies. Uploaded files are
              generally publicly accessible via their URLs.
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="text-base font-bold text-foreground">Voice Calls</h2>
            <p>
              Voice calls use LiveKit servers. For Concord communities, the voice broker issues a short-lived token
              bound to your pubkey, and call media is end-to-end encrypted, so the voice server cannot hear the call.
              For NIP-29 servers, the relay operator manages the LiveKit instance and its data handling, and calls
              are encrypted only in transit.
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="text-base font-bold text-foreground">Analytics</h2>
            <p>
              {APP_NAME} contains no analytics. There are no tracking cookies, no telemetry, and no third-party
              analytics in the client, on any platform.
            </p>
            <p>
              The website at armada.buzz is served by Soapbox's hosting gateway, which collects error reports when
              the page crashes: the error, the page address, and a short trail of recent clicks, page changes and
              network requests leading up to it, with secret keys removed. The Android, iOS and desktop apps do not
              load it, and a self-hosted copy of {APP_NAME} only sends these reports if its host turns them on.
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="text-base font-bold text-foreground">Third-Party Services</h2>
            <p>The app may interact with the following third-party services:</p>
            <ul className="list-disc list-inside space-y-1 ml-2">
              <li><strong>Nostr relays:</strong> For reading and publishing events</li>
              <li><strong>Blossom servers:</strong> For file uploads and media hosting</li>
              <li><strong>LiveKit voice servers:</strong> For real-time voice calls</li>
              <li><strong>NIP-05 providers:</strong> For verifying Nostr addresses</li>
              <li><strong>Link-preview service:</strong> Sees the address of each link it previews</li>
              <li><strong>Push gateway:</strong> For web and iOS notifications; it matches encrypted events and never sees message text</li>
              <li><strong>GIF search provider:</strong> Sees the search terms you type in the GIF picker</li>
            </ul>
            <p>
              Each of these services may have its own data handling practices.
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="text-base font-bold text-foreground">Data Removal</h2>
            <p>
              Because Nostr is a decentralized protocol, {APP_NAME} cannot guarantee the deletion of content
              once it has been published to relays. You can request deletion by publishing a Request to Vanish
              (NIP-62), but individual relays are not obligated to honor these requests. To clear local data, you
              can delete your account from Settings, which wipes all client-side persistence on this device.
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="text-base font-bold text-foreground">Changes to This Policy</h2>
            <p>
              We may update this privacy policy from time to time. Changes will be reflected on this page with an
              updated date. Continued use of {APP_NAME} after changes constitutes acceptance of the revised policy.
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="text-base font-bold text-foreground">Contact</h2>
            <p>
              If you have questions about this privacy policy, you can reach the team behind {APP_NAME} at{" "}
              <a href="https://soapbox.pub" className="text-primary hover:underline" target="_blank" rel="noopener noreferrer">
                soapbox.pub
              </a>.
            </p>
          </section>
        </article>
      </div>
    </main>
  );
}
