// Standalone fake API for manual end-to-end runs:
//   RESET_IN=40 node test/e2e/mock-api.mjs   then   ANTHROPIC_BASE_URL=<printed url> claude ...
import { startMockApi } from "../../plugin/lib/mockapi.js";
const api = await startMockApi({ resetIn: Number(process.env.RESET_IN || 60), util5h: process.env.MOCK_UTIL || "0.05" });
console.log(api.url);
setInterval(() => {}, 1 << 30);
