import { greet } from "./modules/greeting/index.ts";

console.log(greet(process.argv[2] ?? ""));
