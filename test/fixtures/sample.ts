// Sample TypeScript file for napi spike testing
import { readFileSync } from "fs";

function greet(name: string) {
  console.log(`Hello, ${name}!`);
  return `greeted ${name}`;
}

function debug(msg: string) {
  console.log(`[DEBUG] ${msg}`);
}

const result = greet("forge-mcp");
console.log(result);

export { greet, debug };
