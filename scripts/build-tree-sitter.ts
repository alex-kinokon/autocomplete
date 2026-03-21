#!/usr/bin/env bun
/* eslint-disable no-console */
// https://github.com/Gregoor/tree-sitter-wasms/blob/3e88dc9e36b4e8bf752ce53bea61e4b67282a2bb/build.ts
import { exec as asyncExec } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path, { join } from "node:path";
import { promisify } from "node:util";

import { PromisePool } from "@supercharge/promise-pool";
import findRoot from "find-root";

import packageInfo from "../package.json" with { type: "json" };

const langArg = process.argv[2];

const exec = promisify(asyncExec);

const outDir = join(import.meta.dirname, "../src/tree-sitter/wasm");

function copyPrebuiltWASM(name: string, files: string[]) {
  try {
    console.log(`⏳ Copying prebuilt ${name}`);
    let packagePath;
    try {
      packagePath = findRoot(require.resolve(name));
    } catch {
      packagePath = join(import.meta.dirname, "node_modules", name);
    }

    for (const file of files) {
      fs.copyFileSync(join(packagePath, file), join(outDir, file));
    }
    console.log(`✅ Finished copying ${name}`);
  } catch (e) {
    console.error(`🔥 Failed to copy ${name}:\n`, e);
  }
}

async function buildParserWASM(
  name: string,
  { subPath, generate }: { subPath?: string; generate?: boolean } = {}
) {
  const label = subPath ? path.join(name, subPath) : name;
  try {
    console.log(`⏳ ${label}`);
    const now = Date.now();
    let packagePath;
    try {
      packagePath = findRoot(require.resolve(name));
    } catch {
      packagePath = path.join(import.meta.dirname, "../node_modules", name);
    }
    const cwd = subPath ? path.join(packagePath, subPath) : packagePath;
    if (generate) {
      await exec(`bunx tree-sitter generate`, { cwd });
    }
    await exec(`bunx tree-sitter build --wasm ${cwd}`);
    console.log(`✅ ${label} (${Date.now() - now}ms)`);
  } catch (e) {
    console.error(`Failed to build ${label}:\n`, e);
  }
}

if (fs.existsSync(outDir)) {
  fs.rmSync(outDir, { recursive: true, force: true });
}

fs.mkdirSync(outDir);

process.chdir(outDir);

const grammars = Object.keys(packageInfo.devDependencies)
  .filter(n => n.startsWith("tree-sitter-") && n !== "tree-sitter-cli")
  .concat("@tree-sitter-grammars/tree-sitter-zig")
  .concat("@tlaplus/tree-sitter-tlaplus")
  .filter(s => !langArg || s.includes(langArg));

await PromisePool.withConcurrency(os.cpus().length)
  .for(grammars)
  .process(async name => {
    switch (name) {
      case "tree-sitter-rescript":
        await buildParserWASM(name, { generate: true });
        break;

      case "tree-sitter-ocaml":
        copyPrebuiltWASM(name, [
          "tree-sitter-ocaml.wasm",
          "tree-sitter-ocaml_interface.wasm",
          "tree-sitter-ocaml_type.wasm",
        ]);
        break;

      case "tree-sitter-php":
        await buildParserWASM(name, { subPath: "php" });
        break;

      case "tree-sitter-typescript":
        await buildParserWASM(name, { subPath: "typescript" });
        await buildParserWASM(name, { subPath: "tsx" });
        break;

      default:
        await buildParserWASM(name);
    }
  });
