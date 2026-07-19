const path = require("path");
const fs = require("fs");

// In-repo: prefer desktop/ source of truth. In Docker image: use vendored impl.
const desktopPath = path.join(__dirname, "..", "..", "desktop", "kmart-stock-probe.cjs");
const useVendored = process.env.MONITOR_USE_VENDORED === "1" || !fs.existsSync(desktopPath);
module.exports = useVendored
  ? require("./kmart-stock-probe.impl.cjs")
  : require(desktopPath);
