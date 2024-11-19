import * as fs from "fs/promises";
import * as path from "path";
import fetch from "node-fetch";
import PQueue from "p-queue";

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface NpmPackageInfo {
  license?: string;
  description?: string;
}

interface CachedDependencyInfo {
  name: string;
  npmLink: string;
  licenseLink: string;
  description: string;
  isPermissive: boolean;
  lastUpdated: string;
}

const queue = new PQueue({ concurrency: 10 });

const permissiveLicenses = [
  "MIT",
  "BSD",
  "Apache",
  "ISC",
  "Unlicense",
  "CC0",
  "WTFPL",
  "Zlib",
];

function isPermissiveLicense(license: string): boolean {
  return permissiveLicenses.some((pl) =>
    license.toUpperCase().includes(pl.toUpperCase()),
  );
}

async function fetchPackageInfo(packageName: string): Promise<NpmPackageInfo> {
  try {
    const response = await fetch(
      `https://registry.npmjs.org/${encodeURIComponent(packageName)}`,
      {
        headers: { "User-Agent": "Node.js" },
      },
    );
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const data = await response.json();
    return data as NpmPackageInfo;
  } catch (error) {
    console.error(`Error fetching info for ${packageName}:`, error);
    return {};
  }
}

function formatDependencyInfo(
  dep: string,
  npmLink: string,
  licenseLink: string,
  description: string,
  isPermissive: boolean,
  lastUpdated: string,
): string {
  const warningMark = isPermissive ? "" : "⚠️ ";
  const warningNote = isPermissive
    ? ""
    : "\n\n**Note:** This license may not be permissive. Please review before use.";

  return `### ${warningMark}${dep}

${description || "No description available."}

- **NPM:** [${npmLink}](${npmLink})
- **License:** [${licenseLink}](${licenseLink})
- *Cache:* ${lastUpdated}${warningNote}

---`;
}

function updateProgress(current: number, total: number) {
  const percentage = Math.round((current / total) * 100);
  const progressBar = "=".repeat(percentage / 2) + "-".repeat(50 - percentage / 2);
  process.stdout.write(`\r[${progressBar}] ${percentage}% | ${current}/${total}`);
}

function parseDate(dateString: string): Date {
  // Try parsing ISO format first
  let date = new Date(dateString);
  if (!isNaN(date.getTime())) {
    console.log(`Parsed ISO date: ${date.toISOString()}`);
    return date;
  }

  // Handle the specific format "31. 8. 2024 15"
  const specificFormatMatch = dateString.match(/(\d+)\.\s*(\d+)\.\s*(\d+)\s*(\d+)/);
  if (specificFormatMatch) {
    const [, day, month, year, hour] = specificFormatMatch;
    date = new Date(parseInt(year), parseInt(month) - 1, parseInt(day), parseInt(hour));
    if (!isNaN(date.getTime())) {
      console.log(`Parsed specific format date: ${date.toISOString()}`);
      return date;
    }
  }

  // Try parsing other common formats
  const formats = [
    "MM/DD/YYYY, HH:mm:ss",
    "YYYY-MM-DD HH:mm:ss",
    "MMMM D, YYYY HH:mm:ss",
    "D. M. YYYY HH:mm:ss",
    // Add more formats as needed
  ];

  for (const format of formats) {
    date = new Date(dateString);
    if (!isNaN(date.getTime())) {
      console.log(`Parsed date with format ${format}: ${date.toISOString()}`);
      return date;
    }
  }

  // If all parsing attempts fail, return the oldest possible date
  console.warn(`Unable to parse date: ${dateString}. Using oldest possible date.`);
  return new Date(0);
}

async function readCachedDependencies(
  outputFile: string,
): Promise<Record<string, CachedDependencyInfo>> {
  try {
    const content = await fs.readFile(outputFile, "utf-8");
    const dependencies = content.split("### ").slice(1);
    const cachedDeps: Record<string, CachedDependencyInfo> = {};

    for (const dep of dependencies) {
      const lines = dep.split("\n").filter((line) => line.trim() !== "");
      const name = lines[0].trim().replace("⚠️ ", "");
      const description = lines[1].trim();
      const npmLink = lines[2].split("(")[1].slice(0, -1);
      const licenseLink = lines[3].split("(")[1].slice(0, -1);

      const lastUpdatedLine = lines.find((line) => line.startsWith("- *Cache:*"));
      const lastUpdated = lastUpdatedLine
        ? lastUpdatedLine.split(":")[1].trim().replace(/\*/g, "")
        : new Date(0).toISOString();

      const isPermissive = !lines[0].includes("⚠️");

      cachedDeps[name] = {
        name,
        npmLink,
        licenseLink,
        description,
        isPermissive,
        lastUpdated,
      };
    }

    return cachedDeps;
  } catch (error) {
    console.error("Error reading cached dependencies:", error);
    return {};
  }
}

async function generateDependenciesList(
  inputFile: string = "package.json",
  outputFile: string = "dependencies.md",
): Promise<void> {
  try {
    const packageJsonPath = path.resolve(process.cwd(), inputFile);
    const packageJsonContent = await fs.readFile(packageJsonPath, "utf-8");
    const packageJson: PackageJson = JSON.parse(packageJsonContent);

    const allDependencies = {
      ...packageJson.dependencies,
      ...packageJson.devDependencies,
    };

    const cachedDependencies = await readCachedDependencies(outputFile);

    const dependenciesCount = Object.keys(allDependencies).length;
    let processedCount = 0;
    let nonPermissiveCount = 0;
    let cachedCount = 0;

    console.log("Generating dependency information:");
    updateProgress(0, dependenciesCount);

    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);

    const dependenciesPromises = Object.keys(allDependencies)
      .sort()
      .map((dep) =>
        queue.add(async () => {
          const cachedInfo = cachedDependencies[dep];
          const isCacheValid =
            cachedInfo && parseDate(cachedInfo.lastUpdated) > oneWeekAgo;

          let packageInfo: NpmPackageInfo;
          let npmLink: string;
          let licenseLink: string;
          let isPermissive: boolean;
          let lastUpdated: string;

          if (isCacheValid) {
            cachedCount++;
            packageInfo = {
              license: cachedInfo.licenseLink.split("/").pop(),
              description: cachedInfo.description,
            };
            npmLink = cachedInfo.npmLink;
            licenseLink = cachedInfo.licenseLink;
            isPermissive = cachedInfo.isPermissive;
            lastUpdated = cachedInfo.lastUpdated;
          } else {
            packageInfo = await fetchPackageInfo(dep);
            npmLink = `https://www.npmjs.com/package/${encodeURIComponent(dep)}`;
            licenseLink = packageInfo.license
              ? `https://opensource.org/licenses/${encodeURIComponent(
                  packageInfo.license,
                )}`
              : "No license information available";
            isPermissive = isPermissiveLicense(packageInfo.license || "");
            lastUpdated = new Date().toLocaleString();
          }

          if (!isPermissive) {
            nonPermissiveCount++;
          }

          processedCount++;
          updateProgress(processedCount, dependenciesCount);

          return formatDependencyInfo(
            dep,
            npmLink,
            licenseLink,
            packageInfo.description || "",
            isPermissive,
            lastUpdated,
          );
        }),
      );

    const dependenciesList = (await Promise.all(dependenciesPromises)).join("\n\n");

    process.stdout.write("\n");

    const header = `# Project Dependencies List

> Generated on: ${new Date().toLocaleString()}

## Summary
- **Total Dependencies:** ${dependenciesCount}
- **Non-Permissive Licenses:** ${nonPermissiveCount}

## Description
This document contains a comprehensive list of all dependencies used in this codebase. For each dependency, you'll find:
- Its intended use
- Source link
- License information
- A link to the license definition

## Note
⚠️ **Warning:** Dependencies marked with ⚠️ have potentially non-permissive licenses. Please review these carefully before use.

---
`;

    const footer = `

---

End of Dependencies List`;

    const fullContent = header + dependenciesList + footer;

    const outputPath = path.resolve(process.cwd(), outputFile);
    await fs.writeFile(outputPath, fullContent, "utf-8");

    console.log(`Dependencies list has been written to ${outputFile}`);
    console.log(`Cached dependencies used: ${cachedCount}`);
    if (nonPermissiveCount > 0) {
      console.warn(
        `\n⚠️ Warning: ${nonPermissiveCount} dependencies have potentially non-permissive licenses. Please review the output file.`,
      );
    }
  } catch (error) {
    console.error("An error occurred:", error);
  }
}

generateDependenciesList();