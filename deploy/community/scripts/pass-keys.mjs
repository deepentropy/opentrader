// A new Ed25519 key pair for passes (#252). PASS_PRIVATE_KEY goes to this
// Worker (`wrangler secret put PASS_PRIVATE_KEY`), PASS_PUBLIC_KEY to the
// gateway. A new pair voids every pass within 15 minutes (their lifetime).
// Run: node scripts/pass-keys.mjs
import { generateKeyPairSync } from "node:crypto";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
console.log(`PASS_PRIVATE_KEY=${privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url")}`);
console.log(`PASS_PUBLIC_KEY=${publicKey.export({ format: "jwk" }).x}`);
