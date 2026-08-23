import fs from "node:fs";
import { webcrypto } from "node:crypto";

const privatePath = process.env.TMG_AUTH_PRIVATE_JWK_PATH;
const publicPath = process.env.TMG_AUTH_PUBLIC_KEY_PATH;
if (!privatePath || !publicPath) throw new Error("TMG_AUTH_PRIVATE_JWK_PATH and TMG_AUTH_PUBLIC_KEY_PATH are required");

const keyPair = await webcrypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const [privateJwk, publicRaw] = await Promise.all([
  webcrypto.subtle.exportKey("jwk", keyPair.privateKey),
  webcrypto.subtle.exportKey("raw", keyPair.publicKey),
]);
const publicKey = Buffer.from(publicRaw).toString("base64url");

fs.writeFileSync(privatePath, `${JSON.stringify(privateJwk)}\n`, { mode: 0o600 });
fs.writeFileSync(publicPath, `${publicKey}\n`, { mode: 0o600 });
console.log("ephemeral Ed25519 acceptance keypair generated with raw public key");
