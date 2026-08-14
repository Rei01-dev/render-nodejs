import { faker } from "@faker-js/faker";
import mysql from "mysql2/promise";
import os from "node:os";
import pidusage from "pidusage";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import dns from "node:dns/promises";
import { Client as PgClient } from "pg";


function getCpuSnapshot() {
  const cpus = os.cpus();

  let idle = 0;
  let total = 0;

  for (const cpu of cpus) {
    idle += cpu.times.idle;

    total +=
      cpu.times.user +
      cpu.times.nice +
      cpu.times.sys +
      cpu.times.idle +
      cpu.times.irq;
  }

  return {
    idle,
    total,
  };
}

function calculateCpuUsage(
  previous: ReturnType<typeof getCpuSnapshot>,
  current: ReturnType<typeof getCpuSnapshot>
) {
  const idleDelta = current.idle - previous.idle;
  const totalDelta = current.total - previous.total;

  if (totalDelta <= 0) {
    return 0;
  }

  return Number(
    (100 * (1 - idleDelta / totalDelta)).toFixed(2)
  );
}

function getRamUsage() {
  const total = os.totalmem();
  const free = os.freemem();

  const used = total - free;

  return {
    total,
    used,
    percent: Number(
      ((used / total) * 100).toFixed(2)
    ),
  };
}


function startResourceMonitor() {
  let previousCpu = getCpuSnapshot();

  const cpuSamples: number[] = [];
  const ramSamples: number[] = [];

  // Take an immediate RAM sample
  const initialRam = getRamUsage();
  ramSamples.push(initialRam.percent);

  const interval = setInterval(() => {
    const currentCpu = getCpuSnapshot();

    const cpuUsage = calculateCpuUsage(
      previousCpu,
      currentCpu
    );

    previousCpu = currentCpu;

    const ram = getRamUsage();

    cpuSamples.push(cpuUsage);
    ramSamples.push(ram.percent);
  }, 50);

  return {
    stop() {
      clearInterval(interval);

      // Take one final CPU sample
      const finalCpu = getCpuSnapshot();

      const finalCpuUsage =
        calculateCpuUsage(
          previousCpu,
          finalCpu
        );

      cpuSamples.push(finalCpuUsage);

      // Take final RAM sample
      const finalRam = getRamUsage();

      ramSamples.push(finalRam.percent);

      const averageCpu =
        cpuSamples.length > 0
          ? cpuSamples.reduce(
              (sum, value) => sum + value,
              0
            ) / cpuSamples.length
          : 0;

      const peakCpu =
        cpuSamples.length > 0
          ? Math.max(...cpuSamples)
          : 0;

      const averageRam =
        ramSamples.length > 0
          ? ramSamples.reduce(
              (sum, value) => sum + value,
              0
            ) / ramSamples.length
          : 0;

      const peakRam =
        ramSamples.length > 0
          ? Math.max(...ramSamples)
          : 0;

      return {
        averageCpu: Number(
          averageCpu.toFixed(2)
        ),

        peakCpu: Number(
          peakCpu.toFixed(2)
        ),

        averageRam: Number(
          averageRam.toFixed(2)
        ),

        peakRam: Number(
          peakRam.toFixed(2)
        ),
      };
    },
  };
}


/**
 * Monitor this Node.js process memory during a benchmark.
 * Stores peak RSS (resident set size), which is more useful for
 * cross-host comparison than endHeap - startHeap.
 */
function startProcessMemoryMonitor(intervalMs = 50) {
  let peakRss = 0;
  let peakHeapUsed = 0;
  let rssTotal = 0;
  let samples = 0;
  let stopped = false;

  function sample() {
    if (stopped) {
      return;
    }

    const memory = process.memoryUsage();

    peakRss = Math.max(peakRss, memory.rss);
    peakHeapUsed = Math.max(peakHeapUsed, memory.heapUsed);
    rssTotal += memory.rss;
    samples += 1;
  }

  sample();

  const interval = setInterval(sample, intervalMs);

  return {
    stop() {
      if (!stopped) {
        sample();
        stopped = true;
        clearInterval(interval);
      }

      const averageRss =
        samples > 0
          ? rssTotal / samples
          : 0;

      return {
        averageRssMb: Number(
          (averageRss / 1024 / 1024).toFixed(2)
        ),
        peakRssMb: Number(
          (peakRss / 1024 / 1024).toFixed(2)
        ),
        peakHeapUsedMb: Number(
          (peakHeapUsed / 1024 / 1024).toFixed(2)
        ),
      };
    },
  };
}

// MySQL PID Finder


const execFileAsync = promisify(execFile);


/**
 * Get all IP addresses assigned to this machine/container.
 */
function getLocalAddresses(): Set<string> {
  const addresses = new Set<string>();

  addresses.add("127.0.0.1");
  addresses.add("::1");

  const interfaces =
    os.networkInterfaces();

  for (const network of Object.values(interfaces)) {
    if (!network) {
      continue;
    }

    for (const item of network) {
      addresses.add(item.address);
    }
  }

  return addresses;
}


/**
 * Determine whether DATABASE_HOST points to
 * the same machine/container as Strapi.
 */
async function isDatabaseLocal(): Promise<boolean> {
  const host =
    process.env.DATABASE_HOST ||
    "127.0.0.1";

  const normalizedHost =
    host.trim().toLowerCase();

  // Obvious local addresses
  if (
    normalizedHost === "localhost" ||
    normalizedHost === "127.0.0.1" ||
    normalizedHost === "::1"
  ) {
    return true;
  }

  // Sometimes the local hostname is used
  if (
    normalizedHost ===
    os.hostname().toLowerCase()
  ) {
    return true;
  }

  try {
    const resolved =
      await dns.lookup(host, {
        all: true,
      });

    const localAddresses =
      getLocalAddresses();

    return resolved.some((entry) =>
      localAddresses.has(entry.address)
    );

  } catch (error) {
    console.warn(
      `Unable to resolve database host "${host}"`,
      error
    );

    return false;
  }
}


/**
 * Windows MySQL/MariaDB PID detection.
 */
async function findWindowsMySqlPid():
  Promise<number | null> {

  try {
    const command = `
      $p = Get-Process -Name mysqld,mariadbd -ErrorAction SilentlyContinue |
      Select-Object -First 1 -ExpandProperty Id;

      if ($p) {
        Write-Output $p
      }
    `;

    const { stdout } =
      await execFileAsync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          command,
        ],
        {
          windowsHide: true,
        }
      );

    const value =
      stdout.trim();

    if (!value) {
      return null;
    }

    const pid =
      Number(value);

    return Number.isInteger(pid)
      ? pid
      : null;

  } catch {
    return null;
  }
}


/**
 * Linux MySQL/MariaDB PID detection.
 */
async function findLinuxMySqlPid():
  Promise<number | null> {

  const attempts = [
    ["pgrep", ["-x", "mysqld"]],
    ["pgrep", ["-x", "mariadbd"]],
    ["pgrep", ["-f", "mysqld"]],
    ["pgrep", ["-f", "mariadbd"]],
  ] as const;

  for (const [command, args] of attempts) {
    try {
      const { stdout } =
        await execFileAsync(
          command,
          [...args]
        );

      const firstPid =
        stdout
          .trim()
          .split(/\s+/)
          .find(Boolean);

      if (!firstPid) {
        continue;
      }

      const pid = Number(firstPid);

      if (
        Number.isInteger(pid) &&
        pid > 0
      ) {
        return pid;
      }

    } catch {
      // Try next method
    }
  }

  return null;
}


/**
 * Cross-platform DB process discovery.
 *
 * Returns null when:
 * - DB is remote
 * - MySQL process can't be found
 * - process access is restricted
 * - OS isn't supported
 */
async function findMySqlPid():
  Promise<number | null> {

  const local =
    await isDatabaseLocal();

  if (!local) {
    console.log(
      "Database is remote - skipping local DB process monitoring."
    );

    return null;
  }

  if (process.platform === "win32") {

    return await findWindowsMySqlPid();

  }

  if (process.platform === "linux") {

    return await findLinuxMySqlPid();

  }

  console.log(
    `Database process monitoring is not supported on ${process.platform}.`
  );

  return null;
}

// MySQL Process Monitor
function startDatabaseMonitor(
  pid: number
) {
  const cpuSamples: number[] = [];
  const memorySamples: number[] = [];

  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  async function sample() {
    if (stopped) {
      return;
    }

    try {
      const stats =
        await pidusage(pid);

      cpuSamples.push(
        Number(stats.cpu || 0)
      );

      memorySamples.push(
        Number(stats.memory || 0)
      );

    } catch (error) {
      console.warn(
        "Unable to sample MySQL process:",
        error
      );
    }

    if (!stopped) {
      timer = setTimeout(
        sample,
        100
      );
    }
  }

  // Start immediately
  void sample();

  return {
    async stop() {
      stopped = true;

      if (timer) {
        clearTimeout(timer);
      }

      // Take one final reading
      try {
        const stats =
          await pidusage(pid);

        cpuSamples.push(
          Number(stats.cpu || 0)
        );

        memorySamples.push(
          Number(stats.memory || 0)
        );

      } catch {
        // MySQL might no longer be accessible.
      }

      const averageCpu =
        cpuSamples.length
          ? cpuSamples.reduce(
              (sum, value) =>
                sum + value,
              0
            ) / cpuSamples.length
          : undefined;

      const peakCpu =
        cpuSamples.length
          ? Math.max(...cpuSamples)
          : undefined;

      const averageMemory =
        memorySamples.length
          ? memorySamples.reduce(
              (sum, value) =>
                sum + value,
              0
            ) / memorySamples.length
          : undefined;

      const peakMemory =
        memorySamples.length
          ? Math.max(...memorySamples)
          : undefined;

      const cpuReliable = 
            process.platform !== "win32";

      return {
        databaseCpu:
          cpuReliable && averageCpu !== undefined
            ? Number(averageCpu.toFixed(2))
            : undefined,

        databasePeakCpu:
          cpuReliable && peakCpu !== undefined
            ? Number(peakCpu.toFixed(2))
            : undefined,

        databaseRam:
          averageMemory === undefined
            ? undefined
            : Number(
                (
                  averageMemory /
                  1024 /
                  1024
                ).toFixed(2)
              ),

        databasePeakRam:
          peakMemory === undefined
            ? undefined
            : Number(
                (
                  peakMemory /
                  1024 /
                  1024
                ).toFixed(2)
              ),
      };
    },
  };
}

export default {
  

  async strapiInsert(ctx: any) {

    const provider =
      process.env.BENCHMARK_PROVIDER ||
      "Local Development";

    const batchSize = 1;


    const mediaFiles = await strapi.documents("plugin::upload.file").findMany({
      limit: 1000,
    });

    // const profileImages = mediaFiles.map(file => file.id);
    const profileImages: number[] = mediaFiles.map((file: any) => file.id);

    console.log("Found media IDs:", profileImages);

    const count = Number(
      ctx.request.body.count || 1000
    );

    const start = Date.now();

    const resourceMonitor = 
      startResourceMonitor();

    const processMemoryMonitor =
      startProcessMemoryMonitor();

    let databaseUsage: {
      databaseCpu?: number;
      databasePeakCpu?: number;
      databaseRam?: number;
      databasePeakRam?: number;
    } = {};

    const mysqlPid =
      await findMySqlPid();

    console.log(
      "Database monitoring:",
      {
        host:
          process.env.DATABASE_HOST ||
          "127.0.0.1",

        platform:
          process.platform,

        mysqlPid,
      }
    );

    const databaseMonitor =
      mysqlPid
        ? startDatabaseMonitor(mysqlPid)
        : null;


    const data = [];

    for (let i = 0; i < count; i++) {

      data.push({
        name: faker.person.fullName(),
        email: faker.internet.email(),
        company: faker.company.name(),
        profileImage:
          profileImages[
            Math.floor(Math.random() * profileImages.length)
          ]
      });

    }


    const generationTime =
      Date.now() - start;


    const dbStart = Date.now();


    const service =
      strapi.documents(
        "api::benchmark-user.benchmark-user"
      );


    try {

      for (const item of data) {

        await service.create({
          data: {
            name: item.name,
            email: item.email,
            company: item.company,
            profileImage: item.profileImage,
          },
        });

      }

    } catch (error) {

      ctx.throw(500, error);

    }


    const databaseTime =
      Date.now() - dbStart;


    const totalTime =
      Date.now() - start;


    const processMemoryUsage =
      processMemoryMonitor.stop();

    // Peak Node.js process RSS in MB.
    const memoryUsed =
      processMemoryUsage.peakRssMb;

    const resourceUsage =
      resourceMonitor.stop();

      databaseUsage =
        databaseMonitor
          ? await databaseMonitor.stop()
          : {};


    await strapi
      .documents(
        "api::benchmark-run.benchmark-run"
      )
      .create({
        data: {
          name: "Faker User Insert Test",
          type: "strapi_insert",
          provider,
          records: count,
          generationTime,
          databaseTime,
          totalTime,
          batchSize,
          memory: memoryUsed,


          applicationCpu:
            resourceUsage.averageCpu,

          applicationPeakCpu:
            resourceUsage.peakCpu,

          applicationRam:
            resourceUsage.averageRam,

          applicationPeakRam:
            resourceUsage.peakRam,

          ...(databaseUsage.databaseCpu !== undefined && {
            databaseCpu:
              databaseUsage.databaseCpu,
          }),

          ...(databaseUsage.databasePeakCpu !== undefined && {
            databasePeakCpu:
              databaseUsage.databasePeakCpu,
          }),

          ...(databaseUsage.databaseRam !== undefined && {
            databaseRam:
              databaseUsage.databaseRam,
          }),

          ...(databaseUsage.databasePeakRam !== undefined && {
            databasePeakRam:
              databaseUsage.databasePeakRam,
          }),
        },
      });


    ctx.body = {
      success: true,

      records: count,

      generationTime:
        `${generationTime} ms`,

      databaseTime:
        `${databaseTime} ms`,

      totalTime:
        `${totalTime} ms`,

      memory:
        `${memoryUsed} MB`,

      applicationCpu:
        `${resourceUsage.averageCpu}%`,

      applicationPeakCpu:
        `${resourceUsage.peakCpu}%`,

      applicationRam:
        `${resourceUsage.averageRam}%`,

      applicationPeakRam:
        `${resourceUsage.peakRam}%`,

      databaseCpu:
        databaseUsage.databaseCpu !== undefined
          ? `${databaseUsage.databaseCpu}%`
          : null,

      databasePeakCpu:
        databaseUsage.databasePeakCpu !== undefined
          ? `${databaseUsage.databasePeakCpu}%`
          : null,

      databaseRam:
        databaseUsage.databaseRam !== undefined
          ? `${databaseUsage.databaseRam} MB`
          : null,

      databasePeakRam:
        databaseUsage.databasePeakRam !== undefined
          ? `${databaseUsage.databasePeakRam} MB`
          : null,
      // TEMPORARY DEBUG
      debug: {
        databaseHost:
          process.env.DATABASE_HOST ||
          "127.0.0.1",

        platform:
          process.platform,

        mysqlPid,
      },
    };

  },


async mysqlInsert(ctx: any) {
  const provider =
    process.env.BENCHMARK_PROVIDER ||
    "Local Development";

  const dbClient =
    process.env.DATABASE_CLIENT || "mysql";

  const BATCH_SIZE = 5000;

  const count = Number(
    ctx.request.body.count || 1000
  );

  if (!Number.isInteger(count) || count <= 0) {
    ctx.throw(400, "Count must be a positive integer.");
  }

  const start = Date.now();

  const resourceMonitor =
    startResourceMonitor();

  const processMemoryMonitor =
    startProcessMemoryMonitor();

  let databaseUsage: {
    databaseCpu?: number;
    databasePeakCpu?: number;
    databaseRam?: number;
    databasePeakRam?: number;
  } = {};

  /*
   * OS-level database monitoring only makes
   * sense for the MySQL/MariaDB setup where
   * we are looking for mariadbd/mysqld.
   *
   * Render PostgreSQL is a separate managed
   * service, so there is no postgres PID
   * visible to this Node container.
   */
  const mysqlPid =
    dbClient === "mysql"
      ? await findMySqlPid()
      : null;

  console.log("Database monitoring:", {
    client: dbClient,
    host:
      process.env.DATABASE_HOST ||
      (process.env.DATABASE_URL
        ? "DATABASE_URL"
        : "unknown"),
    platform: process.platform,
    mysqlPid,
  });

  const databaseMonitor =
    mysqlPid
      ? startDatabaseMonitor(mysqlPid)
      : null;

  // Generate Faker data
  const data: Array<
    [string, string, string, Date, Date]
  > = [];

  for (let i = 0; i < count; i++) {
    const now = new Date();

    data.push([
      faker.person.fullName(),
      faker.internet.email(),
      faker.company.name(),
      now,
      now,
    ]);
  }

  const generationTime =
    Date.now() - start;

  const dbStart = Date.now();

  try {
    /*
     * =========================
     * PostgreSQL / Render
     * =========================
     */
    if (dbClient === "postgres") {
      const pgConnection =
        new PgClient({
          connectionString:
            process.env.DATABASE_URL,

          ssl:
            process.env.DATABASE_SSL === "true"
              ? {
                  rejectUnauthorized:
                    process.env
                      .DATABASE_SSL_REJECT_UNAUTHORIZED !==
                    "false",
                }
              : false,
        });

      await pgConnection.connect();

      try {
        for (
          let offset = 0;
          offset < data.length;
          offset += BATCH_SIZE
        ) {
          const batch = data.slice(
            offset,
            offset + BATCH_SIZE
          );

          const values: unknown[] = [];
          const placeholders: string[] = [];

          batch.forEach((row, rowIndex) => {
            const base = rowIndex * 5;

            placeholders.push(
              `($${base + 1}, ` +
              `$${base + 2}, ` +
              `$${base + 3}, ` +
              `$${base + 4}, ` +
              `$${base + 5})`
            );

            values.push(
              row[0],
              row[1],
              row[2],
              row[3],
              row[4]
            );
          });

          console.log(
            `PostgreSQL batch: ` +
            `${offset + 1} - ` +
            `${offset + batch.length} / ` +
            `${data.length}`
          );

          await pgConnection.query(
            `
            INSERT INTO benchmark_users
            (
              name,
              email,
              company,
              created_at,
              updated_at
            )
            VALUES ${placeholders.join(",")}
            `,
            values
          );
        }
      } finally {
        await pgConnection.end();
      }
    }

    /*
     * =========================
     * MySQL / MariaDB / Plesk
     * =========================
     */
    else if (dbClient === "mysql") {
      const connection =
        await mysql.createConnection({
          host:
            process.env.DATABASE_HOST ||
            "127.0.0.1",

          port: Number(
            process.env.DATABASE_PORT ||
            3306
          ),

          user:
            process.env.DATABASE_USERNAME ||
            "allinones",

          password:
            process.env.DATABASE_PASSWORD,

          database:
            process.env.DATABASE_NAME ||
            "allinones",
        });

      try {
        for (
          let offset = 0;
          offset < data.length;
          offset += BATCH_SIZE
        ) {
          const batch = data.slice(
            offset,
            offset + BATCH_SIZE
          );

          const placeholders = batch
            .map(
              () => "(?, ?, ?, ?, ?)"
            )
            .join(",");

          const values = batch.flat();

          console.log(
            `MySQL batch: ` +
            `${offset + 1} - ` +
            `${offset + batch.length} / ` +
            `${data.length}`
          );

          await connection.execute(
            `
            INSERT INTO benchmark_users
            (
              name,
              email,
              company,
              created_at,
              updated_at
            )
            VALUES ${placeholders}
            `,
            values
          );
        }
      } finally {
        await connection.end();
      }
    }

    else {
      ctx.throw(
        400,
        `Unsupported raw database benchmark: ${dbClient}`
      );
    }
  } catch (error) {
    console.error(
      `Raw ${dbClient} benchmark failed:`,
      error
    );

    processMemoryMonitor.stop();
    resourceMonitor.stop();

    if (databaseMonitor) {
      await databaseMonitor.stop();
    }

    ctx.throw(500, error);
  }

  const databaseTime =
    Date.now() - dbStart;

  const totalTime =
    Date.now() - start;

  const processMemoryUsage =
    processMemoryMonitor.stop();

  // Peak Node.js process RSS in MB.
  const memoryUsed =
    processMemoryUsage.peakRssMb;

  const resourceUsage =
    resourceMonitor.stop();

  databaseUsage =
    databaseMonitor
      ? await databaseMonitor.stop()
      : {};

  const benchmarkName =
    dbClient === "postgres"
      ? "Raw PostgreSQL Bulk Insert"
      : "Raw MySQL Bulk Insert";

  await strapi
    .documents(
      "api::benchmark-run.benchmark-run"
    )
    .create({
      data: {
        name: benchmarkName,

        // Keeping this for frontend compatibility
        type: "mysql_insert",

        provider,
        records: count,
        batchSize: BATCH_SIZE,
        generationTime,
        databaseTime,
        totalTime,
        memory: memoryUsed,

        applicationCpu:
          resourceUsage.averageCpu,

        applicationPeakCpu:
          resourceUsage.peakCpu,

        applicationRam:
          resourceUsage.averageRam,

        applicationPeakRam:
          resourceUsage.peakRam,

        ...(databaseUsage.databaseCpu !==
          undefined && {
          databaseCpu:
            databaseUsage.databaseCpu,
        }),

        ...(databaseUsage.databasePeakCpu !==
          undefined && {
          databasePeakCpu:
            databaseUsage.databasePeakCpu,
        }),

        ...(databaseUsage.databaseRam !==
          undefined && {
          databaseRam:
            databaseUsage.databaseRam,
        }),

        ...(databaseUsage.databasePeakRam !==
          undefined && {
          databasePeakRam:
            databaseUsage.databasePeakRam,
        }),
      },
    });

  ctx.body = {
    success: true,
    databaseClient: dbClient,
    records: count,

    generationTime:
      `${generationTime} ms`,

    databaseTime:
      `${databaseTime} ms`,

    totalTime:
      `${totalTime} ms`,

    memory:
      `${memoryUsed} MB`,

    applicationCpu:
      `${resourceUsage.averageCpu}%`,

    applicationPeakCpu:
      `${resourceUsage.peakCpu}%`,

    applicationRam:
      `${resourceUsage.averageRam}%`,

    applicationPeakRam:
      `${resourceUsage.peakRam}%`,

    databaseCpu:
      databaseUsage.databaseCpu !== undefined
        ? `${databaseUsage.databaseCpu}%`
        : null,

    databasePeakCpu:
      databaseUsage.databasePeakCpu !== undefined
        ? `${databaseUsage.databasePeakCpu}%`
        : null,

    databaseRam:
      databaseUsage.databaseRam !== undefined
        ? `${databaseUsage.databaseRam} MB`
        : null,

    databasePeakRam:
      databaseUsage.databasePeakRam !== undefined
        ? `${databaseUsage.databasePeakRam} MB`
        : null,

    debug: {
      databaseClient: dbClient,
      databaseHost:
        process.env.DATABASE_HOST ||
        (process.env.DATABASE_URL
          ? "Render internal DATABASE_URL"
          : null),

      platform:
        process.platform,

      mysqlPid,
    },
  };
},


// Page load benchmark
async pageLoad(ctx: any) {
  const provider =
    process.env.BENCHMARK_PROVIDER ||
    "Local Development";

  const pageSize = Math.max(
    1,
    Math.min(
      100,
      Number(ctx.request.body.pageSize || 50)
    )
  );

  const totalRecords =
    await strapi.documents(
      "api::benchmark-user.benchmark-user"
    ).count({});

  const pages =
    Math.ceil(
      totalRecords / pageSize
    );

  console.log(
    "Page benchmark:",
    {
      totalRecords,
      pageSize,
      pages,
    }
  );

  const start = Date.now();

  // Application/host monitor
  const resourceMonitor =
    startResourceMonitor();

  const processMemoryMonitor =
    startProcessMemoryMonitor();


  // Database process monitor
  let databaseUsage: {
    databaseCpu?: number;
    databasePeakCpu?: number;
    databaseRam?: number;
    databasePeakRam?: number;
  } = {};

  const mysqlPid =
    await findMySqlPid();

  console.log(
    "Page benchmark DB monitoring:",
    {
      host:
        process.env.DATABASE_HOST ||
        "127.0.0.1",

      platform:
        process.platform,

      mysqlPid,
    }
  );

  const databaseMonitor =
    mysqlPid
      ? startDatabaseMonitor(mysqlPid)
      : null;


  const pageTimes: number[] = [];

  let totalRecordsFetched = 0;

  try {
    const service =
      strapi.documents(
        "api::benchmark-user.benchmark-user"
      );

    for (
      let page = 1;
      page <= pages;
      page++
    ) {
      const offset =
        (page - 1) * pageSize;

      const pageStart =
        performance.now();

      const users =
        await service.findMany({
          populate: {
            profileImage: true,
          },

          sort: {
            createdAt: "desc",
          },

          start: offset,
          limit: pageSize,
        });

      const pageEnd =
        performance.now();

      const elapsed =
        pageEnd - pageStart;

      pageTimes.push(elapsed);

      totalRecordsFetched +=
        users.length;

      console.log(
        `Page ${page}/${pages}: ${elapsed.toFixed(2)} ms`
      );

      // Stop early if we've reached
      // the end of the collection.
      if (users.length < pageSize) {
        break;
      }
    }

  } catch (error) {
    console.error(
      "Page load benchmark failed:",
      error
    );

    if (databaseMonitor) {
      await databaseMonitor.stop();
    }

    processMemoryMonitor.stop();
    resourceMonitor.stop();

    ctx.throw(500, error);
  }


  const totalTime =
    Date.now() - start;

  const processMemoryUsage =
    processMemoryMonitor.stop();

  // Peak Node.js process RSS in MB.
  const memoryUsed =
    processMemoryUsage.peakRssMb;


  const resourceUsage =
    resourceMonitor.stop();

  databaseUsage =
    databaseMonitor
      ? await databaseMonitor.stop()
      : {};


  const actualPagesTested =
    pageTimes.length;


  const averagePageTime =
    actualPagesTested > 0
      ? Number(
          (
            pageTimes.reduce(
              (sum, value) =>
                sum + value,
              0
            ) /
            actualPagesTested
          ).toFixed(2)
        )
      : 0;


  const fastestPageTime =
    actualPagesTested > 0
      ? Number(
          Math.min(
            ...pageTimes
          ).toFixed(2)
        )
      : 0;


  const slowestPageTime =
    actualPagesTested > 0
      ? Number(
          Math.max(
            ...pageTimes
          ).toFixed(2)
        )
      : 0;


  await strapi
    .documents(
      "api::benchmark-run.benchmark-run"
    )
    .create({
      data: {
        name:
          "Paginated Page Load Test",

        type:
          "page_load",

        provider,

        records:
          totalRecordsFetched,

        pagesTested:
          actualPagesTested,

        pageSize,

        generationTime:
          0,

        databaseTime:
          totalTime,

        totalTime,

        memory:
          memoryUsed,

        averagePageTime,
        fastestPageTime,
        slowestPageTime,

        applicationCpu:
          resourceUsage.averageCpu,

        applicationPeakCpu:
          resourceUsage.peakCpu,

        applicationRam:
          resourceUsage.averageRam,

        applicationPeakRam:
          resourceUsage.peakRam,

        ...(databaseUsage.databaseCpu !==
          undefined && {
          databaseCpu:
            databaseUsage.databaseCpu,
        }),

        ...(databaseUsage.databasePeakCpu !==
          undefined && {
          databasePeakCpu:
            databaseUsage.databasePeakCpu,
        }),

        ...(databaseUsage.databaseRam !==
          undefined && {
          databaseRam:
            databaseUsage.databaseRam,
        }),

        ...(databaseUsage.databasePeakRam !==
          undefined && {
          databasePeakRam:
            databaseUsage.databasePeakRam,
        }),
      },
    });


  ctx.body = {
    success: true,

    pagesTested:
      actualPagesTested,

    pageSize,

    records:
      totalRecordsFetched,

    averagePageTime:
      `${averagePageTime} ms`,

    fastestPageTime:
      `${fastestPageTime} ms`,

    slowestPageTime:
      `${slowestPageTime} ms`,

    totalTime:
      `${totalTime} ms`,

    memory:
      `${memoryUsed} MB`,

    applicationCpu:
      `${resourceUsage.averageCpu}%`,

    applicationPeakCpu:
      `${resourceUsage.peakCpu}%`,

    applicationRam:
      `${resourceUsage.averageRam}%`,

    applicationPeakRam:
      `${resourceUsage.peakRam}%`,

    databaseCpu:
      databaseUsage.databaseCpu !== undefined
        ? `${databaseUsage.databaseCpu}%`
        : null,

    databasePeakCpu:
      databaseUsage.databasePeakCpu !== undefined
        ? `${databaseUsage.databasePeakCpu}%`
        : null,

    databaseRam:
      databaseUsage.databaseRam !== undefined
        ? `${databaseUsage.databaseRam} MB`
        : null,

    databasePeakRam:
      databaseUsage.databasePeakRam !== undefined
        ? `${databaseUsage.databasePeakRam} MB`
        : null,
  };
},




  async history(ctx: any) {

    const results =
      await strapi
        .documents(
          "api::benchmark-run.benchmark-run"
        )
        .findMany({
          sort: {
            createdAt: "desc"
          },
          limit: 50,
        });


    ctx.body =
      results.map((item: any) => ({
        id: item.id,
        name: item.name,
        type: item.type,
        provider: item.provider,
        records: item.records,
        batchSize: item.batchSize,
        generationTime: item.generationTime,
        databaseTime: item.databaseTime,
        totalTime: item.totalTime,
        memory: item.memory,


        applicationCpu: item.applicationCpu,
        applicationPeakCpu: item.applicationPeakCpu,
        applicationRam: item.applicationRam,
        applicationPeakRam: item.applicationPeakRam,

        databaseCpu: item.databaseCpu,
        databasePeakCpu: item.databasePeakCpu,
        databaseRam: item.databaseRam,
        databasePeakRam: item.databasePeakRam,

        pagesTested:
          item.pagesTested,

        pageSize:
          item.pageSize,

        averagePageTime:
          item.averagePageTime,

        fastestPageTime:
          item.fastestPageTime,

        slowestPageTime:
          item.slowestPageTime,

        createdAt: item.createdAt,
      }));

  },



  async users(ctx: any) {

    const page =
      Number(ctx.query.page ?? 1);

    const pageSize =
      Number(ctx.query.pageSize ?? 50);

    const start =
      (page - 1) * pageSize;

    const users =
      await strapi.documents(
        "api::benchmark-user.benchmark-user"
      ).findMany({
        populate: {
          profileImage: true,
        },
        sort: {
          createdAt: "desc",
        },
        start,
        limit: pageSize,
      });

    const total =
      await strapi.documents(
        "api::benchmark-user.benchmark-user"
      ).count({});

    ctx.body = {

      data: users,

      pagination: {

        page,

        pageSize,

        total,

        pageCount:
          Math.ceil(total / pageSize)

      }

    };

  },


  // If that doesn't work just delete and rebuild
    async userById(ctx: any) {
    try {
      const id = Number(ctx.params.id);

      if (!Number.isInteger(id) || id <= 0) {
        ctx.status = 400;
        ctx.body = {
          error: "Invalid user ID",
        };
        return;
      }

      const users = await strapi
        .documents(
          "api::benchmark-user.benchmark-user"
        )
        .findMany({
          filters: {
            id: {
              $eq: id,
            },
          },
          populate: {
            profileImage: true,
          },
          limit: 1,
        });

      const user = users[0];

      if (!user) {
        ctx.status = 404;
        ctx.body = {
          error: "User not found",
        };
        return;
      }

      ctx.body = {
        data: user,
      };
    } catch (error) {
      strapi.log.error(
        "Failed to load benchmark user",
        error
      );

      ctx.status = 500;
      ctx.body = {
        error: "Failed to load user",
      };
    }
  },


};