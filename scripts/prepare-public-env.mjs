#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const projectRoot = process.cwd();
const outputPath = path.resolve(projectRoot, ".env.public.txt");

const isPlaceholderLike = (value) => {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return true;
  return (
    normalized.startsWith("your_")
    || normalized.startsWith("replace_with")
    || normalized.includes("your_project")
    || normalized.includes("<your")
    || normalized === "changeme"
  );
};

const readEnvFile = (filePath) => {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  const env = {};
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    if (!line || line.trim().startsWith("#") || !line.includes("=")) {
      continue;
    }

    const sep = line.indexOf("=");
    const key = line.slice(0, sep).trim().replace(/^export\s+/i, "");
    const rawValue = line.slice(sep + 1).trim();
    const value = rawValue.replace(/^['"]|['"]$/g, "");
    if (!key || isPlaceholderLike(value)) {
      continue;
    }
    env[key] = value;
  }

  return env;
};

const sources = [
  path.resolve(projectRoot, ".env.public.txt"),
  path.resolve(projectRoot, ".env.public"),
  path.resolve(projectRoot, ".env"),
  path.resolve(projectRoot, ".env.example"),
];

const merged = {};
for (const source of sources) {
  const parsed = readEnvFile(source);
  for (const [key, value] of Object.entries(parsed)) {
    if (!merged[key]) {
      merged[key] = value;
    }
  }
}

const supabaseUrl =
  merged.SUPABASE_URL
  || merged.VITE_SUPABASE_URL
  || merged.NEXT_PUBLIC_SUPABASE_URL
  || "";
const supabaseAnonKey =
  merged.SUPABASE_ANON_KEY
  || merged.SUPABASE_PUBLISHABLE_KEY
  || merged.VITE_SUPABASE_ANON_KEY
  || merged.NEXT_PUBLIC_SUPABASE_ANON_KEY
  || merged.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  || "";

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    "Gagal menyiapkan .env.public.txt: SUPABASE_URL dan SUPABASE_ANON_KEY/SUPABASE_PUBLISHABLE_KEY wajib ada.",
  );
}

const payload = [
  "# Auto-generated public env for desktop installer packaging",
  "# Safe for distribution: contains only public client keys / URLs",
  `SUPABASE_URL=${supabaseUrl}`,
  `SUPABASE_ANON_KEY=${supabaseAnonKey}`,
  `SUPABASE_PUBLISHABLE_KEY=${supabaseAnonKey}`,
  `SAKURUPIAH_IS_PRODUCTION=${merged.SAKURUPIAH_IS_PRODUCTION || "true"}`,
  `SUBSCRIPTION_BACKEND_URL=${merged.SUBSCRIPTION_BACKEND_URL || ""}`,
  "",
].join("\n");

fs.writeFileSync(outputPath, payload, "utf8");
console.log(`[prepare-public-env] Generated ${outputPath}`);
