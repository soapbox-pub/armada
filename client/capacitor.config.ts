/// <reference types="@capacitor-community/safe-area" />

import type { CapacitorConfig } from '@capacitor/cli';
import { KeyboardResize } from '@capacitor/keyboard';

const config: CapacitorConfig = {
  appId: 'pub.armadatastic.app',
  appName: 'Armada',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
  },
  android: {
    allowMixedContent: false,
    // Match the app's dark theme background (index.html theme-color #100b15).
    backgroundColor: '#100b15',
  },
  plugins: {
    // Edge-to-edge + safe-area insets. This plugin makes env(safe-area-inset-*)
    // report correct values on modern Chromium (>=140) and falls back to
    // padding the webview on older buggy webviews. The app's CSS reads
    // var(--safe-area-inset-*, env(safe-area-inset-*, 0px)) (see index.css),
    // so top/bottom chrome clears the status/navigation bars on the APK.
    SafeArea: {
      // Status bar content light (the app is dark-themed by default).
      statusBarStyle: 'DARK',
      navigationBarStyle: 'DARK',
    },
    // Capacitor v8 ships its own (beta) inset handling that conflicts with the
    // safe-area plugin — leaving an extra band/padding at the top. The safe-area
    // plugin docs require disabling it so the plugin owns edge-to-edge insets.
    SystemBars: {
      insetsHandling: 'disable',
    },
    // Soft keyboard handling. `Native` resize lets Android's own
    // windowSoftInputMode="adjustResize" (set in AndroidManifest.xml) shrink the
    // WebView viewport when the keyboard opens, so the in-flow chat composer is
    // pushed up above the keyboard instead of being covered — the single biggest
    // "this is a webpage in a box" giveaway when it's missing. The on-screen
    // accessory bar is suppressed for a cleaner native feel.
    Keyboard: {
      resize: KeyboardResize.Native,
      resizeOnFullScreen: true,
    },
  },
};

export default config;
