// Generates the Ed25519 keypair that signs our session tokens.
//
// EdDSA rather than a shared HMAC secret: the agents service (Phase 6) must
// verify these tokens, and asymmetric means it holds only the public key. A
// shared secret would let any verifier also mint tokens.
import { generateKeyPair, exportPKCS8, exportSPKI } from 'jose';

const { privateKey, publicKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
const pkcs8 = await exportPKCS8(privateKey);
const spki = await exportSPKI(publicKey);

console.log('# Private key — .env only, never committed. Rotating it invalidates every session.');
console.log(`SESSION_PRIVATE_KEY="${pkcs8.trim().replaceAll('\n', '\\n')}"`);
console.log('\n# Public key — safe to distribute to any service that verifies tokens.');
console.log(`SESSION_PUBLIC_KEY="${spki.trim().replaceAll('\n', '\\n')}"`);
