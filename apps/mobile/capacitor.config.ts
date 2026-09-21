import type { CapacitorConfig } from '@capacitor/cli';

/**
 * The app carries the same client the server hosts, built by the web
 * workspace, and talks to whichever server it is pointed at on first launch:
 * see apps/web/src/lib/server.ts.
 */
const config: CapacitorConfig = {
  appId: 'com.paradocs.mobile',
  appName: 'ParaDOCs',
  webDir: '../web/dist',
  // The origins the server's CORS list allows for the app, by default:
  // capacitor://localhost on iOS and https://localhost on Android. Changing
  // either means changing MOBILE_APP_ORIGINS in apps/api/src/config.ts too.
  server: {
    iosScheme: 'capacitor',
    androidScheme: 'https',
    hostname: 'localhost',
  },
  android: {
    // Self-hosted servers on a home or office network are often plain HTTP.
    // The app's own pages are https://localhost, so without this Android would
    // refuse every request to them as mixed content.
    allowMixedContent: true,
  },
  ios: {
    // The page sits under the status bar and home indicator; the client pads
    // itself with the safe-area insets instead of the webview doing it.
    contentInset: 'never',
  },
};

export default config;
