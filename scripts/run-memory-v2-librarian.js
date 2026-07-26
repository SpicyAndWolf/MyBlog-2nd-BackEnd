#!/usr/bin/env node

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = String(argv[index] || "");
    if (argument === "--help" || argument === "-h") {
      values.help = true;
      continue;
    }
    if (!argument.startsWith("--") || argv[index + 1] === undefined || String(argv[index + 1]).startsWith("--")) {
      throw new Error(`Invalid argument: ${argument}`);
    }
    const key = argument.slice(2);
    if (!["userId", "presetId"].includes(key)) throw new Error(`Unknown argument: ${argument}`);
    if (Object.prototype.hasOwnProperty.call(values, key)) throw new Error(`Duplicate argument: ${argument}`);
    values[key] = String(argv[index + 1]);
    index += 1;
  }
  return values;
}

function resolveOptions(values) {
  if (values.help) return { help: true };
  const userId = Number(values.userId);
  const presetId = String(values.presetId ?? "").trim();
  if (!Number.isSafeInteger(userId) || userId <= 0 || !presetId) {
    throw new Error("--userId must be a positive integer and --presetId cannot be empty");
  }
  return { help: false, userId, presetId };
}

function printUsage(stream = process.stdout) {
  stream.write([
    "Usage:",
    "  npm run librarian:memory-v2 -- --userId <id> --presetId <id>",
    "",
    "Captures the latest source boundary, drains Memory targets to the barrier, and runs one global Librarian maintenance task.",
    "This command writes Memory authority data and invokes the configured Memory provider.",
    "",
  ].join("\n"));
}

async function runLibrarian({ db, librarian, userId, presetId }) {
  const { rows } = await db.query(`
    SELECT 1
    FROM chat_prompt_presets
    WHERE user_id=$1 AND preset_id=$2 AND deleted_at IS NULL
  `, [userId, presetId]);
  if (!rows[0]) throw new Error(`Active preset not found: userId=${userId}, presetId=${presetId}`);
  const result = await librarian.runManual(userId, presetId);
  if (result?.status !== "completed") {
    const error = new Error(`Memory Librarian did not complete: ${result?.reason || result?.status || "unknown"}`);
    error.librarianResult = result;
    throw error;
  }
  return result;
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
  const options = resolveOptions(parseArgs(argv));
  if (options.help) {
    printUsage();
    return { status: "help" };
  }
  const context = dependencies.context || (!dependencies.librarian
    ? require("../app/composition/commandContext").createCommandContext()
    : null);
  const db = dependencies.db || context.database;
  const librarian = dependencies.librarian || require("../app/composition/memory")
    .createMemoryAdministrationComposition({ database: db })
    .createLibrarian({ config: context.config.memoryV2Config });
  const result = await runLibrarian({ db, librarian, ...options });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (require.main === module) {
  const context = require("../app/composition/commandContext").createCommandContext();
  main(process.argv.slice(2), { context }).catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  }).finally(async () => {
    await context.database.end();
  });
}

module.exports = { parseArgs, resolveOptions, printUsage, runLibrarian, main };
