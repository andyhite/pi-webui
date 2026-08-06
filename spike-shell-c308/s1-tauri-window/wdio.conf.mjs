// S1/S3 spike harness (#308): drives the built Tauri binary via
// WebKitWebDriver/tauri-driver on Linux, pointed at a real, seeded
// @plotroom/server (spike-server.mjs) through tauri.conf.json's
// build.devUrl (debug-build config). Own throwaway dir, never touches
// apps/desktop production code.
const APP_BINARY = "./src-tauri/target/debug/s1-tauri-window";

export const config = {
  runner: "local",
  specs: ["./test/specs/spike.spec.mjs"],
  maxInstances: 1,

  services: [
    [
      "@wdio/tauri-service",
      {
        appBinaryPath: APP_BINARY,
        driverProvider: "external",
        autoInstallTauriDriver: false,
        tauriDriverPort: 4444,
        captureBackendLogs: true,
        captureFrontendLogs: true,
      },
    ],
  ],

  capabilities: [
    {
      browserName: "tauri",
      "tauri:options": {
        application: APP_BINARY,
      },
    },
  ],

  logLevel: "info",
  bail: 0,
  waitforTimeout: 15000,
  connectionRetryTimeout: 90000,
  connectionRetryCount: 3,

  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: {
    ui: "bdd",
    timeout: 60000,
  },
};
