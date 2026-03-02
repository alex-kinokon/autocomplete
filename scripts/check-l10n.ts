#!/usr/bin/env node
/* eslint-disable no-console */
import { globSync, readFileSync, readdirSync } from "node:fs";

const srcFiles = globSync("src/**/*.ts");

// Extract all vscode.l10n.t("...") / vscode.l10n.t('...') keys from source.
// Collapse whitespace so multiline calls (string on the next line) are matched.
const keys = new Set<string>();
for (const file of srcFiles) {
  const content = readFileSync(file, "utf8").replaceAll(/\s+/g, " ");
  for (const match of content.matchAll(/vscode\.l10n\.t\(\s*"([^"]+)"/g)) {
    keys.add(match[1]!);
  }
  for (const match of content.matchAll(/vscode\.l10n\.t\(\s*'([^']+)'/g)) {
    keys.add(match[1]!);
  }
}

if (keys.size === 0) {
  console.log("No l10n keys found in source.");
  process.exit(0);
}

// Check each bundle
const bundles = readdirSync("l10n").filter(f => f.endsWith(".json"));
let ok = true;

for (const bundle of bundles) {
  const data = JSON.parse(readFileSync(`l10n/${bundle}`, "utf8"));
  const bundleKeys = new Set(Object.keys(data));

  const missing = [...keys].filter(k => !bundleKeys.has(k));
  const extra = [...bundleKeys].filter(k => !keys.has(k));

  if (missing.length > 0) {
    ok = false;
    console.error(`❌ ${bundle}: ${missing.length} missing key(s)`);
    for (const k of missing) {
      console.error(`  - "${k}"`);
    }
  }
  if (extra.length > 0) {
    ok = false;
    console.error(`🛸 ${bundle}: ${extra.length} extra key(s)`);
    for (const k of extra) {
      console.error(`  + "${k}"`);
    }
  }

  if (missing.length === 0 && extra.length === 0) {
    console.log(`✅ ${bundle}`);
  }
}

process.exit(ok ? 0 : 1);
