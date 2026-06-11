const fs = require("node:fs/promises");
const path = require("node:path");
const scheduleHandler = require("../api/schedule");

const outDir = path.resolve(process.argv[2] || path.join(__dirname, "..", "public"));

async function main() {
  await fs.mkdir(outDir, { recursive: true });
  const schedule = await runScheduleHandler();
  await fs.writeFile(
    path.join(outDir, "schedule-live.json"),
    `${JSON.stringify(schedule, null, 2)}\n`,
    "utf8"
  );
  await fs.writeFile(
    path.join(outDir, "performance-live.json"),
    `${JSON.stringify(buildPerformancePlaceholder(), null, 2)}\n`,
    "utf8"
  );
  console.log(
    `Updated ${outDir}: ${schedule.counts.totalMatches} matches, ${schedule.counts.trackedConfirmed} confirmed tracked.`
  );
}

async function runScheduleHandler() {
  const res = {
    statusCode: 200,
    headers: {},
    setHeader(key, value) {
      this.headers[key] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
    }
  };
  await scheduleHandler({ query: {} }, res);
  if (res.statusCode >= 400) {
    throw new Error(res.payload?.error || `schedule handler failed: ${res.statusCode}`);
  }
  return res.payload;
}

function buildPerformancePlaceholder() {
  return {
    cachedAt: Date.now(),
    generatedAt: new Date().toISOString(),
    cacheHit: false,
    rows: [],
    sourceStatus: [
      {
        name: "赛后球员详情",
        ok: true,
        message: "公开网页会定时更新赛程；球员评分和上场时间会在赛后数据源可用后接入。"
      }
    ]
  };
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
