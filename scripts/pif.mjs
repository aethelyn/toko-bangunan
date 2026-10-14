import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const PIF_JSON_PATH = path.resolve("pif.json");
const PIF_PROP_PATH = path.resolve("pif.prop");
const PIF_DIR = path.resolve("pif");
const PIF_INDEX_PATH = path.join(PIF_DIR, "index.json");
const ROOT_INDEX_PATH = path.resolve("index.json");
const PIF_README_PATH = path.join(PIF_DIR, "README.md");
const SDK_MAP_PATH = path.resolve("sdk_map.json");
const TS_REGEX = /^\*Last updated:.*\*$/m;

async function main() {
  try {
    console.log("[INFO] Starting PIF Generator pipeline on GitHub Actions...");

    console.log("[INFO] Fetching Android versions page...");
    const htmlVersionsRes = await fetch("https://developer.android.com/about/versions");
    const htmlVersions = await htmlVersionsRes.text();

    const latestUrlMatch = htmlVersions.match(/https:\/\/developer\.android\.com\/about\/versions\/[^"'\s]*\d/g);
    if (!latestUrlMatch) {
      throw new Error("Failed to find latest Android version URL.");
    }

    const latestUrl = latestUrlMatch.sort().reverse()[0].replace(/"/g, "");
    let versionRelease = "15";
    const verMatch = latestUrl.match(/versions\/([0-9]+)/);
    if (verMatch) {
      versionRelease = verMatch[1];
    }
    console.log(`[INFO] Latest Version URL: ${latestUrl} | Release: ${versionRelease}`);

    console.log("[INFO] Fetching QPR/Canary download page...");
    const htmlLatestRes = await fetch(latestUrl);
    const htmlLatest = await htmlLatestRes.text();

    let fiUrlMatch = "";
    const hrefs = htmlLatest.match(/href="[^"]*"/g);
    if (hrefs) {
      for (const href of hrefs) {
        if (href.includes("download") && href.includes("qpr")) {
          const rawUrl = href.split('"')[1];
          fiUrlMatch = "https://developer.android.com" + rawUrl;
          break;
        }
      }
    }

    if (!fiUrlMatch) {
      throw new Error("Failed to find QPR download link.");
    }

    console.log(`[INFO] QPR Detail URL: ${fiUrlMatch}`);
    const htmlFiRes = await fetch(fiUrlMatch);
    const htmlFi = await htmlFiRes.text();

    const linesFi = htmlFi.split("\n");
    const modelList = [];
    const productList = [];

    for (let i = 0; i < linesFi.length; i++) {
      const line = linesFi[i];
      if (line.includes("tr id=")) {
        const prodMatch = line.match(/tr id="([^"]+)"/);
        if (prodMatch) {
          productList.push(prodMatch[1] + "_beta");
        }
        if (i + 1 < linesFi.length) {
          const nextLine = linesFi[i + 1];
          if (nextLine.includes("td")) {
            const modelMatch = nextLine.match(/<td>([^<]+)<\/td>/);
            if (modelMatch) {
              modelList.push(modelMatch[1].trim());
            }
          }
        }
      }
    }

    console.log(`[INFO] Successfully extracted ${modelList.length} device models.`);
    if (modelList.length === 0 || productList.length === 0) {
      throw new Error("Extracted device list is empty.");
    }

    let selectedIndex = 0;
    const forceSpecific = process.env.FORCE_SPECIFIC_DEVICE === "true";
    if (forceSpecific && process.env.FORCED_DEVICE_MODEL) {
      console.log(`[INFO] FORCE_SPECIFIC_DEVICE enabled for: ${process.env.FORCED_DEVICE_MODEL}`);
      selectedIndex = modelList.findIndex(m => m.toLowerCase().includes(process.env.FORCED_DEVICE_MODEL.toLowerCase()));
      if (selectedIndex === -1) {
        console.warn("[WARNING] Forced device not found, falling back to index 0.");
        selectedIndex = 0;
      }
    } else {
      console.log("[INFO] Selecting highest Pixel flagship automatically...");
      let maxSeries = 0;
      let bestScore = -1;

      for (let i = 0; i < modelList.length; i++) {
        if (modelList[i].toLowerCase().includes("fold")) continue;
        const numMatch = modelList[i].match(/Pixel\s+([0-9]+)/i);
        if (numMatch) {
          const currentSeries = parseInt(numMatch[1], 10);
          let score = 0;
          const lowerName = modelList[i].toLowerCase();

          if (lowerName.includes("pro xl")) score = 4;
          else if (lowerName.includes("pro")) score = 3;
          else if (lowerName.includes("xl")) score = 2;
          else if (lowerName.includes("a")) score = -1;

          if (currentSeries > maxSeries) {
            maxSeries = currentSeries;
            bestScore = score;
            selectedIndex = i;
          } else if (currentSeries === maxSeries && score > bestScore) {
            bestScore = score;
            selectedIndex = i;
          }
        }
      }
    }

    const model = modelList[selectedIndex];
    const product = productList[selectedIndex];
    const device = product.replace("_beta", "");
    console.log(`[INFO] Target: Model="${model}" | Product="${product}" | Device="${device}"`);

    const initialSdk = await getOrUpdateSdk(model);
    console.log(`[INFO] DEVICE_INITIAL_SDK_INT: ${initialSdk}`);

    console.log("[INFO] Fetching API Key from Google Flash Tool...");
    const flashRes = await fetch("https://flash.android.com", {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      }
    });
    const htmlFlash = await flashRes.text();

    let flashKey = "";
    try {
      const bodyMatch = htmlFlash.match(/<body data-client-config=.*/);
      if (bodyMatch) {
        const partsBySemicolon = bodyMatch[0].split(";");
        if (partsBySemicolon.length > 1) {
          const partsByAmpersand = partsBySemicolon[1].split("&");
          flashKey = partsByAmpersand[0].trim();
        }
      }
    } catch {
      // Fallback method
    }

    if (!flashKey) {
      const fallbackKeyMatch = htmlFlash.match(/AIzaSy[A-Za-z0-9_\-]{30,50}/);
      if (fallbackKeyMatch) {
        flashKey = fallbackKeyMatch[0];
      }
    }

    if (!flashKey) {
      throw new Error("Unable to obtain Google Flash Tool API Key.");
    }

    await mkdir(PIF_DIR, { recursive: true });

    console.log(`[INFO] Processing all ${modelList.length} devices found...`);
    const allProfiles = [];
    let selectedProfile = null;
    let resolvedSecurityPatch = "";

    for (let i = 0; i < modelList.length; i++) {
      const curModel = modelList[i];
      const curProduct = productList[i];
      const curDevice = curProduct.replace("_beta", "");

      console.log(`[INFO] [${i + 1}/${modelList.length}] Fetching build for: ${curModel} (${curProduct})...`);

      try {
        const stationRes = await fetch(
          `https://content-flashstation-pa.googleapis.com/v1/builds?product=${curProduct}&key=${flashKey}`,
          { headers: { Referer: "https://flash.android.com" } }
        );
        const stationText = await stationRes.text();
        const canaryData = extractCanaryFromRawJson(stationText);

        if (!canaryData || !canaryData.id || !canaryData.incremental) {
          console.warn(`[WARNING] No active Canary build found for ${curModel}, skipping.`);
          continue;
        }

        const { id, incremental, canaryId } = canaryData;
        const fingerprint = `google/${curProduct}/${curDevice}:CANARY/${id}/${incremental}:user/release-keys`;
        const initialSdk = await getOrUpdateSdk(curModel);

        if (!resolvedSecurityPatch) {
          resolvedSecurityPatch = await resolveSecurityPatch(canaryId);
        }

        const devJsonObj = {
          MANUFACTURER: "Google",
          MODEL: curModel,
          FINGERPRINT: fingerprint,
          BRAND: "google",
          PRODUCT: curProduct,
          DEVICE: curDevice,
          VERSION_RELEASE: versionRelease,
          ID: id,
          SECURITY_PATCH: resolvedSecurityPatch,
          DEVICE_INITIAL_SDK_INT: initialSdk
        };

        const devPropContent = [
          "MANUFACTURER=Google",
          `MODEL=${curModel}`,
          `FINGERPRINT=${fingerprint}`,
          "BRAND=google",
          `PRODUCT=${curProduct}`,
          `DEVICE=${curDevice}`,
          `VERSION_RELEASE=${versionRelease}`,
          `ID=${id}`,
          `SECURITY_PATCH=${resolvedSecurityPatch}`,
          `DEVICE_INITIAL_SDK_INT=${initialSdk}`
        ].join("\n");

        await writeFile(path.join(PIF_DIR, `${curDevice}.json`), JSON.stringify(devJsonObj, null, 2) + "\n", "utf-8");
        await writeFile(path.join(PIF_DIR, `${curDevice}.prop`), devPropContent + "\n", "utf-8");

        allProfiles.push(devJsonObj);

        if (i === selectedIndex) {
          selectedProfile = {
            model: curModel,
            fingerprint,
            jsonObj: devJsonObj,
            jsonContent: JSON.stringify(devJsonObj, null, 2),
            propContent: devPropContent,
            securityPatch: resolvedSecurityPatch
          };
        }
      } catch (err) {
        console.warn(`[WARNING] Failed to process ${curModel}: ${err.message}`);
      }
    }

    if (allProfiles.length === 0) {
      throw new Error("Failed to generate profiles for any device.");
    }

    const indexData = allProfiles.map(p => ({
      name: p.MODEL,
      codename: p.DEVICE,
      json: `pif/${p.DEVICE}.json`,
      prop: `pif/${p.DEVICE}.prop`
    }));

    await writeFile(PIF_INDEX_PATH, JSON.stringify(indexData, null, 2) + "\n", "utf-8");
    await writeFile(ROOT_INDEX_PATH, JSON.stringify(indexData, null, 2) + "\n", "utf-8");
    console.log("[INFO] Saved super simple device list to 'pif/index.json' and root 'index.json'.");

    const markdownRows = allProfiles.map(p => {
      return `| ${p.MODEL} | \`${p.DEVICE}\` | ${p.VERSION_RELEASE} | ${p.SECURITY_PATCH} | ${p.DEVICE_INITIAL_SDK_INT} | [\`${p.DEVICE}.json\`](${p.DEVICE}.json) | [\`${p.DEVICE}.prop\`](${p.DEVICE}.prop) |`;
    }).join("\n");

    const buildReadme = (timestampLine) => [
      "# 📱 Android Canary PIF Profiles",
      "",
      timestampLine,
      "",
      "Catalog of Play Integrity Fix (Canary) profiles for all detected Google Pixel devices.",
      "Each profile is named after the **device codename** (e.g. `mustang.json`, `komodo.json`).",
      "",
      "| Model | Codename | Android | Security Patch | Initial SDK | JSON File | PROP File |",
      "| :--- | :--- | :--- | :--- | :--- | :--- | :--- |",
      markdownRows,
      "",
      "> The main flagship profile is still available at the repository root: [`/pif.json`](../pif.json) & [`/pif.prop`](../pif.prop)."
    ].join("\n") + "\n";

    let previousReadme = null;
    if (existsSync(PIF_README_PATH)) {
      previousReadme = await readFile(PIF_README_PATH, "utf-8");
    }

    const newComparable = buildReadme("").replace(TS_REGEX, "");
    const oldComparable = previousReadme !== null ? previousReadme.replace(TS_REGEX, "") : null;

    if (oldComparable === newComparable) {
      console.log("[INFO] README content unchanged, leaving file untouched.");
    } else {
      await writeFile(
        PIF_README_PATH,
        buildReadme(`*Last updated: ${new Date().toISOString()}*`),
        "utf-8"
      );
      console.log("[INFO] README updated.");
    }

    if (!selectedProfile && allProfiles.length > 0) {
      const fallback = allProfiles[0];
      const fallbackProp = [
        "MANUFACTURER=Google",
        `MODEL=${fallback.MODEL}`,
        `FINGERPRINT=${fallback.FINGERPRINT}`,
        "BRAND=google",
        `PRODUCT=${fallback.PRODUCT}`,
        `DEVICE=${fallback.DEVICE}`,
        `VERSION_RELEASE=${fallback.VERSION_RELEASE}`,
        `ID=${fallback.ID}`,
        `SECURITY_PATCH=${fallback.SECURITY_PATCH}`,
        `DEVICE_INITIAL_SDK_INT=${fallback.DEVICE_INITIAL_SDK_INT}`
      ].join("\n");

      selectedProfile = {
        model: fallback.MODEL,
        fingerprint: fallback.FINGERPRINT,
        jsonObj: fallback,
        jsonContent: JSON.stringify(fallback, null, 2),
        propContent: fallbackProp,
        securityPatch: fallback.SECURITY_PATCH
      };
    }

    let existingFingerprint = null;
    if (existsSync(PIF_JSON_PATH)) {
      try {
        const currentData = JSON.parse(await readFile(PIF_JSON_PATH, "utf-8"));
        existingFingerprint = currentData.FINGERPRINT;
      } catch {
        existingFingerprint = null;
      }
    }

    await writeFile(PIF_JSON_PATH, selectedProfile.jsonContent + "\n", "utf-8");
    await writeFile(PIF_PROP_PATH, selectedProfile.propContent + "\n", "utf-8");
    console.log(`[INFO] Primary profile set to: ${selectedProfile.model} (${selectedProfile.fingerprint})`);

    if (existingFingerprint === selectedProfile.fingerprint) {
      console.log("[INFO] Primary device fingerprint unchanged. Skipping Telegram dispatch.");
      return;
    }

    console.log(`[INFO] New fingerprint detected! Dispatching primary profile (${selectedProfile.model}) to Telegram...`);
    await sendFilesToTelegram(selectedProfile.propContent, selectedProfile.jsonContent, selectedProfile.securityPatch);

    console.log("[SUCCESS] Multi-device Canary PIF process finished successfully.");
  } catch (error) {
    console.error("[CRITICAL ERROR]", error);
    process.exit(1);
  }
}

async function resolveSecurityPatch(canaryId) {
  let securityPatch = "";
  try {
    const secRes = await fetch("https://source.android.com/docs/security/bulletin/pixel");
    const secHtml = await secRes.text();
    const secLines = secHtml.split("\n");

    for (const line of secLines) {
      if (line.includes("<td>" + canaryId)) {
        const lastTdIndex = line.lastIndexOf("<td>");
        const lastTdCloseIndex = line.lastIndexOf("</td>");
        if (lastTdIndex !== -1 && lastTdCloseIndex !== -1 && lastTdCloseIndex > lastTdIndex) {
          securityPatch = line.substring(lastTdIndex + 4, lastTdCloseIndex).trim();
        }
        break;
      }
    }
  } catch (e) {
    console.warn(`[WARNING] Bulletin fetch error: ${e.message}`);
  }

  if (!securityPatch) {
    securityPatch = canaryId + "-05";
    console.warn(`[WARNING] Estimated security patch: ${securityPatch}`);
  } else {
    console.log(`[INFO] Exact security patch resolved: ${securityPatch}`);
  }
  return securityPatch;
}

function extractCanaryFromRawJson(rawJson) {
  const lines = rawJson.split("\n");
  const reversedLines = lines.slice().reverse();

  let canaryIndex = -1;
  for (let i = 0; i < reversedLines.length; i++) {
    if (reversedLines[i].includes('"canary": true') || reversedLines[i].includes('"canary":true')) {
      canaryIndex = i;
      break;
    }
  }

  if (canaryIndex === -1) return null;

  const canaryLines = reversedLines.slice(canaryIndex, canaryIndex + 14);
  let id = "";
  let incremental = "";
  let canaryId = "";

  for (const line of canaryLines) {
    if (line.includes("releaseCandidateName")) {
      const parts = line.split('"');
      if (parts.length >= 4) id = parts[3];
    }
    if (line.includes("buildId")) {
      const parts = line.split('"');
      if (parts.length >= 4) incremental = parts[3];
    }
    if (line.includes('"id"')) {
      const parts = line.split('"');
      if (parts.length >= 4) {
        const rawId = parts[3].replace("canary-", "");
        canaryId = rawId.length >= 4 ? rawId.substring(0, 4) + "-" + rawId.substring(4) : rawId;
      }
    }
  }

  return { id, incremental, canaryId };
}

async function getOrUpdateSdk(modelName) {
  let sdkMap = {
    "Pixel 6": 31,
    "Pixel 7": 33,
    "Pixel Fold": 33,
    "Pixel 8": 34,
    "Pixel 9": 35,
    "Pixel 10": 36
  };

  if (existsSync(SDK_MAP_PATH)) {
    try {
      const raw = await readFile(SDK_MAP_PATH, "utf-8");
      sdkMap = JSON.parse(raw);
    } catch {
      console.warn("[WARNING] Corrupted sdk_map.json, using defaults.");
    }
  } else {
    await writeFile(SDK_MAP_PATH, JSON.stringify(sdkMap, null, 2) + "\n", "utf-8");
  }

  let baseKey = "Pixel 10";
  const seriesMatch = modelName.match(/Pixel\s+([0-9]+)/i);
  if (seriesMatch) {
    baseKey = "Pixel " + seriesMatch[1];
  } else if (modelName.toLowerCase().includes("fold")) {
    baseKey = "Pixel Fold";
  }

  if (sdkMap[baseKey] !== undefined) {
    return sdkMap[baseKey];
  }

  if (seriesMatch) {
    const currentNum = parseInt(seriesMatch[1], 10);
    let maxKnownNum = 6;
    let maxKnownSdk = 31;

    for (const key in sdkMap) {
      const keyMatch = key.match(/Pixel\s+([0-9]+)/i);
      if (keyMatch) {
        const num = parseInt(keyMatch[1], 10);
        if (num > maxKnownNum) {
          maxKnownNum = num;
          maxKnownSdk = sdkMap[key];
        }
      }
    }

    const newSdk = maxKnownSdk + (currentNum - maxKnownNum);
    sdkMap[baseKey] = newSdk;
    await writeFile(SDK_MAP_PATH, JSON.stringify(sdkMap, null, 2) + "\n", "utf-8");
    console.log(`[INFO] New series discovered: Added ${baseKey} (SDK ${newSdk}) to sdk_map.json.`);
    return newSdk;
  }

  return 34;
}

async function sendFilesToTelegram(propContent, jsonContent, patch) {
  const token = process.env.TELEGRAM_TOKEN;
  const chatId = process.env.CHAT_ID;
  const threadId = process.env.THREAD_ID;

  if (!token || !chatId) {
    console.warn("[WARNING] Telegram credentials not provided. Skipping dispatch.");
    return;
  }

  const url = `https://api.telegram.org/bot${token}/sendDocument`;
  const files = [
    { name: `pif-${patch}.prop`, content: propContent, mime: "text/plain" },
    { name: `pif-${patch}.json`, content: jsonContent, mime: "application/json" }
  ];

  for (const file of files) {
    console.log(`[TELEGRAM] Uploading ${file.name}...`);
    const formData = new FormData();
    formData.append("chat_id", chatId);
    if (threadId) {
      formData.append("message_thread_id", threadId);
    }

    const blob = new Blob([file.content], { type: file.mime });
    formData.append("document", blob, file.name);

    try {
      const res = await fetch(url, { method: "POST", body: formData });
      const resJson = await res.json();
      if (!res.ok || !resJson.ok) {
        console.error(`[TELEGRAM ERROR] Failed to send ${file.name}:`, resJson);
      } else {
        console.log(`[TELEGRAM SUCCESS] ${file.name} sent.`);
      }
    } catch (err) {
      console.error(`[TELEGRAM ERROR] Network failure: ${err.message}`);
    }
  }
}

main();
