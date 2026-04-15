#!/usr/bin/env node

import {spawn} from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const defaultOptions = {
  input: path.join("batch", "tasks.tsk"),
  outDir: path.join("out", "batch"),
  composition: "BarLineChart",
  resolution: "1080p",
  codec: "h264",
  frames: null,
  limit: null,
  continueOnError: true,
};

const parseArgs = () => {
  const args = process.argv.slice(2);
  const options = {...defaultOptions};

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    const next = () => {
      const value = args[index + 1];
      if (!value) {
        throw new Error(`Missing value for ${arg}`);
      }
      index++;
      return value;
    };

    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }

    if (arg === "--input" || arg === "-i") {
      options.input = next();
      continue;
    }

    if (arg.startsWith("--input=")) {
      options.input = arg.split("=")[1];
      continue;
    }

    if (arg === "--out" || arg === "-o") {
      options.outDir = next();
      continue;
    }

    if (arg.startsWith("--out=")) {
      options.outDir = arg.split("=")[1];
      continue;
    }

    if (arg === "--composition" || arg === "-c") {
      options.composition = next();
      continue;
    }

    if (arg.startsWith("--composition=")) {
      options.composition = arg.split("=")[1];
      continue;
    }

    if (arg === "--codec") {
      options.codec = next();
      continue;
    }

    if (arg === "--resolution") {
      options.resolution = next().toLowerCase();
      continue;
    }

    if (arg.startsWith("--codec=")) {
      options.codec = arg.split("=")[1];
      continue;
    }

    if (arg.startsWith("--resolution=")) {
      options.resolution = arg.split("=")[1].toLowerCase();
      continue;
    }

    if (arg === "--frames") {
      options.frames = next();
      continue;
    }

    if (arg.startsWith("--frames=")) {
      options.frames = arg.split("=")[1];
      continue;
    }

    if (arg === "--limit") {
      options.limit = Number(next());
      continue;
    }

    if (arg.startsWith("--limit=")) {
      options.limit = Number(arg.split("=")[1]);
      continue;
    }

    if (arg === "--stop-on-error") {
      options.continueOnError = false;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (options.limit !== null && (!Number.isFinite(options.limit) || options.limit <= 0)) {
    throw new Error("--limit must be a positive number");
  }

  if (!["1080p", "2k", "4k"].includes(options.resolution)) {
    throw new Error("--resolution must be one of: 1080p, 2k, 4k");
  }

  return options;
};

const printHelp = () => {
  console.log(`Batch render runner for .tsk files\n
Usage:
  node scripts/batch-render.mjs --input batch/tasks.tsk --out out/batch

Options:
  --input, -i         Input .tsk file (JSON format)
  --out, -o           Output directory for rendered videos
  --composition, -c   Remotion composition ID (default: BarLineChart)
  --resolution        Output preset: 1080p | 2k | 4k (default: 1080p)
  --codec             Render codec (default: h264)
  --frames            Optional frame range, example: 0-120
  --limit             Optional max number of items to render
  --stop-on-error     Stop batch immediately when one item fails
  --help, -h          Show this help
`);
};

const resolutionToSize = (resolution) => {
  if (resolution === "4k") {
    return {width: 3840, height: 2160};
  }

  if (resolution === "2k") {
    return {width: 2560, height: 1440};
  }

  return {width: 1920, height: 1080};
};

const asObject = (value, pathName) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${pathName} must be an object`);
  }

  return value;
};

const asNonEmptyString = (value, pathName) => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${pathName} must be a non-empty string`);
  }

  return value.trim();
};

const asArray = (value, pathName) => {
  if (!Array.isArray(value)) {
    throw new Error(`${pathName} must be an array`);
  }

  return value;
};

const normalizeItem = (item, pathName) => {
  if (typeof item === "string") {
    return {
      title: asNonEmptyString(item, `${pathName}.title`),
      content: "",
    };
  }

  const objectItem = asObject(item, pathName);

  return {
    title: asNonEmptyString(objectItem.title, `${pathName}.title`),
    content: typeof objectItem.content === "string" ? objectItem.content.trim() : "",
  };
};

const loadTskFile = (inputPath) => {
  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input file not found: ${inputPath}`);
  }

  const raw = fs.readFileSync(inputPath, "utf8");
  let parsed;

  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`TSK JSON parse error: ${error.message}`);
  }

  const root = asObject(parsed, "root");
  const columns = asArray(root.columns, "root.columns");

  if (columns.length === 0) {
    throw new Error("root.columns cannot be empty");
  }

  const jobs = [];

  columns.forEach((column, columnIndex) => {
    const parsedColumn = asObject(column, `columns[${columnIndex}]`);
    const columnName = asNonEmptyString(parsedColumn.name, `columns[${columnIndex}].name`);
    const lists = asArray(parsedColumn.lists, `columns[${columnIndex}].lists`);

    if (lists.length === 0) {
      throw new Error(`columns[${columnIndex}].lists cannot be empty`);
    }

    lists.forEach((list, listIndex) => {
      const parsedList = asObject(list, `columns[${columnIndex}].lists[${listIndex}]`);
      const listName = asNonEmptyString(
        parsedList.name,
        `columns[${columnIndex}].lists[${listIndex}].name`,
      );
      const items = asArray(parsedList.items, `columns[${columnIndex}].lists[${listIndex}].items`);

      if (items.length === 0) {
        return;
      }

      const normalizedItems = items.map((item, itemIndex) =>
        normalizeItem(item, `columns[${columnIndex}].lists[${listIndex}].items[${itemIndex}]`),
      );
      const itemTitles = normalizedItems.map((entry) => entry.title);

      normalizedItems.forEach((item, itemIndex) => {
        jobs.push({
          globalIndex: jobs.length + 1,
          columnName,
          listName,
          itemTitle: item.title,
          itemContent: item.content,
          itemIndex: itemIndex + 1,
          totalItems: normalizedItems.length,
          items: itemTitles,
        });
      });
    });
  });

  if (jobs.length === 0) {
    throw new Error("No items found to render. Ensure each list has at least one item.");
  }

  return jobs;
};

const slugify = (value) => {
  const normalized = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

  return normalized.length > 0 ? normalized : "item";
};

const getNextProjectNumber = (outDir) => {
  if (!fs.existsSync(outDir)) {
    return 1;
  }

  const files = fs.readdirSync(outDir);
  const projectNumberRegex = /^Project\s+(\d+)\.mp4$/i;
  let maxNumber = 0;

  for (const fileName of files) {
    const match = fileName.match(projectNumberRegex);
    if (!match) {
      continue;
    }

    const number = Number(match[1]);
    if (Number.isFinite(number) && number > maxNumber) {
      maxNumber = number;
    }
  }

  return maxNumber + 1;
};

const createOutputName = (projectNumber) => {
  return `Project ${String(projectNumber).padStart(3, "0")}.mp4`;
};

const runCommand = (command, args) => {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`Command failed with exit code ${code}`));
    });

    child.on("error", (error) => {
      reject(error);
    });
  });
};

const main = async () => {
  const options = parseArgs();
  const inputPath = path.resolve(options.input);
  const outputDir = path.resolve(options.outDir);
  const nodeBin = process.execPath;
  const remotionCli = path.resolve("node_modules", "@remotion", "cli", "remotion-cli.js");

  if (!fs.existsSync(remotionCli)) {
    throw new Error("Remotion CLI entry was not found. Run npm i first.");
  }

  const allJobs = loadTskFile(inputPath);
  const jobs = options.limit === null ? allJobs : allJobs.slice(0, options.limit);

  fs.mkdirSync(outputDir, {recursive: true});

  console.log(`Loaded ${allJobs.length} job(s) from ${inputPath}`);
  console.log(`Running ${jobs.length} job(s) into ${outputDir}`);
  const size = resolutionToSize(options.resolution);
  console.log(`Resolution preset: ${options.resolution} (${size.width}x${size.height})`);
  const nextProjectNumber = getNextProjectNumber(outputDir);

  let successCount = 0;
  const failures = [];

  for (const [index, job] of jobs.entries()) {
    const fileName = createOutputName(nextProjectNumber + index);
    const outputPath = path.join(outputDir, fileName);

    const props = {
      board: {
        columnName: job.columnName,
        listName: job.listName,
        itemTitle: job.itemTitle,
        itemContent: job.itemContent,
        itemIndex: job.itemIndex,
        totalItems: job.totalItems,
        items: job.items,
      },
    };

    const args = [
      remotionCli,
      "render",
      options.composition,
      outputPath,
      `--props=${JSON.stringify(props)}`,
      "--codec",
      options.codec,
      "--width",
      String(size.width),
      "--height",
      String(size.height),
    ];

    if (options.frames) {
      args.push("--frames", options.frames);
    }

    console.log(`\n[${index + 1}/${jobs.length}] Rendering ${fileName}`);

    try {
      await runCommand(nodeBin, args);
      successCount += 1;
    } catch (error) {
      failures.push({
        fileName,
        reason: error instanceof Error ? error.message : String(error),
      });

      console.error(`Failed: ${fileName}`);

      if (!options.continueOnError) {
        throw error;
      }
    }
  }

  console.log("\nBatch render finished");
  console.log(`Success: ${successCount}`);
  console.log(`Failed: ${failures.length}`);

  failures.forEach((entry) => {
    console.log(`- ${entry.fileName}: ${entry.reason}`);
  });

  if (failures.length > 0) {
    process.exitCode = 1;
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
