// cron.scan-all.js
import { runScan } from "./scanner.js";
import { connectMongo } from "./models.js";

const MONGO_URI = process.env.MONGO_URI || "";
if (!MONGO_URI) throw new Error("MONGO_URI is required");

(async () => {
  try {
    await connectMongo(MONGO_URI);
    console.log("✅ MongoDB connected", new Date().toISOString());

    const result = await runScan(); // { jobs, summaries, emailAttemptsTotal, scannedTotal }
    const acceptingTotal = (result.summaries || []).reduce((a, s) => a + (s.accepting || 0), 0);
    const childTotal = (result.summaries || []).reduce((a, s) => a + (s.childOnly || 0), 0);

    if (acceptingTotal + childTotal > 0) {
      console.log(
        `✅ Finished — accepting found: ${acceptingTotal}, child-only: ${childTotal}, Email attempts: ${result.emailAttemptsTotal || 0}, Total practices scanned: ${result.scannedTotal || 0}`
      );
    } else {
      console.log(
        `• No accepting practices this round (child-only included: ${childTotal}), Email attempts: ${result.emailAttemptsTotal || 0}, Total practices scanned: ${result.scannedTotal || 0}`
      );
    }
    process.exit(0);
  } catch (e) {
    console.error("❌ Cron failed:", e?.message || e);
    process.exit(1);
  }
})();
