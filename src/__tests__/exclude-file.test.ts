import { describe, expect, it } from "vitest";

import { isExcludedFile } from "../exclude-file.ts";

describe("isExcludedFile", () => {
  describe("sensitive basenames", () => {
    it.each([".env", ".npmrc", ".pypirc", ".netrc", ".pgpass"])(
      "excludes %s",
      basename => {
        expect(isExcludedFile(`/home/user/project/${basename}`)).toBe(true);
      }
    );
  });

  describe(".env.* variants", () => {
    it.each([".env.local", ".env.production", ".env.development.local"])(
      "excludes %s",
      name => {
        expect(isExcludedFile(`/project/${name}`)).toBe(true);
      }
    );
  });

  describe("sensitive extensions", () => {
    it.each([".pem", ".key", ".p12", ".pfx", ".jks", ".keystore"])(
      "excludes *%s",
      ext => {
        expect(isExcludedFile(`/certs/server${ext}`)).toBe(true);
      }
    );
  });

  describe("sensitive directories", () => {
    it.each([".ssh", ".aws", ".gnupg"])("excludes files in %s/", dir => {
      expect(isExcludedFile(`/home/user/${dir}/config`)).toBe(true);
    });

    it("handles Windows-style paths", () => {
      expect(isExcludedFile(String.raw`C:\Users\me\.ssh\id_rsa`)).toBe(true);
    });
  });

  describe("non-sensitive files", () => {
    it.each(["index.ts", "package.json", "env.example", ".environment.ts", "README.md"])(
      "allows %s",
      name => {
        expect(isExcludedFile(`/project/src/${name}`)).toBe(false);
      }
    );
  });

  describe("extra user patterns", () => {
    it("matches a glob pattern", () => {
      expect(isExcludedFile("/project/app.log", ["*.log"])).toBe(true);
    });

    it("does not match unrelated files", () => {
      expect(isExcludedFile("/project/app.ts", ["*.log"])).toBe(false);
    });

    it("supports multiple patterns", () => {
      expect(isExcludedFile("/project/secrets.yaml", ["*.log", "secrets.*"])).toBe(true);
    });

    it("skips extra patterns when array is empty", () => {
      expect(isExcludedFile("/project/app.ts", [])).toBe(false);
    });
  });
});
