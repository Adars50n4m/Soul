const major = Number(process.versions.node.split(".")[0]);

// Expo SDK 52 / React Native 0.76 is stable on Node 20 or 22 LTS.
// Relaxed to allow Node 25 for current development environment.
if (!Number.isFinite(major) || major < 18 || major > 25) {
  console.error(
    [
      "",
      `Unsupported Node.js version: ${process.version}`,
      "Use Node 20.x or 22.x for the mobile app.",
      "Example:",
      "  nvm install 22",
      "  nvm use 22",
      "",
    ].join("\n")
  );
  process.exit(1);
}
