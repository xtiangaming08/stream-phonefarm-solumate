import Obfuscator from "javascript-obfuscator";
const { obfuscate } = Obfuscator;

import fs from "fs";
import path from "path";

const inputPath = "./dist/assets";
const files = fs.readdirSync(inputPath).filter((f) => f.endsWith(".js"));

files.forEach((file) => {
  const fullPath = path.join(inputPath, file);
  const code = fs.readFileSync(fullPath, "utf-8");
  const obfuscatedCode = obfuscate(code, {
    compact: true,
    controlFlowFlattening: true,
    debugProtection: true,
    debugProtectionInterval: 4000,
    disableConsoleOutput: true,
    selfDefending: true,
  }).getObfuscatedCode();
  fs.writeFileSync(fullPath, obfuscatedCode, "utf-8");
});
