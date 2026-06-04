/**
 * Live-verify the dual-engine compat fix for host-derived <VENDOR>_API_KEY.
 *
 * Two paths needed compat:
 *   1. CLI runtime spawn (`sendMessageViaCli`) writes both OPENAI_API_KEY
 *      (old engine) and <VENDOR>_API_KEY (new engine) into the child env.
 *   2. Gateway persistence (`models.ts::seedDefaults`) writes both
 *      CUSTOM_PROVIDER_<NAME>_KEY and <VENDOR>_API_KEY into .env so the
 *      long-running gateway can resolve custom provider keys from .env.
 *
 * This script verifies (2) against a running dev Electron instance. It
 * snapshots config.yaml, .env, and models.json and restores them exactly
 * in a finally block, because it intentionally forces a model re-seed.
 *
 * Example:
 *   $env:ENABLE_CDP="1"; $env:CDP_PORT="9337"; npm run dev
 *   $env:CDP_PORT="9337"; node scripts/verify-compat-host-derived-key.js
 */

const fs = require("fs");
const path = require("path");
const { attach } = require("./e2e-attach");

const FAKE_KEY = "sk-fake-deepseek-compat-test-12345";
const PROVIDER_NAME = "CompatTestDeepseek";
const BASE_URL = "https://api.deepseek.com/v1";

function snapshotFile(file) {
  if (!fs.existsSync(file)) return { exists: false, content: "" };
  return { exists: true, content: fs.readFileSync(file, "utf-8") };
}

function restoreFile(file, snapshot) {
  if (snapshot.exists) {
    fs.writeFileSync(file, snapshot.content);
  } else if (fs.existsSync(file)) {
    fs.unlinkSync(file);
  }
}

(async () => {
  let browser;
  let page;
  let cfgFile;
  let envFile;
  let modelsFile;
  let cfgOriginal;
  let envOriginal;
  let modelsOriginal;

  try {
    ({ browser, page } = await attach({ titleHint: "Hermes" }));

    // Phase A - observe HERMES_HOME + engine version.
    const home = await page.evaluate(
      async () => await window.hermesAPI.getHermesHome(),
    );
    const engine = await page.evaluate(
      async () => await window.hermesAPI.getHermesVersion(),
    );
    console.log("HERMES_HOME:", home);
    console.log("Engine:    ", engine);
    const flavor = home.toLowerCase().includes("hermes-oldengine")
      ? "OLD"
      : home.toLowerCase().includes("hermes-newengine")
        ? "NEW"
        : "DEFAULT";
    console.log("Test leg:  ", flavor);

    cfgFile = path.join(home, "config.yaml");
    envFile = path.join(home, ".env");
    modelsFile = path.join(home, "models.json");
    cfgOriginal = snapshotFile(cfgFile);
    envOriginal = snapshotFile(envFile);
    modelsOriginal = snapshotFile(modelsFile);

    // Phase A2 - strip any pre-existing DEEPSEEK_API_KEY so the test can
    // observe the fix writing one, then restore the exact original later.
    const envBefore = envOriginal.exists ? envOriginal.content : "";
    const envWithoutHostKey = envBefore
      .split("\n")
      .filter((line) => !line.startsWith("DEEPSEEK_API_KEY="))
      .join("\n");
    if (envWithoutHostKey !== envBefore) {
      fs.writeFileSync(envFile, envWithoutHostKey);
      console.log("[A2] Stripped pre-existing DEEPSEEK_API_KEY for observability");
    }

    // Phase B - append a custom provider entry to config.yaml.
    const cfg = cfgOriginal.exists ? cfgOriginal.content : "";
    const append =
      "\ncustom_providers:\n" +
      `  - name: "${PROVIDER_NAME}"\n` +
      `    model: "deepseek-chat"\n` +
      `    base_url: "${BASE_URL}"\n` +
      `    api_key: "${FAKE_KEY}"\n`;
    fs.writeFileSync(cfgFile, cfg + append);
    console.log("[B] Appended temporary custom provider to config.yaml");

    // Phase C - force a fresh seedDefaults so .env gets re-persisted.
    if (fs.existsSync(modelsFile)) {
      fs.unlinkSync(modelsFile);
      console.log("[C] Temporarily deleted models.json to force re-seed");
    }
    const listed = await page.evaluate(
      async () => await window.hermesAPI.listModels(),
    );
    const found = listed.find((model) => model.name === PROVIDER_NAME);
    console.log(
      "[C] listModels picked up entry:",
      found ? `id=${found.id}, baseUrl=${found.baseUrl}` : "MISSING",
    );

    // Phase D - read .env and assert both env-var names are written.
    const envContent = fs.existsSync(envFile)
      ? fs.readFileSync(envFile, "utf-8")
      : "";
    const customPrefixKey = `CUSTOM_PROVIDER_${PROVIDER_NAME.toUpperCase()}_KEY`;
    const hasCustomPrefix = new RegExp(
      `^${customPrefixKey}=${FAKE_KEY}$`,
      "m",
    ).test(envContent);
    const hasHostDerived = new RegExp(
      `^DEEPSEEK_API_KEY=${FAKE_KEY}$`,
      "m",
    ).test(envContent);

    console.log("\n[D] .env contents (relevant lines):");
    for (const line of envContent.split("\n")) {
      if (/DEEPSEEK|CUSTOM_PROVIDER_COMPAT/.test(line)) {
        console.log("  ", line);
      }
    }

    console.log("\n=== VERDICT ===");
    console.log(
      `  ${customPrefixKey}=${FAKE_KEY}: ${hasCustomPrefix ? "PASS" : "FAIL"}`,
    );
    console.log(
      `  DEEPSEEK_API_KEY=${FAKE_KEY}:                ${hasHostDerived ? "PASS" : "FAIL"}`,
    );
    if (hasCustomPrefix && hasHostDerived) {
      console.log(
        `\nPASS (${flavor} engine): both env-var names persisted to .env.`,
      );
    } else if (hasCustomPrefix && !hasHostDerived) {
      console.log(
        `\nFAIL (${flavor} engine): only the custom-prefix form was persisted.`,
      );
      process.exitCode = 1;
    } else {
      console.log(
        `\nFAIL (${flavor} engine): missing one or both env-var names.`,
      );
      process.exitCode = 2;
    }
  } catch (error) {
    console.error("ERROR:", error.message || error);
    process.exitCode = 3;
  } finally {
    if (cfgFile && cfgOriginal) restoreFile(cfgFile, cfgOriginal);
    if (envFile && envOriginal) restoreFile(envFile, envOriginal);
    if (modelsFile && modelsOriginal) restoreFile(modelsFile, modelsOriginal);
    if (cfgFile) {
      console.log("\n[E] Restored original config.yaml, .env, and models.json");
    }
    if (browser) await browser.close();
  }
})();
